//! HII operating-logic tools (plan Phase 9).
//!
//! These let the workspace agent work *through* HII rather than around it:
//! reading the operational graph, checking capabilities, touching the local
//! board, searching skills, and handing off over the bridge. Read tools shell
//! out to the `hii` front controller (which routes context/og/caps/bridge to
//! the compatibility layer); they are local-first and carry no network effect.

use crate::tools::ToolResult;
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
    "bridge_send",
    "bridge_read",
];

pub fn is_hii_tool(tool: &str) -> bool {
    HII_TOOLS.contains(&tool)
}

/// Does this HII tool change state (and so count as a mutation for authority)?
pub fn is_mutating(tool: &str) -> bool {
    matches!(tool, "board_write" | "bridge_send")
}

/// Dispatch an HII tool. `repo` is the HII repository root; `query` carries the
/// tool's single free-text argument (a task title, search term, or message).
pub fn execute(repo: &Path, tool: &str, query: Option<&str>) -> ToolResult {
    let arg = query.unwrap_or("").trim();
    let result = match tool {
        "hii_context" => hii(repo, &["context", "--json"]),
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
        "skill_search" => hii(repo, &["skills", "search", arg]),
        "bridge_send" => {
            if arg.is_empty() {
                Err("bridge_send needs a message in `query`".to_string())
            } else {
                hii(repo, &["bridge", "send", arg])
            }
        }
        "bridge_read" => hii(repo, &["bridge", "read"]),
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
}
