//! HII operating-logic tools (plan Phase 9).
//!
//! These let the workspace agent work *through* HII rather than around it:
//! reading the operational graph, checking capabilities, touching the local
//! board, searching skills, and handing off over the bridge. Read tools shell
//! out to the `hii` front controller (which routes context/og/caps/bridge to
//! the compatibility layer); they are local-first and carry no network effect.

use crate::tools::ToolResult;
use hii_core::{
    runtime::{IdentityRefV1, RuntimeSpaceApplyV1},
    runtime_space_apply, runtime_space_snapshot,
};
use serde_json::Value;
use std::{
    path::Path,
    process::{Command, Stdio},
};

/// The HII-native tool names the agent may call, in addition to the filesystem
/// toolbelt. Kept in one place so the schema, dispatcher, and docs agree.
pub const HII_TOOLS: &[&str] = &[
    "hii_context",
    "config_read",
    "config_write",
    "canvas_list",
    "canvas_read",
    "canvas_add",
    "canvas_update",
    "info_find",
    "info_capture",
    "og_next",
    "caps_check",
    "board_read",
    "model_benchmark",
    "capability_install",
    "capability_create",
    "model_catalog",
    "board_write",
    "skill_search",
    "skill_read",
    "library_read",
    "library_write",
    "schedule_read",
    "schedule_write",
    "system_status",
    "system_observe",
    "agent_send",
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
    matches!(
        tool,
        "info_capture"
            | "library_write"
            | "capability_install"
            | "capability_create"
            | "config_write"
            | "board_write"
            | "schedule_write"
            | "agent_send"
            | "bridge_send"
            | "canvas_add"
            | "canvas_update"
    )
}

/// Dispatch an HII tool. `repo` is the HII repository root; `query` carries the
/// tool's single free-text argument (a task title, search term, or message).
/// Dispatch through the active run's process supervisor when available.
pub fn execute_with_tools(
    repo: &Path,
    tool: &str,
    arguments: Option<&Value>,
    tools: &crate::tools::Toolbelt,
) -> ToolResult {
    if tool == "model_catalog" {
        let script = match crate::install::resource(repo, "runtime/daemon/hiid.mjs") {
            Ok(script) => script,
            Err(output) => {
                return ToolResult {
                    ok: false,
                    output,
                    verification: false,
                }
            }
        };
        let args = vec![
            script.display().to_string(),
            "model-runtime".into(),
            "recommend".into(),
            "--json".into(),
        ];
        return tools.run_owned_program_stdout("node", &args, 30);
    }
    if matches!(tool, "capability_install" | "capability_create") {
        let empty = serde_json::json!({});
        let args = arguments
            .and_then(|value| {
                value
                    .get("arguments")
                    .filter(|nested| nested.is_object())
                    .or(Some(value))
            })
            .unwrap_or(&empty);
        let result = if tool == "capability_create" {
            crate::install::create(tools.workspace(), args)
        } else {
            let plan = crate::config::AppPaths::discover().and_then(|paths| {
                crate::install::plan(repo, &paths.runtime, tools.workspace(), args)
            });
            return match plan {
                Ok(plan) => {
                    let mut result =
                        tools.run_owned_program(&plan.program, &plan.args, plan.timeout_secs);
                    // The installer exits successfully only after its kind-specific
                    // cache, source, or package check and durable receipt succeed.
                    result.verification = result.ok;
                    result
                }
                Err(output) => ToolResult {
                    ok: false,
                    output,
                    verification: false,
                },
            };
        };
        return match result {
            Ok(output) => ToolResult {
                ok: true,
                output,
                // Saving a skill draft is verified by exact content readback.
                // Generated tool behavior still requires an execution check.
                verification: args["kind"] == "skill",
            },
            Err(output) => ToolResult {
                ok: false,
                output,
                verification: false,
            },
        };
    }
    if tool == "model_benchmark" {
        return match benchmark_arguments(repo) {
            Ok(args) => tools.run_owned_program("python3", &args, 900),
            Err(output) => ToolResult {
                ok: false,
                output,
                verification: false,
            },
        };
    }
    if matches!(tool, "skill_search" | "skill_read") {
        return skill_tool_result(
            repo,
            Some(tools.workspace()),
            tool,
            arguments,
        );
    }
    let mut result = execute(repo, tool, arguments);
    if tool == "system_status" && result.ok {
        if let Ok(mut value) = serde_json::from_str::<Value>(&result.output) {
            value["local_observation"]["workspace"] = serde_json::json!(tools.workspace());
            result.output = serde_json::to_string_pretty(&value).unwrap_or(result.output);
        }
    }
    result
}

