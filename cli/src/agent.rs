use crate::{
    config::{AppPaths, DEFAULT_MODEL, DEFAULT_REVIEW_MODEL},
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

    if options.verbose {
        println!("HII run {}", store.id);
        println!("workspace  {}", tools.workspace().display());
        println!("model      {}", model);
        println!("goal       {}\n", options.goal);
    } else if io::stdout().is_terminal() {
        print!("HII is working…\r");
        let _ = io::stdout().flush();
    }

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
            } => {
                let label = reason.as_deref().unwrap_or("using workspace tool");
                if options.verbose {
                    println!("[{steps}/{}] {tool}: {label}", options.max_steps);
                }
                let result = execute_tool(
                    &tools,
                    &tool,
                    path.as_deref(),
                    query.as_deref(),
                    command.as_deref(),
                    content.as_deref(),
                    url.as_deref(),
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
    let receipt = Receipt {
        schema_version: 1,
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
Use the smallest relevant context. Read AGENTS.md before editing when it exists. Preserve unclear work. Do not publish, push, spend, message, delete, read secrets, or access paths outside the workspace. The shell guard is a safety backstop, not permission. Use `write` for file edits and `verify` for actual checks. The `http` tool only reaches local services.

Return exactly one JSON object per turn.

Tool action:
{{"type":"tool","tool":"read|list|search|write|shell|verify|http","path":"optional relative path","query":"for search","command":"for shell or verify","content":"for write","url":"for http","reason":"short reason"}}

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

#[allow(clippy::too_many_arguments)]
pub(crate) fn execute_tool(
    tools: &Toolbelt,
    tool: &str,
    path: Option<&str>,
    query: Option<&str>,
    command: Option<&str>,
    content: Option<&str>,
    url: Option<&str>,
    dry_run: bool,
) -> ToolResult {
    match tool {
        "read" => tools.read(path.unwrap_or("")),
        "list" => tools.list(path),
        "search" => tools.search(query.unwrap_or(""), path),
        "write" if dry_run => ToolResult {
            ok: false,
            output: "dry run: write skipped".into(),
            verification: false,
        },
        "write" => tools.write(path.unwrap_or(""), content.unwrap_or("")),
        "shell" if dry_run => ToolResult {
            ok: false,
            output: "dry run: shell skipped".into(),
            verification: false,
        },
        "shell" => tools.shell(command.unwrap_or(""), false),
        "verify" => tools.shell(command.unwrap_or(""), true),
        "http" => tools.http(url.unwrap_or("")),
        _ => ToolResult {
            ok: false,
            output: format!("unknown or malformed tool: {tool}"),
            verification: false,
        },
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
