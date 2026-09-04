use crate::{
    budget::{BudgetKind, Budgets, Cancel, CancelReason, Deadline},
    clock::unix_ms,
    config::{AppPaths, ModelProvider},
    contract::{deletion_shell, sensitive_shell, Authority, Contract, Decision},
    hooks::{HookBatch, HookEvent, HookRunner},
    mcp_client::McpClients,
    ollama::{ChatResult, ChatStreamEvent, Message, Ollama},
    receipt::{
        classify_error, record_verification, redact_text, HookRecord, Outcome, Receipt, RunGuard,
        RunStore, TokenUsageRecord, VerificationRecord,
    },
    runlog::{Delta, Event, Feedback, Human, Journal, OutputMode, StreamPolicy},
    tools::{ToolResult, Toolbelt},
};
use hii_core::adaptive::InteractionProposalV1;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs,
    io::{self, IsTerminal, Write},
    path::{Component, Path, PathBuf},
    sync::mpsc,
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

const TRANSIENT_PROVIDER_RETRIES: usize = 2;
const TRANSIENT_PROVIDER_RETRY_DELAY: Duration = Duration::from_millis(200);

/// The process-wide cancellation signal driven by Ctrl-C.
///
/// A run clones this so the loop, the budget checks, and the provider's
/// streaming thread all observe one decision. It used to be a bare bool checked
/// only between steps, which meant Ctrl-C could not stop a generation already in
/// flight.
fn interrupt_signal() -> &'static Cancel {
    static SIGNAL: OnceLock<Cancel> = OnceLock::new();
    SIGNAL.get_or_init(Cancel::new)
}

