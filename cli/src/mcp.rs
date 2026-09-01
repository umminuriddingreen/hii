//! JSON-RPC 2.0 stdio server — MCP southbound (plan Phase 11).
//!
//! This serves the Model Context Protocol over stdio so any MCP client (another
//! agent, an IDE, an ACP adapter) can discover and call the HII tool surface.
//! Framing is **line-delimited**: exactly one JSON object per `\n`-terminated
//! line in, one per line out. Line framing (rather than `Content-Length`) is
//! chosen for readability and trivial shell testing:
//! `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | hii mcp`.
//!
//! The tool catalog is [`crate::acp::manifest`] — the single source of truth —
//! and calls dispatch to the real `tools.rs` / `hii_tools.rs` handlers (no tool
//! logic is duplicated here). Every `tools/call` passes through the same
//! [`Authority`] envelope the run loop uses, so a read-only server refuses
//! mutating tools with a JSON-RPC error instead of executing them.

use crate::agent::{execute_tool, ToolCall};
use crate::config::AppPaths;
use crate::contract::{deletion_shell, sensitive_shell, Authority, Decision};
use crate::governance::AclConfig;
use crate::tools::{ToolResult, Toolbelt};
use crate::{acp, hii_tools};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::Path;
use std::process::ExitCode;

/// The MCP protocol revision we speak. Bumped when the surface changes.
const PROTOCOL_VERSION: &str = "2024-11-05";

/// Non-standard JSON-RPC error code for an action the authority envelope
/// refuses. Inside the implementation-defined server range (-32000..-32099).
const AUTHORITY_DENIED: i64 = -32001;

/// A decoded JSON-RPC 2.0 request (or notification, when `id` is absent).
#[derive(Debug, Deserialize)]
struct Request {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

/// A JSON-RPC 2.0 response envelope. Exactly one of `result`/`error` is set.
#[derive(Debug, Serialize)]
struct Response {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

/// A JSON-RPC 2.0 error object.
#[derive(Debug, Serialize)]
struct RpcError {
    code: i64,
    message: String,
}

impl Response {
    fn ok(id: Value, result: Value) -> Self {
        Response {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    fn err(id: Value, code: i64, message: impl Into<String>) -> Self {
        Response {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
            }),
        }
    }
}

/// Run the MCP server against `workspace`, gating every call at `authority`.
/// Optionally accepts a `client_identity` for per-client ACL enforcement. Reads
/// line-delimited requests from stdin until EOF and writes one response line
/// per request to stdout. Notifications (no `id`) are consumed silently.
pub fn serve(
    paths: &AppPaths,
    workspace: &Path,
    authority: Authority,
    client_identity: Option<&str>,
) -> Result<ExitCode, String> {
    let tools = Toolbelt::new(workspace.to_path_buf())?;

    // Load governance ACL config when a client identity is present.
    // Falls back to default (reader-only) when no config exists.
    let acl_config = client_identity
        .map(|_| {
            let config_path = std::env::var_os("HII_MCP_CONFIG")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| paths.runtime.join("mcp_acl.json"));
            if config_path.exists() {
                AclConfig::load_from_path(&config_path)
            } else {
                Ok(AclConfig::load_default())
            }
        })
        .transpose()?;

    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_line(
            &line,
            &tools,
            &paths.repo,
            authority,
            client_identity,
            acl_config.as_ref(),
        ) {
            let text = serde_json::to_string(&response).map_err(|error| error.to_string())?;
            writeln!(stdout, "{text}").map_err(|error| error.to_string())?;
            stdout.flush().map_err(|error| error.to_string())?;
        }
    }
    Ok(ExitCode::SUCCESS)
}

/// Parse one line and dispatch it. Returns `None` for notifications (requests
/// without an `id`), which the protocol says must not be answered.
fn handle_line(
    line: &str,
    tools: &Toolbelt,
    repo: &Path,
    authority: Authority,
    client_identity: Option<&str>,
    acl_config: Option<&AclConfig>,
) -> Option<Response> {
    let request: Request = match serde_json::from_str(line) {
        Ok(request) => request,
        // Parse error: reply with a null id per JSON-RPC.
        Err(error) => return Some(Response::err(Value::Null, -32700, error.to_string())),
    };
    let id = request.id.clone()?;
    Some(dispatch(
        &request,
        id,
        tools,
        repo,
        authority,
        client_identity,
        acl_config,
    ))
}

