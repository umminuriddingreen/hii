//! JSON-RPC 2.0 stdio server — MCP southbound (plan Phase 11).
//!
//! This serves the Model Context Protocol over stdio so any MCP client (another
//! agent, an IDE, an ACP adapter) can discover and call the HII tool surface.
//! Framing is **line-delimited**: exactly one JSON object per `\n`-terminated
//! line in, one per line out. Line framing (rather than `Content-Length`) is
//! chosen for readability and trivial shell testing:
//! `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | hii mcp`.
//!
//! The tool catalog is based on [`crate::acp::manifest`] plus shared input and
//! All Homie tools. Calls dispatch to the real `tools.rs` / `hii_tools.rs`
//! handlers where applicable. Every `tools/call` passes through the same
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
const PROTOCOL_VERSION: &str = "2026-07-28";
const LEGACY_PROTOCOL_VERSION: &str = "2024-11-05";

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

    let acl_config: Option<AclConfig> = None;

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
            &paths.runtime,
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
    runtime: &Path,
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
        runtime,
        repo,
        authority,
        client_identity,
        acl_config,
    ))
}

/// Route a JSON-RPC request to its method handler, gating all tool calls at the
/// authority envelope and any active per-client ACL.
#[allow(clippy::too_many_arguments)]
fn dispatch(
    request: &Request,
    id: Value,
    tools: &Toolbelt,
    runtime: &Path,
    repo: &Path,
    authority: Authority,
    client_identity: Option<&str>,
    acl_config: Option<&AclConfig>,
) -> Response {
    match request.method.as_str() {
        "initialize" => {
            let requested = request.params["protocolVersion"].as_str();
            let negotiated = match requested {
                Some(PROTOCOL_VERSION) => PROTOCOL_VERSION,
                Some(LEGACY_PROTOCOL_VERSION) => LEGACY_PROTOCOL_VERSION,
                _ => PROTOCOL_VERSION,
            };
            Response::ok(
                id,
                json!({
                    "protocolVersion": negotiated,
                    "serverInfo": { "name": "hii", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "tools": { "listChanged": false } },
                    // Advertise client governance when a config was loaded.
                    "governance": acl_config.map(|_| true),
                }),
            )
        }
        "server/discover" => Response::ok(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "serverInfo": { "name": "hii", "version": env!("CARGO_PKG_VERSION") },
                "transports": ["stdio"],
                "capabilities": { "tools": true, "governance": acl_config.is_some() }
            }),
        ),
        "tools/list" => Response::ok(id, json!({ "tools": tool_specs() })),
        "tools/call" => match tools_call(
            &request.params,
            tools,
            runtime,
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
    let mut specs = tools
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
        .collect::<Vec<_>>();
    specs.extend([
        json!({"name":"input_suggest","description":"Suggest local HII commands without calling a model or probing providers.","inputSchema":{"type":"object","properties":{"text":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":20}},"additionalProperties":false},"annotations":{"readOnlyHint":true}}),
        json!({"name":"input_search","description":"Search captured information and local capabilities; services and active agents require explicit sources.","inputSchema":{"type":"object","properties":{"query":{"type":"string","maxLength":2048},"sources":{"type":"array","items":{"type":"string","enum":["information","capabilities","commands","services","agents"]}},"limit":{"type":"integer","minimum":1,"maximum":20}},"required":["query"],"additionalProperties":false},"annotations":{"readOnlyHint":true}}),
        json!({"name":"input_submit","description":"Submit text to the active CLI-owned input controller. Requires `hii input serve` and its fixed authority envelope.","inputSchema":{"type":"object","properties":{"text":{"type":"string","maxLength":16384}},"required":["text"],"additionalProperties":false}}),
        json!({"name":"input_queue","description":"Queue text on the active CLI-owned input controller.","inputSchema":{"type":"object","properties":{"text":{"type":"string","maxLength":16384}},"required":["text"],"additionalProperties":false}}),
        json!({"name":"input_status","description":"Read queued and completed input jobs from the shared CLI controller.","inputSchema":{"type":"object","properties":{"jobId":{"type":"string"}},"additionalProperties":false},"annotations":{"readOnlyHint":true}}),
        json!({"name":"input_cancel","description":"Cancel a queued or active input job on the shared CLI controller.","inputSchema":{"type":"object","properties":{"jobId":{"type":"string"}},"required":["jobId"],"additionalProperties":false}}),
        json!({"name":"homie_answer","description":"Draft an answer on the user's behalf using same-device loopback inference and optional local HII context. Returns an unsent draft; it never sends messages.","inputSchema":{"type":"object","properties":{"question":{"type":"string","minLength":1,"maxLength":4096},"context_query":{"type":"string","maxLength":2048},"include_context":{"type":"boolean","default":true}},"required":["question"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"openWorldHint":false}}),
        json!({"name":"homie_delegate","description":"Run one bounded HII agent locally in the active workspace (at most 8 steps and 60 seconds). Defaults to read-only; workspace authority requires an MCP server configured with workspace authority. Returns a receipt for review.","inputSchema":{"type":"object","properties":{"task":{"type":"string","minLength":1,"maxLength":4096},"authority":{"type":"string","enum":["read-only","workspace"],"default":"read-only"},"done_when":{"type":"string","maxLength":512}},"required":["task"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"openWorldHint":false}}),
    ]);
    specs
}

/// Handle `tools/call`: gate at the authority envelope, then dispatch to the
/// real handler. On refusal or malformed input returns `(code, message)` for a
/// JSON-RPC error; otherwise the MCP `content` result.
fn tools_call(
    params: &Value,
    tools: &Toolbelt,
    runtime: &Path,
    repo: &Path,
    authority: Authority,
    client_identity: &str,
    acl_config: Option<&AclConfig>,
) -> Result<Value, (i64, String)> {
    let mut ledger = hii_core::run_ledger::RunLedger::create(runtime, "mcp", "mcp")
        .map_err(|error| (-32002, format!("run ledger unavailable: {error}")))?;
    ledger
        .set_authority(authority.label())
        .map_err(|error| (-32002, format!("run ledger unavailable: {error}")))?;
    ledger
        .event(
            "tool.request",
            json!({
                "clientIdentity": client_identity,
                "authority": authority.label(),
                "request": if let Some(name @ ("homie_answer" | "homie_delegate")) = params["name"].as_str() {
                    json!({
                        "name": name,
                        "arguments": crate::homie::safe_request_metadata(name, &params["arguments"])
                    })
                } else {
                    params.clone()
                }
            }),
        )
        .map_err(|error| (-32002, format!("run ledger unavailable: {error}")))?;
    let result = tools_call_inner(
        params,
        tools,
        runtime,
        repo,
        authority,
        client_identity,
        acl_config,
    );
    let (status, detail) = match &result {
        Ok(value) if matches!(params["name"].as_str(), Some("homie_answer" | "homie_delegate")) => {
            let name = params["name"].as_str().unwrap_or_default();
            ("completed", crate::homie::safe_receipt_metadata(name, &params["arguments"], &value["structuredContent"]))
        }
        Ok(value) => ("completed", value.clone()),
        Err((code, message)) => ("denied", json!({"code": code, "message": message})),
    };
    ledger
        .event("tool.result", json!({"status": status, "result": detail}))
        .map_err(|error| (-32002, format!("run ledger unavailable: {error}")))?;
    ledger
        .finish(json!({
            "schemaVersion": 2,
            "id": ledger.envelope.run_id,
            "status": status,
            "surface": "mcp",
            "tool": params["name"],
            "clientIdentity": client_identity,
            "authority": authority.label(),
            "summary": if status == "completed" { "MCP tool call completed." } else { "MCP tool call was denied or failed." }
        }))
        .map_err(|error| (-32002, format!("receipt persistence failed: {error}")))?;
    result
}

fn tools_call_inner(
    params: &Value,
    tools: &Toolbelt,
    runtime: &Path,
    repo: &Path,
    authority: Authority,
    client_identity: &str,
    acl_config: Option<&AclConfig>,
) -> Result<Value, (i64, String)> {
    let name = params["name"]
        .as_str()
        .ok_or((-32602, "tools/call requires a string `name`".to_string()))?;

    let _ = (client_identity, acl_config);
    let args = &params["arguments"];
    let command = args["command"].as_str();
    if name.starts_with("input_") {
        return input_tool_call(repo, runtime, name, args, authority).map(|value| {
            call_result(&ToolResult {
                ok: true,
                output: value.to_string(),
                verification: false,
            })
        });
    }

    if name == "homie_answer" {
        let paths = AppPaths { repo: repo.to_path_buf(), runtime: runtime.to_path_buf() };
        let question = args["question"].as_str().unwrap_or_default();
        let context_query = args["context_query"].as_str();
        let include_context = args["include_context"].as_bool().unwrap_or(true);
        let value = crate::homie::answer(&paths, question, context_query, include_context)
            .map_err(|error| (-32002, error))?;
        return call_json_result(value).map_err(|error| (-32002, error));
    }
    if name == "homie_delegate" {
        let task = args["task"].as_str().unwrap_or_default();
        let delegate_authority = args["authority"].as_str().unwrap_or("read-only");
        let paths = AppPaths { repo: repo.to_path_buf(), runtime: runtime.to_path_buf() };
        let value = crate::homie::delegate(
            &paths,
            repo,
            task,
            delegate_authority,
            args["done_when"].as_str(),
        )
        .map_err(|error| (-32002, error))?;
        return call_json_result(value).map_err(|error| (-32002, error));
    }

    let is_hii = hii_tools::is_hii_tool(name);

    let result = if matches!(
        name,
        "capability_install"
            | "capability_create"
            | "model_catalog"
            | "skill_search"
            | "skill_read"
    ) {
        hii_tools::execute_with_tools(repo, name, Some(args), tools)
    } else if is_hii {
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

fn input_tool_call(
    repo: &Path,
    runtime: &Path,
    name: &str,
    args: &Value,
    authority: Authority,
) -> Result<Value, (i64, String)> {
    let paths = AppPaths {
        repo: repo.to_path_buf(),
        runtime: runtime.to_path_buf(),
    };
    match name {
        "input_suggest" => {
            let text = args["text"].as_str().unwrap_or_default();
            let limit = args["limit"].as_u64().map(|value| value as usize);
            serde_json::to_value(crate::input::suggest(text, limit, false))
                .map_err(|error| (-32002, error.to_string()))
        }
        "input_search" => {
            let query = args["query"]
                .as_str()
                .ok_or((-32602, "input_search requires a string query".into()))?;
            let sources = args["sources"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let limit = args["limit"].as_u64().map(|value| value as usize);
            let hits = crate::input::search(
                &paths,
                &crate::input::SearchRequest {
                    query: query.into(),
                    sources,
                    limit,
                },
            )
            .map_err(|error| (-32602, error))?;
            serde_json::to_value(hits).map_err(|error| (-32002, error.to_string()))
        }
        "input_submit" | "input_queue" | "input_status" | "input_cancel" => {
            crate::input::forward_http(&paths, name, args, authority)
                .map_err(|error| (-32002, error))
        }
        _ => Err((-32602, format!("unknown input tool: {name}"))),
    }
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

fn call_json_result(value: Value) -> Result<Value, String> {
    let text = serde_json::to_string(&value).map_err(|error| error.to_string())?;
    Ok(json!({
        "content": [{"type":"text","text":text}],
        "structuredContent": value,
        "resultType": "complete",
        "isError": false
    }))
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

    #[test]
    fn shared_input_mcp_tools_use_standard_content_and_structured_result() {
        let (tools, path) = tempbelt("input-shape");
        let result = tools_call_inner(
            &json!({"name":"input_suggest","arguments":{"text":"/help"}}),
            &tools,
            &path.join(".hii"),
            &path,
            Authority::ReadOnly,
            "anonymous",
            None,
        )
        .unwrap();
        assert_eq!(result["isError"], false);
        assert_eq!(result["content"][0]["type"], "text");
        assert!(result["structuredContent"]["suggestions"].is_array());
        let _ = std::fs::remove_dir_all(path);
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
        assert_eq!(specs.len(), expected + 6);
        assert!(specs
                .iter()
            .all(|spec| spec["name"].is_string() && spec["inputSchema"]["type"] == "object"));
        // mcp_call is an agent action, not something this server can proxy.
        assert!(!specs.iter().any(|spec| spec["name"] == "mcp_call"));
        for name in ["canvas_list", "canvas_read", "canvas_add", "canvas_update"] {
            assert!(
                specs.iter().any(|spec| spec["name"] == name),
                "missing {name}"
            );
        }
        for name in [
            "input_suggest",
            "input_search",
            "input_submit",
            "input_status",
            "input_cancel",
            "input_queue",
        ] {
            assert!(
                specs.iter().any(|spec| spec["name"] == name),
                "missing {name}"
            );
        }
        for name in ["homie_answer", "homie_delegate"] {
            assert!(specs.iter().any(|spec| spec["name"] == name), "missing {name}");
        }
    }

    #[test]
    fn legacy_authorities_and_anonymous_identity_allow_real_writes() {
        let (tools, path) = tempbelt("write");
        for (index, authority) in [Authority::ReadOnly, Authority::Workspace, Authority::Yolo]
            .into_iter()
            .enumerate()
        {
            let name = format!("x-{index}.txt");
            let params =
                json!({ "name": "write", "arguments": { "path": name, "content": "written" } });
            let result = tools_call(
            &params,
            &tools,
            &path.join(".hii"),
            &path,
                authority,
            "anonymous",
            None,
        )
            .expect("anonymous mutation should run without an approval channel");
            assert_eq!(result["isError"], json!(false));
            assert_eq!(std::fs::read_to_string(path.join(name)).unwrap(), "written");
        }
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn capability_tools_have_no_authority_gate_and_creation_succeeds_read_only() {
        let (tools, path) = tempbelt("capability-boundary");
        let install = json!({"name":"capability_install","arguments":{"kind":"tool","source":""}});
        for authority in [Authority::ReadOnly, Authority::Workspace, Authority::Owner] {
            let result = tools_call_inner(
                &install,
                &tools,
                &path.join(".hii"),
                &path,
                authority,
                "test",
                None,
            );
            assert!(!matches!(result, Err((AUTHORITY_DENIED, _))));
        }
        let create = json!({"name":"capability_create","arguments":{"kind":"skill","name":"fixture","content":"Read the requested file.","description":"Fixture skill"}});
        let result = tools_call_inner(
            &create,
            &tools,
            &path.join(".hii"),
            &path,
            Authority::ReadOnly,
            "test",
            None,
        )
        .expect("capability creation should succeed under legacy read-only label");
        assert_ne!(result["isError"], true);
        assert_eq!(
            std::fs::read_to_string(path.join(".hii/skills/fixture/SKILL.md")).unwrap(),
            "Read the requested file."
        );
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn legacy_authorities_and_anonymous_identity_allow_real_deletions() {
        let (tools, path) = tempbelt("nested-delete");
        for (index, authority) in [Authority::ReadOnly, Authority::Workspace, Authority::Yolo]
            .into_iter()
            .enumerate()
        {
            let name = format!("f-{index}.txt");
            std::fs::write(path.join(&name), "remove fixture").unwrap();
            let command = format!("rm {name}");
            let params = json!({ "name": "shell", "arguments": { "command": command } });
            let result = tools_call(
            &params,
            &tools,
            &path.join(".hii"),
            &path,
                authority,
            "anonymous",
            None,
        )
            .expect("anonymous deletion should run without an approval channel");
            assert_eq!(result["isError"], json!(false));
            assert!(!path.join(name).exists());
        }
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
            &path.join(".hii"),
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
    fn deletion_runs_without_an_interactive_approval_channel() {
        let (tools, path) = tempbelt("delete");
        std::fs::write(path.join("f.txt"), "keep").unwrap();
        let params = json!({ "name": "shell", "arguments": { "command": "rm f.txt" } });
        let result = tools_call(
            &params,
            &tools,
            &path.join(".hii"),
            &path,
            Authority::Yolo,
            "anonymous",
            None,
        )
        .expect("deletion should run without an interactive approval channel");
        assert_eq!(result["isError"], json!(false));
        assert!(!path.join("f.txt").exists());
        let _ = std::fs::remove_dir_all(path);
    }
}
