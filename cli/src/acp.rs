//! Protocol boundary scaffold (plan Phase 11).
//!
//! The durable interface layer will speak ACP northbound (to the operator) and
//! MCP southbound (to tools). Full duplex servers are a later milestone; this
//! module publishes the machine-readable **tool manifest** — the single source
//! of truth for the bounded executors HII currently exposes — not a boundary on
//! what an agent may reason about or construct — so an ACP/MCP adapter (or another agent)
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
    pub fn label(self) -> &'static str {
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
        "config_read",
        "hii",
        Reach::Hii,
        false,
        "read bounded HII CLI presentation settings",
    ),
    tool(
        "config_write",
        "hii",
        Reach::Hii,
        true,
        "change one bounded HII CLI presentation setting",
    ),
    tool(
        "canvas_list",
        "hii",
        Reach::Hii,
        false,
        "list the canonical HII canvas objects with stable ids and geometry",
    ),
    tool(
        "canvas_read",
        "hii",
        Reach::Hii,
        false,
        "read one canonical HII canvas object by stable id",
    ),
    tool(
        "canvas_add",
        "hii",
        Reach::Hii,
        true,
        "add a bounded editable object to the canonical HII canvas",
    ),
    tool(
        "canvas_update",
        "hii",
        Reach::Hii,
        true,
        "move, resize, rename, or update one canonical HII canvas object",
    ),
    tool(
        "info_find",
        "hii",
        Reach::Hii,
        false,
        "search durable HII information or discover web sources",
    ),
    tool(
        "info_capture",
        "hii",
        Reach::Hii,
        true,
        "capture a web source as durable content, image, lineage, and proof objects",
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
        "schedule_read",
        "hii",
        Reach::Hii,
        false,
        "read local recurring HII work",
    ),
    tool(
        "schedule_write",
        "hii",
        Reach::Hii,
        true,
        "create local recurring HII work",
    ),
    tool(
        "system_status",
        "hii",
        Reach::Hii,
        false,
        "read enrolled Mac and PC executor status",
    ),
    tool(
        "system_observe",
        "hii",
        Reach::Hii,
        false,
        "request a read-only observation from an enrolled executor",
    ),
    tool(
        "object_list",
        "hii",
        Reach::Hii,
        false,
        "list objects through an approved HII grant",
    ),
    tool(
        "object_read",
        "hii",
        Reach::Hii,
        false,
        "read one object through an approved HII grant",
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

pub fn tools() -> &'static [ToolSpec] {
    TOOLS
}

pub fn action_tool_names(include_hii: bool) -> Vec<&'static str> {
    TOOLS
        .iter()
        .filter(|spec| spec.reach != Reach::Mcp)
        .filter(|spec| include_hii || spec.reach != Reach::Hii)
        .map(|spec| spec.name)
        .collect()
}

/// Actions that end or continue the exchange rather than touching anything.
///
/// Deliberately outside [`TOOLS`]: the manifest describes capabilities, and a
/// downstream MCP client has no use for "the agent decided it was done".
pub const CONTROL_ACTIONS: &[&str] = &["final", "message"];

/// Every `"type"` an action may carry — tools plus control actions.
///
/// The prompt and the JSON schema have to offer the same set. A backend that
/// does not honor a schema constraint leaves the prompt as the model's only
/// signal — HII accepts `response_format: json_object` and nothing more —
/// so a `final` present only in the schema is a `final` the model never learns
/// about, and the session can never complete.
pub fn action_type_names(include_hii: bool) -> Vec<&'static str> {
    let mut names = action_tool_names(include_hii);
    names.extend_from_slice(CONTROL_ACTIONS);
    names
}

