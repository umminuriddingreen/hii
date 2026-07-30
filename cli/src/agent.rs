use crate::{
    config::{AppPaths, DEFAULT_MODEL, DEFAULT_REVIEW_MODEL},
    contract::{deletion_shell, sensitive_shell, Authority, Contract, Decision},
    hooks::{HookBatch, HookEvent, HookRunner},
    ollama::{ChatResult, ChatStreamEvent, Message, Ollama},
    receipt::{redact_text, unix_ms, HookRecord, Receipt, RunStore, VerificationRecord},
    tools::{ToolResult, Toolbelt},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    io::{self, IsTerminal, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    sync::mpsc,
    sync::OnceLock,
    thread,
    time::Duration,
};

/// Set by the Ctrl-C handler so an in-flight run can stop at the next step and
/// still finalize a receipt, rather than being killed mid-work.
static INTERRUPTED: AtomicBool = AtomicBool::new(false);

/// Install the interrupt handler once per process. Idempotent and best-effort:
/// if the host already owns the signal, the run simply won't be interruptible.
fn arm_interrupt() {
    static ARMED: OnceLock<()> = OnceLock::new();
    ARMED.get_or_init(|| {
        let _ = ctrlc::set_handler(|| INTERRUPTED.store(true, Ordering::SeqCst));
    });
}

#[derive(Debug)]
pub struct RunOptions {
    pub goal: String,
    pub workspace: PathBuf,
    pub model: Option<String>,
    pub review: bool,
    pub review_model: Option<String>,
    pub max_steps: usize,
    pub dry_run: bool,
    pub verbose: bool,
    pub authority: Authority,
    pub done_when: Option<String>,
    pub verify: Vec<String>,
    pub use_context: bool,
    pub output: RunOutput,
    pub last_message: Option<PathBuf>,
    pub hooks: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunOutput {
    Human,
    Json,
    Jsonl,
}

fn jsonl_event(event: &str, data: Value) -> Value {
    json!({
        "schemaVersion": 1,
        "event": event,
        "atUnixMs": unix_ms(),
        "data": data
    })
}

fn emit_jsonl(output: RunOutput, event: &str, data: Value) {
    if output != RunOutput::Jsonl {
        return;
    }
    println!("{}", jsonl_event(event, data));
    let _ = io::stdout().flush();
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Action {
    Tool {
        tool: String,
        path: Option<String>,
        query: Option<String>,
        command: Option<String>,
        content: Option<String>,
        url: Option<String>,
        reason: Option<String>,
        #[serde(default)]
        old: Option<String>,
        #[serde(default)]
        new: Option<String>,
        #[serde(default)]
        replace_all: bool,
        #[serde(default)]
        offset: Option<usize>,
        #[serde(default)]
        limit: Option<usize>,
    },
    Final {
        summary: String,
        #[serde(default)]
        verification: Vec<String>,
        next: Option<String>,
    },
    Message {
        message: String,
    },
}

pub(crate) const MODEL_LOOP_DETECTED_MESSAGE: &str =
    "MODEL LOOP DETECTED — HII stopped the repeated rejected action and preserved the session. Revise or steer the request; completed workspace changes remain in place.";

#[derive(Debug, Default)]
pub(crate) struct RejectedActionGuard {
    last_action: String,
    last_state: Option<(usize, Option<usize>)>,
    rejected_count: usize,
}

impl RejectedActionGuard {
    pub(crate) fn would_loop(
        &self,
        raw: &str,
        mutation_epoch: usize,
        verified_epoch: Option<usize>,
    ) -> bool {
        self.rejected_count >= 2
            && self.last_state == Some((mutation_epoch, verified_epoch))
            && self.last_action == normalized_action(raw)
    }

    pub(crate) fn reject(
        &mut self,
        raw: &str,
        mutation_epoch: usize,
        verified_epoch: Option<usize>,
    ) {
        let action = normalized_action(raw);
        let state = (mutation_epoch, verified_epoch);
        if self.last_state == Some(state) && self.last_action == action {
            self.rejected_count += 1;
        } else {
            self.last_action = action;
            self.last_state = Some(state);
            self.rejected_count = 1;
        }
    }

    pub(crate) fn reset(&mut self) {
        self.last_action.clear();
        self.last_state = None;
        self.rejected_count = 0;
    }
}

fn normalized_action(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn run(paths: &AppPaths, options: RunOptions) -> Result<Receipt, String> {
    if options.goal.trim().is_empty() {
        return Err("goal cannot be empty".into());
    }
    validate_declared_verification(&options.verify)?;

    let tools = Toolbelt::new(options.workspace)?;
    let hooks = HookRunner::load(&paths.runtime, tools.workspace(), options.hooks)?;
    let last_message = options
        .last_message
        .as_deref()
        .map(|requested| {
            if options.authority == Authority::ReadOnly {
                return Err("--last-message requires workspace write authority".into());
            }
            if options.dry_run {
                return Err("--last-message cannot be used with --dry-run".into());
            }
            resolve_last_message_path(tools.workspace(), requested)
        })
        .transpose()?;
    let git_before = tools.git_snapshot();
    let ollama = Ollama::new(AppPaths::ollama_url());
    let models = ollama.models()?;
    let model = choose_model(options.model.as_deref(), &models)?;
    let review_model = if options.review {
        Some(choose_review_model(
            options.review_model.as_deref(),
            &models,
        )?)
    } else {
        None
    };
    let store = RunStore::create(&paths.runtime)?;
    store.event(
        "run.started",
        json!({
            "goal": options.goal,
            "workspace": tools.workspace(),
            "model": model,
            "max_steps": options.max_steps,
            "dry_run": options.dry_run
        }),
    )?;
    emit_jsonl(
        options.output,
        "run.started",
        json!({
            "runId": &store.id,
            "goal": redact_text(&options.goal),
            "workspace": tools.workspace(),
            "model": &model,
            "authority": options.authority.label()
        }),
    );
    let mut hook_records: Vec<HookRecord> = Vec::new();
    let session_hooks = hooks.fire(
        HookEvent::SessionStart,
        None,
        &store.id,
        json!({
            "goal": redact_text(&options.goal),
            "authority": options.authority.label()
        }),
    );
    persist_hook_batch(&store, options.output, &session_hooks)?;
    let session_hook_mutation = session_hooks.mutated_workspace();
    hook_records.extend(session_hooks.records);
    let prompt_hooks = hooks.fire(
        HookEvent::UserPrompt,
        None,
        &store.id,
        json!({ "prompt": redact_text(&options.goal) }),
    );
    persist_hook_batch(&store, options.output, &prompt_hooks)?;
    let prompt_block = prompt_hooks.block_reason.clone();
    hook_records.extend(prompt_hooks.records);
    if let Some(reason) = prompt_block {
        store.event("run.blocked", json!({ "reason": redact_text(&reason) }))?;
        return Err(format!("Prompt blocked by lifecycle policy: {reason}"));
    }

    let contract = Contract::infer(&options.goal, options.authority)
        .with_done_when(options.done_when.as_deref());
    let capsule = if options.use_context {
        crate::context::ContextCapsule::build(&paths.runtime, tools.workspace())
    } else {
        crate::context::ContextCapsule::default()
    };
    store.event(
        "contract",
        json!({
            "goal": contract.goal,
            "authority": contract.authority.label(),
            "done_when": contract.done_when,
            "context_sources": capsule.sources,
            "declared_verification": options.verify,
        }),
    )?;
    if options.output == RunOutput::Human && options.authority == Authority::Yolo {
        println!(
            "⚡ YOLO — autonomous, no approval prompts. Authority: {}. Workspace/secret guards still apply; a full receipt is written.",
            tools.workspace().display()
        );
    }
    if options.output == RunOutput::Human && options.verbose {
        println!("HII run {}", store.id);
        println!("{}\n", contract.banner());
    }
    let mut approvals: Vec<String> = Vec::new();
    arm_interrupt();
    INTERRUPTED.store(false, Ordering::SeqCst);
    let mut interrupted = false;

    let system = system_prompt(
        tools.workspace(),
        options.max_steps,
        options.dry_run,
        &contract.done_when,
        &options.verify,
    );
    let mut messages = vec![Message::system(system)];
    if !capsule.text.is_empty() {
        messages.push(Message::system(capsule.text.clone()));
    }
    messages.push(Message::user(options.goal.clone()));
    let mut verification: Vec<VerificationRecord> = Vec::new();
    let mut touched_artifacts = BTreeSet::new();
    let mut final_summary = None;
    let mut final_next = None;
    let mut pending_final = None;
    let mut mutation_epoch = usize::from(session_hook_mutation);
    let mut verified_epoch = None;
    let mut observations = HashSet::new();
    let mut steps = 0usize;
    let mut rejected_actions = RejectedActionGuard::default();
    let mut model_loop_detected = false;

    loop {
        if options.max_steps > 0 && steps >= options.max_steps {
            break;
        }
        if INTERRUPTED.load(Ordering::SeqCst) {
            interrupted = true;
            store.event("run.interrupted", json!({ "step": steps }))?;
            break;
        }
        steps += 1;
        let raw = match stream_model_json(&ollama, &model, &messages, steps, options.output) {
            Ok(result) => result.content,
            Err(error)
                if error.contains("MODEL LOOP DETECTED")
                    && mutation_epoch > 0
                    && verified_epoch == Some(mutation_epoch)
                    && verification.iter().any(|check| check.ok) =>
            {
                store.event(
                    "convergence.verified_loop_recovered",
                    json!({
                        "step": steps,
                        "mutation_epoch": mutation_epoch,
                        "reason": "model repeated while preparing the final response"
                    }),
                )?;
                final_summary = Some(verified_completion_summary(&touched_artifacts));
                final_next = None;
                break;
            }
            Err(error) => return Err(error),
        };
        store.event(
            "model.response",
            json!({ "step": steps, "content": redact_text(&raw) }),
        )?;
        emit_jsonl(
            options.output,
            "model.response",
            json!({ "step": steps, "content": redact_text(&raw) }),
        );
        if rejected_actions.would_loop(&raw, mutation_epoch, verified_epoch) {
            model_loop_detected = true;
            store.event(
                "model.loop_detected",
                json!({ "step": steps, "reason": "identical rejected action repeated three times" }),
            )?;
            emit_jsonl(
                options.output,
                "model.loop_detected",
                json!({ "step": steps, "message": MODEL_LOOP_DETECTED_MESSAGE }),
            );
            if options.output == RunOutput::Human {
                crate::tui::recovery(MODEL_LOOP_DETECTED_MESSAGE);
            }
            break;
        }
        let rejected_raw = raw.clone();
        let action = match parse_action(&raw) {
            Ok(action) => action,
            Err(error) => {
                emit_jsonl(
                    options.output,
                    "protocol.retry",
                    json!({ "step": steps, "error": &error }),
                );
                if options.output == RunOutput::Human && options.verbose {
                    println!("[step {steps}] protocol retry: {error}");
                }
                messages.push(Message::assistant(raw));
                messages.push(Message::user(format!(
                    "Protocol error: {error}. Return one JSON object matching the required action schema."
                )));
                rejected_actions.reject(&rejected_raw, mutation_epoch, verified_epoch);
                continue;
            }
        };
        match action {
            Action::Tool {
                tool,
                path,
                query,
                command,
                content,
                url,
                reason,
                old,
                new,
                replace_all,
                offset,
                limit,
            } => {
                if repeats_passing_verification(
                    &tool,
                    command.as_deref().or(url.as_deref()),
                    mutation_epoch,
                    verified_epoch,
                    &verification,
                ) {
                    store.event(
                        "convergence.repeated_verification_completed",
                        json!({ "step": steps, "tool": tool, "mutation_epoch": mutation_epoch }),
                    )?;
                    final_summary = Some(verified_completion_summary(&touched_artifacts));
                    final_next = None;
                    break;
                }
                let label = reason.as_deref().unwrap_or("using workspace tool");
                emit_jsonl(
                    options.output,
                    "tool.started",
                    json!({ "step": steps, "tool": &tool, "target": label }),
                );
                if options.output == RunOutput::Human && io::stdout().is_terminal() {
                    crate::tui::tool_start(steps, &tool, label);
                }
                let is_hii = crate::hii_tools::is_hii_tool(&tool);
                let observation = matches!(
                    tool.as_str(),
                    "read" | "list" | "search" | "web_search" | "web_fetch"
                );
                let observation_key = observation.then(|| {
                    observation_signature(
                        mutation_epoch,
                        &tool,
                        path.as_deref(),
                        query.as_deref().or(url.as_deref()),
                        offset,
                        limit,
                    )
                });
                if observation_key
                    .as_ref()
                    .is_some_and(|key| observations.contains(key))
                {
                    store.event(
                        "convergence.repeated_action",
                        json!({ "step": steps, "tool": tool, "mutation_epoch": mutation_epoch }),
                    )?;
                    messages.push(Message::assistant(raw));
                    messages.push(Message::user(
                        "REPEATED_ACTION: this exact observation already ran after the latest workspace change. Do not repeat read/list/search. Run one actual verify or http acceptance check next, then return final if it passes.",
                    ));
                    rejected_actions.reject(&rejected_raw, mutation_epoch, verified_epoch);
                    continue;
                }
                let mutates = matches!(tool.as_str(), "write" | "edit")
                    || (tool == "shell"
                        && command
                            .as_deref()
                            .is_some_and(shell_command_changes_workspace))
                    || (is_hii && crate::hii_tools::is_mutating(&tool));
                let sensitive = (tool == "shell" || tool == "verify")
                    && command.as_deref().is_some_and(sensitive_shell);
                let deletion = !options.dry_run
                    && (tool == "shell" || tool == "verify")
                    && command.as_deref().is_some_and(deletion_shell);
                let decision = if deletion {
                    Decision::Prompt
                } else {
                    options.authority.decide(mutates, sensitive)
                };
                if let Some(blocked) =
                    enforce_authority(decision, &tool, label, command.as_deref(), &mut approvals)
                {
                    store.event(
                        "authority.block",
                        json!({ "step": steps, "tool": tool, "decision": format!("{decision:?}") }),
                    )?;
                    messages.push(Message::assistant(raw));
                    messages.push(Message::user(blocked));
                    rejected_actions.reject(&rejected_raw, mutation_epoch, verified_epoch);
                    continue;
                }
                let pre_hooks = hooks.fire(
                    HookEvent::PreTool,
                    Some(&tool),
                    &store.id,
                    json!({
                        "step": steps,
                        "tool": &tool,
                        "path": path.as_deref(),
                        "query": query.as_deref(),
                        "command": command.as_deref().map(redact_text),
                        "url": url.as_deref(),
                        "mutatesWorkspace": mutates,
                        "sensitive": sensitive
                    }),
                );
                persist_hook_batch(&store, options.output, &pre_hooks)?;
                let hook_block = pre_hooks.block_reason.clone();
                hook_records.extend(pre_hooks.records);
                if let Some(blocked) = hook_block {
                    messages.push(Message::assistant(raw));
                    messages.push(Message::user(format!(
                        "HOOK_BLOCKED: {blocked}. Choose a compliant alternative."
                    )));
                    rejected_actions.reject(&rejected_raw, mutation_epoch, verified_epoch);
                    continue;
                }
                rejected_actions.reset();
                let result = if is_hii {
                    crate::hii_tools::execute(&paths.repo, &tool, query.as_deref())
                } else {
                    execute_tool(
                        &tools,
                        ToolCall {
                            tool: &tool,
                            path: path.as_deref(),
                            query: query.as_deref(),
                            command: command.as_deref(),
                            content: content.as_deref(),
                            url: url.as_deref(),
                            old: old.as_deref(),
                            new: new.as_deref(),
                            replace_all,
                            offset,
                            limit,
                            allow_delete: deletion,
                        },
                        options.dry_run,
                    )
                };
                let safe_output = redact_text(&result.output);
                if result.ok {
                    if mutates && !options.dry_run {
                        mutation_epoch += 1;
                        verified_epoch = None;
                        verification.clear();
                        observations.clear();
                        pending_final = None;
                    } else if let Some(key) = observation_key {
                        observations.insert(key);
                    }
                }
                if options.output == RunOutput::Human && io::stdout().is_terminal() {
                    crate::tui::tool_result(result.ok, result.verification);
                    if !result.ok {
                        crate::tui::tool_failure_detail(&safe_output);
                    }
                }
                if result.ok && matches!(tool.as_str(), "write" | "edit") {
                    if let Some(path) = path.as_deref() {
                        touched_artifacts.insert(path.to_string());
                    }
                }
                if result.verification {
                    verification.push(VerificationRecord {
                        command: command.or(url).unwrap_or_else(|| tool.clone()),
                        ok: result.ok,
                        output: safe_output.clone(),
                    });
                    if result.ok {
                        verified_epoch = Some(mutation_epoch);
                    }
                }
                let post_hooks = hooks.fire(
                    HookEvent::PostTool,
                    Some(&tool),
                    &store.id,
                    json!({
                        "step": steps,
                        "tool": &tool,
                        "ok": result.ok,
                        "verification": result.verification,
                        "output": &safe_output
                    }),
                );
                persist_hook_batch(&store, options.output, &post_hooks)?;
                let hook_feedback = post_hooks.model_feedback();
                if post_hooks.mutated_workspace() {
                    mutation_epoch += 1;
                    verified_epoch = None;
                    verification.clear();
                    observations.clear();
                }
                hook_records.extend(post_hooks.records);
                store.event(
                    "tool.result",
                    json!({
                        "step": steps,
                        "tool": &tool,
                        "ok": result.ok,
                        "verification": result.verification,
                        "output": &safe_output
                    }),
                )?;
                emit_jsonl(
                    options.output,
                    "tool.result",
                    json!({
                        "step": steps,
                        "tool": tool,
                        "ok": result.ok,
                        "verification": result.verification,
                        "output": safe_output
                    }),
                );
                messages.push(Message::assistant(raw));
                let proof_hint = if result.ok && mutates && !options.dry_run {
                    format!(
                        "\n\nMUTATION EPOCH {mutation_epoch} RECORDED. Run one actual verify or http acceptance check next. Read/list/search are observation only."
                    )
                } else {
                    String::new()
                };
                messages.push(Message::user(format!(
                    "TOOL RESULT [{}]:\n{}{}{}",
                    if result.ok { "ok" } else { "error" },
                    safe_output,
                    proof_hint,
                    if hook_feedback.is_empty() {
                        String::new()
                    } else {
                        format!("\n\n{hook_feedback}")
                    }
                )));
                if result.verification && result.ok {
                    if let Some(pending) = take_verified_pending_final(
                        &mut pending_final,
                        mutation_epoch,
                        verified_epoch,
                    ) {
                        store.event(
                            "convergence.pending_final_completed",
                            json!({ "step": steps, "mutation_epoch": mutation_epoch }),
                        )?;
                        final_summary = Some(pending.summary);
                        final_next = pending.next;
                        break;
                    }
                }
            }
            Action::Final {
                summary,
                verification: claimed,
                next,
            } => {
                let current_proof_missing =
                    mutation_epoch > 0 && verified_epoch != Some(mutation_epoch);
                if options.verify.is_empty()
                    && (!verification.iter().any(|check| check.ok) || current_proof_missing)
                {
                    pending_final = Some(PendingFinal {
                        summary,
                        next,
                        mutation_epoch,
                    });
                    messages.push(Message::assistant(raw));
                    messages.push(Message::user(format!(
                        "No passing HII verification exists for the latest workspace mutation (model claim: {}). Read/list/search are observation only. Run one actual check with verify or http before finalizing.",
                        if claimed.is_empty() { "none" } else { "present" }
                    )));
                    if options.output == RunOutput::Human && options.verbose {
                        println!("[step {steps}] proof required before completion");
                    }
                    rejected_actions.reset();
                    continue;
                }
                final_summary = Some(summary);
                final_next = next;
                break;
            }
            Action::Message { message } => {
                messages.push(Message::assistant(raw));
                messages.push(Message::user(format!(
                    "This is explicit run mode, not chat. Continue the bounded task, verify it, then return a final action. Your conversational message was: {message}"
                )));
                rejected_actions.reject(&rejected_raw, mutation_epoch, verified_epoch);
            }
        }
    }

    if final_summary.is_some() {
        for command in &options.verify {
            let result = tools.shell(command, true);
            let safe_output = redact_text(&result.output);
            store.event(
                "acceptance.result",
                json!({
                    "command": command,
                    "ok": result.ok,
                    "output": safe_output,
                }),
            )?;
            verification.push(VerificationRecord {
                command: command.clone(),
                ok: result.ok,
                output: safe_output,
            });
        }
    }
    let declared_checks_passed = acceptance_passed(&options.verify, &verification);
    let completed = final_summary.is_some()
        && verification.iter().any(|check| check.ok)
        && declared_checks_passed;
    let mut summary = redact_text(&final_summary.unwrap_or_else(|| {
        if model_loop_detected {
            MODEL_LOOP_DETECTED_MESSAGE.into()
        } else if interrupted {
            format!("Interrupted by operator after {steps} step(s); partial work preserved.")
        } else {
            match options.max_steps {
                0 => format!("Run ended before the model returned a final result ({steps} steps)."),
                limit => {
                    format!("Operator step ceiling reached before completion ({limit} steps).")
                }
            }
        }
    }));
    if !declared_checks_passed {
        summary.push_str(" Declared acceptance verification failed.");
    }
    let stop_hooks = hooks.fire(
        HookEvent::Stop,
        None,
        &store.id,
        json!({
            "status": if completed { "completed" } else { "incomplete" },
            "summary": &summary,
            "steps": steps
        }),
    );
    persist_hook_batch(&store, options.output, &stop_hooks)?;
    hook_records.extend(stop_hooks.records);
    if let Some(path) = last_message.as_deref() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "cannot create --last-message directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        fs::write(path, format!("{summary}\n")).map_err(|error| {
            format!(
                "cannot write --last-message output {}: {error}",
                path.display()
            )
        })?;
        let relative = path
            .strip_prefix(tools.workspace())
            .expect("validated last-message path must remain inside workspace")
            .display()
            .to_string();
        touched_artifacts.insert(relative.clone());
        store.event(
            "output.written",
            json!({ "kind": "last_message", "path": &relative }),
        )?;
        emit_jsonl(
            options.output,
            "output.written",
            json!({ "kind": "last_message", "path": relative }),
        );
    }
    let git_status = tools.git_snapshot();
    let review = match review_model.as_deref() {
        Some(reviewer) => {
            if options.output == RunOutput::Human && options.verbose {
                println!("review     {reviewer}");
            }
            let prompt = format!(
                "Review this bounded local agent result. Identify only concrete proof gaps or risks in at most 120 words.\n\nGoal: {}\nSummary: {}\nVerification: {}\nGit status:\n{}",
                options.goal,
                summary,
                serde_json::to_string(&verification).unwrap_or_default(),
                git_status
            );
            Some(
                match ollama.chat_text(
                    reviewer,
                    &[
                        Message::system("You are HII's strict final proof reviewer."),
                        Message::user(prompt),
                    ],
                ) {
                    Ok(review) => redact_text(&review),
                    Err(error) => {
                        let fallback = format!(
                            "Review unavailable; the run receipt and verification remain preserved. {error}"
                        );
                        redact_text(&fallback)
                    }
                },
            )
        }
        None => None,
    };
    let mut artifacts = artifact_inventory(&git_before, &git_status)
        .into_iter()
        .collect::<BTreeSet<_>>();
    artifacts.extend(touched_artifacts);
    let artifacts = artifacts.into_iter().collect::<Vec<_>>();
    let preexisting_changes = artifact_inventory("clean", &git_before);
    let reversible = Some(git_status != "not a git workspace");
    let receipt = Receipt {
        schema_version: 4,
        id: store.id.clone(),
        created_at_unix_ms: store.started_at_unix_ms,
        finished_at_unix_ms: unix_ms(),
        status: if completed {
            "completed".into()
        } else if interrupted {
            "interrupted".into()
        } else {
            "incomplete".into()
        },
        goal: options.goal,
        workspace: tools.workspace().display().to_string(),
        model,
        review_model,
        steps,
        summary,
        verification,
        git_status,
        next: final_next,
        review,
        risk: "Local shell execution is bounded by the selected workspace and destructive-pattern guard; it is not an OS sandbox.".into(),
        authority: Some(contract.authority.label().to_string()),
        done_when: Some(contract.done_when.clone()),
        approvals,
        artifacts,
        reversible,
        context_sources: capsule.sources,
        preexisting_changes,
        hooks: hook_records,
    };
    store.event(
        "run.finished",
        json!({ "status": receipt.status, "summary": receipt.summary }),
    )?;
    let path = store.finish(&paths.runtime, &receipt)?;
    match options.output {
        RunOutput::Json => println!(
            "{}",
            json!({
                "schemaVersion": 1,
                "receipt": &receipt,
                "proof": path
            })
        ),
        RunOutput::Jsonl => emit_jsonl(
            options.output,
            "run.finished",
            json!({ "receipt": &receipt, "proof": path }),
        ),
        RunOutput::Human if options.verbose => print_receipt(&receipt, &path),
        RunOutput::Human => {
            if io::stdout().is_terminal() {
                print!("\x1b[2K\r");
            }
            println!("{}", receipt.summary);
            if let Some(review) = receipt.review.as_deref() {
                println!("\nReview: {review}");
            }
        }
    }
    Ok(receipt)
}

fn persist_hook_batch(
    store: &RunStore,
    output: RunOutput,
    batch: &HookBatch,
) -> Result<(), String> {
    for record in &batch.records {
        let value = serde_json::to_value(record).map_err(|error| error.to_string())?;
        store.event("hook.result", value.clone())?;
        emit_jsonl(output, "hook.result", value);
    }
    Ok(())
}

pub(crate) fn choose_model(
    requested: Option<&str>,
    installed: &[String],
) -> Result<String, String> {
    let requested = requested
        .map(str::to_string)
        .or_else(|| std::env::var("HII_MODEL").ok())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    if installed.iter().any(|model| model == &requested) {
        Ok(requested)
    } else {
        Err(format!(
            "model '{requested}' is not installed; run `hii models`"
        ))
    }
}

fn choose_review_model(requested: Option<&str>, installed: &[String]) -> Result<String, String> {
    let requested = requested.unwrap_or(DEFAULT_REVIEW_MODEL);
    if installed.iter().any(|model| model == requested) {
        Ok(requested.to_string())
    } else {
        Err(format!(
            "review model '{requested}' is not installed; run `hii models`"
        ))
    }
}

fn system_prompt(
    workspace: &std::path::Path,
    max_steps: usize,
    dry_run: bool,
    done_when: &str,
    declared_verification: &[String],
) -> String {
    let declared_verification = if declared_verification.is_empty() {
        "none; choose and run an explicit verification tool".to_string()
    } else {
        declared_verification.join(" ; ")
    };
    let limit = if max_steps == 0 {
        "No tool-step ceiling; continue until finished or interrupted.".to_string()
    } else {
        format!("Operator ceiling: {max_steps} tool steps.")
    };
    format!(
        r#"You are HII. Finish the local goal with proof.
Workspace: {workspace}
{limit} Dry run: {dry_run}.
Done when: {done_when}
Acceptance checks: {declared_verification}

Loop: inspect -> act -> verify -> final.
Proof MUST be one flat {{"type":"verify","command":"npm test"}} action (or `http`); shell/read/list/search and nested checks never count
One JSON action/turn. Types:
read,list,search,web_search,web_fetch,write,edit,shell,verify,http,hii_context,og_next,caps_check,board_read,board_write,skill_search,bridge_send,bridge_read.
Fields: path,query,command,content,old,new,replace_all,offset,limit,url.
Finish: {{"type":"final","summary":"result","verification":["checks run"],"next":null}}

Read AGENTS.md. Use minimal, sliced context. Preserve unclear work. Verify changes. Stay inside the workspace; never publish, push, spend, message, or read secrets. Deletion needs live approval; never hide it in a script. Never claim unrun proof."#,
        workspace = workspace.display()
    )
}

fn stream_model_json(
    ollama: &Ollama,
    model: &str,
    messages: &[Message],
    step: usize,
    output: RunOutput,
) -> Result<ChatResult, String> {
    let ollama = ollama.clone();
    let model_for_thread = model.to_string();
    let messages = messages.to_vec();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        ollama.chat_with_stream(&model_for_thread, &messages, true, true, sender);
    });

    let interactive = output == RunOutput::Human && io::stdout().is_terminal();
    let mut thinking_started = false;
    let mut content_started = false;
    loop {
        match receiver.recv_timeout(Duration::from_millis(120)) {
            Ok(ChatStreamEvent::Thinking(delta)) => {
                if interactive {
                    if !thinking_started {
                        println!("\n  THINKING · step {step}");
                        print!("  ");
                        thinking_started = true;
                    }
                    print!("{}", delta.replace('\n', "\n  "));
                    let _ = io::stdout().flush();
                }
            }
            Ok(ChatStreamEvent::Content(delta)) => {
                if interactive {
                    if !content_started {
                        if thinking_started {
                            println!();
                        }
                        println!("\n  MODEL · step {step}");
                        print!("  ");
                        content_started = true;
                    }
                    print!("{}", delta.replace('\n', "\n  "));
                    let _ = io::stdout().flush();
                }
            }
            Ok(ChatStreamEvent::Done(result)) => {
                if interactive && (thinking_started || content_started) {
                    println!("\n");
                    let _ = io::stdout().flush();
                }
                return result;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("the local model stream stopped unexpectedly".into())
            }
        }
    }
}

