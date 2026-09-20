//! The smallest HII interaction: one prompt, one local streamed answer.

use crate::{
    agent,
    budget::Cancel,
    config::AppPaths,
    ollama::{ChatStreamEvent, Message, Ollama},
    receipt::{
        classify_error, redact_text, Outcome, Receipt, RunGuard, RunStore, TokenUsageRecord,
    },
};
use serde_json::json;
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
};

const SYSTEM_PROMPT: &str =
    "Answer the user directly and concisely. Return only the answer, with no tool protocol.";
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug)]
struct SourceBundle {
    prompt: String,
    provenance: Vec<String>,
}

pub fn run(
    paths: &AppPaths,
    requested_model: Option<&str>,
    prompt: String,
    sources: Vec<PathBuf>,
    requested_workspace: Option<&Path>,
    jsonl: bool,
) -> Result<(), String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("ask needs a prompt".into());
    }

    let workspace = match requested_workspace {
        Some(path) => path
            .canonicalize()
            .map_err(|error| format!("cannot resolve --cwd {}: {error}", path.display()))?,
        None => std::env::current_dir().map_err(|error| error.to_string())?,
    };
    let source_bundle = load_sources(&workspace, prompt, &sources)?;
    let model_prompt = source_bundle.prompt.as_str();
    if crate::run_context::conversation_id().is_none() {
        crate::run_context::set_conversation_id(&hii_core::run_ledger::new_run_id());
    }
    let mut store = RunStore::create(&paths.runtime)?;
    crate::run_context::set_run_id(&store.id);
    store.set_authority("read-only")?;
    crate::run_context::set_origin(crate::run_context::WriteOrigin::Operator);
    let mut guard = Some(RunGuard::start(
        &paths.runtime,
        &store.dir,
        &store.id,
        ask_receipt(
            &store,
            prompt,
            &workspace,
            requested_model.unwrap_or("unresolved"),
            Outcome::Running,
            "Ask run in progress.",
            None,
            &source_bundle.provenance,
        ),
    )?);
    store.event(
        "run.started",
        json!({
            "goal": redact_text(prompt),
            "workspace": workspace,
            "surface": store.envelope().surface,
            "conversationId": crate::run_context::conversation_id()
        }),
    )?;

    let result = (|| -> Result<(), String> {
        let ollama = Ollama::discover().ensure_reachable()?;
        let models = ollama.models()?;
        let env_model_present = std::env::var_os("HII_MODEL").is_some();
        let saved_model = if requested_model.is_none() {
            agent::saved_model_for_provider(paths, ollama.provider())?
        } else {
            None
        };
        let (requested, _) = agent::requested_model_selection(
            requested_model,
            saved_model.as_deref(),
            env_model_present,
        );
        let model = agent::choose_model(requested, ollama.provider(), &models)?;
        crate::run_context::set_model_route(requested, &model, "ask selection");
        store.set_model_route(requested, &model, &model, "ask selection")?;
        let system = format!(
            "{SYSTEM_PROMPT}\n\n{}",
            crate::config::runtime_identity_context(ollama.provider(), &model, ollama.base_url(),)
        );
        let messages = vec![Message::system(system), Message::user(model_prompt)];
        let transcript = messages
            .iter()
            .map(|message| {
                json!({
                    "role": message.role,
                    "content": redact_text(&message.content),
                    "imageCount": message.images.len()
                })
            })
            .collect::<Vec<_>>();
        store.event(
            "model.request",
            json!({
                "provider": ollama.provider().id(),
                "requestedModel": requested,
                "routedModel": model,
                "messages": transcript
            }),
        )?;
        let cancel = Cancel::new();
        let (sender, receiver) = mpsc::channel();
        let worker_ollama = ollama.clone();
        let worker_model = model.clone();
        let worker_cancel = cancel.clone();
        thread::spawn(move || {
            worker_ollama.chat_with_stream(
                &worker_model,
                &messages,
                false,
                false,
                &worker_cancel,
                sender,
            );
        });

        let mut stdout = io::stdout().lock();
        let mut answer = String::new();
        while let Ok(event) = receiver.recv() {
            match event {
                ChatStreamEvent::Thinking(_) => {}
                ChatStreamEvent::Content(text) => {
                    answer.push_str(&text);
                    if jsonl {
                        writeln!(
                            stdout,
                            "{}",
                            json!({
                                "schemaVersion": 1,
                                "event": "model.delta",
                                "data": { "channel": "content", "text": text }
                            })
                        )
                        .map_err(|error| error.to_string())?;
                    } else {
                        write!(stdout, "{text}").map_err(|error| error.to_string())?;
                    }
                    stdout.flush().map_err(|error| error.to_string())?;
                }
                ChatStreamEvent::Done(Ok(result)) => {
                    store.event(
                        "model.response",
                        json!({
                            "provider": ollama.provider().id(),
                            "model": model,
                            "content": redact_text(&answer),
                            "promptTokens": result.usage.prompt_tokens,
                            "completionTokens": result.usage.completion_tokens,
                            "durationMs": result.usage.total_duration_ms
                        }),
                    )?;
                    let receipt = ask_receipt(
                        &store,
                        prompt,
                        &workspace,
                        &model,
                        Outcome::Completed,
                        &answer,
                        Some(TokenUsageRecord {
                            prompt_tokens: result.usage.prompt_tokens,
                            completion_tokens: result.usage.completion_tokens,
                            budget: 0,
                        }),
                        &source_bundle.provenance,
                    );
                    store.event(
                        "run.finished",
                        json!({
                            "status": receipt.status,
                            "summary": receipt.summary
                        }),
                    )?;
                    let proof = guard
                        .take()
                        .ok_or("HII ask receipt guard was already finalized")?
                        .finalize(&receipt)?;
                    if jsonl {
                        writeln!(
                            stdout,
                            "{}",
                            json!({
                                "schemaVersion": 1,
                                "event": "ask.finished",
                                "data": {
                                    "model": model,
                                    "promptTokens": result.usage.prompt_tokens,
                                    "completionTokens": result.usage.completion_tokens,
                                    "durationMs": result.usage.total_duration_ms,
                                    "tokensPerSecond": result.usage.tokens_per_second(),
                                    "runId": store.id,
                                    "proof": proof
                                }
                            })
                        )
                        .map_err(|error| error.to_string())?;
                    } else {
                        writeln!(stdout).map_err(|error| error.to_string())?;
                    }
                    return Ok(());
                }
                ChatStreamEvent::Done(Err(error)) => return Err(error),
            }
        }
        Err("local model stream ended without a result".into())
    })();
    if let Err(error) = &result {
        let outcome = classify_error(error);
        let _ = store.event(
            "run.failed",
            json!({
                "outcome": outcome.label(),
                "error": redact_text(error)
            }),
        );
        if let Some(guard) = guard.as_mut() {
            guard.checkpoint_error(outcome, error, 1)?;
        }
    }
    result
}