/// The published input schema for `name`.
///
/// Ten tools have no entry below and fall through to a `{ "query": string }`
/// placeholder that does not describe them — `board_write`, `bridge_send` and
/// the rest take parameters this never mentions. The placeholder is preserved
/// because it is already published in the MCP manifest, but callers that need
/// to know whether a schema is authoritative must ask
/// [`has_declared_input_schema`] rather than trusting what comes back here.
pub fn input_schema(name: &str) -> Value {
    let object = |properties: Value, required: Value| json!({ "type": "object", "properties": properties, "required": required });
    let string = json!({ "type": "string" });
    let integer = json!({ "type": "integer" });
    match name {
        "read" => object(
            json!({ "path": string, "offset": integer, "limit": integer }),
            json!(["path"]),
        ),
        "list" => object(json!({ "path": string }), json!([])),
        "search" => object(json!({ "query": string, "path": string }), json!(["query"])),
        "web_search" => object(json!({ "query": string }), json!(["query"])),
        "web_fetch" => object(json!({ "url": string }), json!(["url"])),
        "write" => object(
            json!({ "path": string, "content": string }),
            json!(["path", "content"]),
        ),
        "edit" => object(
            json!({
                "path": string,
                "old": string,
                "new": string,
                "replace_all": { "type": "boolean" },
            }),
            json!(["path", "old", "new"]),
        ),
        "shell" | "verify" => object(json!({ "command": string }), json!(["command"])),
        "http" => object(json!({ "url": string }), json!(["url"])),
        "config_read" => object(json!({}), json!([])),
        "config_write" => object(
            json!({ "key": string, "value": string }),
            json!(["key", "value"]),
        ),
        "info_find" => object(
            json!({ "query": string, "web": { "type": "boolean" }, "limit": integer }),
            json!(["query"]),
        ),
        "info_capture" => object(json!({ "url": string }), json!(["url"])),
        "system_status" => object(json!({ "system": string }), json!([])),
        "system_observe" => object(
            json!({
                "system": string,
                "kind": { "type": "string", "enum": ["status", "apps", "files", "proof"] },
                "path": string,
                "receipt": string,
            }),
            json!(["system", "kind"]),
        ),
        "canvas_list" => object(json!({ "spaceId": string, "limit": integer }), json!([])),
        "canvas_read" => object(
            json!({ "spaceId": string, "objectId": string }),
            json!(["objectId"]),
        ),
        "canvas_add" => object(
            json!({
                "spaceId": string,
                "idempotencyKey": string,
                "authorityGrantId": string,
                "type": { "type": "string", "enum": ["note", "canvas-text", "image", "link", "document", "frame"] },
                "title": string,
                "content": string,
                "url": string,
                "x": { "type": "number" },
                "y": { "type": "number" },
                "width": { "type": "number" },
                "height": { "type": "number" },
                "payload": { "type": "object" }
            }),
            json!(["idempotencyKey", "type"]),
        ),
        "canvas_update" => object(
            json!({
                "spaceId": string,
                "idempotencyKey": string,
                "authorityGrantId": string,
                "objectId": string,
                "title": string,
                "content": string,
                "url": string,
                "x": { "type": "number" },
                "y": { "type": "number" },
                "width": { "type": "number" },
                "height": { "type": "number" },
                "rotation": { "type": "number" },
                "payload": { "type": "object" }
            }),
            json!(["idempotencyKey", "objectId"]),
        ),
        "object_read" => object(
            json!({ "grant": string, "object": string }),
            json!(["grant", "object"]),
        ),
        "object_list" => object(json!({ "grant": string }), json!(["grant"])),
        "schedule_write" => object(
            json!({ "cron": string, "task": string, "query": string }),
            json!([]),
        ),
        _ => object(json!({ "query": string }), json!([])),
    }
}

/// Does [`input_schema`] actually describe this tool, or is it the placeholder?
///
/// Enforcing "no undeclared parameters" against a placeholder would reject every
/// real call to the tools it covers, so enforcement asks this first.
pub fn has_declared_input_schema(name: &str) -> bool {
    // The placeholder is exactly an optional `query` and nothing else. Tools
    // that really do take just a query — `web_search` — require it, so they do
    // not collide with this.
    input_schema(name)
        != json!({
            "type": "object",
            "properties": { "query": { "type": "string" } },
            "required": []
        })
}

/// Keys every action may carry regardless of which tool it names: the
/// discriminator itself, the explicit `{"type":"tool","tool":"read"}` spelling,
/// a free-text justification, and the optional flow projection.
pub const ACTION_ENVELOPE_KEYS: &[&str] = &["type", "tool", "reason", "flow"];