pub fn execute(repo: &Path, tool: &str, arguments: Option<&Value>) -> ToolResult {
    execute_as(repo, tool, arguments, "hii-agent")
}

pub fn execute_as(
    repo: &Path,
    tool: &str,
    arguments: Option<&Value>,
    actor_id: &str,
) -> ToolResult {
    let arg = argument_text(arguments).unwrap_or_default();
    let arg = arg.trim();
    let result = match tool {
        "hii_context" => hii(repo, &["context", "--json"]).and_then(compact_context),
        "config_read" => crate::config::AppPaths::discover()
            .map(|paths| crate::settings::describe(&paths.runtime)),
        "config_write" => crate::config::AppPaths::discover().and_then(|paths| {
            let pair = argument_field(arguments, "query").unwrap_or_default();
            let fallback = pair
                .split_once('=')
                .or_else(|| pair.split_once(char::is_whitespace));
            let key = argument_field(arguments, "key")
                .or_else(|| fallback.map(|(key, _)| key.trim().into()))
                .ok_or_else(|| "config_write needs `key` and `value`".to_string())?;
            let value = argument_field(arguments, "value")
                .or_else(|| fallback.map(|(_, value)| value.trim().into()))
                .ok_or_else(|| "config_write needs `key` and `value`".to_string())?;
            crate::settings::set(&paths.runtime, &key, &value)?;
            Ok(crate::settings::describe(&paths.runtime))
        }),
        "canvas_list" => canvas_list(arguments),
        "canvas_read" => canvas_read(arguments),
        "canvas_add" => canvas_add(arguments, actor_id),
        "canvas_update" => canvas_update(arguments, actor_id),
        "info_find" => {
            if arg.is_empty() {
                Err("info_find needs a search query".to_string())
            } else {
                let web = arguments
                    .and_then(|value| value.get("web"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if web {
                    hii(repo, &["info", "find", arg, "--web", "--json"])
                } else {
                    hii(repo, &["info", "find", arg, "--json"])
                }
            }
        }
        "info_capture" => {
            let url = argument_field(arguments, "url").unwrap_or_else(|| arg.to_string());
            if url.trim().is_empty() {
                Err("info_capture needs a http or https URL".to_string())
            } else {
                hii(repo, &["info", "capture", url.trim(), "--json"])
            }
        }
        "og_next" => hii(repo, &["og", "status"]),
        "caps_check" => hii(repo, &["caps", "show"]),
        "board_read" => {
            let source = argument_field(arguments, "board_id")
                .or_else(|| argument_field(arguments, "source"))
                .unwrap_or_else(|| "local".into());
            if !matches!(
                source.to_ascii_lowercase().as_str(),
                "local" | "hii" | "workspace"
            ) {
                Err(format!("SOURCE_MISMATCH: board_read reads only HII's local board, not {source}. Discover and use the verified {source} connection; no data from that source was observed."))
            } else {
                hii(repo, &["board"])
                    .map(|output| format!("Source: HII local board (not Notion).\n{output}"))
            }
        }
        "model_benchmark" => model_benchmark(repo),
        "board_write" => {
            if arg.is_empty() {
                Err("board_write needs a task title in `query`".to_string())
            } else {
                hii(repo, &["task", arg])
            }
        }
        "skill_search" | "skill_read" => skill_tool(repo, None, tool, arguments),
        "library_read" | "library_write" => crate::config::AppPaths::discover().and_then(|paths| {
            crate::library::request(&paths,arguments.ok_or("Missing library arguments")?,tool=="library_read")
                .and_then(|value|serde_json::to_string(&value).map_err(|e|e.to_string()))
        }),
        "schedule_read" => hii(repo, &["schedule", "list"]),
        "schedule_write" => {
            let cron = argument_field(arguments, "cron").unwrap_or_default();
            let task = argument_field(arguments, "task").unwrap_or_default();
            let (cron, task) = if cron.trim().is_empty() || task.trim().is_empty() {
                arg.split_once("::").unwrap_or(("", ""))
            } else {
                (cron.as_str(), task.as_str())
            };
            if cron.trim().is_empty() || task.trim().is_empty() {
                Err("schedule_write needs `<five-field cron>::<task>` in `query`".to_string())
            } else {
                hii(repo, &["schedule", "add", cron.trim(), task.trim()])
            }
        }
        "system_status" => system_status(repo, arguments),
        "system_observe" => system_observe(repo, arguments),
        "agent_send" => {
            let handoff = arguments.and_then(|value| value.get("arguments"));
            let to = argument_field(handoff, "to").unwrap_or_default();
            let task = argument_field(handoff, "task").unwrap_or_default();
            let message = argument_field(handoff, "message").unwrap_or_default();
            if to.trim().is_empty() || task.trim().is_empty() || message.trim().is_empty() {
                Err(
                    "agent_send needs arguments.to, arguments.task, and arguments.message"
                        .to_string(),
                )
            } else {
                let mut command = vec![
                    "agents".to_string(),
                    "send".into(),
                    "--from".into(),
                    "hii-agent".into(),
                    "--to".into(),
                    to,
                    "--task".into(),
                    task,
                    "--message".into(),
                    message,
                ];
                for field in ["workspace", "receipt"] {
                    if let Some(value) = argument_field(handoff, field) {
                        command.push(format!("--{field}"));
                        command.push(value);
                    }
                }
                if let Some(contexts) = handoff
                    .and_then(|value| value.get("contextRefs"))
                    .and_then(Value::as_array)
                {
                    for context in contexts.iter().filter_map(Value::as_str) {
                        command.push("--context".into());
                        command.push(context.into());
                    }
                }
                hii(
                    repo,
                    &command.iter().map(String::as_str).collect::<Vec<_>>(),
                )
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
        "object_list" => {
            let grant = argument_field(arguments, "grant").unwrap_or_else(|| arg.to_string());
            if grant.trim().is_empty() {
                hii(repo, &["object", "list", "--json"])
            } else {
                hii(repo, &["object", "list", "--json", "--grant", grant.trim()])
            }
        }
        "object_read" => {
            let grant = argument_field(arguments, "grant").unwrap_or_default();
            let object = argument_field(arguments, "object").unwrap_or_default();
            let (grant, id) = if object.trim().is_empty() {
                arg.split_once("::").unwrap_or((grant.as_str(), arg))
            } else {
                (grant.as_str(), object.as_str())
            };
            if id.trim().is_empty() {
                Err("object_read needs an object id in `query` or `arguments.object`".to_string())
            } else if grant.trim().is_empty() {
                hii(repo, &["object", "read", "--json", "--object", id])
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

fn canvas_snapshot(
    arguments: Option<&Value>,
) -> Result<hii_core::runtime::RuntimeSpaceSnapshotV1, String> {
    runtime_space_snapshot(
        argument_field(arguments, "spaceId").filter(|value| !value.trim().is_empty()),
    )
}

fn canvas_list(arguments: Option<&Value>) -> Result<String, String> {
    let snapshot = canvas_snapshot(arguments)?;
    let limit = arguments
        .and_then(|value| value.get("limit"))
        .and_then(Value::as_u64)
        .unwrap_or(200)
        .clamp(1, 500) as usize;
    let objects = snapshot
        .document
        .get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    serde_json::to_string(&serde_json::json!({
        "spaceId": snapshot.space_id,
        "sequence": snapshot.sequence,
        "objects": objects
    }))
    .map_err(|error| error.to_string())
}

fn canvas_read(arguments: Option<&Value>) -> Result<String, String> {
    let reference = required_argument(arguments, "objectId")?;
    let snapshot = canvas_snapshot(arguments)?;
    let id = hii_core::runtime::resolve_space_object_id(&snapshot, &reference)?;
    let object = snapshot
        .document
        .get("nodes")
        .and_then(Value::as_array)
        .and_then(|nodes| {
            nodes
                .iter()
                .find(|node| node.get("id").and_then(Value::as_str) == Some(id.as_str()))
        })
        .cloned()
        .ok_or_else(|| format!("canvas object not found: {id}"))?;
    serde_json::to_string(&serde_json::json!({
        "spaceId": snapshot.space_id,
        "sequence": snapshot.sequence,
        "object": object
    }))
    .map_err(|error| error.to_string())
}

fn canvas_add(arguments: Option<&Value>, actor_id: &str) -> Result<String, String> {
    let kind = required_argument(arguments, "type")?;
    if !matches!(
        kind.as_str(),
        "note" | "canvas-text" | "image" | "link" | "document" | "frame" | "run" | "intent"
    ) {
        return Err(format!("canvas_add type is not allowed: {kind}"));
    }
    let mut snapshot = canvas_snapshot(arguments)?;
    let now = chrono::Utc::now().to_rfc3339();
    let id = format!("mcp-{}", uuid::Uuid::new_v4());
    let next_z = snapshot
        .document
        .get("nextZ")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        + 1;
    let count = snapshot
        .document
        .get("nodes")
        .and_then(Value::as_array)
        .map_or(0, Vec::len) as f64;
    let mut payload = arguments
        .and_then(|value| value.get("payload"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    copy_string_argument(arguments, "title", &mut payload, "title");
    copy_string_argument(
        arguments,
        "content",
        &mut payload,
        match kind.as_str() {
            "canvas-text" => "text",
            // A run or intent object carries the sentence it exists to carry
            // out; the run pane reads `prompt` first.
            "run" | "intent" => "prompt",
            _ => "content",
        },
    );
    copy_string_argument(arguments, "url", &mut payload, "url");
    // An agent may propose a run; it may not start one. The object is written
    // in exactly the state a person has to approve, and `autoStart` is set
    // here rather than copied from arguments so it cannot be overridden.
    let proposes_work = matches!(kind.as_str(), "run" | "intent");
    if proposes_work {
        payload.insert("status".into(), Value::from("waiting_approval"));
        payload.insert("autoStart".into(), Value::from(false));
    }
    // Match `defaultSize` in lib/workspace/ingest.ts so an agent-placed run has
    // room for its manifest without the person resizing it first.
    let (default_width, default_height) = match kind.as_str() {
        "run" => (620.0, 460.0),
        "intent" => (520.0, 150.0),
        _ => (360.0, 240.0),
    };
    let node = serde_json::json!({
        "id": id,
        "type": kind,
        "x": bounded_number(arguments, "x", 80.0 + (count % 6.0) * 48.0, -100_000.0, 100_000.0),
        "y": bounded_number(arguments, "y", 80.0 + (count % 5.0) * 42.0, -100_000.0, 100_000.0),
        "w": bounded_number(arguments, "width", default_width, 80.0, 4096.0),
        "h": bounded_number(arguments, "height", default_height, 60.0, 4096.0),
        "z": next_z,
        "rotation": 0,
        "createdAt": now,
        "updatedAt": now,
        "object": {
            "kind": match kind.as_str() {
                "frame" => "scene",
                "run" => "run",
                "intent" => "intent",
                _ => "artifact",
            },
            "owner": actor_id,
            "status": if proposes_work { "waiting_approval" } else { "ready" },
            "source": "hii mcp",
            "capabilityId": if proposes_work {
                "hii.agent.workspace_run"
            } else {
                "hii.workspace.creative_canvas"
            },
            "audit": [{ "ts": now, "actor": "agent", "action": "added object through hii mcp" }]
        },
        "payload": payload
    });
    snapshot.document["revision"] = Value::from(snapshot.sequence);
    snapshot.document["updatedAt"] = Value::from(now);
    snapshot.document["nextZ"] = Value::from(next_z);
    snapshot.document["nodes"]
        .as_array_mut()
        .ok_or_else(|| "canvas nodes are unavailable".to_string())?
        .push(node.clone());
    apply_canvas(snapshot, arguments, actor_id, node)
}

fn canvas_update(arguments: Option<&Value>, actor_id: &str) -> Result<String, String> {
    let reference = required_argument(arguments, "objectId")?;
    let mut snapshot = canvas_snapshot(arguments)?;
    let id = hii_core::runtime::resolve_space_object_id(&snapshot, &reference)?;
    let now = chrono::Utc::now().to_rfc3339();
    let node = snapshot
        .document
        .get_mut("nodes")
        .and_then(Value::as_array_mut)
        .and_then(|nodes| {
            nodes
                .iter_mut()
                .find(|node| node.get("id").and_then(Value::as_str) == Some(id.as_str()))
        })
        .ok_or_else(|| format!("canvas object not found: {id}"))?;
    for (argument, field, fallback, min, max) in [
        ("x", "x", 0.0, -100_000.0, 100_000.0),
        ("y", "y", 0.0, -100_000.0, 100_000.0),
        ("width", "w", 360.0, 80.0, 4096.0),
        ("height", "h", 240.0, 60.0, 4096.0),
        ("rotation", "rotation", 0.0, -360.0, 360.0),
    ] {
        if arguments.and_then(|value| value.get(argument)).is_some() {
            node[field] =
                serde_json::json!(bounded_number(arguments, argument, fallback, min, max));
        }
    }
    let content_field = if node.get("type").and_then(Value::as_str) == Some("canvas-text") {
        "text"
    } else {
        "content"
    };
    let payload = node
        .get_mut("payload")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "canvas object payload is unavailable".to_string())?;
    if let Some(patch) = arguments
        .and_then(|value| value.get("payload"))
        .and_then(Value::as_object)
    {
        for (key, value) in patch {
            payload.insert(key.clone(), value.clone());
        }
    }
    copy_string_argument(arguments, "title", payload, "title");
    copy_string_argument(arguments, "content", payload, content_field);
    copy_string_argument(arguments, "url", payload, "url");
    node["updatedAt"] = Value::from(now.clone());
    let updated = node.clone();
    snapshot.document["revision"] = Value::from(snapshot.sequence);
    snapshot.document["updatedAt"] = Value::from(now);
    apply_canvas(snapshot, arguments, actor_id, updated)
}

fn apply_canvas(
    snapshot: hii_core::runtime::RuntimeSpaceSnapshotV1,
    arguments: Option<&Value>,
    actor_id: &str,
    object: Value,
) -> Result<String, String> {
    let idempotency_key = required_argument(arguments, "idempotencyKey")?;
    let actor = IdentityRefV1 {
        id: format!("mcp:{actor_id}"),
        kind: "agent".into(),
    };
    let run_id = crate::run_context::run_id();
    let grant_id = match argument_field(arguments, "authorityGrantId")
        .filter(|value| !value.trim().is_empty())
    {
        Some(grant) => grant, // Caller-supplied grants must already exist.
        None => {
            // This adapter runs only after the run authority / MCP ACL gates.
            // A stable identity makes revocation durable across later calls.
            let scope = serde_json::to_vec(&(&actor.id, &snapshot.space_id, &run_id))
                .map_err(|error| error.to_string())?;
            let digest = ring::digest::digest(&ring::digest::SHA256, &scope);
            let grant = format!(
                "mcp-acl:{}",
                digest
                    .as_ref()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            );
            hii_core::runtime::grant_space_mutation(
                &hii_core::runtime_root()?,
                &snapshot.space_id,
                &IdentityRefV1 {
                    id: "human:local".into(),
                    kind: "human".into(),
                },
                &actor,
                &grant,
                run_id.as_deref(),
            )?;
            grant
        }
    };
    let applied = runtime_space_apply(RuntimeSpaceApplyV1 {
        version: 1,
        space_id: Some(snapshot.space_id.clone()),
        expected_sequence: snapshot.sequence,
        actor,
        authority_grant_id: Some(grant_id),
        run_id,
        idempotency_key,
        document: snapshot.document,
    })?;
    serde_json::to_string(&serde_json::json!({
        "spaceId": applied.space_id,
        "sequence": applied.sequence,
        "object": object
    }))
    .map_err(|error| error.to_string())
}

fn required_argument(arguments: Option<&Value>, field: &str) -> Result<String, String> {
    argument_field(arguments, field)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{field} is required"))
}

fn bounded_number(
    arguments: Option<&Value>,
    field: &str,
    fallback: f64,
    min: f64,
    max: f64,
) -> f64 {
    arguments
        .and_then(|value| value.get(field))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn copy_string_argument(
    arguments: Option<&Value>,
    source: &str,
    target: &mut serde_json::Map<String, Value>,
    destination: &str,
) {
    if let Some(value) = argument_field(arguments, source) {
        target.insert(
            destination.into(),
            Value::from(value.chars().take(100_000).collect::<String>()),
        );
    }
}

fn argument_text(arguments: Option<&Value>) -> Option<String> {
    let value = arguments?;
    if let Some(query) = value
        .get("query")
        .and_then(Value::as_str)
        .filter(|query| !query.is_empty())
    {
        return Some(query.to_string());
    }
    if let Some(nested) = value.get("arguments") {
        if let Some(text) = argument_text(Some(nested)) {
            return Some(text);
        }
    }
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    None
}

fn argument_field(arguments: Option<&Value>, field: &str) -> Option<String> {
    let arguments = arguments?;
    arguments
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| argument_field(arguments.get("arguments"), field))
}

fn system_status(repo: &Path, arguments: Option<&Value>) -> Result<String, String> {
    let system = argument_field(arguments, "system");
    let mut args = vec!["systems", "status"];
    if let Some(system) = system.as_deref().filter(|value| !value.trim().is_empty()) {
        args.push(system.trim());
    }
    args.push("--json");
    let output = hii(repo, &args)?;
    let mut value: Value = serde_json::from_str(&output).map_err(|e| e.to_string())?;
    value["local_observation"] = serde_json::json!({"os": std::env::consts::OS, "architecture": std::env::consts::ARCH, "hii_resources": repo, "source": "current HII process", "observed_at_unix_ms": crate::clock::unix_ms()});
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

fn system_observe(repo: &Path, arguments: Option<&Value>) -> Result<String, String> {
    let system = argument_field(arguments, "system")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "system_observe needs `system`".to_string())?;
    let kind = argument_field(arguments, "kind")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "status".into());
    match kind.as_str() {
        "status" => hii(repo, &["systems", "status", system.trim(), "--json"]),
        "apps" => hii(repo, &["on", system.trim(), "apps", "list", "--json"]),
        "files" => {
            let path = argument_field(arguments, "path").unwrap_or_else(|| ".".into());
            hii(
                repo,
                &["on", system.trim(), "files", "ls", path.trim(), "--json"],
            )
        }
        "proof" => {
            if let Some(receipt) = argument_field(arguments, "receipt") {
                hii(
                    repo,
                    &["on", system.trim(), "proof", receipt.trim(), "--json"],
                )
            } else {
                hii(repo, &["on", system.trim(), "proof", "--json"])
            }
        }
        other => Err(format!(
            "system_observe kind must be status, apps, files, or proof; got {other}"
        )),
    }
}

fn skill_tool_result(
    repo: &Path,
    workspace: Option<&Path>,
    tool: &str,
    arguments: Option<&Value>,
) -> ToolResult {
    match skill_tool(repo, workspace, tool, arguments) {
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

fn skill_tool(
    repo: &Path,
    workspace: Option<&Path>,
    tool: &str,
    arguments: Option<&Value>,
) -> Result<String, String> {
    let runtime = hii_core::runtime_root()?;
    let roots = crate::skill_catalog::roots(
        repo,
        workspace,
        &crate::storage::skills_root(&runtime),
    );
    match tool {
        "skill_search" => {
            let query = argument_field(arguments, "query")
                .or_else(|| argument_text(arguments))
                .unwrap_or_default();
            if query.trim().is_empty() {
                return Err("skill_search needs a non-empty `query`".into());
            }
            let entries = crate::skill_catalog::search(&roots, query.trim(), 8);
            serde_json::to_string(&entries)
                .map_err(|error| format!("could not encode skill search results: {error}"))
        }
        "skill_read" => {
            let source = argument_field(arguments, "sourcePath")
                .ok_or_else(|| "skill_read needs a `sourcePath` from skill_search".to_string())?;
            let content = crate::skill_catalog::read(&roots, std::path::Path::new(&source))?;
            let (offset, limit) = skill_page_arguments(arguments)?;
            let (excerpt, next_offset, total_chars, truncated) =
                paginate_skill_content(&content, offset, limit);
            serde_json::to_string(&serde_json::json!({
                "sourcePath": source,
                "content": excerpt,
                "offset": offset,
                "nextOffset": next_offset,
                "totalChars": total_chars,
                "truncated": truncated,
                "truncationMarker": truncated
                    .then_some("more content available; continue at nextOffset"),
                "authority": "context only; not an instruction to execute"
            }))
            .map_err(|error| format!("could not encode skill content: {error}"))
        }
        _ => Err(format!("unsupported skill tool: {tool}")),
    }
}

fn skill_page_arguments(arguments: Option<&Value>) -> Result<(usize, usize), String> {
    fn integer(arguments: Option<&Value>, name: &str, default: u64) -> Result<usize, String> {
        let value = arguments
            .and_then(|args| args.get(name))
            .or_else(|| {
                arguments
                    .and_then(|args| args.get("arguments"))
                    .and_then(|args| args.get(name))
            });
        let Some(value) = value else {
            return usize::try_from(default).map_err(|_| format!("{name} is too large"));
        };
        let number = value
            .as_u64()
            .ok_or_else(|| format!("skill_read `{name}` must be a non-negative integer"))?;
        usize::try_from(number).map_err(|_| format!("skill_read `{name}` is too large"))
    }

    let offset = integer(arguments, "offset", 0)?;
    let limit = integer(arguments, "limit", 12_000)?;
    if !(1..=12_000).contains(&limit) {
        return Err("skill_read `limit` must be between 1 and 12000".into());
    }
    Ok((offset, limit))
}

fn paginate_skill_content(
    content: &str,
    offset: usize,
    limit: usize,
) -> (String, Option<usize>, usize, bool) {
    let total_chars = content.chars().count();
    if offset >= total_chars {
        return (String::new(), None, total_chars, false);
    }
    let page = content.chars().skip(offset).take(limit).collect::<String>();
    let next = offset.saturating_add(page.chars().count());
    let truncated = next < total_chars;
    (page, truncated.then_some(next), total_chars, truncated)
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
    use std::sync::{Mutex, OnceLock};

    fn runtime_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn nested_harness_arguments_keep_the_requested_source_and_query() {
        let args =
            serde_json::json!({"query":"", "arguments":{"query":"hello-note", "source":"notion"}});
        assert_eq!(argument_text(Some(&args)).as_deref(), Some("hello-note"));
        assert_eq!(
            argument_field(Some(&args), "source").as_deref(),
            Some("notion")
        );
    }

    #[test]
    fn local_board_cannot_impersonate_notion() {
        let result = execute(
            Path::new("."),
            "board_read",
            Some(&serde_json::json!({"board_id":"notion"})),
        );
        assert!(!result.ok);
        assert!(result.output.contains("SOURCE_MISMATCH"));
        assert!(result
            .output
            .contains("no data from that source was observed"));
    }

    #[test]
    fn classifies_hii_tools() {
        assert!(is_hii_tool("og_next"));
        assert!(is_hii_tool("info_find"));
        assert!(is_hii_tool("info_capture"));
        assert!(is_hii_tool("board_write"));
        assert!(is_hii_tool("skill_search"));
        assert!(is_hii_tool("skill_read"));
        assert!(!is_hii_tool("write"));
    }

    #[test]
    fn marks_mutating_hii_tools() {
        assert!(is_mutating("info_capture"));
        assert!(!is_mutating("info_find"));
        assert!(is_mutating("board_write"));
        assert!(is_mutating("bridge_send"));
        assert!(!is_mutating("board_read"));
        assert!(!is_mutating("og_next"));
        assert!(!is_mutating("skill_search"));
        assert!(!is_mutating("skill_read"));
    }

    #[test]
    fn skill_read_paginates_unicode_by_character_and_stops_at_end() {
        let (first, next, total, truncated) = paginate_skill_content("a界🙂b", 0, 2);
        assert_eq!(first, "a界");
        assert_eq!(next, Some(2));
        assert_eq!(total, 4);
        assert!(truncated);

        let (second, next, total, truncated) = paginate_skill_content("a界🙂b", 2, 2);
        assert_eq!(second, "🙂b");
        assert_eq!(next, None);
        assert_eq!(total, 4);
        assert!(!truncated);

        let (at_end, next, total, truncated) = paginate_skill_content("a界🙂b", 4, 2);
        assert!(at_end.is_empty());
        assert_eq!(next, None);
        assert_eq!(total, 4);
        assert!(!truncated);

        let (past_end, next, total, truncated) = paginate_skill_content("a界🙂b", 8, 2);
        assert!(past_end.is_empty());
        assert_eq!(next, None);
        assert_eq!(total, 4);
        assert!(!truncated);
    }

    #[test]
    fn skill_read_pagination_bounds_requested_page_size() {
        assert_eq!(
            skill_page_arguments(Some(&serde_json::json!({"offset": 3, "limit": 12000})))
                .unwrap(),
            (3, 12000)
        );
        assert!(skill_page_arguments(Some(&serde_json::json!({"limit": 0}))).is_err());
        assert!(skill_page_arguments(Some(&serde_json::json!({"limit": 12001}))).is_err());
        assert!(skill_page_arguments(Some(&serde_json::json!({"offset": -1}))).is_err());
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

    #[test]
    fn canvas_add_is_readable_from_canonical_runtime_space() {
        let _guard = runtime_env_lock().lock().expect("runtime env lock");
        let temp_dir = tempfile::tempdir().expect("temp runtime");
        let previous_runtime = std::env::var_os("HII_RUNTIME_DIR");
        std::env::set_var("HII_RUNTIME_DIR", temp_dir.path());

        let added = canvas_add(
            Some(&serde_json::json!({
                "spaceId": "test-space",
                "idempotencyKey": "test-canvas-add",
                "type": "note",
                "title": "MCP-visible note",
                "content": "hello from mcp"
            })),
            "test-agent",
        )
        .expect("canvas add");
        let added: serde_json::Value = serde_json::from_str(&added).expect("added json");
        let object_id = added["object"]["id"].as_str().expect("object id");

        let read = canvas_read(Some(&serde_json::json!({
            "spaceId": "test-space",
            "objectId": object_id
        })))
        .expect("canvas read");
        let read: serde_json::Value = serde_json::from_str(&read).expect("read json");

        assert_eq!(read["object"]["payload"]["title"], "MCP-visible note");
        assert_eq!(read["object"]["payload"]["content"], "hello from mcp");

        let mut snapshot = runtime_space_snapshot(Some("test-space".into())).unwrap();
        let grant = snapshot
            .recent_events
            .iter()
            .find_map(|event| event.authority_grant_id.clone())
            .expect("persisted grant in event");
        snapshot.document["nodes"][0]["handle"] = serde_json::json!("durable-note");
        runtime_space_apply(RuntimeSpaceApplyV1 {
            version: 1,
            space_id: Some(snapshot.space_id.clone()),
            expected_sequence: snapshot.sequence,
            actor: IdentityRefV1 {
                id: "human:local".into(),
                kind: "human".into(),
            },
            authority_grant_id: None,
            run_id: None,
            idempotency_key: "assign-test-handle".into(),
            document: snapshot.document,
        })
        .unwrap();
        assert!(canvas_read(Some(
            &serde_json::json!({"spaceId":"test-space", "objectId":"@durable-note"})
        ))
        .is_ok());
        let update = serde_json::json!({
            "spaceId":"test-space", "objectId":"@durable-note",
            "idempotencyKey":"handle-update", "content":"updated through handle"
        });
        assert!(canvas_update(Some(&update), "test-agent").is_ok());
        let mut forged = update.clone();
        forged["authorityGrantId"] = serde_json::json!("invented-permission");
        assert!(canvas_update(Some(&forged), "test-agent")
            .unwrap_err()
            .contains("does not authorize"));
        hii_core::runtime::revoke_space_mutation_grant(
            temp_dir.path(),
            "test-space",
            &IdentityRefV1 {
                id: "human:local".into(),
                kind: "human".into(),
            },
            &grant,
        )
        .unwrap();
        assert!(canvas_update(Some(&update), "test-agent")
            .unwrap_err()
            .contains("does not authorize"));

        if let Some(previous_runtime) = previous_runtime {
            std::env::set_var("HII_RUNTIME_DIR", previous_runtime);
        } else {
            std::env::remove_var("HII_RUNTIME_DIR");
        }
    }

    /// An agent can propose a run. It cannot approve one.
    ///
    /// The payload here asks for exactly that, and the arguments are copied
    /// into the object, so this is the drift that would be silent: a run that
    /// arrives already `running` skips the approval pane entirely.
    #[test]
    fn agent_placed_run_cannot_start_itself() {
        let _guard = runtime_env_lock().lock().expect("runtime env lock");
        let temp_dir = tempfile::tempdir().expect("temp runtime");
        let previous_runtime = std::env::var_os("HII_RUNTIME_DIR");
        std::env::set_var("HII_RUNTIME_DIR", temp_dir.path());

        let added = canvas_add(
            Some(&serde_json::json!({
                "spaceId": "test-space",
                "idempotencyKey": "test-canvas-run",
                "type": "run",
                "content": "tidy the receipts directory",
                "payload": { "status": "running", "autoStart": true }
            })),
            "test-agent",
        )
        .expect("canvas add run");
        let added: serde_json::Value = serde_json::from_str(&added).expect("added json");
        let object = &added["object"];

        assert_eq!(object["payload"]["status"], "waiting_approval");
        assert_eq!(object["payload"]["autoStart"], false);
        assert_eq!(object["object"]["status"], "waiting_approval");
        assert_eq!(object["object"]["kind"], "run");
        assert_eq!(object["object"]["capabilityId"], "hii.agent.workspace_run");
        // The run pane reads `prompt` first; `content` would render as nothing.
        assert_eq!(object["payload"]["prompt"], "tidy the receipts directory");

        assert!(canvas_add(
            Some(&serde_json::json!({
                "spaceId": "test-space",
                "idempotencyKey": "test-canvas-terminal",
                "type": "terminal"
            })),
            "test-agent",
        )
        .is_err());

        if let Some(previous_runtime) = previous_runtime {
            std::env::set_var("HII_RUNTIME_DIR", previous_runtime);
        } else {
            std::env::remove_var("HII_RUNTIME_DIR");
        }
    }
}

fn benchmark_arguments(repo: &Path) -> Result<Vec<String>, String> {
    let runtime = crate::config::AppPaths::discover()?.runtime;
    let provider = crate::ollama::Ollama::discover().ensure_reachable()?;
    let models = provider.models()?;
    if models.len() != 1 {
        return Err(
            "BENCHMARK_UNMEASURED: local endpoint must advertise exactly one served model identity"
                .into(),
        );
    }
    let evidence = runtime
        .join("benchmarks")
        .join(format!("native-{}.json", crate::clock::unix_ms()));
    Ok(vec![
        repo.join("scripts/hii-model-benchmark.py")
            .display()
            .to_string(),
        provider.base_url().into(),
        models[0].clone(),
        evidence.display().to_string(),
    ])
}

fn model_benchmark(repo: &Path) -> Result<String, String> {
    let args = benchmark_arguments(repo)?;
    let tools = crate::tools::Toolbelt::new(repo.to_path_buf())?;
    let result = tools.run_owned_program("python3", &args, 900);
    if result.ok {
        Ok(result.output)
    } else {
        Err(result.output)
    }
}