fn ask_receipt(
    store: &RunStore,
    prompt: &str,
    workspace: &std::path::Path,
    model: &str,
    outcome: Outcome,
    summary: &str,
    token_usage: Option<TokenUsageRecord>,
    context_sources: &[String],
) -> Receipt {
    Receipt {
        schema_version: 9,
        id: store.id.clone(),
        created_at_unix_ms: store.started_at_unix_ms,
        finished_at_unix_ms: if outcome == Outcome::Running { 0 } else { crate::clock::unix_ms() },
        status: outcome.status().into(),
        goal: redact_text(prompt),
        workspace: workspace.display().to_string(),
        model: model.to_string(),
        review_model: None,
        steps: 1,
        summary: redact_text(summary),
        verification: Vec::new(),
        git_status: "not captured (ask is read-only)".into(),
        next: None,
        review: None,
        risk: "Local no-tools inference; operational transcript is retained in the private run ledger.".into(),
        authority: Some("read-only".into()),
        done_when: None,
        approvals: Vec::new(),
        artifacts: Vec::new(),
        reversible: Some(true),
        context_sources: context_sources.to_vec(),
        preexisting_changes: Vec::new(),
        hooks: Vec::new(),
        outcome: outcome.label().into(),
        exit_code: outcome.exit_code(),
        completion: None,
        model_source: Some("ask".into()),
        autonomy_level: Some("read-only".into()),
        learning_candidates: Vec::new(),
        user_corrections: Vec::new(),
        failure_patterns: Vec::new(),
        skill_draft_ref: None,
        token_usage,
        engine: None,
    }
}