/// Route a JSON-RPC request to its method handler, gating all tool calls at the
/// authority envelope and any active per-client ACL.
fn dispatch(
    request: &Request,
    id: Value,
    tools: &Toolbelt,
    repo: &Path,
    authority: Authority,
    client_identity: Option<&str>,
    acl_config: Option<&AclConfig>,
) -> Response {
    match request.method.as_str() {
        "initialize" => Response::ok(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "serverInfo": { "name": "hii", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "tools": { "listChanged": false } },
                // Advertise client governance when a config was loaded.
                "governance": acl_config.map(|_| true),
            }),
        ),
        "tools/list" => Response::ok(id, json!({ "tools": tool_specs() })),
        "tools/call" => match tools_call(
            &request.params,
            tools,
            repo,
            authority,
            client_identity.unwrap_or("anonymous"),
            acl_config,
        ) {
            Ok(result) => Response::ok(id, result),
            Err((code, message)) => Response::err(id, code, message),
        },
        other => Response::err(id, -32601, format!("method not found: {other}")),
    }
}

/// The `tools/list` payload: every manifest tool with a real JSON-schema for its
/// arguments. Descriptions and the mutating flag come straight from the manifest.
fn tool_specs() -> Vec<Value> {
    let manifest = acp::manifest();
    let tools = manifest["tools"].as_array().cloned().unwrap_or_default();
    tools
        .into_iter()
        // Advertise only what this server can actually run; downstream MCP
        // proxying is not implemented here.
        .filter(|tool| acp::is_directly_executable(tool["name"].as_str().unwrap_or_default()))
        .map(|tool| {
            let name = tool["name"].as_str().unwrap_or_default();
            let mut spec = json!({
                "name": name,
                "description": tool["description"],
                "inputSchema": tool["inputSchema"],
                "annotations": tool["annotations"],
            });
            if !tool["outputSchema"].is_null() {
                spec["outputSchema"] = tool["outputSchema"].clone();
            }
            spec
        })
        .collect()
}

/// Handle `tools/call`: gate at the authority envelope, then dispatch to the
/// real handler. On refusal or malformed input returns `(code, message)` for a
/// JSON-RPC error; otherwise the MCP `content` result.
fn tools_call(
    params: &Value,
    tools: &Toolbelt,
    repo: &Path,
    authority: Authority,
    client_identity: &str,
    acl_config: Option<&AclConfig>,
) -> Result<Value, (i64, String)> {
    let name = params["name"]
        .as_str()
        .ok_or((-32602, "tools/call requires a string `name`".to_string()))?;

    if matches!(name, "canvas_add" | "canvas_update") && client_identity == "anonymous" {
        return Err((
            AUTHORITY_DENIED,
            "canvas mutation requires a configured --client-identity".to_string(),
        ));
    }

    // ACL enforcement — per-client governance gate runs before authority.
    if let Some(acl) = acl_config {
        let param_count = params["arguments"].as_object().map_or(0, |args| args.len());
        if let Err(err) = acl.check_acl_with_params(client_identity, name, param_count) {
            return Err((-32099, format!("acl denied: {err}")));
        }
    }

    // Authority gate - mirrors the run loop's classification (agent.rs).
    let args = &params["arguments"];
    let command = args["command"].as_str();
    let mutates = matches!(name, "write" | "edit")
        || (name == "shell" && command.is_some())
        || (hii_tools::is_hii_tool(name) && hii_tools::is_mutating(name));
    let sensitive = matches!(name, "shell" | "verify") && command.is_some_and(sensitive_shell);
    let deletion = matches!(name, "shell" | "verify") && command.is_some_and(deletion_shell);
    let decision = if deletion {
        Decision::Prompt
    } else {
        authority.decide(mutates, sensitive)
    };
    match decision {
        Decision::Allow => {}
        Decision::Deny => {
            return Err((
                AUTHORITY_DENIED,
                format!("authority '{}' refuses tool '{name}'", authority.label()),
            ))
        }
        Decision::Prompt => {
            // Stdio has no interactive channel; a boundary that needs approval
            // is refused rather than run unattended.
            return Err((
                AUTHORITY_DENIED,
                format!(
                    "tool '{name}' crosses a boundary that requires approval; not available over stdio"
                ),
            ));
        }
    }

    let is_hii = hii_tools::is_hii_tool(name);

    let result = if is_hii {
        hii_tools::execute_as(repo, name, Some(args), client_identity)
    } else if acp::is_directly_executable(name) {
        execute_tool(
            tools,
            ToolCall {
                tool: name,
                path: args["path"].as_str(),
                query: args["query"].as_str(),
                command,
                content: args["content"].as_str(),
                url: args["url"].as_str(),
                old: args["old"].as_str(),
                new: args["new"].as_str(),
                replace_all: args["replace_all"].as_bool().unwrap_or(false),
                offset: args["offset"].as_u64().map(|value| value as usize),
                limit: args["limit"].as_u64().map(|value| value as usize),
                allow_delete: false,
            },
            false,
        )
    } else {
        return Err((-32602, format!("unknown tool: {name}")));
    };
    Ok(call_result(&result))
}