fn validate_declared_verification(commands: &[String]) -> Result<(), String> {
    for command in commands {
        if command.trim().is_empty() {
            return Err("--verify commands cannot be empty".into());
        }
        if sensitive_shell(command) {
            return Err(format!(
                "--verify must be a local acceptance check, not an external action: {command}"
            ));
        }
    }
    Ok(())
}

fn resolve_last_message_path(workspace: &Path, requested: &Path) -> Result<PathBuf, String> {
    let relative = if requested.is_absolute() {
        requested.strip_prefix(workspace).map_err(|_| {
            format!(
                "--last-message must stay inside the workspace: {}",
                requested.display()
            )
        })?
    } else {
        requested
    };
    let mut normalized = PathBuf::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "--last-message must stay inside the workspace: {}",
                    requested.display()
                ))
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("--last-message requires a file path inside the workspace".into());
    }

    let target = workspace.join(normalized);
    if target.exists() {
        let metadata = fs::symlink_metadata(&target).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "--last-message cannot write through a symlink: {}",
                target.display()
            ));
        }
        let canonical = target.canonicalize().map_err(|error| error.to_string())?;
        if !canonical.starts_with(workspace) {
            return Err(format!(
                "--last-message must stay inside the workspace: {}",
                requested.display()
            ));
        }
    } else {
        let mut ancestor = target
            .parent()
            .ok_or_else(|| "--last-message requires a parent directory".to_string())?;
        while !ancestor.exists() {
            ancestor = ancestor
                .parent()
                .ok_or_else(|| "--last-message could not resolve a workspace parent".to_string())?;
        }
        let canonical = ancestor.canonicalize().map_err(|error| error.to_string())?;
        if !canonical.starts_with(workspace) {
            return Err(format!(
                "--last-message must stay inside the workspace: {}",
                requested.display()
            ));
        }
    }
    Ok(target)
}

