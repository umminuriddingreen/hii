//! HII operating-logic tools (plan Phase 9).
//!
//! These let the workspace agent work *through* HII rather than around it:
//! reading the operational graph, checking capabilities, touching the local
//! board, searching skills, and handing off over the bridge. Read tools shell
//! out to the `hii` front controller (which routes context/og/caps/bridge to
//! the compatibility layer); they are local-first and carry no network effect.

use crate::{config::AppPaths, mail, tools::ToolResult};
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
    "canvas_list",
    "canvas_read",
    "canvas_add",
    "canvas_update",
    "info_find",
    "info_capture",
    "mail_accounts",
    "mail_setup_guide",
    "mail_search",
    "mail_read",
    "og_next",
    "caps_check",
    "board_read",
    "board_write",
    "skill_search",
    "schedule_read",
    "schedule_write",
    "system_status",
    "system_observe",
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
            | "board_write"
            | "schedule_write"
            | "bridge_send"
            | "canvas_add"
            | "canvas_update"
    )
}

/// Dispatch an HII tool. `repo` is the HII repository root; `query` carries the
/// tool's single free-text argument (a task title, search term, or message).
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
        "mail_accounts" => AppPaths::discover().and_then(|paths| {
            mail::list_accounts(&paths)
                .and_then(|value| serde_json::to_string(&value).map_err(|error| error.to_string()))
        }),
        "mail_setup_guide" => {
            let provider = argument_field(arguments, "provider").unwrap_or_default();
            let provider = provider.trim().to_ascii_lowercase();
            if !matches!(provider.as_str(), "gmail" | "icloud") {
                Err("mail_setup_guide provider must be gmail or icloud".into())
            } else {
                let email =
                    argument_field(arguments, "email").filter(|value| !value.trim().is_empty());
                let id = argument_field(arguments, "id").filter(|value| !value.trim().is_empty());
                let mut command = vec![
                    "hii".to_string(),
                    "mail".to_string(),
                    "setup".to_string(),
                    provider.clone(),
                ];
                if let Some(email) = email.as_deref() {
                    command.extend(["--email".into(), email.trim().into()]);
                }
                if let Some(id) = id.as_deref() {
                    command.extend(["--id".into(), id.trim().into()]);
                }
                serde_json::to_string(&serde_json::json!({
                    "schemaVersion": 1,
                    "kind": "hii.mail.setup-guide",
                    "provider": provider,
                    "command": command,
                    "userActionRequired": true,
                    "secretBoundary": "Run this command in a local interactive terminal. The agent must never request or receive the app password.",
                }))
                .map_err(|error| error.to_string())
            }
        }
        "mail_search" => {
            let paths = AppPaths::discover();
            let account = argument_field(arguments, "account");
            let mailbox = argument_field(arguments, "mailbox");
            let query = argument_field(arguments, "query").unwrap_or_else(|| "UNSEEN".into());
            let limit = arguments
                .and_then(|value| value.get("limit"))
                .and_then(Value::as_u64)
                .unwrap_or(20) as usize;
            paths.and_then(|paths| {
                mail::search_many(
                    &paths,
                    account.as_deref(),
                    mailbox.as_deref(),
                    &query,
                    limit,
                    actor_id,
                )
                .and_then(|value| serde_json::to_string(&value).map_err(|error| error.to_string()))
            })
        }
        "mail_read" => {
            let account = argument_field(arguments, "account").unwrap_or_default();
            let mailbox = argument_field(arguments, "mailbox");
            let uid = arguments
                .and_then(|value| value.get("uid"))
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or(0);
            if account.trim().is_empty() || uid == 0 {
                Err("mail_read needs an account and positive uid".into())
            } else {
                AppPaths::discover().and_then(|paths| {
                    mail::read(&paths, &account, mailbox.as_deref(), uid, actor_id).and_then(
                        |value| serde_json::to_string(&value).map_err(|error| error.to_string()),
                    )
                })
            }
        }
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
            let grant = argument_field(arguments, "grant").unwrap_or_else(|| arg.to_string());
            if grant.trim().is_empty() {
                Err("object_list needs the approved grant id in `query`".to_string())
            } else {
                hii(repo, &["object", "list", "--json", "--grant", grant.trim()])
            }
        }
        "object_read" => {
            let grant = argument_field(arguments, "grant").unwrap_or_default();
            let object = argument_field(arguments, "object").unwrap_or_default();
            let (grant, id) = if grant.trim().is_empty() || object.trim().is_empty() {
                arg.split_once("::").unwrap_or(("", ""))
            } else {
                (grant.as_str(), object.as_str())
            };
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
    if let Some(query) = value.get("query").and_then(Value::as_str) {
        return Some(query.to_string());
    }
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    None
}

fn argument_field(arguments: Option<&Value>, field: &str) -> Option<String> {
    arguments?
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn system_status(repo: &Path, arguments: Option<&Value>) -> Result<String, String> {
    let system = argument_field(arguments, "system");
    let mut args = vec!["systems", "status"];
    if let Some(system) = system.as_deref().filter(|value| !value.trim().is_empty()) {
        args.push(system.trim());
    }
    args.push("--json");
    hii(repo, &args)
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
    use std::sync::{Mutex, OnceLock};

    fn runtime_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn classifies_hii_tools() {
        assert!(is_hii_tool("og_next"));
        assert!(is_hii_tool("info_find"));
        assert!(is_hii_tool("info_capture"));
        assert!(is_hii_tool("mail_search"));
        assert!(is_hii_tool("mail_read"));
        assert!(is_hii_tool("mail_accounts"));
        assert!(is_hii_tool("mail_setup_guide"));
        assert!(is_hii_tool("board_write"));
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
