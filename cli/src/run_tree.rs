//! Read-only projection of one conversation journal into expandable runs.
use serde_json::Value;
use std::{path::Path, process::Command};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Artifact {
    label: String,
    target: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Row {
    label: String,
    detail: String,
    artifacts: Vec<Artifact>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Run {
    title: String,
    rows: Vec<Row>,
}

/// Show the conversation's durable run journal. In a terminal this is a nested,
/// inline picker; in pipes it returns a stable plain-text tree.
pub fn browse(events: &[Value]) -> Result<String, String> {
    let runs = build(events);
    if !crate::picker::is_available() {
        return Ok(frame(&runs));
    }
    let choices = runs
        .iter()
        .enumerate()
        .rev()
        .map(|(i, run)| {
            crate::picker::Choice::new(
                i.to_string(),
                format!("{} · {} events", run.title, run.rows.len()),
            )
        })
        .collect::<Vec<_>>();
    let Some(selected) = crate::picker::select("Runs in this conversation", &choices)? else {
        return Ok("Run tree closed.".into());
    };
    let Ok(run_index) = selected.parse::<usize>() else {
        return Ok("Run tree closed.".into());
    };
    let run = &runs[run_index];
    let choices = run
        .rows
        .iter()
        .enumerate()
        .map(|(i, row)| {
            crate::picker::Choice::new(
                format!("{i}"),
                format!("{} · {}", row.label, preview(&row.detail)),
            )
        })
        .collect::<Vec<_>>();
    let Some(selected) = crate::picker::select(&run.title, &choices)? else {
        return Ok("Run tree closed.".into());
    };
    let Ok(index) = selected.parse::<usize>() else {
        return Ok("Run tree closed.".into());
    };
    let row = &run.rows[index];
    if row.artifacts.is_empty() {
        return Ok(format!("{}\n{}", row.label, row.detail));
    }
    let artifact_choices = row
        .artifacts
        .iter()
        .enumerate()
        .map(|(i, artifact)| {
            crate::picker::Choice::new(
                i.to_string(),
                format!("{} · {}", artifact.label, artifact.target),
            )
        })
        .collect::<Vec<_>>();
    if let Some(selected) =
        crate::picker::select("Open an existing run artifact", &artifact_choices)?
    {
        if let Ok(index) = selected.parse::<usize>() {
            let artifact = &row.artifacts[index];
            return Ok(match open_artifact(&artifact.target) {
                Ok(()) => format!("Opened {}.", artifact.label),
                Err(error) => format!("Could not open {}: {error}", artifact.label),
            });
        }
    }
    Ok("Run tree closed.".into())
}

/// Plain, noninteractive projection for pipes and isolated public-test sessions.
pub fn render(events: &[Value]) -> String {
    frame(&build(events))
}

fn build(events: &[Value]) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    for event in events {
        let kind = event
            .get("kind")
            .or_else(|| event.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let data = event.get("data").unwrap_or(event);
        match kind {
            "user.message" | "conversation.steered" => {
                runs.push(Run {
                    title: format!("Run {}", runs.len() + 1),
                    rows: vec![Row {
                        label: "User intent".into(),
                        detail: clean(&text(data, &["content", "message", "text"])),
                        artifacts: artifacts(data),
                    }],
                });
            }
            "run.linked" | "run.started" => {
                if let Some(run) = runs.last_mut() {
                    let goal = text(data, &["goal"]);
                    if !goal.is_empty()
                        && run
                            .rows
                            .first()
                            .is_some_and(|row| row.detail == "(details unavailable)")
                    {
                        run.rows[0].detail = clean(&goal);
                    }
                    let id = text(data, &["run_id", "id"]);
                    if !id.is_empty() {
                        run.title = format!("{} · {}", run.title, clean(&id));
                    }
                    let model = text(data, &["model"]);
                    if !model.is_empty() {
                        run.rows.push(Row {
                            label: "Run started".into(),
                            detail: clean(&model),
                            artifacts: artifacts(data),
                        });
                    }
                } else {
                    let goal = text(data, &["goal"]);
                    runs.push(Run {
                        title: format!("Run {}", runs.len() + 1),
                        rows: vec![Row {
                            label: "User intent".into(),
                            detail: clean(&goal),
                            artifacts: artifacts(data),
                        }],
                    });
                }
            }
            "assistant.message" | "assistant.completed" | "assistant.response" => {
                add(&mut runs, "Assistant", data)
            }
            "tool.action"
            | "tool.action.result"
            | "tool.result"
            | "tool.output"
            | "tool.output.partial"
            | "info"
            | "verification"
            | "artifact.created"
            | "artifact" => add(&mut runs, kind, data),
            "run.completed"
            | "run.finished"
            | "run.failed"
            | "run.cancelled"
            | "conversation.compacted"
            | "conversation.undo"
            | "background.started"
            | "background.completed" => add(&mut runs, kind, data),
            _ => {}
        }
    }
    // Journals can predate run.started. Keep visible conversational items.
    if runs.is_empty() {
        for event in events {
            let kind = event.get("kind").and_then(Value::as_str).unwrap_or("");
            if matches!(kind, "user.message" | "assistant.message") {
                add(
                    &mut runs,
                    if kind == "user.message" {
                        "User"
                    } else {
                        "Assistant"
                    },
                    event.get("data").unwrap_or(event),
                );
            }
        }
        if !runs.is_empty() {
            runs[0].title = "Conversation history".into();
        }
    }
    runs
}
fn add(runs: &mut [Run], label: &str, data: &Value) {
    if let Some(run) = runs.last_mut() {
        let value = text(
            data,
            &[
                "tool", "name", "content", "output", "message", "goal", "summary", "status",
                "path", "url",
            ],
        );
        run.rows.push(Row {
            label: clean(label),
            detail: clean(&value),
            artifacts: artifacts(data),
        });
    }
}
fn text(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}
fn clean(value: &str) -> String {
    let s: String = value.chars().filter(|c| !c.is_control()).collect();
    if s.trim().is_empty() {
        "(details unavailable)".into()
    } else {
        s
    }
}
fn preview(value: &str) -> String {
    let mut chars = value.chars();
    let clipped: String = chars.by_ref().take(220).collect();
    if chars.next().is_some() {
        format!("{clipped}…")
    } else {
        clipped
    }
}
fn artifacts(value: &Value) -> Vec<Artifact> {
    let mut found = Vec::new();
    collect(value, &mut found);
    found.sort_by(|a, b| a.target.cmp(&b.target));
    found.dedup_by(|a, b| a.target == b.target);
    found
}
fn collect(value: &Value, found: &mut Vec<Artifact>) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if let Some(s) = value.as_str() {
                    let k = key.to_ascii_lowercase();
                    if matches!(k.as_str(), "content" | "output" | "message" | "summary") {
                        for candidate in artifact_mentions(s) {
                            found.push(Artifact {
                                label: clean(key),
                                target: candidate,
                            });
                        }
                    }
                    if (k.contains("path")
                        || k.contains("file")
                        || k.contains("artifact")
                        || k == "url"
                        || k.ends_with("uri"))
                        && safe_target(s)
                    {
                        found.push(Artifact {
                            label: clean(key),
                            target: s.trim().to_string(),
                        });
                    }
                } else {
                    collect(value, found);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                collect(value, found);
            }
        }
        _ => {}
    }
}
fn artifact_mentions(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .filter_map(|word| {
            let candidate = word.trim_matches(|c: char| {
                matches!(
                    c,
                    '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';' | '.' | '"' | '\''
                )
            });
            safe_target(candidate).then(|| candidate.to_string())
        })
        .collect()
}
fn safe_target(target: &str) -> bool {
    if target.chars().any(char::is_control) {
        return false;
    }
    if target.starts_with("https://") || target.starts_with("http://") {
        let Some((_, rest)) = target.split_once("://") else {
            return false;
        };
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        return !authority.is_empty() && !authority.contains('@') && target == target.trim();
    }
    if target.contains("://") || target.starts_with("file:") {
        return false;
    }
    let ext = Path::new(target)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "avif"
            | "html"
            | "htm"
            | "pdf"
            | "svg"
            | "glb"
            | "gltf"
            | "obj"
            | "stl"
            | "3dm"
            | "blend"
    )
}
fn open_artifact(target: &str) -> Result<(), String> {
    if !safe_target(target) {
        return Err("unsupported artifact target".into());
    }
    let url = target.starts_with("https://") || target.starts_with("http://");
    if !url && !Path::new(target).is_file() {
        return Err("local file does not exist".into());
    }
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = Command::new("explorer.exe");
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut cmd = Command::new("xdg-open");
    let target = if url {
        target.to_string()
    } else {
        // An absolute path cannot be interpreted as an opener command option.
        Path::new(target)
            .canonicalize()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned()
    };
    cmd.arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
fn frame(runs: &[Run]) -> String {
    if runs.is_empty() {
        return "RUNS\n  No durable runs in this conversation.".into();
    }
    let mut out = String::from("RUNS\n");
    for (i, run) in runs.iter().enumerate() {
        out.push_str(&format!(
            "{} {}\n",
            if i + 1 == runs.len() {
                "└─"
            } else {
                "├─"
            },
            clean(&run.title)
        ));
        for (j, row) in run.rows.iter().enumerate() {
            out.push_str(&format!(
                "   {} {} — {}\n",
                if j + 1 == run.rows.len() {
                    "└─"
                } else {
                    "├─"
                },
                clean(&row.label),
                clean(&row.detail)
            ));
            for a in &row.artifacts {
                out.push_str(&format!(
                    "      ↳ {}: {}\n",
                    clean(&a.label),
                    clean(&a.target)
                ));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn groups_thread_events_into_separate_runs_and_sanitizes_controls() {
        let events = vec![
            serde_json::json!({"kind":"user.message","data":{"content":"make image"}}),
            serde_json::json!({"kind":"run.linked","data":{"run_id":"r1","goal":"make image","model":"local"}}),
            serde_json::json!({"kind":"tool.result","data":{"tool":"image_gen","output":{"artifact_path":"/tmp/a.png"}}}),
            serde_json::json!({"kind":"assistant.message","data":{"content":"done\nunsafe"}}),
            serde_json::json!({"kind":"run.finished","data":{"run_id":"r1","status":"complete","summary":"made image"}}),
            serde_json::json!({"kind":"user.message","data":{"content":"next"}}),
            serde_json::json!({"kind":"run.linked","data":{"run_id":"r2","goal":"next"}}),
        ];
        let runs = build(&events);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].rows[0].detail, "make image");
        assert_eq!(runs[0].rows[2].artifacts[0].target, "/tmp/a.png");
        assert_eq!(runs[0].rows[3].detail, "doneunsafe");
        assert!(frame(&runs).contains("made image"));
    }
    #[test]
    fn rejects_script_and_non_http_urls() {
        assert!(!safe_target("javascript:alert(1)"));
        assert!(!safe_target("file:///tmp/a.png"));
        assert!(!safe_target("https://user:secret@example.test/a.png"));
        assert!(safe_target("https://example.test/view"));
    }
}