fn shell_command_changes_workspace(command: &str) -> bool {
    let lowered = command.trim().to_ascii_lowercase();
    let non_mutating = [
        "open ",
        "xdg-open ",
        "start ",
        "rg ",
        "ls ",
        "cat ",
        "head ",
        "tail ",
        "sed -n",
        "find ",
        "pwd",
        "wc ",
        "stat ",
        "file ",
        "git status",
        "git diff",
        "git log",
        "git show",
        "cargo test",
        "cargo check",
        "cargo clippy",
        "npm test",
        "npm run check",
        "npm run build",
        "node --check",
    ];
    !non_mutating
        .iter()
        .any(|prefix| lowered.starts_with(prefix))
}

fn observation_signature(
    mutation_epoch: usize,
    tool: &str,
    path: Option<&str>,
    query: Option<&str>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> String {
    format!(
        "{mutation_epoch}|{tool}|{}|{}|{}|{}",
        path.unwrap_or(""),
        query.unwrap_or(""),
        offset.map_or_else(String::new, |value| value.to_string()),
        limit.map_or_else(String::new, |value| value.to_string())
    )
}

fn acceptance_passed(commands: &[String], records: &[VerificationRecord]) -> bool {
    commands.iter().all(|command| {
        records
            .iter()
            .any(|record| record.command == *command && record.ok)
    })
}

#[derive(Debug, PartialEq, Eq)]
struct PendingFinal {
    summary: String,
    next: Option<String>,
    mutation_epoch: usize,
}

fn take_verified_pending_final(
    pending: &mut Option<PendingFinal>,
    mutation_epoch: usize,
    verified_epoch: Option<usize>,
) -> Option<PendingFinal> {
    let ready = pending.as_ref().is_some_and(|final_action| {
        final_action.mutation_epoch == mutation_epoch && verified_epoch == Some(mutation_epoch)
    });
    ready.then(|| pending.take()).flatten()
}

fn verified_completion_summary(artifacts: &BTreeSet<String>) -> String {
    if artifacts.is_empty() {
        return "Completed and verified the bounded workspace run. HII closed the run after the model repeated while preparing the final summary.".into();
    }
    format!(
        "Completed and verified the bounded workspace run. Artifacts: {}. HII closed the run after the model repeated while preparing the final summary.",
        artifacts.iter().cloned().collect::<Vec<_>>().join(", ")
    )
}

fn repeats_passing_verification(
    tool: &str,
    target: Option<&str>,
    mutation_epoch: usize,
    verified_epoch: Option<usize>,
    records: &[VerificationRecord],
) -> bool {
    matches!(tool, "verify" | "http")
        && verified_epoch == Some(mutation_epoch)
        && target.is_some_and(|target| {
            records
                .iter()
                .any(|record| record.ok && record.command == target)
        })
}

pub(crate) fn parse_action(raw: &str) -> Result<Action, String> {
    let trimmed = raw.trim();
    let candidate = if trimmed.starts_with("```") {
        trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
    } else if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
        &trimmed[start..=end]
    } else {
        trimmed
    };
    let mut value: serde_json::Value = match serde_json::from_str(candidate) {
        Ok(value) => value,
        Err(original_error) => {
            let repaired = escape_literal_control_chars_in_json_strings(candidate);
            serde_json::from_str(&repaired).map_err(|_| original_error.to_string())?
        }
    };
    let action_type = value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    if matches!(
        action_type.as_str(),
        "read"
            | "list"
            | "search"
            | "web_search"
            | "web_fetch"
            | "write"
            | "edit"
            | "shell"
            | "verify"
            | "http"
            | "hii_context"
            | "og_next"
            | "caps_check"
            | "board_read"
            | "board_write"
            | "skill_search"
            | "bridge_send"
            | "bridge_read"
    ) {
        value["type"] = serde_json::Value::String("tool".into());
        value["tool"] = serde_json::Value::String(action_type);
    }
    serde_json::from_value(value).map_err(|error| error.to_string())
}