/// The complete action grammar, as one JSON Schema.
///
/// This is what the model is *physically* allowed to emit. Each action is its
/// own branch carrying only the parameters its tool declares, closed with
/// `additionalProperties: false`, so a shape like
/// `{"type":"read","path":"x.py","content":"<invented file body>"}` cannot be
/// generated at all.
///
/// That shape is not hypothetical. It is what the 9B model produced on step 1
/// of a real run: a `read` carrying 5138 characters of hallucinated file
/// content, which ran past the completion cap mid-string, truncated into
/// invalid JSON, cost a protocol retry and 2048 tokens — and then, because the
/// invented body stayed in the transcript, the model spent two more steps
/// editing against a file that never existed. A flat schema that accepts every
/// property on every action cannot prevent any step of that; a per-action
/// schema makes it unreachable.
///
/// Derived from [`input_schema`] so the grammar, the published MCP manifest,
/// and the loop's own validation cannot drift apart.
pub fn action_schema() -> Value {
    let string = json!({ "type": "string" });
    let mut branches: Vec<Value> = action_tool_names(true)
        .into_iter()
        .map(|name| {
            let schema = input_schema(name);
            let mut properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            properties.insert("type".into(), json!({ "const": name }));
            properties.insert("reason".into(), string.clone());
            let mut required = vec![json!("type")];
            if let Some(list) = schema.get("required").and_then(Value::as_array) {
                required.extend(list.iter().cloned());
            }
            json!({
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": false,
            })
        })
        .collect();
    branches.push(json!({
        "type": "object",
        "properties": {
            "type": { "const": "final" },
            "summary": string,
            "verification": { "type": "array", "items": string },
            "next": string,
        },
        "required": ["type", "summary"],
        "additionalProperties": false,
    }));
    branches.push(json!({
        "type": "object",
        "properties": { "type": { "const": "message" }, "message": string },
        "required": ["type", "message"],
        "additionalProperties": false,
    }));
    branches.push(json!({
        "type": "object",
        "properties": {
            "type": { "const": "mcp_call" },
            "server": string,
            "tool": string,
            "arguments": { "type": "object" },
            "reason": string,
        },
        "required": ["type", "server", "tool"],
        "additionalProperties": false,
    }));
    json!({ "oneOf": branches })
}

/// Check a raw action object against the grammar its tool declares.
///
/// Runs on the parsed JSON rather than the deserialized [`Action`], because
/// `Action::Tool` flattens every tool's parameters into one struct: by the time
/// it exists, "this key was present" and "this key belongs here" are no longer
/// distinguishable. Two failures are reported:
///
/// * a **missing** required parameter — a compact model emitting
///   `{"type":"verify"}` while trying to finish; and
/// * an **unexpected** parameter, which is the more valuable signal. A tool
///   parameter the tool does not have is the model stating something it cannot
///   know. Rejecting it costs one retry; accepting it writes a confabulation
///   into the transcript that the model then treats as an observation.
///
/// A backend that honors [`action_schema`] never reaches these errors. Not
/// every backend does, so the same rules are enforced here as well.
pub fn validate_action_params(tool: &str, value: &Value) -> Result<(), String> {
    let schema = input_schema(tool);
    let declared = schema
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let object = match value.as_object() {
        Some(object) => object,
        None => return Err("an action must be a JSON object".into()),
    };

    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            let present = object.get(key).is_some_and(|value| match value {
                Value::Null => false,
                Value::String(text) => !text.trim().is_empty(),
                _ => true,
            });
            if !present {
                return Err(format!("{tool} requires a non-empty {key}"));
            }
        }
    }

    // Only a tool whose schema actually describes it can say which parameters
    // are undeclared. Against the `{ "query": string }` placeholder this check
    // would reject every real `board_write` or `bridge_send`.
    if !has_declared_input_schema(tool) {
        return Ok(());
    }
    let unexpected: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|key| !declared.contains_key(*key) && !ACTION_ENVELOPE_KEYS.contains(key))
        .collect();
    if unexpected.is_empty() {
        return Ok(());
    }
    let accepted = {
        let mut names: Vec<&str> = declared.keys().map(String::as_str).collect();
        names.sort_unstable();
        names
    };
    Err(format!(
        "{tool} does not take {}; it accepts only {}. Do not state a file's contents in the action that reads it — call the tool and use what it returns.",
        unexpected.join(", "),
        if accepted.is_empty() {
            "no parameters".to_string()
        } else {
            accepted.join(", ")
        }
    ))
}

pub fn output_schema(name: &str) -> Option<Value> {
    match name {
        "system_status" | "system_observe" => Some(json!({
            "type": "object",
            "properties": {
                "system": { "type": "string" },
                "status": { "type": "string" },
                "next": { "type": "string" },
                "receipt": { "type": "object" }
            }
        })),
        "canvas_list" | "canvas_read" | "canvas_add" | "canvas_update" => Some(json!({
            "type": "object",
            "properties": {
                "spaceId": { "type": "string" },
                "sequence": { "type": "integer" },
                "object": { "type": "object" },
                "objects": { "type": "array" }
            }
        })),
        _ => None,
    }
}

