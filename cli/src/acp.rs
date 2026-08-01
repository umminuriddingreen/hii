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

/// What a tool can actually touch.
///
/// `side` predates this and mislabelled `shell` and `http` as `"fs"` despite one
/// executing arbitrary programs and the other opening sockets, so a consumer
/// filtering on it to gate egress or to sandbox saw the wrong set. `side` is kept
/// unchanged for existing readers and `reach` carries the accurate answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    /// Reads or writes inside the workspace.
    Local,
    /// Opens a network connection.
    Network,
    /// Runs an arbitrary program.
    Exec,
    /// Crosses into HII's own operating logic.
    Hii,
    /// Dispatches to an operator-configured downstream MCP server.
    Mcp,
}

impl Reach {
    fn label(self) -> &'static str {
        match self {
            Reach::Local => "local",
            Reach::Network => "network",
            Reach::Exec => "exec",
            Reach::Hii => "hii",
            Reach::Mcp => "mcp",
        }
    }
}

/// One tool the agent exposes.
pub struct ToolSpec {
    pub name: &'static str,
    /// Legacy grouping. Deprecated in favor of `reach`; kept byte-identical so
    /// published manifests do not change meaning under existing readers.
    pub side: &'static str,
    pub reach: Reach,
    pub mutates: bool,
    pub description: &'static str,
}

const fn tool(
    name: &'static str,
    side: &'static str,
    reach: Reach,
    mutates: bool,
    description: &'static str,
) -> ToolSpec {
    ToolSpec {
        name,
        side,
        reach,
        mutates,
        description,
    }
}

const TOOLS: &[ToolSpec] = &[
    tool(
        "read",
        "fs",
        Reach::Local,
        false,
        "read a file, optionally a line range",
    ),
    tool("list", "fs", Reach::Local, false, "list files under a path"),
    tool(
        "search",
        "fs",
        Reach::Local,
        false,
        "regex search across the workspace",
    ),
    tool(
        "web_search",
        "network",
        Reach::Network,
        false,
        "search the public web and return compact cited results",
    ),
    tool(
        "web_fetch",
        "network",
        Reach::Network,
        false,
        "read one public web page with private-network protection",
    ),
    tool(
        "write",
        "fs",
        Reach::Local,
        true,
        "create or overwrite a file",
    ),
    tool(
        "edit",
        "fs",
        Reach::Local,
        true,
        "exact unique string replacement in a file",
    ),
    tool(
        "shell",
        "fs",
        Reach::Exec,
        true,
        "run a workspace-bounded shell command",
    ),
    tool(
        "verify",
        "fs",
        Reach::Exec,
        false,
        "run a command as a recorded proof",
    ),
    tool(
        "http",
        "fs",
        Reach::Network,
        false,
        "GET a local (127.0.0.1/localhost) URL",
    ),
    tool(
        "mcp_call",
        "mcp",
        Reach::Mcp,
        true,
        "call a tool on an operator-configured MCP server",
    ),
    tool(
        "hii_context",
        "hii",
        Reach::Hii,
        false,
        "repo/runtime context snapshot",
    ),
    tool(
        "og_next",
        "hii",
        Reach::Hii,
        false,
        "operational-graph next path",
    ),
    tool(
        "caps_check",
        "hii",
        Reach::Hii,
        false,
        "list HII capabilities",
    ),
    tool(
        "board_read",
        "hii",
        Reach::Hii,
        false,
        "read the local task board",
    ),
    tool(
        "board_write",
        "hii",
        Reach::Hii,
        true,
        "capture a task on the board",
    ),
    tool(
        "skill_search",
        "hii",
        Reach::Hii,
        false,
        "find a registered skill",
    ),
    tool(
        "bridge_send",
        "hii",
        Reach::Hii,
        true,
        "send an inter-agent bridge message",
    ),
    tool(
        "bridge_read",
        "hii",
        Reach::Hii,
        false,
        "read the bridge inbox",
    ),
];

/// The capability manifest as a JSON value.
pub fn manifest() -> Value {
    let tools: Vec<Value> = TOOLS
        .iter()
        .map(|spec| {
            json!({
                "name": spec.name,
                "side": spec.side,
                "reach": spec.reach.label(),
                "mutates": spec.mutates,
                "description": spec.description,
            })
        })
        .collect();
    json!({
        "schema": "hii.tool-manifest/2",
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

/// Is `name` a tool this agent exposes at all? Kept alongside
/// [`is_directly_executable`] so tests can tell "not ours" apart from "ours but
/// not runnable here".
#[cfg(test)]
pub fn is_known_tool(name: &str) -> bool {
    TOOLS.iter().any(|spec| spec.name == name)
}

/// Is `name` a tool this process can execute directly?
///
/// `mcp_call` is part of the agent's action surface but dispatches to an
/// operator-configured downstream server, which the stdio MCP server does not
/// proxy. It is listed in the manifest — the manifest describes what the agent
/// can do — and excluded from what `hii mcp-serve` advertises.
pub fn is_directly_executable(name: &str) -> bool {
    TOOLS
        .iter()
        .any(|spec| spec.name == name && spec.reach != Reach::Mcp)
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