/// Local models occasionally emit otherwise valid JSON tool actions with
/// literal newlines or tabs inside a large `content` string. JSON requires
/// those control characters to be escaped, so repair only that narrow defect
/// before rejecting the action. Structural JSON errors remain errors.
fn escape_literal_control_chars_in_json_strings(candidate: &str) -> String {
    let mut repaired = String::with_capacity(candidate.len());
    let mut in_string = false;
    let mut escaped = false;

    for character in candidate.chars() {
        if in_string {
            if escaped {
                match character {
                    '\n' => repaired.push('n'),
                    '\r' => repaired.push('r'),
                    '\t' => repaired.push('t'),
                    control if control <= '\u{001f}' => {
                        use std::fmt::Write as _;
                        let _ = write!(repaired, "u{:04x}", control as u32);
                    }
                    _ => repaired.push(character),
                }
                escaped = false;
                continue;
            }
            match character {
                '\\' => {
                    repaired.push(character);
                    escaped = true;
                }
                '"' => {
                    repaired.push(character);
                    in_string = false;
                }
                '\n' => repaired.push_str("\\n"),
                '\r' => repaired.push_str("\\r"),
                '\t' => repaired.push_str("\\t"),
                control if control <= '\u{001f}' => {
                    use std::fmt::Write as _;
                    let _ = write!(repaired, "\\u{:04x}", control as u32);
                }
                _ => repaired.push(character),
            }
        } else {
            repaired.push(character);
            if character == '"' {
                in_string = true;
            }
        }
    }
    repaired
}

