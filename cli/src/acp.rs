//! Protocol boundary scaffold (plan Phase 11).
//!
//! The durable interface layer will speak ACP northbound (to the operator) and
//! MCP southbound (to tools). Full duplex servers are a later milestone; this
//! module publishes the machine-readable **tool manifest** — the single source
//! of truth for what the agent can do — so an ACP/MCP adapter (or another agent)
//! can discover the capability surface today via `hii tools-manifest`.

use crate::config::AppPaths;
use crate::contract::Authority;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::process::ExitCode;

/// One tool the agent exposes: name, side (filesystem vs HII operating logic),
/// whether it mutates state, and a one-line description.
const TOOLS: &[(&str, &str, bool, &str)] = &[
    ("read", "fs", false, "read a file, optionally a line range"),
    ("list", "fs", false, "list files under a path"),
    ("search", "fs", false, "regex search across the workspace"),
    (
        "web_search",
        "network",
        false,
        "search the public web and return compact cited results",
    ),
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

/// Is `name` a tool this agent exposes at all? The MCP dispatcher uses this to
/// separate a filesystem tool from an unknown one, keeping the manifest the
/// single source of truth for the capability surface.
pub fn is_known_tool(name: &str) -> bool {
    TOOLS.iter().any(|(tool, ..)| *tool == name)
}

// ---------------------------------------------------------------------------
// ACP northbound server (plan Phase 11) — MINIMAL STUB.
//
// The Agent Client Protocol is how an operator/client drives HII: sessions,
// streaming tool calls, permission requests. This function proves the
// northbound boundary is wired — it speaks the same line-delimited JSON-RPC 2.0
// framing as the MCP server (`mcp.rs`) and answers just enough to complete a
// handshake:
//
//   COMPLETE:  `initialize` (advertises protocol + agent capabilities) and
//              `session/new` (mints a session id, then streams a `session/update`
//              acknowledgement notification back over stdout).
//   STUBBED:   `session/prompt`, streaming tool-call updates, and permission
//              requests are not implemented yet — the run loop is not bridged to
//              ACP. Unknown methods return a JSON-RPC "method not found".
// ---------------------------------------------------------------------------

/// Run the minimal ACP northbound server over stdio. See the module note above
/// for what is complete versus stubbed.
pub fn serve(_paths: &AppPaths, _authority: Authority) -> Result<ExitCode, String> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut next_session = 1u64;
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                write_json(
                    &mut stdout,
                    &rpc_error(Value::Null, -32700, &error.to_string()),
                )?;
                continue;
            }
        };
        // Notifications (no `id`) are acknowledged silently.
        let Some(id) = request.get("id").cloned() else {
            continue;
        };
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        match method {
            "initialize" => {
                write_json(
                    &mut stdout,
                    &rpc_ok(
                        id,
                        json!({
                            "protocolVersion": 1,
                            "agentInfo": { "name": "hii", "version": env!("CARGO_PKG_VERSION") },
                            "agentCapabilities": { "promptCapabilities": { "streaming": true } },
                        }),
                    ),
                )?;
            }
            "session/new" => {
                let session_id = format!("hii-session-{next_session}");
                next_session += 1;
                write_json(&mut stdout, &rpc_ok(id, json!({ "sessionId": session_id })))?;
                // Stream a first session/update acknowledgement (a notification,
                // so it carries no id). This proves the northbound stream works.
                write_json(
                    &mut stdout,
                    &json!({
                        "jsonrpc": "2.0",
                        "method": "session/update",
                        "params": {
                            "sessionId": session_id,
                            "update": { "kind": "ready", "message": "session established" },
                        },
                    }),
                )?;
            }
            other => {
                write_json(
                    &mut stdout,
                    &rpc_error(id, -32601, &format!("method not found (stub): {other}")),
                )?;
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

/// Serialize `value` as one `\n`-terminated JSON line and flush it.
fn write_json(out: &mut impl Write, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|error| error.to_string())?;
    writeln!(out, "{text}").map_err(|error| error.to_string())?;
    out.flush().map_err(|error| error.to_string())
}

/// A JSON-RPC 2.0 success envelope.
fn rpc_ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// A JSON-RPC 2.0 error envelope.
fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
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

    #[test]
    fn recognizes_known_tools() {
        assert!(is_known_tool("read"));
        assert!(is_known_tool("bridge_send"));
        assert!(!is_known_tool("nope"));
    }
}