fn load_sources(
    workspace: &Path,
    prompt: &str,
    sources: &[PathBuf],
) -> Result<SourceBundle, String> {
    if sources.is_empty() {
        return Ok(SourceBundle {
            prompt: prompt.to_string(),
            provenance: Vec::new(),
        });
    }

    let mut total_bytes = 0_u64;
    let mut combined = String::with_capacity(prompt.len() + 1024);
    combined.push_str(prompt);
    combined.push_str("\n\nUse the following user-approved sources. Cite them by the displayed path and do not invent missing content.\n");
    let mut provenance = Vec::with_capacity(sources.len());

    for source in sources {
        let resolved = if source.is_absolute() {
            source.clone()
        } else {
            workspace.join(source)
        };
        let canonical = resolved
            .canonicalize()
            .map_err(|error| format!("cannot resolve source {}: {error}", source.display()))?;
        let metadata = fs::metadata(&canonical)
            .map_err(|error| format!("cannot inspect source {}: {error}", canonical.display()))?;
        if !metadata.is_file() {
            return Err(format!("source is not a file: {}", canonical.display()));
        }
        if metadata.len() > MAX_SOURCE_BYTES {
            return Err(format!(
                "source exceeds the 2 MiB limit: {} ({} bytes)",
                canonical.display(),
                metadata.len()
            ));
        }
        total_bytes = total_bytes.saturating_add(metadata.len());
        if total_bytes > MAX_TOTAL_SOURCE_BYTES {
            return Err(format!(
                "attached sources exceed the 8 MiB total limit ({} bytes)",
                total_bytes
            ));
        }
        let content = fs::read_to_string(&canonical).map_err(|error| {
            format!(
                "source must be valid UTF-8 text (extract PDFs first): {}: {error}",
                canonical.display()
            )
        })?;
        let label = canonical.display().to_string();
        provenance.push(label.clone());
        combined.push_str("\n\n--- SOURCE: ");
        combined.push_str(&label);
        combined.push_str(" ---\n");
        combined.push_str(&content);
    }

    Ok(SourceBundle {
        prompt: combined,
        provenance,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn chat_system_prompt_does_not_request_agent_actions() {
        assert!(SYSTEM_PROMPT.contains("directly"));
        assert!(!SYSTEM_PROMPT.contains("JSON action"));
        assert!(!SYSTEM_PROMPT.contains("tool call"));
    }

    #[test]
    fn attached_sources_are_grounded_and_provenanced() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("hii-ask-source-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("brief.txt"), "authoritative requirement").unwrap();

        let bundle = load_sources(&root, "Summarize", &[PathBuf::from("brief.txt")]).unwrap();

        assert!(bundle.prompt.contains("Summarize"));
        assert!(bundle.prompt.contains("authoritative requirement"));
        assert_eq!(
            bundle.provenance,
            vec![root
                .join("brief.txt")
                .canonicalize()
                .unwrap()
                .display()
                .to_string()]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn attached_sources_reject_missing_files() {
        let error = load_sources(
            Path::new("/tmp"),
            "Summarize",
            &[PathBuf::from("hii-source-that-does-not-exist.txt")],
        )
        .unwrap_err();
        assert!(error.contains("cannot resolve source"));
    }
}