/// Convert a [`ToolResult`] into the MCP `tools/call` content shape.
fn call_result(result: &ToolResult) -> Value {
    let structured = serde_json::from_str::<Value>(&result.output).ok();
    json!({
        "content": [{ "type": "text", "text": result.output }],
        "structuredContent": structured,
        "resultType": "complete",
        "isError": !result.ok,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// A private workspace per call, keyed by `label`, so tests running in
    /// parallel do not delete one another's fixtures.
    fn tempbelt(label: &str) -> (Toolbelt, std::path::PathBuf) {
        let path = env::temp_dir().join(format!("hii-mcp-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        (Toolbelt::new(path.clone()).unwrap(), path)
    }

    #[test]
    fn request_parses_from_json() {
        let request: Request =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#).unwrap();
        assert_eq!(request.method, "tools/list");
        assert_eq!(request.id, Some(json!(7)));
    }

    /// Everything advertised must be executable here, and everything executable
    /// must be advertised — this server never offers a tool it would refuse.
    #[test]
    fn tools_list_covers_every_directly_executable_manifest_tool() {
        let specs = tool_specs();
        let manifest = acp::manifest();
        let expected = manifest["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|tool| acp::is_directly_executable(tool["name"].as_str().unwrap_or_default()))
            .count();
        assert_eq!(specs.len(), expected);
        assert!(specs
            .iter()
            .all(|spec| spec["name"].is_string() && spec["inputSchema"]["type"] == "object"));
        // mcp_call is an agent action, not something this server can proxy.
        assert!(!specs.iter().any(|spec| spec["name"] == "mcp_call"));
        for name in ["canvas_list", "canvas_read", "canvas_add", "canvas_update"] {
            assert!(specs.iter().any(|spec| spec["name"] == name), "missing {name}");
        }
    }

    #[test]
    fn read_only_rejects_a_mutating_call() {
        let (tools, path) = tempbelt("reject");
        let params = json!({ "name": "write", "arguments": { "path": "x.txt", "content": "no" } });
        let error = tools_call(
            &params,
            &tools,
            &path,
            Authority::ReadOnly,
            "anonymous",
            None,
        )
        .unwrap_err();
        assert_eq!(error.0, AUTHORITY_DENIED);
        // The refused write must not have touched the workspace.
        assert!(!path.join("x.txt").exists());
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn deletion_is_refused_even_with_yolo_authority() {
        let (tools, path) = tempbelt("nested-delete");
        std::fs::write(path.join("f.txt"), "keep").unwrap();
        let params = json!({ "name": "shell", "arguments": { "command": "rm f.txt" } });
        let error =
            tools_call(&params, &tools, &path, Authority::Yolo, "anonymous", None).unwrap_err();
        assert_eq!(error.0, AUTHORITY_DENIED);
        assert!(path.join("f.txt").exists());
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn read_only_allows_a_read_call() {
        let (tools, path) = tempbelt("allow");
        std::fs::write(path.join("f.txt"), "hello").unwrap();
        let params = json!({ "name": "read", "arguments": { "path": "f.txt" } });
        let result = tools_call(
            &params,
            &tools,
            &path,
            Authority::ReadOnly,
            "anonymous",
            None,
        )
        .unwrap();
        assert_eq!(result["isError"], json!(false));
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn deletion_is_refused_without_an_interactive_approval_channel() {
        let (tools, path) = tempbelt("delete");
        std::fs::write(path.join("f.txt"), "keep").unwrap();
        let params = json!({ "name": "shell", "arguments": { "command": "rm f.txt" } });
        let error =
            tools_call(&params, &tools, &path, Authority::Yolo, "anonymous", None).unwrap_err();
        assert_eq!(error.0, AUTHORITY_DENIED);
        assert!(path.join("f.txt").exists());
        let _ = std::fs::remove_dir_all(path);
    }
}