/// One decoded tool invocation. Grouping the arguments keeps the dispatcher's
/// signature stable as new tools (edit, ranged read) add parameters, and lets
/// both the run loop and the REPL share one call path.
pub(crate) struct ToolCall<'a> {
    pub tool: &'a str,
    pub path: Option<&'a str>,
    pub query: Option<&'a str>,
    pub command: Option<&'a str>,
    pub content: Option<&'a str>,
    pub url: Option<&'a str>,
    pub old: Option<&'a str>,
    pub new: Option<&'a str>,
    pub replace_all: bool,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    pub allow_delete: bool,
}

pub(crate) fn execute_tool(tools: &Toolbelt, call: ToolCall, dry_run: bool) -> ToolResult {
    let blocked = |what: &str| ToolResult {
        ok: false,
        output: format!("dry run: {what} skipped"),
        verification: false,
    };
    let malformed = |what: &str| ToolResult {
        ok: false,
        output: format!("malformed {what}: a non-empty value is required"),
        verification: false,
    };
    match call.tool {
        "read" => tools.read_range(call.path.unwrap_or(""), call.offset, call.limit),
        "list" => tools.list(call.path),
        "search" => tools.search(call.query.unwrap_or(""), call.path),
        "web_search" => tools.web_search(call.query.unwrap_or("")),
        "web_fetch" if call.url.is_none_or(|url| url.trim().is_empty()) => malformed("url"),
        "web_fetch" => tools.web_fetch(call.url.unwrap_or("")),
        "write" if dry_run => blocked("write"),
        "write" => tools.write(call.path.unwrap_or(""), call.content.unwrap_or("")),
        "edit" if dry_run => blocked("edit"),
        "edit" => tools.edit(
            call.path.unwrap_or(""),
            call.old.unwrap_or(""),
            call.new.unwrap_or(""),
            call.replace_all,
        ),
        "shell" | "verify" if call.command.is_none_or(|command| command.trim().is_empty()) => {
            malformed("command")
        }
        "shell" if dry_run => blocked("shell"),
        "shell" => {
            tools.shell_with_delete_approval(call.command.unwrap_or(""), false, call.allow_delete)
        }
        "verify" => {
            tools.shell_with_delete_approval(call.command.unwrap_or(""), true, call.allow_delete)
        }
        "http" if call.url.is_none_or(|url| url.trim().is_empty()) => malformed("url"),
        "http" => tools.http(call.url.unwrap_or("")),
        other => ToolResult {
            ok: false,
            output: format!("unknown or malformed tool: {other}"),
            verification: false,
        },
    }
}

