//! Read-only, continuously legible projection of the HII run journal.
//!
//! The append-only JSONL journal remains authoritative. This module is a cheap
//! renderer: it never calls a model, copies raw tool output, or creates a
//! competing event store.

use chrono::{DateTime, Local};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Seek, SeekFrom},
    path::{Path, PathBuf},
    thread,
    time::{Duration, SystemTime},
};

const INITIAL_ROWS: usize = 40;
const POLL_INTERVAL: Duration = Duration::from_millis(100);

pub fn watch(
    runtime: &Path,
    workspace: &Path,
    run_id: Option<&str>,
    follow: bool,
    raw_jsonl: bool,
) -> Result<(), String> {
    let path = resolve_events(runtime, workspace, run_id)?;
    let file = File::open(&path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut lines = Vec::new();
    let mut line = String::new();
    while reader
        .read_line(&mut line)
        .map_err(|error| error.to_string())?
        > 0
    {
        if let Some(event) = parse(&line) {
            lines.push(event);
        }
        line.clear();
    }

    if !raw_jsonl {
        println!("HII // LIVE STREAM");
        println!("source  {}", path.display());
        println!(
            "mode    {} · 100ms observation cadence",
            if follow { "following" } else { "snapshot" }
        );
        println!("────────────────────────────────────────────────────────────────");
    }
    for event in lines.iter().skip(lines.len().saturating_sub(INITIAL_ROWS)) {
        present(event, raw_jsonl);
    }
    if !follow {
        return Ok(());
    }

    // The initial read leaves the cursor at EOF. New complete JSONL records are
    // rendered as they arrive; partial writes remain buffered until newline.
    let offset = reader
        .stream_position()
        .map_err(|error| error.to_string())?;
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    loop {
        match reader.read_line(&mut line) {
            Ok(0) => thread::sleep(POLL_INTERVAL),
            Ok(_) => {
                if let Some(event) = parse(&line) {
                    present(&event, raw_jsonl);
                }
                line.clear();
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn resolve_events(
    runtime: &Path,
    workspace: &Path,
    run_id: Option<&str>,
) -> Result<PathBuf, String> {
    let runs = runtime.join("runs/cli");
    if let Some(run_id) = run_id {
        let direct = runs.join(run_id).join("events.jsonl");
        if direct.is_file() {
            return Ok(direct);
        }
        let matches = fs::read_dir(&runs)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(run_id))
            })
            .collect::<Vec<_>>();
        return match matches.as_slice() {
            [path] => Ok(path.join("events.jsonl")),
            _ => Err(format!("run id `{run_id}` was not found or is ambiguous")),
        };
    }

    let canonical = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    let mut candidates = fs::read_dir(&runs)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path().join("events.jsonl"))
        .filter(|path| path.is_file() && belongs_to_workspace(path, &canonical))
        .map(|path| {
            let modified = fs::metadata(&path)
                .and_then(|metadata| metadata.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            (modified, path)
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.0));
    candidates
        .into_iter()
        .next()
        .map(|(_, path)| path)
        .ok_or_else(|| format!("no HII run stream found for {}", workspace.display()))
}

fn belongs_to_workspace(path: &Path, workspace: &Path) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| parse(&line))
        .find(|event| event.kind == "run.started")
        .and_then(|event| {
            event
                .data
                .get("workspace")
                .and_then(Value::as_str)
                .map(PathBuf::from)
        })
        .map(|path| path.canonicalize().unwrap_or(path) == workspace)
        .unwrap_or(false)
}

#[derive(Clone, Debug)]
struct StoredEvent {
    at_unix_ms: u128,
    run_id: String,
    kind: String,
    data: Value,
}

fn parse(line: &str) -> Option<StoredEvent> {
    let value: Value = serde_json::from_str(line).ok()?;
    Some(StoredEvent {
        at_unix_ms: value.get("ts_unix_ms")?.as_u64()? as u128,
        run_id: value
            .get("run_id")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        kind: value.get("kind")?.as_str()?.to_string(),
        data: value.get("data").cloned().unwrap_or(Value::Null),
    })
}

fn present(event: &StoredEvent, raw_jsonl: bool) {
    if raw_jsonl {
        println!(
            "{}",
            json!({
                "schemaVersion": 1,
                "event": event.kind,
                "atUnixMs": event.at_unix_ms,
                "source": "cli.run",
                "scope": { "runId": event.run_id },
                "data": event.data
            })
        );
        return;
    }
    let Some((glyph, lane, summary)) = human_row(event) else {
        return;
    };
    println!(
        "{}  {}  {:<9} {}",
        timestamp(event.at_unix_ms),
        glyph,
        lane,
        one_line(&summary, 88)
    );
}

