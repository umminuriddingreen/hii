use crate::{
    config::{AppPaths, DEFAULT_MODEL, DEFAULT_REVIEW_MODEL},
    contract::{sensitive_shell, Authority, Contract, Decision},
    ollama::{Message, Ollama},
    receipt::{redact_text, unix_ms, Receipt, RunStore, VerificationRecord},
    tools::{ToolResult, Toolbelt},
};
use serde::Deserialize;
use serde_json::json;
use std::{
    io::{self, IsTerminal, Write},
    path::PathBuf,
};

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

pub fn run(paths: &AppPaths, options: RunOptions) -> Result<Receipt, String> {
    if options.goal.trim().is_empty() {
        return Err("goal cannot be empty".into());
    }
    if options.max_steps == 0 || options.max_steps > 64 {
        return Err("max steps must be between 1 and 64".into());
    }

    let tools = Toolbelt::new(options.workspace)?;
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

    let contract = Contract::infer(&options.goal, options.authority);
    store.event(
        "contract",
        json!({
            "goal": contract.goal,
            "authority": contract.authority.label(),
            "done_when": contract.done_when,
        }),
    )?;
    if options.authority == Authority::Yolo {
        println!(
            "⚡ YOLO — autonomous, no approval prompts. Authority: {}. Workspace/secret guards still apply; a full receipt is written.",
            tools.workspace().display()
        );
    }
    if options.verbose {
        println!("HII run {}", store.id);
        println!("{}\n", contract.banner());
    } else if io::stdout().is_terminal() {
        print!("HII is working…\r");
        let _ = io::stdout().flush();
    }
    let mut approvals: Vec<String> = Vec::new();

    let system = system_prompt(tools.workspace(), options.max_steps, options.dry_run);
    let mut messages = vec![Message::system(system), Message::user(options.goal.clone())];
    let mut verification = Vec::new();
    let mut parse_failures = 0usize;
    let mut final_summary = None;
    let mut final_next = None;
    let mut steps = 0usize;

    while steps < options.max_steps {
        steps += 1;
        if options.verbose {
            print!("[{steps}/{}] thinking…\r", options.max_steps);
        }
        let raw = ollama.chat_json(&model, &messages)?;
        if options.verbose {
            print!("\x1b[2K\r");
        }
        store.event(
            "model.response",
            json!({ "step": steps, "content": redact_text(&raw) }),
        )?;
        let action = match parse_action(&raw) {
            Ok(action) => action,
            Err(error) => {
                parse_failures += 1;
                if options.verbose {
                    println!("[{steps}/{}] protocol retry: {error}", options.max_steps);
                }
                messages.push(Message::assistant(raw));
                messages.push(Message::user(format!(
                    "Protocol error: {error}. Return one JSON object matching the required action schema."
                )));
                if parse_failures >= 3 {
                    return Err("model failed the HII action protocol three times".into());
                }
                continue;
            }
        };
        parse_failures = 0;
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
                let label = reason.as_deref().unwrap_or("using workspace tool");
                if options.verbose {
                    println!("[{steps}/{}] ◆ {tool}: {label}", options.max_steps);
                }
                let mutates = matches!(tool.as_str(), "write" | "edit")
                    || (tool == "shell" && command.is_some());
                let sensitive = (tool == "shell" || tool == "verify")
                    && command.as_deref().is_some_and(sensitive_shell);
                let decision = options.authority.decide(mutates, sensitive);
                if let Some(blocked) =
                    enforce_authority(decision, &tool, label, command.as_deref(), &mut approvals)
                {
                    store.event(
                        "authority.block",
                        json!({ "step": steps, "tool": tool, "decision": format!("{decision:?}") }),
                    )?;
                    messages.push(Message::assistant(raw));
                    messages.push(Message::user(blocked));
                    continue;
                }
                let result = execute_tool(
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
                    },
                    options.dry_run,
                );
                let safe_output = redact_text(&result.output);
                if result.verification {
                    verification.push(VerificationRecord {
                        command: command.or(url).unwrap_or_else(|| tool.clone()),
                        ok: result.ok,
                        output: safe_output.clone(),
                    });
                }
                store.event(
                    "tool.result",
                    json!({
                        "step": steps,
                        "tool": tool,
                        "ok": result.ok,
                        "verification": result.verification,
                        "output": safe_output
                    }),
                )?;
                messages.push(Message::assistant(raw));
                messages.push(Message::user(format!(
                    "TOOL RESULT [{}]:\n{}",
                    if result.ok { "ok" } else { "error" },
                    safe_output
                )));
            }
            Action::Final {
                summary,
                verification: claimed,
                next,
            } => {
                if verification.is_empty() {
                    messages.push(Message::assistant(raw));
                    messages.push(Message::user(format!(
                        "No HII verification result exists yet (model claim: {}). Run the actual check with verify or http before finalizing.",
                        if claimed.is_empty() { "none" } else { "present" }
                    )));
                    if options.verbose {
                        println!(
                            "[{steps}/{}] proof required before completion",
                            options.max_steps
                        );
                    }
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
            }
        }
    }

    let completed = final_summary.is_some();
    let summary = redact_text(&final_summary.unwrap_or_else(|| {
        format!(
            "Step limit reached before the model returned a final result ({} steps).",
            options.max_steps
        )
    }));
    let git_status = tools.git_snapshot();
    let review = match review_model.as_deref() {
        Some(reviewer) => {
            if options.verbose {
                println!("review     {reviewer}");
            }
            let prompt = format!(
                "Review this bounded local agent result. Identify only concrete proof gaps or risks in at most 120 words.\n\nGoal: {}\nSummary: {}\nVerification: {}\nGit status:\n{}",
                options.goal,
                summary,
                serde_json::to_string(&verification).unwrap_or_default(),
                git_status
            );
            Some(redact_text(&ollama.chat_text(
                reviewer,
                &[
                    Message::system("You are HII's strict final proof reviewer."),
                    Message::user(prompt),
                ],
            )?))
        }
        None => None,
    };
    let artifacts = artifact_inventory(&git_status);
    let reversible = Some(git_status != "not a git workspace");
    let receipt = Receipt {
        schema_version: 2,
        id: store.id.clone(),
        created_at_unix_ms: store.started_at_unix_ms,
        finished_at_unix_ms: unix_ms(),
        status: if completed { "completed".into() } else { "incomplete".into() },
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
    };
    store.event(
        "run.finished",
        json!({ "status": receipt.status, "summary": receipt.summary }),
    )?;
    let path = store.finish(&paths.runtime, &receipt)?;
    if options.verbose {
        print_receipt(&receipt, &path);
    } else {
        if io::stdout().is_terminal() {
            print!("\x1b[2K\r");
        }
        println!("{}", receipt.summary);
        if let Some(review) = receipt.review.as_deref() {
            println!("\nReview: {review}");
        }
    }
    Ok(receipt)
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

