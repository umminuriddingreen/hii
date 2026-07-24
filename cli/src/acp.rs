//! Protocol boundary scaffold (plan Phase 11).
//!
//! The durable interface layer will speak ACP northbound (to the operator) and
//! MCP southbound (to tools). Full duplex servers are a later milestone; this
//! module publishes the machine-readable **tool manifest** — the single source
//! of truth for what the agent can do — so an ACP/MCP adapter (or another agent)
//! can discover the capability surface today via `hii tools-manifest`.

use serde_json::{json, Value};

/// One tool the agent exposes: name, side (filesystem vs HII operating logic),
/// whether it mutates state, and a one-line description.
const TOOLS: &[(&str, &str, bool, &str)] = &[
    ("read", "fs", false, "read a file, optionally a line range"),
    ("list", "fs", false, "list files under a path"),
    ("search", "fs", false, "regex search across the workspace"),
    ("write", "fs", true, "create or overwrite a file"),
    (
        "edit",
        "fs",
        true,
        "exact unique string replacement in a file",
    ),
    ("shell", "fs", true, "run a workspace-bounded shell command"),
    ("verify", "fs", false, "run a command as a recorded proof"),
    ("http", "fs", false, "GET a local (127.0.0.1/localhost) URL"),
    ("hii_context", "hii", false, "repo/runtime context snapshot"),
    ("og_next", "hii", false, "operational-graph next path"),
    ("caps_check", "hii", false, "list HII capabilities"),
    ("board_read", "hii", false, "read the local task board"),
    ("board_write", "hii", true, "capture a task on the board"),
    ("skill_search", "hii", false, "find a registered skill"),
    (
        "bridge_send",
        "hii",
        true,
        "send an inter-agent bridge message",
    ),
    ("bridge_read", "hii", false, "read the bridge inbox"),
];

/// The capability manifest as a JSON value.
pub fn manifest() -> Value {
    let tools: Vec<Value> = TOOLS
        .iter()
        .map(|(name, side, mutates, description)| {
            json!({
                "name": name,
                "side": side,
                "mutates": mutates,
                "description": description,
            })
        })
        .collect();
    json!({
        "schema": "hii.tool-manifest/1",
        "authority_levels": [
            "read-only",
            "workspace",
            "external-preview",
            "external-commit",
            "yolo"
        ],
        "tools": tools,
    })
}

/// Pretty-printed manifest for `hii tools-manifest`.
pub fn render() -> String {
    serde_json::to_string_pretty(&manifest()).unwrap_or_else(|_| "{}".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_lists_every_tool_with_fields() {
        let value = manifest();
        let tools = value["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), TOOLS.len());
        assert!(tools
            .iter()
            .all(|tool| tool["name"].is_string() && tool["mutates"].is_boolean()));
    }
}
