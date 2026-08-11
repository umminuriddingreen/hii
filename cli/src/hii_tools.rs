//! HII operating-logic tools (plan Phase 9).
//!
//! These let the workspace agent work *through* HII rather than around it:
//! reading the operational graph, checking capabilities, touching the local
//! board, searching skills, and handing off over the bridge. Read tools shell
//! out to the `hii` front controller (which routes context/og/caps/bridge to
//! the compatibility layer); they are local-first and carry no network effect.

use crate::tools::ToolResult;
use serde_json::Value;
use std::{
    path::Path,
    process::{Command, Stdio},
};

/// The HII-native tool names the agent may call, in addition to the filesystem
/// toolbelt. Kept in one place so the schema, dispatcher, and docs agree.
pub const HII_TOOLS: &[&str] = &[
    "hii_context",
    "og_next",
    "caps_check",
    "board_read",
    "board_write",
    "skill_search",
    "schedule_read",
    "schedule_write",
    "bridge_send",
    "bridge_read",
    "object_list",
    "object_read",
];

pub fn is_hii_tool(tool: &str) -> bool {
    HII_TOOLS.contains(&tool)
}

/// Does this HII tool change state (and so count as a mutation for authority)?
pub fn is_mutating(tool: &str) -> bool {
    matches!(tool, "board_write" | "schedule_write" | "bridge_send")
}

/// Dispatch an HII tool. `repo` is the HII repository root; `query` carries the
/// tool's single free-text argument (a task title, search term, or message).
pub fn execute(repo: &Path, tool: &str, query: Option<&str>) -> ToolResult {
    let arg = query.unwrap_or("").trim();
    let result = match tool {
        "hii_context" => hii(repo, &["context", "--json"]).and_then(compact_context),
        "og_next" => hii(repo, &["og", "status"]),
        "caps_check" => hii(repo, &["caps", "show"]),
        "board_read" => hii(repo, &["board"]),
        "board_write" => {
            if arg.is_empty() {
                Err("board_write needs a task title in `query`".to_string())
            } else {
                hii(repo, &["task", arg])
            }
        }
        "skill_search" => skill_search(repo, arg),
        "schedule_read" => hii(repo, &["schedule", "list"]),
        "schedule_write" => {
            let (cron, task) = arg.split_once("::").unwrap_or(("", ""));
            if cron.trim().is_empty() || task.trim().is_empty() {
                Err("schedule_write needs `<five-field cron>::<task>` in `query`".to_string())
            } else {
                hii(repo, &["schedule", "add", cron.trim(), task.trim()])
            }
        }
        "bridge_send" => {
            if arg.is_empty() {
                Err("bridge_send needs a message in `query`".to_string())
            } else {
                hii(repo, &["bridge", "send", arg])
            }
        }
        "bridge_read" => hii(repo, &["bridge", "read"]),
        // Object reads only. Object *writes* are not exposed as a free-form
        // agent tool: a mutation needs an approved scope, a base version and an
        // idempotency key, none of which fit a single free-text argument, and
        // guessing them is exactly what the governed interface exists to stop.
        // `query` names the approved grant, never the scope itself: a caller that
        // describes its own authority does not have any.
        "object_list" => {
            if arg.is_empty() {
                Err("object_list needs the approved grant id in `query`".to_string())
            } else {
                hii(repo, &["object", "list", "--json", "--grant", arg])
            }
        }
        "object_read" => {
            let (grant, id) = arg.split_once("::").unwrap_or(("", ""));
            if grant.trim().is_empty() || id.trim().is_empty() {
                Err("object_read needs `<grant id>::<object id>` in `query`".to_string())
            } else {
                hii(
                    repo,
                    &["object", "read", "--json", "--grant", grant, "--object", id],
                )
            }
        }
        other => Err(format!("unknown HII tool: {other}")),
    };
    match result {
        Ok(output) => ToolResult {
            ok: true,
            output,
            verification: false,
        },
        Err(output) => ToolResult {
            ok: false,
            output,
            verification: false,
        },
    }
}

fn skill_search(repo: &Path, query: &str) -> Result<String, String> {
    let mut sections = Vec::new();
    if let Ok(hii_output) = hii(repo, &["skills", "search", query]) {
        if !hii_output.trim().is_empty() {
            sections.push(format!("HII registered skills\n{}", hii_output.trim()));
        }
    }
    let Some(home) = dirs::home_dir() else {
        return Ok(sections.join("\n\n"));
    };
    let root = home.join(".hermes/skills");
    let mut matches = Vec::new();
    collect_matching_skills(&root, &query.to_ascii_lowercase(), &mut matches);
    matches.sort();
    for path in matches.into_iter().take(3) {
        if let Ok(content) = std::fs::read_to_string(&path) {
            sections.push(format!(
                "Hermes skill migration source\nsource: {}\n{}",
                path.display(),
                content.chars().take(12_000).collect::<String>()
            ));
        }
    }
    if sections.is_empty() {
        Err(format!("no local HII or Hermes skill matched: {query}"))
    } else {
        Ok(sections.join("\n\n"))
    }
}

fn collect_matching_skills(root: &Path, query: &str, matches: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_matching_skills(&path, query, matches);
        } else if path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
            let haystack = format!(
                "{} {}",
                path.display(),
                std::fs::read_to_string(&path)
                    .unwrap_or_default()
                    .chars()
                    .take(2_000)
                    .collect::<String>()
            )
            .to_ascii_lowercase();
            if query.is_empty() || query.split_whitespace().all(|term| haystack.contains(term)) {
                matches.push(path);
            }
        }
    }
}