pub fn annotations(spec: &ToolSpec) -> Value {
    let read_only = !spec.mutates;
    let open_world = matches!(spec.reach, Reach::Network | Reach::Mcp)
        || matches!(
            spec.name,
            "system_status" | "system_observe" | "bridge_send" | "bridge_read"
        );
    let destructive = matches!(spec.name, "write" | "edit" | "shell");
    json!({
        "readOnlyHint": read_only,
        "destructiveHint": destructive,
        "idempotentHint": read_only,
        "openWorldHint": open_world,
        "mutates": spec.mutates,
        "reach": spec.reach.label(),
    })
}

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
                "inputSchema": input_schema(spec.name),
                "outputSchema": output_schema(spec.name),
                "annotations": annotations(spec),
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
/// can do — and excluded from what `hii mcp` advertises.
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
    fn the_prompt_offers_the_same_action_types_the_schema_does() {
        // A `final` that exists only in the JSON schema is invisible to any
        // backend that does not honor schema constraints, which is why no
        // interactive session had ever reached one.
        let names = super::action_type_names(true);
        assert!(names.contains(&"final"), "final must be offered: {names:?}");
        assert!(names.contains(&"message"));
        assert!(names.contains(&"read"));
    }

    #[test]
    fn control_actions_stay_out_of_the_published_tool_manifest() {
        let manifest = super::manifest();
        let tools = manifest["tools"].as_array().expect("tools");
        for control in super::CONTROL_ACTIONS {
            assert!(
                !tools.iter().any(|tool| tool["name"] == *control),
                "{control} is not a capability and must not be advertised as a tool"
            );
        }
    }

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

    /// The concrete confabulation this rejects: on step 1 of a real run the
    /// model emitted a `read` carrying 5138 characters of invented file body,
    /// then spent two further steps editing against the file it had imagined.
    /// The harness ignored the field; the transcript did not.
    #[test]
    fn a_read_cannot_smuggle_an_invented_file_body() {
        let action =
            json!({ "type": "read", "path": "fizz.py", "content": "def fizz(n):\n    ..." });
        let error =
            validate_action_params("read", &action).expect_err("content is not a read parameter");
        assert!(error.contains("content"), "{error}");
        assert!(
            error.contains("path"),
            "should name what read does accept: {error}"
        );

        let honest = json!({ "type": "read", "path": "fizz.py" });
        assert!(validate_action_params("read", &honest).is_ok());
    }

    #[test]
    fn a_missing_required_parameter_is_named() {
        let error = validate_action_params("verify", &json!({ "type": "verify" }))
            .expect_err("verify needs a command");
        assert!(error.contains("command"), "{error}");
        // Present-but-blank is missing, not satisfied.
        assert!(validate_action_params(
            "edit",
            &json!({ "type": "edit", "path": "  ", "old": "a", "new": "b" })
        )
        .is_err());
    }

    /// Ten tools publish a `{ "query": string }` placeholder that does not
    /// describe them. Enforcing undeclared-parameter rejection against that
    /// placeholder would reject every real call to them.
    #[test]
    fn placeholder_schemas_never_reject_a_real_call() {
        for name in [
            "board_write",
            "bridge_send",
            "og_next",
            "caps_check",
            "hii_context",
        ] {
            assert!(
                !has_declared_input_schema(name),
                "{name} gained a real schema; enforce it"
            );
            assert!(
                validate_action_params(name, &json!({ "type": name, "task": "x", "anything": 1 }))
                    .is_ok(),
                "{name} must not be gated by a placeholder"
            );
        }
        assert!(has_declared_input_schema("read"));
        assert!(has_declared_input_schema("web_search"));
    }

    /// Every tool the agent can execute must be reachable as a flat action.
    /// Ten were not: the parser carried its own copy of this list.
    #[test]
    fn every_executable_tool_is_reachable_as_a_flat_action() {
        for spec in tools() {
            if spec.reach == Reach::Mcp {
                continue;
            }
            assert!(
                action_tool_names(true).contains(&spec.name),
                "{} is advertised and executable but unreachable",
                spec.name
            );
        }
    }
}