fn human_row(event: &StoredEvent) -> Option<(&'static str, &'static str, String)> {
    let string = |key: &str| event.data.get(key).and_then(Value::as_str).unwrap_or("");
    match event.kind.as_str() {
        "run.started" => Some(("◎", "OBJECTIVE", string("goal").to_string())),
        "contract" => Some((
            "◇",
            "BOUNDARY",
            format!("done when: {}", string("done_when")),
        )),
        "tool.started" => Some((
            "◉",
            "ACT",
            format!("{} · {}", string("tool"), string("target")),
        )),
        "tool.result" => Some((
            if event.data.get("ok").and_then(Value::as_bool) == Some(true) {
                "✓"
            } else {
                "!"
            },
            if event.data.get("verification").and_then(Value::as_bool) == Some(true) {
                "PROOF"
            } else {
                "OBSERVE"
            },
            format!(
                "{} · {}",
                string("tool"),
                if event.data.get("ok").and_then(Value::as_bool) == Some(true) {
                    "ok"
                } else {
                    "failed"
                }
            ),
        )),
        "mcp.result" => Some((
            "↳",
            "AGENT",
            format!("{} · {}", string("server"), string("tool")),
        )),
        "model.usage" => Some((
            "◌",
            "METER",
            format!(
                "{} tokens used · {} remaining",
                event
                    .data
                    .get("total_prompt_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    + event
                        .data
                        .get("total_completion_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                event
                    .data
                    .get("remaining_tokens")
                    .and_then(Value::as_u64)
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unbounded".into())
            ),
        )),
        "acceptance.result" => Some((
            if event.data.get("ok").and_then(Value::as_bool) == Some(true) {
                "✓"
            } else {
                "!"
            },
            "PROOF",
            string("command").to_string(),
        )),
        "budget.exceeded" => Some(("!", "ATTENTION", format!("{} exhausted", string("budget")))),
        "authority.block" | "run.blocked" => Some(("!", "BLOCKED", string("reason").to_string())),
        "run.interrupted" => Some(("■", "PAUSED", string("reason").to_string())),
        "run.finished" => Some(("●", "COMPLETE", string("summary").to_string())),
        "protocol.retry" | "model.loop_detected" => Some(("!", "RECOVER", event.kind.clone())),
        // Full model text and feedback remain available in the raw journal but
        // are intentionally not sprayed across the human stream.
        _ => None,
    }
}

fn timestamp(milliseconds: u128) -> String {
    DateTime::from_timestamp_millis(milliseconds.min(i64::MAX as u128) as i64)
        .map(|value| {
            value
                .with_timezone(&Local)
                .format("%H:%M:%S%.3f")
                .to_string()
        })
        .unwrap_or_else(|| "--:--:--.---".into())
}

fn one_line(value: &str, max: usize) -> String {
    let compact = value
        .replace("\\n", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if compact.chars().count() <= max {
        compact
    } else {
        compact
            .chars()
            .take(max.saturating_sub(1))
            .collect::<String>()
            + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_projection_hides_raw_model_and_flattens_escaped_lines() {
        let event = StoredEvent {
            at_unix_ms: 1,
            run_id: "run".into(),
            kind: "tool.started".into(),
            data: json!({"tool":"read", "target":"one\\ntwo"}),
        };
        let (_, lane, text) = human_row(&event).unwrap();
        assert_eq!(lane, "ACT");
        assert_eq!(one_line(&text, 80), "read · one two");

        let raw = StoredEvent {
            kind: "model.response".into(),
            ..event
        };
        assert!(human_row(&raw).is_none());
    }

    #[test]
    fn token_meter_reports_cumulative_usage() {
        let event = StoredEvent {
            at_unix_ms: 1,
            run_id: "run".into(),
            kind: "model.usage".into(),
            data: json!({
                "total_prompt_tokens": 100,
                "total_completion_tokens": 25,
                "remaining_tokens": 875
            }),
        };
        let (_, lane, text) = human_row(&event).unwrap();
        assert_eq!(lane, "METER");
        assert!(text.contains("125 tokens used"));
        assert!(text.contains("875 remaining"));
    }
}