/// Install the interrupt handler once per process. Idempotent and best-effort:
/// if the host already owns the signal, the run simply won't be interruptible.
fn arm_interrupt() {
    static ARMED: OnceLock<()> = OnceLock::new();
    ARMED.get_or_init(|| {
        let _ = ctrlc::set_handler(|| interrupt_signal().cancel(CancelReason::Interrupt));
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
    /// Declared before execution. `None` keeps informational-task behavior, so
    /// every contract written before this existed still means what it meant.
    pub outcome_requirements: Option<crate::contract::OutcomeRequirements>,
    pub use_context: bool,
    /// Explicit, source-labelled context supplied by a trusted invocation
    /// surface (for example HII Bar's frontmost-app observer). These are
    /// recorded even when the run exits before model execution completes.
    pub context_sources: Vec<String>,
    pub output: RunOutput,
    pub stream: StreamPolicy,
    pub budgets: Budgets,
    /// Proceed past a declared check whose program is missing, so the model can
    /// report the blocker itself instead of the run refusing to start.
    pub allow_missing_verify_deps: bool,
    pub last_message: Option<PathBuf>,
    pub hooks: bool,
    pub coding: bool,
    /// Reviewed skills explicitly selected for this run. Loading is fail-closed,
    /// and each id is attributed to the receipt before the first model call.
    pub skill_ids: Vec<String>,
    pub autonomy_level: AutonomyLevel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunOutput {
    Human,
    Json,
    Jsonl,
    Quiet,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutonomyLevel {
    Approval,
    LocalFull,
}

const MAX_INVOCATION_CONTEXT_SOURCES: usize = 32;
const MAX_INVOCATION_CONTEXT_SOURCE_CHARS: usize = 1_024;

fn bounded_context_sources(sources: &[String]) -> Vec<String> {
    let mut bounded = Vec::new();
    for source in sources.iter().take(MAX_INVOCATION_CONTEXT_SOURCES) {
        let source = redact_text(source.trim());
        if source.is_empty() {
            continue;
        }
        let source = source
            .chars()
            .take(MAX_INVOCATION_CONTEXT_SOURCE_CHARS)
            .collect::<String>();
        if !bounded.contains(&source) {
            bounded.push(source);
        }
    }
    bounded
}

impl AutonomyLevel {
    pub fn label(self) -> &'static str {
        match self {
            AutonomyLevel::Approval => "approval",
            AutonomyLevel::LocalFull => "local-full",
        }
    }
}

impl RunOutput {
    fn mode(self, verbose: bool) -> OutputMode {
        match self {
            RunOutput::Human => OutputMode::Human { verbose },
            RunOutput::Json => OutputMode::Json,
            RunOutput::Jsonl => OutputMode::Jsonl,
            RunOutput::Quiet => OutputMode::Quiet,
        }
    }
}

/// Hand journaled text to the model.
///
/// Taking [`Feedback`] rather than a bare `String` is the point: the only way to
/// obtain one is [`Journal::feedback`], so a message cannot reach the model
/// without having been recorded first.
fn push_feedback(messages: &mut Vec<Message>, feedback: Feedback) {
    messages.push(Message::user(feedback.into_inner()));
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Action {
    Tool {
        #[serde(default)]
        flow: Option<FlowProjection>,
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
        #[serde(default)]
        flow: Option<FlowProjection>,
        summary: String,
        #[serde(default)]
        verification: Vec<String>,
        next: Option<String>,
    },
    Message {
        #[serde(default)]
        flow: Option<FlowProjection>,
        message: String,
    },
    McpCall {
        #[serde(default)]
        flow: Option<FlowProjection>,
        server: String,
        tool: String,
        #[serde(default)]
        arguments: Value,
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlowProjection {
    pub title: String,
    pub goal: String,
    pub current: String,
    #[serde(default)]
    pub direction: Vec<String>,
    pub next: String,
}

impl Action {
    /// The same choice, in the durable interaction vocabulary.
    ///
    /// [`Action`] and `InteractionProposalV1` describe one thing — the model
    /// proposes to talk, to use a capability, to ask, or to finish — and were
    /// written twice. Converting rather than adding a third model is what lets
    /// a conversation turn be recorded against an objective thread.
    ///
    /// `Ask` has no counterpart here: this action surface has no way to pause
    /// for an answer, so a question arrives as a `Message` and reads as
    /// `Respond`. Closing that gap is a change to the loop, not to this map.
    pub(crate) fn as_proposal(&self) -> InteractionProposalV1 {
        match self {
            Self::Message { message, .. } => InteractionProposalV1::Respond {
                text: message.clone(),
            },
            Self::Final { summary, .. } => InteractionProposalV1::Finish {
                summary: summary.clone(),
            },
            Self::Tool {
                tool,
                path,
                query,
                command,
                content,
                url,
                ..
            } => InteractionProposalV1::Capability {
                phase: capability_phase(tool).into(),
                capability_id: tool.clone(),
                input: json!({
                    "path": path,
                    "query": query,
                    "command": command,
                    "content": content,
                    "url": url,
                }),
            },
            Self::McpCall {
                server,
                tool,
                arguments,
                ..
            } => InteractionProposalV1::Capability {
                phase: "act".into(),
                capability_id: format!("mcp:{server}:{tool}"),
                input: arguments.clone(),
            },
        }
    }

    pub(crate) fn flow(&self) -> Option<&FlowProjection> {
        match self {
            Self::Tool { flow, .. }
            | Self::Final { flow, .. }
            | Self::Message { flow, .. }
            | Self::McpCall { flow, .. } => flow.as_ref(),
        }
    }
}

/// Which phase of an interaction a tool belongs to.
///
/// Mirrors the observation/mutation split the loop already enforces: `verify`
/// is the only action that can produce proof, reads never change anything, and
/// everything else is a mutation.
fn capability_phase(tool: &str) -> &'static str {
    match tool {
        "verify" => "verify",
        "read" | "list" | "search" | "web_search" | "web_fetch" => "observe",
        other if crate::hii_tools::is_hii_tool(other) && !crate::hii_tools::is_mutating(other) => {
            "observe"
        }
        _ => "act",
    }
}

pub(crate) const MODEL_LOOP_DETECTED_MESSAGE: &str =
    "MODEL LOOP DETECTED — HII stopped the repeated rejected action and preserved the session. Revise or steer the request; completed workspace changes remain in place.";
const ADAPTIVE_REASONING_BUDGET_RETRY: &str = "adaptive reasoning budget ended";
const ADAPTIVE_REASONING_MAX_CHARS: usize = 4_096;
const ADAPTIVE_REASONING_MAX_TIME: Duration = Duration::from_secs(12);

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

/// Stops semantically identical tool failures even when the model disguises
/// the retry by changing a query, URL, or surrounding JSON. The action-text
/// guard cannot catch that class of loop.
#[derive(Debug, Default)]
pub(crate) struct RepeatedToolFailureGuard {
    mutation_epoch: usize,
    counts: HashMap<String, usize>,
}

impl RepeatedToolFailureGuard {
    pub(crate) fn record(
        &mut self,
        tool: &str,
        output: &str,
        mutation_epoch: usize,
    ) -> Option<(String, usize)> {
        if self.mutation_epoch != mutation_epoch {
            self.mutation_epoch = mutation_epoch;
            self.counts.clear();
        }
        let signature = tool_failure_signature(tool, output)?;
        let count = self.counts.entry(signature.clone()).or_insert(0);
        *count += 1;
        (*count >= 2).then(|| (signature, *count))
    }
}

fn tool_failure_signature(tool: &str, output: &str) -> Option<String> {
    let first_line = output
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("unknown tool failure")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    let repeatable_class = first_line.starts_with("native_webview_required")
        || first_line.starts_with("web fetch returned http ")
        || first_line.starts_with("web fetch failed:")
        || first_line.starts_with("blocked destructive shell pattern:")
        || first_line.starts_with("missing_dependency:")
        || first_line.starts_with("hook_blocked:")
        || first_line.starts_with("blocked:");
    repeatable_class.then(|| format!("{}:{first_line}", tool.to_ascii_lowercase()))
}

#[derive(Debug, Default)]
struct MissingProofGuard {
    last_state: Option<(usize, Option<usize>)>,
}

impl MissingProofGuard {
    fn repeated_without_progress(
        &mut self,
        mutation_epoch: usize,
        verified_epoch: Option<usize>,
    ) -> bool {
        let state = (mutation_epoch, verified_epoch);
        if self.last_state == Some(state) {
            true
        } else {
            self.last_state = Some(state);
            false
        }
    }
}

fn normalized_action(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn route_public_http(tool: String, url: Option<&str>) -> (String, bool) {
    let public_url = url.is_some_and(|url| {
        let lowered = url.trim().to_ascii_lowercase();
        let loopback = [
            "http://127.0.0.1:",
            "https://127.0.0.1:",
            "http://localhost:",
            "https://localhost:",
            "http://[::1]:",
            "https://[::1]:",
        ]
        .iter()
        .any(|prefix| lowered.starts_with(prefix));
        (lowered.starts_with("http://") || lowered.starts_with("https://")) && !loopback
    });
    if tool == "http" && public_url {
        ("web_fetch".into(), true)
    } else {
        (tool, false)
    }
}

fn final_requires_model_verification(
    declared_verification: bool,
    mutation_epoch: usize,
    verified_epoch: Option<usize>,
) -> bool {
    !declared_verification && mutation_epoch > 0 && verified_epoch != Some(mutation_epoch)
}

fn counts_as_read_only_source_evidence(authority: Authority, tool: &str, ok: bool) -> bool {
    ok && authority == Authority::ReadOnly && matches!(tool, "web_search" | "web_fetch")
}

pub fn run(paths: &AppPaths, options: RunOptions) -> Result<Receipt, String> {
    if options.goal.trim().is_empty() {
        return Err("goal cannot be empty".into());
    }
    validate_declared_verification(&options.verify, None)?;
    let declaration = if options.verify.is_empty() {
        None
    } else {
        Some(crate::declaration::Declaration::register(
            &options.verify,
            crate::run_context::WriteOrigin::Operator,
        )?)
    };
    let loaded_skills = options
        .skill_ids
        .iter()
        .map(|id| crate::skill_runtime::load(paths, id))
        .collect::<Result<Vec<_>, _>>()?;

    let tools = Toolbelt::new(options.workspace)?;
    if !options.allow_missing_verify_deps {
        validate_declared_verification(&options.verify, Some(tools.workspace()))?;
    }
    let mcp_clients = McpClients::load(&paths.runtime, tools.workspace())?;
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
    let ollama = Ollama::discover().ensure_reachable()?;
    let models = ollama.models()?;
    let saved_model = if options.model.is_none() {
        paths
            .user_model_preference()?
            .map(|preference| preference.model)
    } else {
        None
    };
    let model_source = if options.model.is_some() {
        "explicit"
    } else if saved_model.is_some() {
        "saved-user"
    } else if std::env::var_os("HII_MODEL").is_some() {
        "env"
    } else {
        "provider-default"
    }
    .to_string();
    let model = choose_model(
        options.model.as_deref().or(saved_model.as_deref()),
        ollama.provider(),
        &models,
    )?;
    let review_model = if options.review {
        Some(choose_review_model(
            options.review_model.as_deref(),
            ollama.provider(),
            &models,
        )?)
    } else {
        None
    };
    let invocation_context_sources = bounded_context_sources(&options.context_sources);
    let store = RunStore::create(&paths.runtime)?;
    crate::run_context::set_origin(crate::run_context::WriteOrigin::Operator);
    let run_id = store.id.clone();
    let started_at = store.started_at_unix_ms;
    let run_dir = store.dir.clone();
    // Claim the receipt before the first model call. Every later exit path —
    // including `?` and the provider errors that used to return with nothing
    // written — now leaves a receipt and a pointer that names this run.
    let mut guard = RunGuard::start(
        &paths.runtime,
        &run_dir,
        &run_id,
        draft_receipt(
            &run_id,
            started_at,
            &options.goal,
            options.authority,
            options.done_when.as_deref(),
            tools.workspace(),
            &model,
            &model_source,
            options.autonomy_level,
            &invocation_context_sources,
        ),
    )?;
    let mut journal = Journal::new(store, options.output.mode(options.verbose), options.stream);
    for skill in &loaded_skills {
        crate::skill_lifecycle::record_invocation(paths, &skill.id, Some(&run_id))?;
    }
    let preflight = crate::pipe::compile_for(
        paths,
        &options.goal,
        "hii.agent.workspace_run",
        options.authority,
    );
    journal.emit(Event::new("pipe.preflight").data(json!({
        "status": preflight.status,
        "capability": preflight.capability.capability_id,
        "adapter": preflight.capability.adapter,
        "authority_decision": preflight.capability.authority_decision,
        "proof_required": preflight.proof_required,
        "skills": loaded_skills.iter().map(|skill| skill.id.as_str()).collect::<Vec<_>>()
    })))?;
    journal.emit(Event::new("run.started").data(json!({
        "run_id": &run_id,
        "goal": redact_text(&options.goal),
        "workspace": tools.workspace(),
        "model": &model,
        "provider": ollama.provider().id(),
        "provider_label": ollama.provider_label(),
        "endpoint": ollama.base_url(),
        "model_source": &model_source,
        "coding": options.coding,
        "autonomy_level": options.autonomy_level.label(),
        "authority": options.authority.label(),
        "max_steps": options.max_steps,
        "dry_run": options.dry_run,
        "skills": loaded_skills.iter().map(|skill| skill.id.as_str()).collect::<Vec<_>>()
    })))?;
    let mut hook_records: Vec<HookRecord> = Vec::new();
    let session_hooks = hooks.fire(
        HookEvent::SessionStart,
        None,
        &run_id,
        json!({
            "goal": redact_text(&options.goal),
            "authority": options.authority.label()
        }),
    );
    persist_hook_batch(&mut journal, &session_hooks)?;
    let session_hook_mutation = session_hooks.mutated_workspace();
    hook_records.extend(session_hooks.records);
    let prompt_hooks = hooks.fire(
        HookEvent::UserPrompt,
        None,
        &run_id,
        json!({ "prompt": redact_text(&options.goal) }),
    );
    persist_hook_batch(&mut journal, &prompt_hooks)?;
    let prompt_block = prompt_hooks.block_reason.clone();
    hook_records.extend(prompt_hooks.records);
    if let Some(reason) = prompt_block {
        journal.emit(Event::new("run.blocked").data(json!({ "reason": redact_text(&reason) })))?;
        return Err(format!("Prompt blocked by lifecycle policy: {reason}"));
    }

    let contract = Contract::infer(&options.goal, options.authority)
        .with_done_when(options.done_when.as_deref())
        .with_outcome_requirements(options.outcome_requirements.clone());
    let mut capsule = if options.use_context {
        crate::context::ContextCapsule::build(&paths.runtime, tools.workspace())
    } else {
        crate::context::ContextCapsule::default()
    };
    for source in &invocation_context_sources {
        if !capsule.sources.contains(source) {
            capsule.sources.push(source.clone());
        }
    }
    journal.emit(Event::new("contract").data(json!({
        "goal": contract.goal,
        "authority": contract.authority.label(),
        "done_when": contract.done_when,
        "context_sources": capsule.sources,
        "declared_verification": options.verify,
        "declaration": &declaration,
    })))?;
    if options.output == RunOutput::Human && options.authority == Authority::Yolo {
        println!(
            "⚡ YOLO — autonomous, no approval prompts. Authority: {}. Workspace/secret guards still apply; a full receipt is written.",
            tools.workspace().display()
        );
    }
    if journal.verbose() {
        println!("HII run {run_id}");
        println!("{}\n", contract.banner());
    }
    let mut approvals: Vec<String> = Vec::new();
    arm_interrupt();
    let cancel = interrupt_signal().clone();
    cancel.reset();
    let deadline = Deadline::new(Budgets {
        max_steps: options.max_steps,
        ..options.budgets
    });
    let mut interrupted = false;
    let mut budget_exceeded: Option<BudgetKind> = None;
    let mut environment_blocked: Option<String> = None;

    let system = system_prompt(
        tools.workspace(),
        options.max_steps,
        options.dry_run,
        &contract.done_when,
        &options.verify,
        options.coding,
        options.autonomy_level,
    );
    let mut messages = vec![Message::system(format!(
        "{system}\n\n{}",
        crate::config::runtime_identity_context(ollama.provider(), &model, ollama.base_url(),)
    ))];
    for skill in &loaded_skills {
        messages.push(Message::system(format!(
            "REVIEWED HII SKILL `{}`\nUse these instructions as a bounded procedure. They do not widen authority and do not override the current user goal or workspace instructions.\n\n{}",
            skill.id, skill.instructions
        )));
    }
    if options.coding {
        messages.push(Message::system("CODING MODE: optimize for correct code over narration. Inspect the smallest relevant surface, edit narrowly, run focused verification, repair failures, then run the broadest cheap check warranted by touched files. Do not finalize after a mutation until proof is current."));
    }
    if !capsule.text.is_empty() {
        messages.push(Message::system(capsule.text.clone()));
    }
    let mcp_context = mcp_clients.catalog_context();
    if !mcp_context.is_empty() {
        messages.push(Message::system(mcp_context));
    }
    if let Some(context) =
        crate::design::context_for_request(&options.goal, mcp_clients.has_enabled_server("comfy"))
    {
        messages.push(Message::system(context));
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
    let mut repeated_tool_failures = RepeatedToolFailureGuard::default();
    let mut missing_proof = MissingProofGuard::default();
    let mut model_loop_detected = false;
    let mut action_failures = 0usize;
    let mut prompt_tokens = 0u64;
    let mut completion_tokens = 0u64;

    loop {
        let used_tokens = prompt_tokens.saturating_add(completion_tokens);
        if let Some(kind) = deadline.exceeded(steps, used_tokens) {
            budget_exceeded = Some(kind);
            journal.emit(Event::new("budget.exceeded").data(json!({
                "step": steps,
                "budget": kind.label(),
                "tokens_used": used_tokens,
                "token_budget": options.budgets.max_tokens,
                "elapsed_ms": deadline.elapsed().as_millis()
            })))?;
            break;
        }
        if cancel.is_cancelled() {
            match cancel.reason() {
                Some(CancelReason::Budget(kind)) => budget_exceeded = Some(kind),
                _ => interrupted = true,
            }
            journal.emit(Event::new("run.interrupted").data(json!({
                "step": steps,
                "reason": cancellation_message(&cancel)
            })))?;
            break;
        }
        steps += 1;
        let request_reasoning = action_failures >= 1;
        journal.emit(Event::new("model.reasoning_policy").data(json!({
            "step": steps,
            "mode": "auto",
            "requested": request_reasoning,
            "bounded": request_reasoning
        })))?;
        let result = match stream_model_json_with_retries(
            &ollama,
            &model,
            &messages,
            ModelStreamPolicy {
                step: steps,
                think: request_reasoning,
                relaxed_json: false,
            },
            &mut journal,
            &deadline,
            &cancel,
        ) {
            Ok(result) => result,
            Err(error) if error == ADAPTIVE_REASONING_BUDGET_RETRY => {
                cancel.reset();
                action_failures = 0;
                journal.emit(Event::new("model.reasoning_budget_exceeded").data(json!({
                    "step": steps,
                    "max_chars": ADAPTIVE_REASONING_MAX_CHARS,
                    "max_ms": ADAPTIVE_REASONING_MAX_TIME.as_millis()
                })))?;
                messages.push(Message::user(
                    "Reasoning budget ended. Emit the smallest safe relevant JSON action now. Do not narrate the plan.",
                ));
                steps = steps.saturating_sub(1);
                continue;
            }
            Err(error)
                if error.contains("MODEL LOOP DETECTED")
                    && mutation_epoch > 0
                    && verified_epoch == Some(mutation_epoch)
                    && verification.iter().any(|check| check.ok) =>
            {
                journal.emit(
                    Event::new("convergence.verified_loop_recovered").data(json!({
                        "step": steps,
                        "mutation_epoch": mutation_epoch,
                        "reason": "model repeated while preparing the final response"
                    })),
                )?;
                final_summary = Some(verified_completion_summary(&touched_artifacts));
                final_next = None;
                break;
            }
            Err(error) if cancel.is_cancelled() => {
                if matches!(
                    cancel.reason(),
                    Some(CancelReason::Budget(
                        BudgetKind::ModelCall | BudgetKind::StreamIdle
                    ))
                ) && mutation_epoch > 0
                    && verified_epoch == Some(mutation_epoch)
                    && verification.iter().any(|check| check.ok)
                {
                    journal.emit(Event::new("convergence.verified_timeout_recovered").data(
                        json!({
                            "step": steps,
                            "mutation_epoch": mutation_epoch,
                            "reason": cancellation_message(&cancel)
                        }),
                    ))?;
                    final_summary = Some(verified_completion_summary(&touched_artifacts));
                    final_next = None;
                    break;
                }
                match cancel.reason() {
                    Some(CancelReason::Budget(kind)) => budget_exceeded = Some(kind),
                    _ => interrupted = true,
                }
                journal.emit(Event::new("run.interrupted").data(json!({
                    "step": steps,
                    "reason": redact_text(&error)
                })))?;
                break;
            }
            Err(error) => {
                guard.record_error(classify_error(&error), &error);
                return Err(error);
            }
        };
        prompt_tokens = prompt_tokens.saturating_add(result.usage.prompt_tokens);
        completion_tokens = completion_tokens.saturating_add(result.usage.completion_tokens);
        journal.emit(Event::new("model.usage").data(json!({
            "step": steps,
            "prompt_tokens": result.usage.prompt_tokens,
            "completion_tokens": result.usage.completion_tokens,
            "total_prompt_tokens": prompt_tokens,
            "total_completion_tokens": completion_tokens,
            "token_budget": options.budgets.max_tokens,
            "remaining_tokens": (options.budgets.max_tokens > 0).then(|| options.budgets.max_tokens.saturating_sub(prompt_tokens.saturating_add(completion_tokens)))
        })))?;
        let raw = result.content;
        journal.emit(
            Event::new("model.response")
                .data(json!({ "step": steps, "content": redact_text(&raw) })),
        )?;
        if rejected_actions.would_loop(&raw, mutation_epoch, verified_epoch) {
            model_loop_detected = true;
            journal.emit(
                Event::new("model.loop_detected")
                    .data(json!({
                        "step": steps,
                        "reason": "identical rejected action repeated three times",
                        "message": MODEL_LOOP_DETECTED_MESSAGE
                    }))
                    .human(Human::Recovery(MODEL_LOOP_DETECTED_MESSAGE.into())),
            )?;
            break;
        }
        let rejected_raw = raw.clone();
        // An empty completion is reported on its own rather than as a parse
        // failure, so a silent model is distinguishable from a malformed one in
        // the log. Both are steered back to the protocol the same way.
        let action = match parse_action(&raw) {
            Ok(action) => action,
            Err(error) => {
                action_failures += 1;
                let kind = if raw.trim().is_empty() {
                    "model.empty_response"
                } else {
                    "protocol.retry"
                };
                let feedback = journal.feedback(
                    Event::new(kind)
                        .data(json!({ "step": steps, "error": &error }))
                        .human(Human::Line(format!(
                            "[step {steps}] protocol retry: {error}"
                        ))),
                    format!(
                        "Protocol error: {error}. Return one JSON object matching the required action schema."
                    ),
                )?;
                messages.push(Message::assistant(raw));
                push_feedback(&mut messages, feedback);
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
                ..
            } => {
                let (tool, rerouted_public_http) = route_public_http(tool, url.as_deref());
                if repeats_passing_verification(
                    &tool,
                    command.as_deref().or(url.as_deref()),
                    mutation_epoch,
                    verified_epoch,
                    &verification,
                ) {
                    journal.emit(
                        Event::new("convergence.repeated_verification_completed").data(
                            json!({ "step": steps, "tool": tool, "mutation_epoch": mutation_epoch }),
                        ),
                    )?;
                    final_summary = Some(verified_completion_summary(&touched_artifacts));
                    final_next = None;
                    break;
                }
                let label = reason.as_deref().unwrap_or("using workspace tool");
                journal.emit(
                    Event::new("tool.started")
                        .data(json!({ "step": steps, "tool": &tool, "target": label }))
                        .human(Human::ToolStart {
                            step: steps,
                            tool: tool.clone(),
                            target: label.to_string(),
                        }),
                )?;
                // A verification whose program is missing is an environment
                // problem. Executing it would surface as a plain failure, and
                // three of those drive the repair loop into rewriting code that
                // was never wrong.
                if matches!(tool.as_str(), "verify" | "shell") {
                    if let Some(missing) = command.as_deref().and_then(|command| {
                        crate::tools::preflight_command(command, tools.workspace()).err()
                    }) {
                        let feedback = journal.feedback(
                            Event::new("verification.missing_dependency").data(json!({
                                "step": steps,
                                "program": &missing.program,
                                "command": &missing.command
                            })),
                            format!(
                                "MISSING_DEPENDENCY: '{}' is not installed or not on PATH, so `{}` cannot run. This is an environment problem, not a code problem — do not edit code to work around it. Use a check that relies on an available tool, or return final describing the blocker.",
                                missing.program, missing.command
                            ),
                        )?;
                        environment_blocked.get_or_insert_with(|| missing.program.clone());
                        messages.push(Message::assistant(raw));
                        push_feedback(&mut messages, feedback);
                        rejected_actions.reject(&rejected_raw, mutation_epoch, verified_epoch);
                        continue;
                    }
                }
                // Captured before `command` is consumed by the verification record.
                let check_label = command.clone().unwrap_or_else(|| tool.clone());
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
                    let feedback = journal.feedback(
                        Event::new("convergence.repeated_action").data(
                            json!({ "step": steps, "tool": tool, "mutation_epoch": mutation_epoch }),
                        ),
                        "REPEATED_ACTION: this exact observation already ran after the latest workspace change. Do not repeat read/list/search. Run one actual verify or http acceptance check next, then return final if it passes.",
                    )?;
                    messages.push(Message::assistant(raw));
                    push_feedback(&mut messages, feedback);
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
                    let feedback = journal.feedback(
                        Event::new("authority.block").data(
                            json!({ "step": steps, "tool": tool, "decision": format!("{decision:?}") }),
                        ),
                        blocked,
                    )?;
                    messages.push(Message::assistant(raw));
                    push_feedback(&mut messages, feedback);
                    rejected_actions.reject(&rejected_raw, mutation_epoch, verified_epoch);
                    continue;
                }
                let pre_hooks = hooks.fire(
                    HookEvent::PreTool,
                    Some(&tool),
                    &run_id,
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
                persist_hook_batch(&mut journal, &pre_hooks)?;
                let hook_block = pre_hooks.block_reason.clone();
                hook_records.extend(pre_hooks.records);
                if let Some(blocked) = hook_block {
                    let feedback = journal.feedback(
                        Event::new("hook.block").data(
                            json!({ "step": steps, "tool": tool, "reason": redact_text(&blocked) }),
                        ),
                        format!("HOOK_BLOCKED: {blocked}. Choose a compliant alternative."),
                    )?;
                    messages.push(Message::assistant(raw));
                    push_feedback(&mut messages, feedback);
                    rejected_actions.reject(&rejected_raw, mutation_epoch, verified_epoch);
                    continue;
                }
                let result = if is_hii {
                    let args = json!({ "query": query.as_deref().unwrap_or("") });
                    crate::hii_tools::execute(&paths.repo, &tool, Some(&args))
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
                let repeated_failure = (!result.ok)
                    .then(|| repeated_tool_failures.record(&tool, &safe_output, mutation_epoch))
                    .flatten();
                if result.ok {
                    action_failures = 0;
                    rejected_actions.reset();
                } else {
                    action_failures += 1;
                    rejected_actions.reject(&rejected_raw, mutation_epoch, verified_epoch);
                }
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
                if result.ok && matches!(tool.as_str(), "write" | "edit") {
                    if let Some(path) = path.as_deref() {
                        if let Some(path) = canonical_artifact_path(tools.workspace(), path) {
                            touched_artifacts.insert(path);
                        }
                    }
                }
                let read_only_source_evidence =
                    counts_as_read_only_source_evidence(options.authority, &tool, result.ok);
                if result.verification || read_only_source_evidence {
                    record_verification(
                        &mut verification,
                        VerificationRecord {
                            command: command.or(url).unwrap_or_else(|| tool.clone()),
                            ok: result.ok,
                            output: safe_output.clone(),
                        },
                    );
                    if result.verification && result.ok {
                        verified_epoch = Some(mutation_epoch);
                    }
                }
                let post_hooks = hooks.fire(
                    HookEvent::PostTool,
                    Some(&tool),
                    &run_id,
                    json!({
                        "step": steps,
                        "tool": &tool,
                        "ok": result.ok,
                        "verification": result.verification,
                        "output": &safe_output
                    }),
                );
                persist_hook_batch(&mut journal, &post_hooks)?;
                let hook_feedback = post_hooks.model_feedback();
                if post_hooks.mutated_workspace() {
                    mutation_epoch += 1;
                    verified_epoch = None;
                    verification.clear();
                    observations.clear();
                }
                hook_records.extend(post_hooks.records);
                // A verification that failed for an environmental reason is
                // reported as such, so the model stops treating it as evidence
                // that the code is wrong.
                let environment_hint = if !result.ok && matches!(tool.as_str(), "verify" | "shell")
                {
                    let class = crate::tools::classify_failure(&safe_output);
                    if class != crate::tools::FailureClass::AssertionFailure {
                        environment_blocked.get_or_insert_with(|| check_label.clone());
                    }
                    class.environment_hint()
                } else {
                    None
                };
                let proof_hint = if result.ok && mutates && !options.dry_run {
                    format!(
                        "\n\nMUTATION EPOCH {mutation_epoch} RECORDED. Run one actual verify or http acceptance check next. Read/list/search are observation only."
                    )
                } else {
                    String::new()
                };
                let route_hint = if rerouted_public_http {
                    "\n\nHII ROUTE: this public URL was read with web_fetch. Use web_search for broader native discovery; http remains reserved for localhost verification."
                } else {
                    ""
                };
                let repair_hint = if result.ok {
                    ""
                } else {
                    "\n\nERROR_RECOVERY: inspect the exact failure before acting. Do not repeat the same action unchanged. Diagnose the cause, gather missing external context with web_search/web_fetch when relevant, then choose the smallest corrected action."
                };
                let feedback = journal.feedback(
                    Event::new("tool.result")
                        .data(json!({
                            "step": steps,
                            "tool": &tool,
                            "ok": result.ok,
                            "verification": result.verification,
                            "output": &safe_output
                        }))
                        .human(Human::ToolResult {
                            ok: result.ok,
                            verification: result.verification,
                            detail: (!result.ok).then(|| safe_output.clone()),
                        }),
                    format!(
                        "TOOL RESULT [{}]:\n{}{}{}{}{}{}",
                        if result.ok { "ok" } else { "error" },
                        safe_output,
                        proof_hint,
                        environment_hint
                            .map(|hint| format!("\n\n{hint}"))
                            .unwrap_or_default(),
                        if hook_feedback.is_empty() {
                            String::new()
                        } else {
                            format!("\n\n{hook_feedback}")
                        },
                        route_hint,
                        repair_hint
                    ),
                )?;
                messages.push(Message::assistant(raw));
                push_feedback(&mut messages, feedback);
                if let Some((signature, count)) = repeated_failure {
                    model_loop_detected = true;
                    journal.emit(
                        Event::new("model.loop_detected")
                            .data(json!({
                                "step": steps,
                                "reason": "same tool failure class repeated without state progress",
                                "tool": tool,
                                "signature": signature,
                                "count": count,
                                "message": MODEL_LOOP_DETECTED_MESSAGE
                            }))
                            .human(Human::Recovery(MODEL_LOOP_DETECTED_MESSAGE.into())),
                    )?;
                    break;
                }
                if result.verification && result.ok {
                    if let Some(pending) = take_verified_pending_final(
                        &mut pending_final,
                        mutation_epoch,
                        verified_epoch,
                    ) {
                        journal
                            .emit(Event::new("convergence.pending_final_completed").data(
                                json!({ "step": steps, "mutation_epoch": mutation_epoch }),
                            ))?;
                        final_summary = Some(pending.summary);
                        final_next = pending.next;
                        break;
                    }
                }
            }
            Action::McpCall {
                server,
                tool,
                arguments,
                reason,
                ..
            } => {
                let label = reason
                    .as_deref()
                    .unwrap_or("using an operator-configured MCP tool");
                let qualified = format!("{server}.{tool}");
                let plan = match mcp_clients.plan(&server, &tool, arguments, options.authority) {
                    Ok(plan) => plan,
                    Err(error) => {
                        let feedback = journal.feedback(
                            Event::new("mcp.block").data(json!({
                                "step": steps,
                                "server": server,
                                "tool": tool,
                                "reason": redact_text(&error)
                            })),
                            format!(
                                "MCP_BLOCKED: {}. Refresh the server catalog or choose a configured tool.",
                                redact_text(&error)
                            ),
                        )?;
                        messages.push(Message::assistant(raw));
                        push_feedback(&mut messages, feedback);
                        rejected_actions.reject(&rejected_raw, mutation_epoch, verified_epoch);
                        continue;
                    }
                };
                if options.dry_run && (plan.mutates || plan.sensitive) {
                    let feedback = journal.feedback(
                        Event::new("mcp.block").data(json!({
                            "step": steps,
                            "server": server,
                            "tool": tool,
                            "reason": "dry run forbids mutating or open-world MCP calls"
                        })),
                        format!(
                            "MCP_BLOCKED: {qualified} may mutate state or reach an open-world system, so it cannot run in dry-run mode."
                        ),
                    )?;
                    messages.push(Message::assistant(raw));
                    push_feedback(&mut messages, feedback);
                    rejected_actions.reject(&rejected_raw, mutation_epoch, verified_epoch);
                    continue;
                }
                if let Some(blocked) = enforce_authority(
                    plan.decision,
                    &format!("mcp:{qualified}"),
                    label,
                    Some(&qualified),
                    &mut approvals,
                ) {
                    let feedback = journal.feedback(
                        Event::new("authority.block").data(json!({
                            "step": steps,
                            "tool": format!("mcp:{qualified}"),
                            "serverTrust": plan.trust.label(),
                            "decision": format!("{:?}", plan.decision),
                            "destructive": plan.destructive
                        })),
                        blocked,
                    )?;
                    messages.push(Message::assistant(raw));
                    push_feedback(&mut messages, feedback);
                    rejected_actions.reject(&rejected_raw, mutation_epoch, verified_epoch);
                    continue;
                }
                journal.emit(
                    Event::new("tool.started")
                        .data(json!({
                            "step": steps,
                            "tool": format!("mcp:{qualified}"),
                            "target": label
                        }))
                        .human(Human::ToolStart {
                            step: steps,
                            tool: format!("mcp:{qualified}"),
                            target: label.to_string(),
                        }),
                )?;
                let pre_hooks = hooks.fire(
                    HookEvent::PreTool,
                    Some("mcp_call"),
                    &run_id,
                    json!({
                        "step": steps,
                        "server": server,
                        "tool": tool,
                        "mutatesWorkspace": plan.mutates,
                        "sensitive": plan.sensitive,
                        "destructive": plan.destructive
                    }),
                );
                persist_hook_batch(&mut journal, &pre_hooks)?;
                let hook_block = pre_hooks.block_reason.clone();
                hook_records.extend(pre_hooks.records);
                if let Some(blocked) = hook_block {
                    let feedback = journal.feedback(
                        Event::new("hook.block").data(json!({
                            "step": steps,
                            "tool": format!("mcp:{qualified}"),
                            "reason": redact_text(&blocked)
                        })),
                        format!("HOOK_BLOCKED: {blocked}. Choose a compliant alternative."),
                    )?;
                    messages.push(Message::assistant(raw));
                    push_feedback(&mut messages, feedback);
                    rejected_actions.reject(&rejected_raw, mutation_epoch, verified_epoch);
                    continue;
                }
                rejected_actions.reset();
                let result = mcp_clients.call(&plan);
                let (ok, output) = match result {
                    Ok(result) => (result.ok, redact_text(&result.output)),
                    Err(error) => (false, redact_text(&error)),
                };
                if ok {
                    action_failures = 0;
                } else {
                    action_failures += 1;
                }
                if ok && plan.mutates && !options.dry_run {
                    mutation_epoch += 1;
                    verified_epoch = None;
                    verification.clear();
                    observations.clear();
                    pending_final = None;
                }
                let post_hooks = hooks.fire(
                    HookEvent::PostTool,
                    Some("mcp_call"),
                    &run_id,
                    json!({
                        "step": steps,
                        "server": server,
                        "tool": tool,
                        "ok": ok,
                        "output": &output
                    }),
                );
                persist_hook_batch(&mut journal, &post_hooks)?;
                let hook_feedback = post_hooks.model_feedback();
                if post_hooks.mutated_workspace() {
                    mutation_epoch += 1;
                    verified_epoch = None;
                    verification.clear();
                    observations.clear();
                    pending_final = None;
                }
                hook_records.extend(post_hooks.records);
                let proof_hint = if ok && plan.mutates && !options.dry_run {
                    format!(
                        "\n\nMUTATION EPOCH {mutation_epoch} RECORDED. Run one actual verify or http acceptance check next."
                    )
                } else {
                    String::new()
                };
                let feedback = journal.feedback(
                    Event::new("mcp.result")
                        .data(json!({
                            "step": steps,
                            "server": server,
                            "tool": tool,
                            "ok": ok,
                            "mutatesWorkspace": plan.mutates,
                            "output": &output
                        }))
                        .human(Human::ToolResult {
                            ok,
                            verification: false,
                            detail: (!ok).then(|| output.clone()),
                        }),
                    format!(
                        "MCP TOOL RESULT [{}] from {qualified}:\n{}{}{}",
                        if ok { "ok" } else { "error" },
                        output,
                        proof_hint,
                        if hook_feedback.is_empty() {
                            String::new()
                        } else {
                            format!("\n\n{hook_feedback}")
                        }
                    ),
                )?;
                messages.push(Message::assistant(raw));
                push_feedback(&mut messages, feedback);
            }
            Action::Final {
                summary,
                verification: claimed,
                next,
                ..
            } => {
                if final_requires_model_verification(
                    !options.verify.is_empty(),
                    mutation_epoch,
                    verified_epoch,
                ) {
                    if missing_proof.repeated_without_progress(mutation_epoch, verified_epoch) {
                        model_loop_detected = true;
                        journal.emit(
                            Event::new("model.loop_detected")
                                .data(json!({
                                    "step": steps,
                                    "reason": "final repeated without verification progress",
                                    "mutation_epoch": mutation_epoch,
                                    "message": MODEL_LOOP_DETECTED_MESSAGE
                                }))
                                .human(Human::Recovery(MODEL_LOOP_DETECTED_MESSAGE.into())),
                        )?;
                        break;
                    }
                    pending_final = Some(PendingFinal {
                        summary,
                        next,
                        mutation_epoch,
                    });
                    let feedback = journal.feedback(
                        Event::new("convergence.proof_required")
                            .data(json!({ "step": steps, "mutation_epoch": mutation_epoch })),
                        format!(
                            "No passing HII verification exists for the latest workspace mutation (model claim: {}). Read/list/search/web_search/web_fetch are observation only. Use web_search/web_fetch for public research; never pass a public URL to http. Create the requested artifact when the goal asks for one, then run verify or a loopback http check with an explicit port before finalizing.",
                            if claimed.is_empty() { "none" } else { "present" }
                        ),
                    )?;
                    messages.push(Message::assistant(raw));
                    push_feedback(&mut messages, feedback);
                    if journal.verbose() {
                        println!("[step {steps}] proof required before completion");
                    }
                    rejected_actions.reset();
                    continue;
                }
                final_summary = Some(summary);
                final_next = next;
                break;
            }
            Action::Message { message, .. } => {
                let feedback = journal.feedback(
                    Event::new("model.message").data(json!({ "step": steps })),
                    format!(
                        "This is explicit run mode, not chat. Continue the bounded task, verify it, then return a final action. Your conversational message was: {message}"
                    ),
                )?;
                messages.push(Message::assistant(raw));
                push_feedback(&mut messages, feedback);
                rejected_actions.reject(&rejected_raw, mutation_epoch, verified_epoch);
            }
        }
    }

    if final_summary.is_some() {
        for command in &options.verify {
            // The model may already have run this exact check. Re-running it
            // would both double the recorded proof and pay for the suite twice.
            if acceptance_passed(std::slice::from_ref(command), &verification) {
                journal.emit(Event::new("acceptance.skipped").data(json!({
                    "command": command,
                    "reason": "already verified in the current mutation epoch",
                })))?;
                continue;
            }
            let result = tools.shell(command, true);
            let safe_output = redact_text(&result.output);
            journal.emit(Event::new("acceptance.result").data(json!({
                "command": command,
                "ok": result.ok,
                "output": safe_output,
            })))?;
            record_verification(
                &mut verification,
                VerificationRecord {
                    command: command.clone(),
                    ok: result.ok,
                    output: safe_output,
                },
            );
        }
    }
    let declared_checks_passed = acceptance_passed(&options.verify, &verification);
    let mut summary = redact_text(&final_summary.clone().unwrap_or_else(|| {
        if model_loop_detected {
            MODEL_LOOP_DETECTED_MESSAGE.into()
        } else if interrupted {
            format!("Interrupted by operator after {steps} step(s); partial work preserved.")
        } else if let Some(kind) = budget_exceeded {
            format!(
                "{} reached after {steps} step(s) and {}s; partial work preserved.",
                kind.label(),
                deadline.elapsed().as_secs()
            )
        } else if let Some(blocker) = environment_blocked.as_deref() {
            format!(
                "Blocked by the environment rather than the code: verification could not run ({blocker})."
            )
        } else {
            format!("Run ended before the model returned a final result ({steps} steps).")
        }
    }));
    if !declared_checks_passed {
        summary.push_str(" Declared acceptance verification failed.");
    }
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
        journal.emit(
            Event::new("output.written").data(json!({ "kind": "last_message", "path": &relative })),
        )?;
    }
    let git_status = tools.git_snapshot();
    let artifacts = artifact_inventory(&git_before, &git_status)
        .into_iter()
        .chain(touched_artifacts)
        .filter_map(|path| canonical_artifact_path(tools.workspace(), &path))
        .collect::<BTreeSet<_>>();
    let preexisting_changes = artifact_inventory("clean", &git_before);
    let review = match review_model.as_deref() {
        Some(reviewer) => {
            if journal.verbose() {
                println!("review     {reviewer}");
            }
            let review_paths = artifacts.iter().cloned().collect::<Vec<_>>();
            let diff = redact_text(&tools.git_diff_snapshot(&review_paths));
            let review_verification = verification
                .iter()
                .map(|record| {
                    json!({
                        "command": record.command,
                        "ok": record.ok,
                        "output": record.output.chars().take(2_000).collect::<String>()
                    })
                })
                .collect::<Vec<_>>();
            let prompt = format!(
                "Review this bounded local agent result. Identify only concrete defects, proof gaps, or risks in at most 120 words. Use the supplied diff as source truth; do not invent behavior beyond the code and evidence. If there is no concrete finding, say so plainly.\n\nGoal: {}\nSummary: {}\nVerification: {}\nBaseline Git status:\n{}\nFinal Git status:\n{}\nArtifacts: {}\nWorkspace diff:\n{}",
                options.goal,
                summary,
                serde_json::to_string(&review_verification).unwrap_or_default(),
                git_before,
                git_status,
                serde_json::to_string(&artifacts).unwrap_or_default(),
                if diff.is_empty() { "(no tracked diff)" } else { &diff }
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
    let artifacts = artifacts.iter().cloned().collect::<Vec<_>>();
    let reversible = Some(git_status != "not a git workspace");

    // One assessment decides completion for every surface. The receipt carries
    // it, and the daemon, CapabilityJob and workspace read it rather than each
    // applying a weaker rule of their own.
    let terminated = if interrupted {
        Some("The run was interrupted before the work finished.".to_string())
    } else if model_loop_detected {
        Some("The run was stopped after the model looped.".to_string())
    } else {
        // A blocked environment is deliberately absent here. One incidental
        // command failing for environmental reasons must not veto a run whose
        // declared checks and outcome were satisfied; it stays a fallback
        // classification for a run that failed with nothing else to explain it.
        budget_exceeded.map(|kind| format!("{} reached before the work finished.", kind.label()))
    };
    let completion = crate::completion::assess(crate::completion::CompletionInput {
        workspace: tools.workspace(),
        requirements: contract.outcome_requirements.as_ref(),
        final_summary: final_summary.as_deref(),
        declared_checks: &options.verify,
        verification: &verification,
        artifacts: &artifacts,
        terminated: terminated.as_deref(),
    });
    if declaration
        .as_ref()
        .is_some_and(|declaration| !declaration.supports_verification())
    {
        return Err("the pre-registered acceptance declaration changed during execution".into());
    }
    let completed = completion.satisfied;
    // A required artifact that was found belongs in the inventory even when the
    // run did not modify it, so the receipt lists what the outcome actually
    // rests on rather than only what changed.
    let mut artifacts = artifacts;
    for evidence in &completion.evidence {
        if evidence.exists && evidence.is_file {
            if let Some(path) = canonical_artifact_path(tools.workspace(), &evidence.path) {
                artifacts.push(path);
            }
        }
    }
    artifacts.sort();
    artifacts.dedup();
    if !completed && !completion.unmet_requirements.is_empty() {
        journal.emit(Event::new("completion.unsatisfied").data(json!({
            "unmetRequirements": &completion.unmet_requirements,
            "failedChecks": &completion.failed_checks,
            "missingArtifacts": &completion.missing_artifacts,
            "invalidArtifacts": &completion.invalid_artifacts,
        })))?;
    }
    for reason in &completion.missing_artifacts {
        summary.push_str(&format!(" Required artifact missing: {reason}."));
    }
    for reason in &completion.invalid_artifacts {
        summary.push_str(&format!(" Required artifact invalid: {reason}."));
    }

    let stop_hooks = hooks.fire(
        HookEvent::Stop,
        None,
        &run_id,
        json!({
            "status": if completed { "completed" } else { "incomplete" },
            "summary": &summary,
            "steps": steps
        }),
    );
    persist_hook_batch(&mut journal, &stop_hooks)?;
    hook_records.extend(stop_hooks.records);

    // One classification drives status, outcome, and the exit code, so the three
    // can never disagree about why the run ended.
    let outcome = if completed {
        Outcome::Completed
    } else if interrupted {
        Outcome::Interrupted
    } else if model_loop_detected {
        Outcome::LoopAbort
    } else if !declared_checks_passed
        || !completion.missing_artifacts.is_empty()
        || !completion.invalid_artifacts.is_empty()
    {
        // A declared outcome that was not produced is a verification failure,
        // not a generic abort: the run did not do what it said it would.
        Outcome::VerifyFailed
    } else {
        match budget_exceeded {
            Some(BudgetKind::Steps) => Outcome::StepCeiling,
            Some(BudgetKind::Tokens) => Outcome::TokenBudget,
            Some(_) => Outcome::Deadline,
            // Say why the run could not prove anything, rather than leaving the
            // operator to infer it from a generic abort.
            None if environment_blocked.is_some() => Outcome::EnvironmentBlocked,
            None => Outcome::Aborted,
        }
    };
    let mut receipt = Receipt {
        schema_version: 8,
        id: run_id.clone(),
        created_at_unix_ms: started_at,
        finished_at_unix_ms: unix_ms(),
        status: outcome.status().into(),
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
        outcome: outcome.label().into(),
        exit_code: outcome.exit_code(),
        completion: Some(completion),
        model_source: Some(model_source),
        autonomy_level: Some(options.autonomy_level.label().into()),
        learning_candidates: Vec::new(),
        user_corrections: Vec::new(),
        failure_patterns: Vec::new(),
        skill_draft_ref: None,
        token_usage: Some(TokenUsageRecord {
            prompt_tokens,
            completion_tokens,
            budget: options.budgets.max_tokens,
        }),
    };
    if let Ok(Some(path)) =
        crate::learning::record_from_receipt(&paths.runtime, &receipt, None, None)
    {
        receipt.learning_candidates.push(path.display().to_string());
    }
    // Close the competence loop: any skill attributed to this run has been
    // waiting on an outcome since it was invoked. Grading here is what lets a
    // skill ever move past `proposed`. Best-effort — a lifecycle write must
    // never fail a run that already did its work.
    let _ = crate::skill_lifecycle::grade_receipt(paths, &receipt);
    let path = guard.finalize(&receipt)?;
    // The receipt is embedded here as well as written to receipt.json so a
    // consumer following the event stream never has to open a second file.
    journal.emit(Event::new("run.finished").data(json!({
        "status": receipt.status,
        "summary": receipt.summary,
        // Named alongside the status so a stream consumer can see how strong the
        // evidence behind it is without opening the receipt.
        "proofStrength": receipt
            .completion
            .as_ref()
            .map(|assessment| assessment.proof_strength.label())
            .unwrap_or("legacy"),
        "receipt": &receipt,
        "proof": &path
    })))?;
    journal.finish(&receipt, &path);
    match options.output {
        RunOutput::Json => println!(
            "{}",
            json!({
                "schemaVersion": 1,
                "receipt": &receipt,
                "proof": path
            })
        ),
        RunOutput::Jsonl | RunOutput::Quiet => {}
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

fn persist_hook_batch(journal: &mut Journal, batch: &HookBatch) -> Result<(), String> {
    for record in &batch.records {
        let value = serde_json::to_value(record).map_err(|error| error.to_string())?;
        journal.emit(Event::new("hook.result").data(value))?;
    }
    Ok(())
}

pub(crate) fn choose_model(
    requested: Option<&str>,
    provider: ModelProvider,
    installed: &[String],
) -> Result<String, String> {
    choose_model_with_env(
        requested,
        std::env::var("HII_MODEL").ok().as_deref(),
        provider,
        installed,
    )
}

fn choose_model_with_env(
    requested: Option<&str>,
    env_model: Option<&str>,
    provider: ModelProvider,
    installed: &[String],
) -> Result<String, String> {
    let explicit = requested
        .map(str::to_string)
        .or_else(|| env_model.map(str::to_string));
    let requested = explicit
        .clone()
        .unwrap_or_else(|| provider.default_model().to_string());
    if installed.iter().any(|model| model == &requested) {
        return Ok(requested);
    }
    if installed.is_empty() {
        return Err("no local models are available; run `hii runner doctor`".into());
    }
    if explicit.is_some() {
        return Err(format!(
            "model '{requested}' is not installed; run `hii models`"
        ));
    }
    // A missing default is never silently swapped for whatever the provider
    // happens to list first: the substitute model has different capabilities,
    // and a run that quietly changed models is a run whose proof record lies
    // about what produced it. Say what is missing and let the operator choose.
    Err(format!(
        "default model '{requested}' is not installed on this provider (available: {}). \
Install it, or choose one explicitly with `--model <name>` or HII_MODEL=<name>.",
        installed.join(", ")
    ))
}

fn choose_review_model(
    requested: Option<&str>,
    provider: ModelProvider,
    installed: &[String],
) -> Result<String, String> {
    let requested = requested.unwrap_or_else(|| provider.default_review_model());
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
    coding: bool,
    autonomy_level: AutonomyLevel,
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
    let coding = if coding {
        "Coding: rg/read->edit->test->repair->final. Correctness>prose."
    } else {
        "General: act; create artifact; verify."
    };
    let autonomy = match autonomy_level {
        AutonomyLevel::Approval => "Ask for sensitive/destructive/external actions.",
        AutonomyLevel::LocalFull => {
            "Local-full: act/test/commit. Ask: delete/push/publish/spend/message/secrets/access."
        }
    };
    format!(
        r#"You are HII, the work system. Own the bounded loop; other agents are only references/backends.
Workspace:{workspace}
{limit} Dry:{dry_run}. Done:{done_when}. Checks:{declared_verification}
{coding} {autonomy}
Loop: intent -> context -> bounded work -> verify -> receipt. No plan narration.
Habits: inspect real files, preserve unclear work, patch narrowly, repair failed checks.
Proof: one flat {{"type":"verify","command":"npm test"}} or http; shell/read/list/search never count.
JSON only; no native tool tags. T:{tool_names}. F:path,query,command,content,old,new,replace_all,offset,limit,url.
Write: {{"type":"write","path":"relative-file.md","content":"complete file text"}}; file text only.
Finish: {{"type":"final","summary":"result","verification":["checks run"],"next":null}}
Read AGENTS.md. Stay in workspace. Never claim unrun proof."#,
        workspace = workspace.display(),
        tool_names = crate::acp::action_tool_names(true).join(",")
    )
}

struct ModelStreamPolicy {
    step: usize,
    think: bool,
    relaxed_json: bool,
}

fn stream_model_json(
    ollama: &Ollama,
    model: &str,
    messages: &[Message],
    policy: ModelStreamPolicy,
    journal: &mut Journal,
    deadline: &Deadline,
    cancel: &Cancel,
) -> Result<ChatResult, String> {
    let ModelStreamPolicy {
        step,
        think,
        relaxed_json,
    } = policy;
    let ollama = ollama.clone();
    let model_for_thread = model.to_string();
    let messages = messages.to_vec();
    let stream_cancel = cancel.clone();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        if relaxed_json {
            ollama.chat_with_stream_unconstrained(
                &model_for_thread,
                &messages,
                think,
                &stream_cancel,
                sender,
            );
        } else {
            ollama.chat_with_stream(
                &model_for_thread,
                &messages,
                true,
                think,
                &stream_cancel,
                sender,
            );
        }
    });

    // Whether progress is shown at all is the journal's decision, so `--stream`
    // reaches a piped run exactly the way it reaches a terminal.
    let streaming = journal.streaming();
    let human = matches!(journal.mode(), OutputMode::Human { .. });
    let mut thinking_started = false;
    let mut content_started = false;
    let mut reasoning_chars = 0usize;
    let call_started = Instant::now();
    // Stays `None` until the first delta arrives. The stream-idle budget measures
    // the gap *between* two pieces of streamed output, so it must not police
    // time-to-first-token: a large local model can spend longer than the idle
    // budget on prompt eval before emitting anything, and cancelling there
    // aborts a healthy run. Until the stream opens, the model-call budget is the
    // governor.
    let mut last_delta: Option<Instant> = None;
    let call_budget = deadline.model_call_budget();
    let idle_budget = deadline.stream_idle();
    loop {
        match receiver.recv_timeout(Duration::from_millis(120)) {
            Ok(ChatStreamEvent::Thinking(delta)) => {
                reasoning_chars += delta.chars().count();
                if think
                    && !content_started
                    && (reasoning_chars >= ADAPTIVE_REASONING_MAX_CHARS
                        || call_started.elapsed() >= ADAPTIVE_REASONING_MAX_TIME)
                {
                    cancel.cancel(CancelReason::Client);
                    return Err(ADAPTIVE_REASONING_BUDGET_RETRY.into());
                }
                if streaming && human && !thinking_started {
                    println!("\n  THINKING · step {step}");
                    print!("  ");
                    thinking_started = true;
                }
                last_delta = Some(Instant::now());
                journal.delta(Delta::Thinking(indent_for(human, delta)));
            }
            Ok(ChatStreamEvent::Content(delta)) => {
                if streaming && human && !content_started {
                    if thinking_started {
                        println!();
                    }
                    println!("\n  MODEL · step {step}");
                    print!("  ");
                    content_started = true;
                }
                last_delta = Some(Instant::now());
                journal.delta(Delta::Content(indent_for(human, delta)));
            }
            Ok(ChatStreamEvent::Done(result)) => {
                if streaming && human && (thinking_started || content_started) {
                    println!("\n");
                    let _ = io::stdout().flush();
                }
                return result;
            }
            // Budgets and Ctrl-C are checked on the idle tick rather than only
            // between steps, which is what lets a generation in progress be
            // abandoned instead of running to completion first.
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(kind) = call_budget
                    .filter(|limit| call_started.elapsed() >= *limit)
                    .map(|_| BudgetKind::ModelCall)
                    .or_else(|| {
                        idle_budget
                            .zip(last_delta)
                            .filter(|(limit, since)| since.elapsed() >= *limit)
                            .map(|_| BudgetKind::StreamIdle)
                    })
                {
                    cancel.cancel(CancelReason::Budget(kind));
                }
                if cancel.is_cancelled() {
                    // Dropping the receiver makes the producer's next send fail,
                    // so the streaming thread unwinds on its own.
                    return Err(cancellation_message(cancel));
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if cancel.is_cancelled() {
                    return Err(cancellation_message(cancel));
                }
                return Err("the local model stream stopped unexpectedly".into());
            }
        }
    }
}

fn stream_model_json_with_retries(
    ollama: &Ollama,
    model: &str,
    messages: &[Message],
    policy: ModelStreamPolicy,
    journal: &mut Journal,
    deadline: &Deadline,
    cancel: &Cancel,
) -> Result<ChatResult, String> {
    let step = policy.step;
    let think = policy.think;
    for retry in 0..=TRANSIENT_PROVIDER_RETRIES {
        let result = stream_model_json(
            ollama,
            model,
            messages,
            ModelStreamPolicy {
                step,
                think,
                relaxed_json: retry > 0,
            },
            journal,
            deadline,
            cancel,
        );
        match result {
            Ok(result) => return Ok(result),
            Err(error)
                if retry < TRANSIENT_PROVIDER_RETRIES
                    && (is_transient_provider_error(&error)
                        || matches!(
                            cancel.reason(),
                            Some(CancelReason::Budget(
                                BudgetKind::ModelCall | BudgetKind::StreamIdle
                            ))
                        ))
                    && deadline.exceeded(step, 0).is_none() =>
            {
                cancel.reset();
                journal.emit(
                    Event::new("model.provider_retry")
                        .data(json!({
                            "step": step,
                            "retry": retry + 1,
                            "max_retries": TRANSIENT_PROVIDER_RETRIES,
                            "error": redact_text(&error)
                        }))
                        .human(Human::Line(format!(
                            "[step {step}] local model transport interrupted; retrying"
                        ))),
                )?;
                thread::sleep(TRANSIENT_PROVIDER_RETRY_DELAY);
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("bounded provider retry loop always returns")
}

fn is_transient_provider_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("model provider returned http 500")
        || error.contains("model provider returned http 502")
        || error.contains("model provider returned http 503")
        || error.contains("model provider returned http 504")
        || error.contains("failed to read ollama stream")
        || error.contains("local model stream stopped unexpectedly")
        || (error.contains("invalid ollama stream response")
            && error.contains("missing field `message`"))
        || error.contains("connection reset")
        || error.contains("broken pipe")
        || error.contains("unexpected eof")
}

/// The receipt written before the first model call.
///
/// It carries the real goal, workspace, and model so that a run which dies early
/// is still identifiable; the outcome starts as `running` and is replaced by
/// whatever actually happens.
#[allow(clippy::too_many_arguments)]
fn draft_receipt(
    run_id: &str,
    started_at: u128,
    goal: &str,
    authority: Authority,
    done_when: Option<&str>,
    workspace: &Path,
    model: &str,
    model_source: &str,
    autonomy_level: AutonomyLevel,
    context_sources: &[String],
) -> Receipt {
    Receipt {
        schema_version: 8,
        id: run_id.to_string(),
        created_at_unix_ms: started_at,
        finished_at_unix_ms: 0,
        status: Outcome::Running.status().into(),
        goal: redact_text(goal),
        workspace: workspace.display().to_string(),
        model: model.to_string(),
        review_model: None,
        steps: 0,
        summary: "Run in progress.".into(),
        verification: Vec::new(),
        git_status: String::new(),
        next: None,
        review: None,
        risk: String::new(),
        authority: Some(authority.label().to_string()),
        done_when: done_when.map(str::to_string),
        approvals: Vec::new(),
        artifacts: Vec::new(),
        reversible: None,
        context_sources: context_sources.to_vec(),
        preexisting_changes: Vec::new(),
        hooks: Vec::new(),
        outcome: Outcome::Running.label().into(),
        exit_code: Outcome::Running.exit_code(),
        completion: None,
        model_source: Some(model_source.into()),
        autonomy_level: Some(autonomy_level.label().into()),
        learning_candidates: Vec::new(),
        user_corrections: Vec::new(),
        failure_patterns: Vec::new(),
        skill_draft_ref: None,
        token_usage: None,
    }
}

/// Why a run stopped, phrased for the operator and the receipt.
fn cancellation_message(cancel: &Cancel) -> String {
    match cancel.reason() {
        Some(CancelReason::Interrupt) => "Interrupted by operator.".into(),
        Some(CancelReason::Client) => "Cancelled by the client.".into(),
        Some(CancelReason::Budget(kind)) => format!(
            "{} exhausted; the run stopped mid-generation and the receipt is preserved.",
            kind.label()
        ),
        None => "Run cancelled.".into(),
    }
}

/// Terminal output is indented under a step header; machine streams stay raw.
fn indent_for(human: bool, delta: String) -> String {
    if human {
        delta.replace('\n', "\n  ")
    } else {
        delta
    }
}

fn validate_declared_verification(
    commands: &[String],
    workspace: Option<&Path>,
) -> Result<(), String> {
    for command in commands {
        if command.trim().is_empty() {
            return Err("--verify commands cannot be empty".into());
        }
        if sensitive_shell(command) {
            return Err(format!(
                "--verify must be a local acceptance check, not an external action: {command}"
            ));
        }
        // Fail at second zero rather than after a full run. A declared check that
        // cannot execute is an environment problem, and discovering it only after
        // the loop finishes wastes the entire run.
        if let Some(workspace) = workspace {
            if let Err(missing) = crate::tools::preflight_command(command, workspace) {
                return Err(format!(
                    "--verify \"{}\" needs '{}', which is not installed or not on PATH. Install it, choose another check, or pass --allow-missing-verify-deps to decide during the run.",
                    missing.command, missing.program
                ));
            }
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
    parse_action_with_repair(raw).map(|(action, _)| action)
}

/// What had to be adjusted before a raw model response parsed as an action.
///
/// The repairs themselves are deliberate — compact local models fence their
/// JSON and emit literal newlines inside strings — but absorbing them silently
/// hid how often the action protocol is missed at all. Reported so the record
/// can show it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ActionRepair {
    /// Wrapped in a code fence, or surrounded by prose.
    Unwrapped,
    /// Contained literal control characters inside JSON strings.
    EscapedControlChars,
}

impl ActionRepair {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Unwrapped => "unwrapped",
            Self::EscapedControlChars => "escaped-control-chars",
        }
    }
}

pub(crate) fn parse_action_with_repair(
    raw: &str,
) -> Result<(Action, Option<ActionRepair>), String> {
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
    let mut repair = (candidate != trimmed).then_some(ActionRepair::Unwrapped);
    let mut value: serde_json::Value = match serde_json::from_str(candidate) {
        Ok(value) => value,
        Err(original_error) => {
            let repaired = escape_literal_control_chars_in_json_strings(candidate);
            let value = serde_json::from_str(&repaired).map_err(|_| original_error.to_string())?;
            repair = Some(ActionRepair::EscapedControlChars);
            value
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
            | "schedule_read"
            | "schedule_write"
            | "bridge_send"
            | "bridge_read"
    ) {
        value["type"] = serde_json::Value::String("tool".into());
        value["tool"] = serde_json::Value::String(action_type);
    }
    let action = serde_json::from_value(value).map_err(|error| error.to_string())?;
    validate_action_fields(&action)?;
    Ok((action, repair))
}

/// Reject incomplete calls before they consume a tool step. Compact models
/// often emit `{\"type\":\"verify\"}` while trying to finish a simple task;
/// executing that shape only produces a vague tool failure and encourages a
/// recovery loop. Keep this beside parsing so both managed runs and the REPL
/// return the same precise correction to the model.
fn validate_action_fields(action: &Action) -> Result<(), String> {
    let Action::Tool {
        tool,
        path,
        query,
        command,
        content,
        url,
        old,
        new,
        ..
    } = action
    else {
        return Ok(());
    };
    let present = |value: Option<&String>| value.is_some_and(|value| !value.trim().is_empty());
    match tool.as_str() {
        "read" => present(path.as_ref())
            .then_some(())
            .ok_or_else(|| "read requires a non-empty path".into()),
        "search" | "web_search" => present(query.as_ref())
            .then_some(())
            .ok_or_else(|| format!("{tool} requires a non-empty query")),
        "web_fetch" | "http" => present(url.as_ref())
            .then_some(())
            .ok_or_else(|| format!("{tool} requires a non-empty url")),
        "write" => (present(path.as_ref()) && content.is_some())
            .then_some(())
            .ok_or_else(|| "write requires a path and content".into()),
        "edit" => (present(path.as_ref()) && old.is_some() && new.is_some())
            .then_some(())
            .ok_or_else(|| "edit requires path, old, and new fields".into()),
        "shell" | "verify" => present(command.as_ref())
            .then_some(())
            .ok_or_else(|| format!("{tool} requires a non-empty command")),
        _ => Ok(()),
    }
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
            .filter_map(|line| {
                let path = line.get(3..)?;
                Some(
                    path.rsplit_once(" -> ")
                        .map(|(_, destination)| destination)
                        .unwrap_or(path)
                        .to_string(),
                )
            })
            .collect::<BTreeSet<_>>()
    };
    let before = paths(before);
    paths(after).difference(&before).cloned().collect()
}

fn canonical_artifact_path(workspace: &Path, raw: &str) -> Option<String> {
    let raw = Path::new(raw.trim());
    if raw.as_os_str().is_empty()
        || raw
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return None;
    }
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        workspace.join(raw)
    };
    let resolved = candidate.canonicalize().unwrap_or(candidate);
    let relative = resolved.strip_prefix(workspace).ok()?;
    if relative.as_os_str().is_empty() {
        return None;
    }
    Some(relative.display().to_string())
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
    if let Some(completion) = receipt.completion.as_ref() {
        println!(
            "Proof Strength: {} ({})",
            completion.proof_strength.label(),
            if completion.satisfied {
                "satisfied"
            } else {
                "not satisfied"
            }
        );
    }
    if !receipt.artifacts.is_empty() {
        println!("Artifacts: {} file(s)", receipt.artifacts.len());
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
    if let Some(review) = receipt.review.as_deref() {
        println!("Review: {review}");
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
    fn draft_receipt_preserves_invocation_context_before_model_work() {
        let sources = vec!["nsworkspace:frontmost-app:Rhino".to_string()];
        let receipt = draft_receipt(
            "run-id",
            1,
            "inspect",
            Authority::ReadOnly,
            None,
            Path::new("/tmp"),
            "local-model",
            "provider-default",
            AutonomyLevel::Approval,
            &sources,
        );
        assert_eq!(receipt.context_sources, sources);
    }

    #[test]
    fn invocation_context_sources_are_bounded_redacted_and_deduplicated() {
        let sources = vec![
            " nsworkspace:frontmost-app:Rhino ".to_string(),
            "nsworkspace:frontmost-app:Rhino".to_string(),
            "token=secret-value".to_string(),
            "x".repeat(MAX_INVOCATION_CONTEXT_SOURCE_CHARS + 100),
        ];
        let bounded = bounded_context_sources(&sources);
        assert_eq!(bounded.len(), 3);
        assert_eq!(bounded[0], "nsworkspace:frontmost-app:Rhino");
        assert!(!bounded[1].contains("secret-value"));
        assert_eq!(
            bounded[2].chars().count(),
            MAX_INVOCATION_CONTEXT_SOURCE_CHARS
        );
    }

    #[test]
    fn parses_json_action() {
        let action = parse_action(r#"{"type":"tool","tool":"list","reason":"inspect"}"#).unwrap();
        assert!(matches!(action, Action::Tool { tool, .. } if tool == "list"));
    }

    #[test]
    fn parsing_reports_the_repair_it_had_to_apply() {
        use super::{parse_action_with_repair, ActionRepair};
        let (_, clean) = parse_action_with_repair(r#"{"type":"list"}"#).unwrap();
        assert_eq!(clean, None);

        let (_, fenced) = parse_action_with_repair("```json\n{\"type\":\"list\"}\n```").unwrap();
        assert_eq!(fenced, Some(ActionRepair::Unwrapped));
        assert_eq!(fenced.unwrap().label(), "unwrapped");

        // A literal newline inside a JSON string: the single most common way a
        // compact local model misses the protocol while still meaning an action.
        let (_, escaped) = parse_action_with_repair(
            "{\"type\":\"write\",\"path\":\"a.txt\",\"content\":\"one\ntwo\"}",
        )
        .unwrap();
        assert_eq!(escaped, Some(ActionRepair::EscapedControlChars));
    }

    #[test]
    fn action_carries_a_replaceable_semantic_flow_projection() {
        let action = parse_action(r#"{"type":"skill_search","query":"dashboard","flow":{"title":"Personal Dashboard","goal":"See what matters now","current":"Choosing the dashboard structure","direction":["HII","School"],"next":"Build the first visible section"}}"#).unwrap();
        let flow = action.flow().expect("flow projection");
        assert_eq!(flow.title, "Personal Dashboard");
        assert_eq!(flow.direction, vec!["HII", "School"]);
        assert!(!format!("{} {}", flow.current, flow.next).contains("skill_search"));
    }

    #[test]
    fn parses_flat_local_model_action() {
        let action =
            parse_action(r#"{"type":"write","path":"hello.txt","content":"hello\n"}"#).unwrap();
        assert!(matches!(action, Action::Tool { tool, .. } if tool == "write"));
    }

    #[test]
    fn rejects_incomplete_tool_actions_before_execution() {
        assert!(parse_action(r#"{"type":"verify"}"#)
            .unwrap_err()
            .contains("verify requires a non-empty command"));
        assert!(parse_action(r#"{"type":"http"}"#)
            .unwrap_err()
            .contains("http requires a non-empty url"));
    }

    #[test]
    fn parses_governed_mcp_action() {
        let action = parse_action(
            r#"{"type":"mcp_call","server":"local","tool":"inspect","arguments":{"path":"Cargo.toml"}}"#,
        )
        .unwrap();
        assert!(matches!(
            action,
            Action::McpCall {
                server,
                tool,
                arguments,
                ..
            } if server == "local"
                && tool == "inspect"
                && arguments["path"] == "Cargo.toml"
        ));
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
            false,
            AutonomyLevel::LocalFull,
        );
        // The ceiling is not arbitrary: small local models lose action-emission
        // reliability as the system prompt grows, so additions must be paid for
        // deliberately rather than accumulating.
        //
        // Raised from 1_250 to cover the native tool list. `web_search`,
        // `web_fetch`, `canvas_*`, `object_*` and `bridge_*` became native
        // tools, and a model cannot call a tool the `T:` line never names, so
        // those bytes buy capability rather than prose. The `T:`/`F:` line is
        // now ~30% of the prompt and is the first place to look if this needs
        // to come back down -- by dropping tools, not by describing them less.
        assert!(
            prompt.len() <= 1_300,
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
            false,
            AutonomyLevel::LocalFull,
        );
        assert!(prompt.contains("Proof: one flat"));
        assert!(prompt.contains("shell/read/list/search never count"));
        assert!(prompt.contains(
            r#"{"type":"write","path":"relative-file.md","content":"complete file text"}"#
        ));
        assert!(prompt.contains(r#"{"type":"verify","command":"npm test"}"#));
    }

    #[test]
    fn agent_prompt_makes_hii_own_bounded_work() {
        let prompt = system_prompt(
            std::path::Path::new("/workspace"),
            8,
            false,
            "verified",
            &[],
            false,
            AutonomyLevel::LocalFull,
        );
        assert!(prompt.contains("You are HII, the work system"));
        assert!(prompt.contains("Own the bounded loop"));
        assert!(prompt.contains("other agents are only references/backends"));
        assert!(prompt.contains("intent -> context -> bounded work -> verify -> receipt"));
        assert!(prompt.contains("inspect real files"));
        assert!(prompt.contains("patch narrowly"));
        assert!(prompt.contains("repair failed checks"));
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
            false,
            AutonomyLevel::LocalFull,
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
    fn repeated_tool_failure_guard_uses_failure_class_not_action_text() {
        let mut guard = RepeatedToolFailureGuard::default();

        assert_eq!(
            guard.record(
                "web_fetch",
                "web fetch returned HTTP 403\nurl: https://first.example",
                0,
            ),
            None
        );
        let repeated = guard
            .record(
                "web_fetch",
                "web fetch returned HTTP 403\nurl: https://second.example",
                0,
            )
            .expect("same failure class should stop after the second occurrence");
        assert_eq!(repeated.1, 2);
        assert!(repeated.0.contains("http 403"));

        assert_eq!(
            guard.record("web_fetch", "web fetch returned HTTP 403", 1),
            None,
            "a workspace mutation starts a fresh failure epoch"
        );

        assert_eq!(guard.record("shell", "exit 1", 1), None);
        assert_eq!(
            guard.record("shell", "exit 1", 1),
            None,
            "generic failures need the existing exact-action guard to avoid false positives"
        );
    }

    #[test]
    fn repeated_missing_proof_final_without_progress_stops() {
        let mut guard = MissingProofGuard::default();

        assert!(!guard.repeated_without_progress(0, None));
        assert!(guard.repeated_without_progress(0, None));
        assert!(!guard.repeated_without_progress(1, None));
        assert!(!guard.repeated_without_progress(1, Some(1)));
        assert!(guard.repeated_without_progress(1, Some(1)));
    }

    #[test]
    fn public_http_actions_route_to_bounded_web_fetch() {
        assert_eq!(
            route_public_http("http".into(), Some("https://example.com/guide")),
            ("web_fetch".into(), true)
        );
        assert_eq!(
            route_public_http("http".into(), Some("http://127.0.0.1:3042/")),
            ("http".into(), false)
        );
        assert_eq!(
            route_public_http("http".into(), Some("https://localhost:3042/")),
            ("http".into(), false)
        );
        assert_eq!(
            route_public_http("web_search".into(), None),
            ("web_search".into(), false)
        );
    }

    #[test]
    fn observation_only_answers_do_not_enter_a_missing_proof_loop() {
        assert!(!final_requires_model_verification(false, 0, None));
        assert!(final_requires_model_verification(false, 1, None));
        assert!(!final_requires_model_verification(false, 1, Some(1)));
        assert!(!final_requires_model_verification(true, 1, None));
    }

    #[test]
    fn successful_read_only_source_tools_count_as_incidental_evidence() {
        assert!(counts_as_read_only_source_evidence(
            Authority::ReadOnly,
            "web_search",
            true
        ));
        assert!(counts_as_read_only_source_evidence(
            Authority::ReadOnly,
            "web_fetch",
            true
        ));
        assert!(!counts_as_read_only_source_evidence(
            Authority::Workspace,
            "web_fetch",
            true
        ));
        assert!(!counts_as_read_only_source_evidence(
            Authority::ReadOnly,
            "read",
            true
        ));
        assert!(!counts_as_read_only_source_evidence(
            Authority::ReadOnly,
            "web_search",
            false
        ));
    }

    #[test]
    fn declared_verification_rejects_external_actions() {
        let commands = vec!["git push origin main".to_string()];
        assert!(validate_declared_verification(&commands, None).is_err());
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
    fn artifacts_parse_unstaged_and_renamed_porcelain_paths() {
        assert_eq!(
            artifact_inventory("clean", " M src/label.rs"),
            vec!["src/label.rs"]
        );
        assert_eq!(
            artifact_inventory("clean", "R  src/old.rs -> src/new.rs"),
            vec!["src/new.rs"]
        );
    }

    #[test]
    fn artifact_paths_are_canonical_workspace_relative() {
        let workspace = temp_workspace().canonicalize().unwrap();
        let nested = workspace.join("src");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("label.rs"), "content").unwrap();

        assert_eq!(
            canonical_artifact_path(&workspace, "src/label.rs"),
            Some("src/label.rs".into())
        );
        assert_eq!(
            canonical_artifact_path(&workspace, &nested.join("label.rs").display().to_string()),
            Some("src/label.rs".into())
        );
        assert_eq!(canonical_artifact_path(&workspace, "../outside.rs"), None);
        fs::remove_dir_all(workspace).expect("remove temporary workspace");
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

    #[test]
    fn retries_only_transient_provider_transport_failures() {
        for error in [
            "model provider returned HTTP 500: {\"error\":\"EOF\"}",
            "model provider returned HTTP 503: overloaded",
            "failed to read Ollama stream: unexpected EOF",
            "invalid Ollama stream response: missing field `message`",
            "the local model stream stopped unexpectedly",
            "cannot reach local model provider: connection reset by peer",
        ] {
            assert!(is_transient_provider_error(error), "{error}");
        }

        for error in [
            "MODEL LOOP DETECTED — repeated block",
            "Protocol error: expected one JSON object",
            "authority denied shell command",
            ADAPTIVE_REASONING_BUDGET_RETRY,
        ] {
            assert!(!is_transient_provider_error(error), "{error}");
        }
    }
}
#[test]
fn model_selection_is_strict_and_defaults_per_provider() {
    use crate::config::{DEFAULT_MODEL, DEFAULT_NATIVE_MODEL};

    // An Ollama tag can never appear in a native catalog, so the native
    // default must be resolved from the provider, not from one shared string.
    let native = vec![
        DEFAULT_NATIVE_MODEL.to_string(),
        "Qwen/Qwen3-4B".to_string(),
    ];
    assert_eq!(
        choose_model_with_env(None, None, ModelProvider::Native, &native).unwrap(),
        DEFAULT_NATIVE_MODEL
    );
    let ollama = vec![DEFAULT_MODEL.to_string(), "qwen3:14b".to_string()];
    assert_eq!(
        choose_model_with_env(None, None, ModelProvider::Ollama, &ollama).unwrap(),
        DEFAULT_MODEL
    );

    // A missing default fails loudly rather than silently running whatever the
    // provider happens to list first.
    let partial = vec!["Qwen/Qwen3-4B".to_string()];
    let error = choose_model_with_env(None, None, ModelProvider::Native, &partial)
        .expect_err("native default is not installed");
    assert!(error.contains(DEFAULT_NATIVE_MODEL), "{error}");
    assert!(error.contains("Qwen/Qwen3-4B"), "{error}");

    // Explicit selection stays strict, and an explicit name still wins.
    assert!(choose_model_with_env(Some("missing"), None, ModelProvider::Native, &partial).is_err());
    assert_eq!(
        choose_model_with_env(None, Some("Qwen/Qwen3-4B"), ModelProvider::Native, &partial)
            .unwrap(),
        "Qwen/Qwen3-4B"
    );
}

#[test]
fn review_model_defaults_per_provider() {
    use crate::config::{DEFAULT_NATIVE_REVIEW_MODEL, DEFAULT_REVIEW_MODEL};

    let native = vec![DEFAULT_NATIVE_REVIEW_MODEL.to_string()];
    assert_eq!(
        choose_review_model(None, ModelProvider::Native, &native).unwrap(),
        DEFAULT_NATIVE_REVIEW_MODEL
    );
    let ollama = vec![DEFAULT_REVIEW_MODEL.to_string()];
    assert_eq!(
        choose_review_model(None, ModelProvider::Ollama, &ollama).unwrap(),
        DEFAULT_REVIEW_MODEL
    );
    assert!(choose_review_model(None, ModelProvider::Native, &ollama).is_err());
}
