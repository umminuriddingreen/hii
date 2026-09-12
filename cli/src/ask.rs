//! The smallest HII interaction: one prompt, one local streamed answer.

use crate::{
    agent,
    budget::Cancel,
    config::AppPaths,
    ollama::{ChatStreamEvent, Message, Ollama},
};
use serde_json::json;
use std::{
    io::{self, Write},
    sync::mpsc,
    thread,
};

const SYSTEM_PROMPT: &str =
    "Answer the user directly and concisely. Return only the answer, with no tool protocol.";

pub fn run(
    paths: &AppPaths,
    requested_model: Option<&str>,
    prompt: String,
    jsonl: bool,
) -> Result<(), String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("ask needs a prompt".into());
    }

    let ollama = Ollama::discover().ensure_reachable()?;
    let models = ollama.models()?;
    let env_model_present = std::env::var_os("HII_MODEL").is_some();
    let saved_model = if requested_model.is_none() {
        paths
            .user_model_preference()?
            .map(|preference| preference.model)
    } else {
        None
    };
    let (requested, _) = agent::requested_model_selection(
        requested_model,
        saved_model.as_deref(),
        env_model_present,
    );
    let model = agent::choose_model(requested, ollama.provider(), &models)?;
    let system = format!(
        "{SYSTEM_PROMPT}\n\n{}",
        crate::config::runtime_identity_context(ollama.provider(), &model, ollama.base_url(),)
    );
    let messages = vec![Message::system(system), Message::user(prompt)];
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
    while let Ok(event) = receiver.recv() {
        match event {
            ChatStreamEvent::Thinking(_) => {}
            ChatStreamEvent::Content(text) => {
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
                                "tokensPerSecond": result.usage.tokens_per_second()
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_system_prompt_does_not_request_agent_actions() {
        assert!(SYSTEM_PROMPT.contains("directly"));
        assert!(!SYSTEM_PROMPT.contains("JSON action"));
        assert!(!SYSTEM_PROMPT.contains("tool call"));
    }
}
