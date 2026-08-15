//! HII backend adapter.
//!
//! The workstation is the AII (agent-side) surface of HII. Its data comes
//! from the HII runtime at `~/.hii`:
//!   - `hii.db` (SQLite, read-only here): `projects` and `tasks` tables
//!   - `remotes.json`: registered remote machines
//!
//! Task/project metadata_json may carry agent-execution fields
//! (repo_url, local_path, default_branch, branch, worktree, session,
//! machine_id, agent_tool) — absent fields fall back to AII conventions:
//! branch `agent/{slug}`, session `aii__{project}__{task}`.
//!
//! TODO: write path — create_agent_task should INSERT into hii.db and log a
//! task_workflow_event so the HII engine stays the source of truth.

use crate::models::*;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;

fn hii_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".hii"))
}

/// Live reachability: can we open a TCP connection to any candidate port?
fn probe(host: &str, ports: &[u16]) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;
    ports.iter().any(|port| {
        format!("{host}:{port}")
            .to_socket_addrs()
            .ok()
            .and_then(|mut addrs| addrs.next())
            .map(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(600)).is_ok())
            .unwrap_or(false)
    })
}

fn open_db() -> Option<Connection> {
    let path = hii_dir()?.join("hii.db");
    if !path.exists() {
        return None;
    }
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

fn slug(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn meta_str(meta: &Value, key: &str) -> Option<String> {
    meta.get(key)?.as_str().map(str::to_string)
}

fn map_status(s: &str) -> AgentStatus {
    match s.to_lowercase().as_str() {
        "in progress" | "running" => AgentStatus::Running,
        "completed" | "done" => AgentStatus::Completed,
        "blocked" => AgentStatus::Blocked,
        "failed" => AgentStatus::Failed,
        "needs review" | "review" | "in review" => AgentStatus::NeedsReview,
        "archived" => AgentStatus::Archived,
        _ => AgentStatus::Queued,
    }
}

fn map_tool(s: Option<String>) -> AgentTool {
    match s.as_deref().map(str::to_lowercase).as_deref() {
        Some("codex") => AgentTool::Codex,
        Some("claude_code") | Some("claude") => AgentTool::ClaudeCode,
        Some("cursor") => AgentTool::Cursor,
        _ => AgentTool::Custom,
    }
}

pub fn projects() -> Option<Vec<Project>> {
    let db = open_db()?;
    let mut stmt = db
        .prepare("SELECT id, title, summary, metadata_json FROM projects ORDER BY updated_at DESC")
        .ok()?;
    let rows = stmt
        .query_map([], |r| {
            let id: String = r.get(0)?;
            let title: String = r.get(1)?;
            let meta: Value =
                serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(Value::Null);
            Ok(Project {
                id,
                name: title,
                repo_url: meta_str(&meta, "repo_url").unwrap_or_default(),
                local_path: meta_str(&meta, "local_path").unwrap_or_default(),
                default_branch: meta_str(&meta, "default_branch")
                    .unwrap_or_else(|| "main".into()),
                preferred_agent: map_tool(meta_str(&meta, "preferred_agent")),
                default_machine_id: meta_str(&meta, "default_machine_id")
                    .unwrap_or_else(|| "local".into()),
            })
        })
        .ok()?;
    Some(rows.flatten().collect())
}

pub fn tasks() -> Option<Vec<AgentTask>> {
    let db = open_db()?;
    // Project titles for session/branch naming conventions.
    let mut proj_stmt = db.prepare("SELECT id, title FROM projects").ok()?;
    let proj_names: std::collections::HashMap<String, String> = proj_stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .ok()?
        .flatten()
        .collect();

    let mut stmt = db
        .prepare(
            "SELECT id, title, status, project_id, workflow_label, details, \
             failure_reason, metadata_json, created_at, updated_at \
             FROM tasks ORDER BY updated_at DESC",
        )
        .ok()?;
    let rows = stmt
        .query_map([], |r| {
            let id: String = r.get(0)?;
            let title: String = r.get(1)?;
            let status: String = r.get(2)?;
            let project_id: Option<String> = r.get(3)?;
            let workflow_label: String = r.get(4)?;
            let details: String = r.get(5)?;
            let failure_reason: String = r.get(6)?;
            let meta: Value =
                serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or(Value::Null);
            let created_at: String = r.get(8)?;
            let updated_at: String = r.get(9)?;

            let project_id = project_id.unwrap_or_default();
            let p_slug = proj_names
                .get(&project_id)
                .map(|t| slug(t))
                .unwrap_or_else(|| "hii".into());
            let t_slug = slug(&title);

            let mut logs = vec![format!("$ task created {created_at}")];
            if !workflow_label.is_empty() {
                logs.push(format!("$ workflow: {workflow_label}"));
            }
            logs.push(format!("$ status: {status}"));
            if !failure_reason.is_empty() {
                logs.push(format!("$ failure: {failure_reason}"));
            }
            let latest_log = logs.last().cloned().unwrap_or_default();

            Ok(AgentTask {
                id,
                title,
                machine_id: meta_str(&meta, "machine_id").unwrap_or_else(|| "local".into()),
                repo_path: meta_str(&meta, "repo_path").unwrap_or_default(),
                branch_name: meta_str(&meta, "branch")
                    .unwrap_or_else(|| format!("agent/{t_slug}")),
                worktree_path: meta_str(&meta, "worktree")
                    .unwrap_or_else(|| format!("~/aii/worktrees/{p_slug}/{t_slug}")),
                agent_tool: map_tool(meta_str(&meta, "agent_tool")),
                prompt: details,
                status: map_status(&status),
                session_id: meta_str(&meta, "session")
                    .unwrap_or_else(|| format!("aii__{p_slug}__{t_slug}")),
                latest_log,
                logs,
                pr_url: meta_str(&meta, "pr_url"),
                created_at,
                updated_at,
                project_id,
            })
        })
        .ok()?;
    Some(rows.flatten().collect())
}

pub fn machines() -> Option<Vec<Machine>> {
    let dir = hii_dir()?;
    if !dir.exists() {
        return None;
    }

    let running = tasks()
        .map(|t| {
            t.iter()
                .filter(|t| matches!(t.status, AgentStatus::Running))
                .count() as u32
        })
        .unwrap_or(0);

    let live = crate::metrics::local_snapshot();
    let mut machines = vec![Machine {
        id: "local".into(),
        name: live.hostname.clone(),
        os: std::env::consts::OS.into(),
        host: format!("{}.local", live.hostname),
        ssh_user: std::env::var("USER").unwrap_or_default(),
        status: MachineStatus::Online,
        cpu_percent: live.cpu_percent,
        ram_percent: live.ram_percent,
        disk_percent: live.disk_percent,
        gpu_percent: None,
        active_agent_count: running,
        last_heartbeat: now_iso(),
        default_worktree_root: "~/aii/worktrees".into(),
        tags: vec!["control-surface".into(), "hii".into()],
    }];

    // Remote machines registered in the HII runtime.
    if let Ok(raw) = std::fs::read_to_string(dir.join("remotes.json")) {
        if let Ok(Value::Array(remotes)) = serde_json::from_str::<Value>(&raw) {
            for r in remotes {
                let name = r
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("remote")
                    .to_string();
                let url = r.get("url").and_then(Value::as_str).unwrap_or("");
                let scheme_port = if url.starts_with("https://") { 443 } else { 80 };
                let host = url
                    .trim_start_matches("http://")
                    .trim_start_matches("https://")
                    .split(['/', ':'])
                    .next()
                    .unwrap_or("")
                    .to_string();

                // Live reachability: SSH or the registered service port.
                let online = !host.is_empty() && probe(&host, &[22, scheme_port]);
                machines.push(Machine {
                    id: r
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or(&name)
                        .to_string(),
                    name,
                    os: r
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    host,
                    ssh_user: String::new(),
                    status: if online {
                        MachineStatus::Online
                    } else {
                        MachineStatus::Offline
                    },
                    // TODO(phase-4): pull cpu/ram/disk over SSH once reachable.
                    cpu_percent: 0.0,
                    ram_percent: 0.0,
                    disk_percent: 0.0,
                    gpu_percent: None,
                    active_agent_count: 0,
                    last_heartbeat: if online {
                        now_iso()
                    } else {
                        r.get("updatedAt")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string()
                    },
                    default_worktree_root: "~/aii/worktrees".into(),
                    tags: vec!["remote".into(), "hii".into()],
                });
            }
        }
    }

    Some(machines)
}

fn now_iso() -> String {
    // Avoid a chrono dependency for one timestamp.
    let out = std::process::Command::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output();
    out.ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiiStatus {
    pub available: bool,
    pub db_path: String,
    pub task_count: i64,
    pub project_count: i64,
}

#[tauri::command]
pub fn hii_status() -> HiiStatus {
    let db_path = hii_dir()
        .map(|d| d.join("hii.db").to_string_lossy().into_owned())
        .unwrap_or_default();
    match open_db() {
        Some(db) => {
            let count = |sql: &str| -> i64 {
                db.query_row(sql, [], |r| r.get(0)).unwrap_or(0)
            };
            HiiStatus {
                available: true,
                db_path,
                task_count: count("SELECT COUNT(*) FROM tasks"),
                project_count: count("SELECT COUNT(*) FROM projects"),
            }
        }
        None => HiiStatus {
            available: false,
            db_path,
            task_count: 0,
            project_count: 0,
        },
    }
}