fn compact_context(raw: String) -> Result<String, String> {
    let context: Value =
        serde_json::from_str(&raw).map_err(|error| format!("invalid HII context: {error}"))?;
    let paths = context["git"]["worktree"]["files"]
        .as_array()
        .into_iter()
        .flatten()
        .take(12)
        .filter_map(|file| file["path"].as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let commits = context["git"]["recent"]
        .as_array()
        .into_iter()
        .flatten()
        .take(5)
        .filter_map(Value::as_str)
        .map(|commit| format!("- {commit}"))
        .collect::<Vec<_>>()
        .join("\n");
    let tasks = context["localState"]["boardTasks"]["recent"]
        .as_array()
        .into_iter()
        .flatten()
        .take(5)
        .filter_map(|task| {
            Some(format!(
                "- [{}] {} ({})",
                task["lane"].as_str()?,
                task["title"].as_str()?,
                task["coordinate"].as_str().unwrap_or("no coordinate")
            ))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let jobs = context["localState"]["recentJobs"]
        .as_array()
        .into_iter()
        .flatten()
        .take(3)
        .filter_map(|job| {
            let summary = job["inputSummary"]
                .as_str()?
                .chars()
                .take(140)
                .collect::<String>()
                .replace('\n', " ");
            Some(format!(
                "- {} [{}]: {}",
                job["capabilityId"].as_str()?,
                job["status"].as_str().unwrap_or("unknown"),
                summary
            ))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let next = context["nextActions"]
        .as_array()
        .into_iter()
        .flatten()
        .take(3)
        .filter_map(|item| {
            Some(format!(
                "- {}: {}",
                item["track"].as_str()?,
                item["action"].as_str()?
            ))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let schedules = context["localState"]["personalContext"]["schedules"]["items"]
        .as_array()
        .into_iter()
        .flatten()
        .take(8)
        .filter_map(|item| {
            Some(format!(
                "- {}  {}",
                item["cron"].as_str()?,
                item["task"].as_str()?
            ))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let profile = context["localState"]["personalContext"]["profile"]["path"]
        .as_str()
        .unwrap_or("none");
    let repo = context["identity"]["repo"].as_str().unwrap_or("unknown");
    let branch = context["git"]["branch"].as_str().unwrap_or("unknown");
    let total = context["git"]["worktree"]["counts"]["total"]
        .as_u64()
        .unwrap_or(0);
    let open = context["localState"]["boardTasks"]["open"]
        .as_u64()
        .unwrap_or(0);
    Ok(format!(
        "HII CURRENT CONTEXT\nrepo: {repo}\nbranch: {branch}\nworktree: {total} change(s)\nfiles: {}\nprofile: {profile}\n\nRECENT COMMITS\n{}\n\nOPEN BOARD ({open})\n{}\n\nACTIVE SCHEDULES\n{}\n\nRECENT RUNS\n{}\n\nLIKELY NEXT\n{}",
        if paths.is_empty() { "none" } else { &paths },
        if commits.is_empty() { "none" } else { &commits },
        if tasks.is_empty() { "none" } else { &tasks },
        if schedules.is_empty() { "none" } else { &schedules },
        if jobs.is_empty() { "none" } else { &jobs },
        if next.is_empty() { "none" } else { &next }
    ))
}

/// Invoke the `hii` front controller with the given args, returning combined
/// output. Uses the `hii` binary on `PATH`; if that is absent, falls back to the
/// repo's release binary.
fn hii(repo: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("hii")
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .output()
        .or_else(|_| {
            Command::new(repo.join("target/release/hii"))
                .args(args)
                .current_dir(repo)
                .stdin(Stdio::null())
                .output()
        })
        .map_err(|error| format!("cannot run hii {}: {error}", args.join(" ")))?;
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
        return Err(if combined.trim().is_empty() {
            format!("hii {} failed", args.join(" "))
        } else {
            combined.trim().to_string()
        });
    }
    Ok(combined.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_hii_tools() {
        assert!(is_hii_tool("og_next"));
        assert!(is_hii_tool("board_write"));
        assert!(!is_hii_tool("write"));
    }

    #[test]
    fn marks_mutating_hii_tools() {
        assert!(is_mutating("board_write"));
        assert!(is_mutating("bridge_send"));
        assert!(!is_mutating("board_read"));
        assert!(!is_mutating("og_next"));
    }

    #[test]
    fn compacts_context_to_model_relevant_state() {
        let raw = serde_json::json!({
            "identity": {"repo": "/repo", "runtime": "/runtime"},
            "git": {
                "branch": "main",
                "worktree": {
                    "clean": false,
                    "counts": {"total": 1},
                    "files": [{"path": "src/main.rs"}]
                },
                "recent": ["abc change"]
            },
            "localState": {
                "boardTasks": {
                    "open": 1,
                    "byLane": {"doing": 1},
                    "recent": [{"title": "Ship", "lane": "doing", "coordinate": "/repo"}]
                },
                "recentJobs": [{
                    "capabilityId": "hii.agent",
                    "status": "completed",
                    "createdAt": "now",
                    "inputSummary": "work"
                }]
            },
            "nextActions": [{"track": "build", "coordinate": "cargo test", "action": "verify"}],
            "capabilities": vec![serde_json::json!({"large": "unused"}); 100]
        })
        .to_string();
        let compact = compact_context(raw).expect("compact context");
        assert!(compact.contains("src/main.rs"));
        assert!(compact.contains("abc change"));
        assert!(!compact.contains("large"));
        assert!(compact.contains("HII CURRENT CONTEXT"));
        assert!(compact.len() < 2_000);
    }
}