/// Derive only newly dirty paths between two porcelain snapshots. Direct
/// write/edit targets are added separately, which also catches edits to files
/// that were already dirty before the run.
fn artifact_inventory(before: &str, after: &str) -> Vec<String> {
    let paths = |snapshot: &str| {
        if matches!(snapshot, "clean" | "not a git workspace") {
            return BTreeSet::new();
        }
        snapshot
            .lines()
            .filter_map(|line| line.get(3..).map(str::to_string))
            .collect::<BTreeSet<_>>()
    };
    let before = paths(before);
    paths(after).difference(&before).cloned().collect()
}

/// Apply an authority [`Decision`] to a pending tool action. Returns `Some(msg)`
/// to feed back to the model when the action must not run; `None` to proceed.
/// A `Prompt` decision shows a semantic approval and, on a non-interactive
/// stream, defaults to denial (the operator can re-run with higher authority
/// or `--yolo`).
fn enforce_authority(
    decision: Decision,
    tool: &str,
    reason: &str,
    command: Option<&str>,
    approvals: &mut Vec<String>,
) -> Option<String> {
    match decision {
        Decision::Allow => None,
        Decision::Deny => Some(format!(
            "BLOCKED by authority envelope: `{tool}` ({reason}) is outside the current authority. \
             Choose a read-only or in-workspace step, or the operator must raise authority."
        )),
        Decision::Prompt => {
            let target = command.unwrap_or(tool);
            if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
                return Some(format!(
                    "PAUSED (needs approval, none available non-interactively): {target}. \
                     Proceed only under higher authority or --yolo."
                ));
            }
            println!(
                "\nAPPROVAL NEEDED\n  ACTION   {tool}\n  DETAIL   {target}\n  REASON   {reason}\n  EFFECT   crosses an external / hard-to-reverse boundary"
            );
            print!("  Allow this action? [y/N] ");
            let _ = io::stdout().flush();
            let mut answer = String::new();
            if io::stdin().read_line(&mut answer).is_ok()
                && matches!(answer.trim(), "y" | "Y" | "yes")
            {
                approvals.push(format!("{tool}: {target}"));
                None
            } else {
                Some(format!(
                    "DENIED by operator: {target}. Choose a different step."
                ))
            }
        }
    }
}