fn system_prompt(workspace: &std::path::Path, max_steps: usize, dry_run: bool) -> String {
    format!(
        r#"You are the local HII workspace agent. Complete the user's goal; do not stop at advice.

Workspace boundary: {workspace}
Step limit: {max_steps}
Dry run: {dry_run}

Loop: inspect -> choose one tool -> act -> observe -> adjust -> verify -> final receipt.
Use the smallest relevant context. Read AGENTS.md before editing when it exists. Preserve unclear work. Do not publish, push, spend, message, delete, read secrets, or access paths outside the workspace. The shell guard is a safety backstop, not permission. Prefer `edit` for changing existing files (exact, minimal), `write` for new files or full rewrites, and `verify` for actual checks. For large files, read a slice with `offset`/`limit`. The `http` tool only reaches local services.

Return exactly one JSON object per turn.

Tool action:
{{"type":"tool","tool":"read|list|search|write|edit|shell|verify|http","path":"relative path","query":"for search","command":"for shell or verify","content":"for write","old":"exact text to replace (edit)","new":"replacement text (edit)","replace_all":false,"offset":1,"limit":200,"url":"for http","reason":"short reason"}}

Final action:
{{"type":"final","summary":"what is now true","verification":["checks actually run"],"next":"highest-value next action or null"}}

Never claim a check ran unless you invoked verify or http and saw its output. Do not wrap JSON in Markdown."#,
        workspace = workspace.display()
    )
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
    serde_json::from_str(candidate).map_err(|error| error.to_string())
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
}

pub(crate) fn execute_tool(tools: &Toolbelt, call: ToolCall, dry_run: bool) -> ToolResult {
    let blocked = |what: &str| ToolResult {
        ok: false,
        output: format!("dry run: {what} skipped"),
        verification: false,
    };
    match call.tool {
        "read" => tools.read_range(call.path.unwrap_or(""), call.offset, call.limit),
        "list" => tools.list(call.path),
        "search" => tools.search(call.query.unwrap_or(""), call.path),
        "write" if dry_run => blocked("write"),
        "write" => tools.write(call.path.unwrap_or(""), call.content.unwrap_or("")),
        "edit" if dry_run => blocked("edit"),
        "edit" => tools.edit(
            call.path.unwrap_or(""),
            call.old.unwrap_or(""),
            call.new.unwrap_or(""),
            call.replace_all,
        ),
        "shell" if dry_run => blocked("shell"),
        "shell" => tools.shell(call.command.unwrap_or(""), false),
        "verify" => tools.shell(call.command.unwrap_or(""), true),
        "http" => tools.http(call.url.unwrap_or("")),
        other => ToolResult {
            ok: false,
            output: format!("unknown or malformed tool: {other}"),
            verification: false,
        },
    }
}

/// Derive a changed-file inventory from a `git status --short` snapshot.
fn artifact_inventory(git_status: &str) -> Vec<String> {
    if git_status == "clean" || git_status == "not a git workspace" {
        return Vec::new();
    }
    git_status
        .lines()
        .filter_map(|line| line.get(3..).map(str::to_string))
        .collect()
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

    #[test]
    fn parses_json_action() {
        let action = parse_action(r#"{"type":"tool","tool":"list","reason":"inspect"}"#).unwrap();
        assert!(matches!(action, Action::Tool { tool, .. } if tool == "list"));
    }

    #[test]
    fn parses_fenced_action() {
        let action = parse_action(
            "```json\n{\"type\":\"final\",\"summary\":\"done\",\"verification\":[]}\n```",
        )
        .unwrap();
        assert!(matches!(action, Action::Final { summary, .. } if summary == "done"));
    }
}