pub(crate) fn request_deletion_approval(command: &str) -> bool {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return false;
    }
    println!(
        "\nDELETE APPROVAL NEEDED\n  COMMAND  {command}\n  SCOPE    current workspace only\n  EFFECT   removes files or directories"
    );
    print!("  Allow this deletion? [y/N] ");
    let _ = io::stdout().flush();
    let mut answer = String::new();
    io::stdin().read_line(&mut answer).is_ok() && matches!(answer.trim(), "y" | "Y" | "yes")
}

fn print_receipt(receipt: &Receipt, path: &std::path::Path) {
    println!("\nDone: {}", receipt.summary);
    println!(
        "Verified: {}",
        if receipt.verification.is_empty() {
            "no explicit verification recorded".into()
        } else {
            format!("{} check(s)", receipt.verification.len())
        }
    );
    if let Some(authority) = receipt.authority.as_deref() {
        println!("Authority: {authority}");
    }
    if !receipt.artifacts.is_empty() {
        println!("Changed: {} file(s)", receipt.artifacts.len());
        for artifact in receipt.artifacts.iter().take(10) {
            println!("  {artifact}");
        }
    }
    if !receipt.preexisting_changes.is_empty() {
        println!(
            "Baseline: {} pre-existing change(s) preserved",
            receipt.preexisting_changes.len()
        );
    }
    if !receipt.approvals.is_empty() {
        println!("Approvals: {}", receipt.approvals.join(", "));
    }
    println!("Proof: {}", path.display());
    println!("Risk: {}", receipt.risk);
    println!(
        "Next Command: {}",
        receipt.next.as_deref().unwrap_or("hii proof")
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_workspace() -> PathBuf {
        static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        let serial = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("hii-run-output-{}-{nonce}-{serial}", process::id()));
        fs::create_dir_all(&path).expect("create temporary workspace");
        path.canonicalize().expect("canonicalize workspace")
    }

    #[test]
    fn parses_json_action() {
        let action = parse_action(r#"{"type":"tool","tool":"list","reason":"inspect"}"#).unwrap();
        assert!(matches!(action, Action::Tool { tool, .. } if tool == "list"));
    }

    #[test]
    fn parses_flat_local_model_action() {
        let action =
            parse_action(r#"{"type":"write","path":"hello.txt","content":"hello\n"}"#).unwrap();
        assert!(matches!(action, Action::Tool { tool, .. } if tool == "write"));
    }

    #[test]
    fn repairs_literal_newlines_in_local_model_write_content() {
        let action = parse_action(
            "{\"type\":\"write\",\"path\":\"public/index.html\",\"content\":\"<h1>\nhello</h1>\"}",
        )
        .unwrap();
        assert!(matches!(
            action,
            Action::Tool {
                tool,
                content: Some(content),
                ..
            } if tool == "write" && content == "<h1>\nhello</h1>"
        ));
    }

    #[test]
    fn repairs_backslash_before_literal_newline_in_write_content() {
        let action = parse_action(
            "{\"type\":\"write\",\"path\":\"public/index.html\",\"content\":\"first\\\nsecond\"}",
        )
        .unwrap();
        assert!(matches!(
            action,
            Action::Tool {
                tool,
                content: Some(content),
                ..
            } if tool == "write" && content == "first\nsecond"
        ));
    }

    #[test]
    fn parses_fenced_action() {
        let action = parse_action(
            "```json\n{\"type\":\"final\",\"summary\":\"done\",\"verification\":[]}\n```",
        )
        .unwrap();
        assert!(matches!(action, Action::Final { summary, .. } if summary == "done"));
    }

    #[test]
    fn agent_prompt_stays_lean() {
        let prompt = system_prompt(
            std::path::Path::new("/workspace"),
            12,
            false,
            "the focused tests pass",
            &[],
        );
        assert!(
            prompt.len() <= 1_000,
            "agent prompt grew to {} bytes",
            prompt.len()
        );
    }

    #[test]
    fn agent_prompt_makes_receipt_verification_explicit() {
        let prompt = system_prompt(
            std::path::Path::new("/workspace"),
            8,
            false,
            "verified",
            &[],
        );
        assert!(prompt.contains("Proof MUST be one flat"));
        assert!(prompt.contains("shell/read/list/search and nested checks never count"));
        assert!(prompt.contains(r#"{"type":"verify","command":"npm test"}"#));
    }

    #[test]
    fn empty_verification_commands_cannot_become_proof() {
        let tools = Toolbelt::new(std::env::temp_dir()).unwrap();
        let result = execute_tool(
            &tools,
            ToolCall {
                tool: "verify",
                path: None,
                query: None,
                command: None,
                content: None,
                url: None,
                old: None,
                new: None,
                replace_all: false,
                offset: None,
                limit: None,
                allow_delete: false,
            },
            false,
        );
        assert!(!result.ok);
        assert!(!result.verification);
        assert!(result.output.contains("non-empty"));
    }

    #[test]
    fn zero_steps_means_no_agent_ceiling() {
        let prompt = system_prompt(
            std::path::Path::new("/workspace"),
            0,
            false,
            "verified",
            &[],
        );
        assert!(prompt.contains("No tool-step ceiling"));
        assert!(!prompt.contains("Operator ceiling:"));
    }

    #[test]
    fn three_identical_rejected_actions_trigger_loop_recovery() {
        let mut guard = RejectedActionGuard::default();
        let action = r#"{"type":"final","summary":"done"}"#;

        assert!(!guard.would_loop(action, 1, None));
        guard.reject(action, 1, None);
        assert!(!guard.would_loop(action, 1, None));
        guard.reject(action, 1, None);
        assert!(guard.would_loop(action, 1, None));
    }

    #[test]
    fn rejected_action_guard_resets_when_action_or_state_changes() {
        let mut guard = RejectedActionGuard::default();
        guard.reject("same action", 1, None);
        guard.reject("same   action", 1, None);
        assert!(guard.would_loop("same action", 1, None));
        assert!(!guard.would_loop("different action", 1, None));
        assert!(!guard.would_loop("same action", 2, None));

        guard.reset();
        assert!(!guard.would_loop("same action", 1, None));
    }

    #[test]
    fn declared_verification_rejects_external_actions() {
        let commands = vec!["git push origin main".to_string()];
        assert!(validate_declared_verification(&commands).is_err());
    }

    #[test]
    fn every_declared_acceptance_check_must_pass() {
        let commands = vec!["cargo test".to_string(), "cargo clippy".to_string()];
        let records = vec![VerificationRecord {
            command: "cargo test".into(),
            ok: true,
            output: "ok".into(),
        }];
        assert!(!acceptance_passed(&commands, &records));
    }

    #[test]
    fn pending_final_completes_only_after_same_epoch_proof() {
        let mut pending = Some(PendingFinal {
            summary: "artifact ready".into(),
            next: None,
            mutation_epoch: 2,
        });

        assert!(take_verified_pending_final(&mut pending, 2, None).is_none());
        assert!(take_verified_pending_final(&mut pending, 3, Some(3)).is_none());
        assert_eq!(
            take_verified_pending_final(&mut pending, 2, Some(2)),
            Some(PendingFinal {
                summary: "artifact ready".into(),
                next: None,
                mutation_epoch: 2,
            })
        );
        assert!(pending.is_none());
    }

    #[test]
    fn verified_loop_recovery_summary_names_receipt_artifacts() {
        let artifacts = BTreeSet::from([
            "docs/launch/launch-storyboard.md".to_string(),
            "docs/launch/other.md".to_string(),
        ]);
        let summary = verified_completion_summary(&artifacts);

        assert!(summary.contains("Completed and verified"));
        assert!(summary.contains("docs/launch/launch-storyboard.md"));
        assert!(summary.contains("model repeated while preparing the final summary"));
    }

    #[test]
    fn repeated_passing_verification_is_a_completion_signal() {
        let records = vec![VerificationRecord {
            command: "npm test".into(),
            ok: true,
            output: "passed".into(),
        }];

        assert!(repeats_passing_verification(
            "verify",
            Some("npm test"),
            2,
            Some(2),
            &records
        ));
        assert!(!repeats_passing_verification(
            "verify",
            Some("npm test"),
            3,
            Some(2),
            &records
        ));
        assert!(!repeats_passing_verification(
            "verify",
            Some("npm run check"),
            2,
            Some(2),
            &records
        ));
    }

    #[test]
    fn preview_commands_do_not_create_a_workspace_mutation_epoch() {
        assert!(!shell_command_changes_workspace("open public/index.html"));
        assert!(!shell_command_changes_workspace("npm run build"));
        assert!(shell_command_changes_workspace("cp a.txt b.txt"));
    }

    #[test]
    fn repeated_observations_change_signature_after_mutation() {
        let first = observation_signature(1, "read", Some("site.html"), None, None, None);
        let repeated = observation_signature(1, "read", Some("site.html"), None, None, None);
        let after_write = observation_signature(2, "read", Some("site.html"), None, None, None);
        assert_eq!(first, repeated);
        assert_ne!(first, after_write);
    }

    #[test]
    fn artifacts_exclude_preexisting_dirty_files() {
        let before = " M existing.rs\n?? old.txt";
        let after = " M existing.rs\n?? old.txt\n?? new.txt";
        assert_eq!(artifact_inventory(before, after), vec!["new.txt"]);
    }

    #[test]
    fn jsonl_events_have_a_stable_envelope() {
        let event = jsonl_event("tool.started", json!({ "tool": "read" }));
        assert_eq!(event["schemaVersion"], 1);
        assert_eq!(event["event"], "tool.started");
        assert_eq!(event["data"]["tool"], "read");
        assert!(event["atUnixMs"].as_u64().is_some());
    }

    #[test]
    fn last_message_paths_are_bounded_to_the_workspace() {
        let workspace = temp_workspace();
        let nested = resolve_last_message_path(&workspace, Path::new("output/final.txt"))
            .expect("relative path should resolve");
        assert_eq!(nested, workspace.join("output/final.txt"));
        assert!(resolve_last_message_path(&workspace, Path::new("../escape.txt")).is_err());
        assert!(resolve_last_message_path(&workspace, Path::new("/tmp/escape.txt")).is_err());
        assert_eq!(
            resolve_last_message_path(&workspace, &workspace.join("inside.txt"))
                .expect("absolute in-workspace path should resolve"),
            workspace.join("inside.txt")
        );
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
    }

    #[cfg(unix)]
    #[test]
    fn last_message_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let workspace = temp_workspace();
        let outside = temp_workspace();
        symlink(&outside, workspace.join("outside")).expect("create escape symlink");
        assert!(resolve_last_message_path(&workspace, Path::new("outside/final.txt")).is_err());
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
        fs::remove_dir_all(outside).expect("remove outside directory");
    }
}
