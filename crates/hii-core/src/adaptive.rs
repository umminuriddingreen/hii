// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Durable adaptive-project and objective-thread contracts over HII's operational graph.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use uuid::Uuid;

const SPACE: &str = "hii-adaptive-projects";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBindingV1 {
    pub schema_version: u8,
    pub kind: String,
    pub id: String,
    pub name: String,
    pub canonical_root: String,
    pub filesystem_identity: String,
    pub git_worktree: Option<String>,
    pub git_common_directory: Option<String>,
    pub authority_boundary: String,
    pub validation_status: String,
    pub created_at: String,
    pub updated_at: String,
    pub provenance: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectiveThreadV1 {
    pub schema_version: u8,
    pub kind: String,
    pub id: String,
    pub project_id: String,
    pub objective: String,
    pub status: String,
    pub revision: u64,
    pub relation_links: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectForegroundStateV1 {
    pub schema_version: u8,
    pub kind: String,
    pub project_id: String,
    pub foreground_thread_id: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionEventV1 {
    pub schema_version: u8,
    pub id: String,
    pub interaction_id: String,
    pub project_id: String,
    pub thread_id: String,
    pub run_id: Option<String>,
    pub sequence: u64,
    pub timestamp: String,
    pub kind: String,
    pub text: Option<String>,
    pub payload: Value,
    pub causation_event_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InteractionProposalV1 {
    Respond {
        text: String,
    },
    Capability {
        phase: String,
        capability_id: String,
        input: Value,
    },
    Ask {
        text: String,
    },
    Finish {
        summary: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshotV1 {
    pub schema_version: u8,
    pub kind: String,
    pub project: ProjectBindingV1,
    pub thread: ObjectiveThreadV1,
    pub foreground: bool,
    pub interaction_events: Vec<InteractionEventV1>,
    pub next_sequence: u64,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn object_id(kind: &str, id: &str) -> String {
    format!("adaptive:{kind}:{id}")
}

fn identity(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!("unix:{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    {
        Ok(format!("path:{}", path.display()))
    }
}

fn git_path(root: &Path, arg: &str) -> Option<String> {
    let output = Command::new("git")
        .args(["-C"])
        .arg(root)
        .args(["rev-parse", arg])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn connection(runtime: &Path) -> Result<Connection, String> {
    let c = crate::operational::database(runtime)?;
    crate::operational::migrate(&c)?;
    for statement in [
        "ALTER TABLE operational_operations ADD COLUMN interaction_id TEXT",
        "ALTER TABLE operational_operations ADD COLUMN interaction_sequence INTEGER",
        "ALTER TABLE operational_operations ADD COLUMN causation_event_id TEXT",
    ] {
        if let Err(error) = c.execute(statement, []) {
            if !error.to_string().contains("duplicate column name") {
                return Err(error.to_string());
            }
        }
    }
    c.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_operations_interaction_sequence
           ON operational_operations(interaction_id, interaction_sequence)
           WHERE interaction_id IS NOT NULL AND interaction_sequence IS NOT NULL;
         INSERT OR IGNORE INTO schema_migrations(version) VALUES ('adaptive-project-thread-v1');",
    )
    .map_err(|e| e.to_string())?;
    Ok(c)
}

fn upsert<T: Serialize>(
    c: &Connection,
    id: &str,
    kind: &str,
    value: &T,
    timestamp: &str,
) -> Result<(), String> {
    let properties = serde_json::to_string(value).map_err(|e| e.to_string())?;
    c.execute(
        "INSERT INTO operational_objects (id,space_id,type,schema_version,properties_json,provenance_json,owner_actor_id,created_at,updated_at,deleted_at,semantic_version,canonical_source,provenance_class)
         VALUES (?1,?2,?3,1,?4,'{\"source\":\"hii adaptive\"}','local operator',?5,?5,NULL,1,'graph','human_authored')
         ON CONFLICT(id) DO UPDATE SET properties_json=excluded.properties_json,updated_at=excluded.updated_at,deleted_at=NULL,semantic_version=operational_objects.semantic_version+1",
        params![id, SPACE, kind, properties, timestamp],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn values(c: &Connection, kind: &str) -> Result<Vec<Value>, String> {
    let mut s = c.prepare("SELECT properties_json FROM operational_objects WHERE space_id=?1 AND type=?2 AND deleted_at IS NULL ORDER BY updated_at DESC,id").map_err(|e| e.to_string())?;
    let rows = s
        .query_map(params![SPACE, kind], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect();
    rows
}

pub fn bind(runtime: &Path, root: &Path, name: Option<&str>) -> Result<ProjectBindingV1, String> {
    let canonical =
        fs::canonicalize(root).map_err(|e| format!("cannot bind {}: {e}", root.display()))?;
    if !canonical.is_dir() {
        return Err("project root must be a directory".into());
    }
    let timestamp = now();
    let project = ProjectBindingV1 {
        schema_version: 1,
        kind: "boundComputationalProject".into(),
        id: Uuid::new_v4().to_string(),
        name: name
            .map(str::to_owned)
            .or_else(|| {
                canonical
                    .file_name()
                    .map(|v| v.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| canonical.display().to_string()),
        canonical_root: canonical.display().to_string(),
        filesystem_identity: identity(&canonical)?,
        git_worktree: git_path(&canonical, "--show-toplevel"),
        git_common_directory: git_path(&canonical, "--git-common-dir"),
        authority_boundary: "canonical-project-root".into(),
        validation_status: "valid".into(),
        created_at: timestamp.clone(),
        updated_at: timestamp.clone(),
        provenance: json!({"actor":"local operator","source":"hii project bind"}),
    };
    upsert(
        &connection(runtime)?,
        &object_id("project", &project.id),
        "adaptive-project-binding",
        &project,
        &timestamp,
    )?;
    Ok(project)
}

pub fn projects(runtime: &Path) -> Result<Vec<ProjectBindingV1>, String> {
    values(&connection(runtime)?, "adaptive-project-binding")?
        .into_iter()
        .map(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
        .collect()
}

pub fn project(runtime: &Path, id: &str) -> Result<ProjectBindingV1, String> {
    let matches: Vec<_> = projects(runtime)?
        .into_iter()
        .filter(|p| p.id == id || p.id.starts_with(id))
        .collect();
    match matches.as_slice() {
        [one] => Ok(one.clone()),
        [] => Err(format!("bound project not found: {id}")),
        _ => Err(format!("bound project id is ambiguous: {id}")),
    }
}

pub fn validate(runtime: &Path, id: &str) -> Result<ProjectBindingV1, String> {
    let mut p = project(runtime, id)?;
    let path = PathBuf::from(&p.canonical_root);
    p.validation_status = match fs::canonicalize(&path) {
        Err(_) => "needsRebind".into(),
        Ok(canonical) if identity(&canonical).ok().as_deref() != Some(&p.filesystem_identity) => {
            "identityMismatch".into()
        }
        Ok(canonical) if git_path(&canonical, "--git-common-dir") != p.git_common_directory => {
            "gitIdentityMismatch".into()
        }
        Ok(_) => "valid".into(),
    };
    p.updated_at = now();
    upsert(
        &connection(runtime)?,
        &object_id("project", &p.id),
        "adaptive-project-binding",
        &p,
        &p.updated_at,
    )?;
    Ok(p)
}

pub fn create_thread(
    runtime: &Path,
    project_id: &str,
    objective: &str,
) -> Result<ObjectiveThreadV1, String> {
    project(runtime, project_id)?;
    if objective.trim().is_empty() {
        return Err("objective cannot be empty".into());
    }
    let timestamp = now();
    let t = ObjectiveThreadV1 {
        schema_version: 1,
        kind: "objectiveThread".into(),
        id: Uuid::new_v4().to_string(),
        project_id: project_id.into(),
        objective: objective.trim().into(),
        status: "open".into(),
        revision: 1,
        relation_links: vec![],
        created_at: timestamp.clone(),
        updated_at: timestamp.clone(),
    };
    let c = connection(runtime)?;
    upsert(
        &c,
        &object_id("thread", &t.id),
        "objective-thread",
        &t,
        &timestamp,
    )?;
    if foreground(runtime, project_id)?.is_none() {
        activate_thread(runtime, project_id, &t.id)?;
    }
    Ok(t)
}

pub fn threads(runtime: &Path, project_id: &str) -> Result<Vec<ObjectiveThreadV1>, String> {
    Ok(values(&connection(runtime)?, "objective-thread")?
        .into_iter()
        .filter_map(|v| serde_json::from_value::<ObjectiveThreadV1>(v).ok())
        .filter(|t| t.project_id == project_id)
        .collect())
}

pub fn thread(runtime: &Path, id: &str) -> Result<ObjectiveThreadV1, String> {
    let all = values(&connection(runtime)?, "objective-thread")?;
    let matches: Vec<_> = all
        .into_iter()
        .filter_map(|v| serde_json::from_value::<ObjectiveThreadV1>(v).ok())
        .filter(|t| t.id == id || t.id.starts_with(id))
        .collect();
    match matches.as_slice() {
        [one] => Ok(one.clone()),
        [] => Err(format!("thread not found: {id}")),
        _ => Err(format!("thread id is ambiguous: {id}")),
    }
}

fn foreground(
    runtime: &Path,
    project_id: &str,
) -> Result<Option<ProjectForegroundStateV1>, String> {
    Ok(values(&connection(runtime)?, "project-foreground")?
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .find(|f: &ProjectForegroundStateV1| f.project_id == project_id))
}

pub fn activate_thread(
    runtime: &Path,
    project_id: &str,
    thread_id: &str,
) -> Result<ProjectForegroundStateV1, String> {
    let t = thread(runtime, thread_id)?;
    if t.project_id != project_id {
        return Err("thread belongs to another project".into());
    }
    let timestamp = now();
    let f = ProjectForegroundStateV1 {
        schema_version: 1,
        kind: "projectForegroundState".into(),
        project_id: project_id.into(),
        foreground_thread_id: t.id,
        updated_at: timestamp.clone(),
    };
    upsert(
        &connection(runtime)?,
        &object_id("foreground", project_id),
        "project-foreground",
        &f,
        &timestamp,
    )?;
    Ok(f)
}

pub fn append_event(
    runtime: &Path,
    mut event: InteractionEventV1,
    idempotency_key: &str,
) -> Result<InteractionEventV1, String> {
    let c = connection(runtime)?;
    let existing = c.query_row("SELECT payload_json FROM operational_operations WHERE space_id=?1 AND idempotency_key=?2", params![SPACE,idempotency_key], |r| r.get::<_,String>(0)).optional().map_err(|e| e.to_string())?;
    if let Some(raw) = existing {
        return serde_json::from_str(&raw).map_err(|e| e.to_string());
    }
    let next: u64 = c.query_row("SELECT COALESCE(MAX(interaction_sequence),0)+1 FROM operational_operations WHERE interaction_id=?1", [&event.interaction_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    event.sequence = next;
    if event.id.is_empty() {
        event.id = Uuid::new_v4().to_string();
    }
    if event.timestamp.is_empty() {
        event.timestamp = now();
    }
    let raw = serde_json::to_string(&event).map_err(|e| e.to_string())?;
    let lamport: u64 = c
        .query_row(
            "SELECT COALESCE(MAX(lamport),0)+1 FROM operational_operations WHERE space_id=?1",
            [SPACE],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    c.execute("INSERT INTO operational_operations (id,space_id,actor_id,type,target_id,lamport,payload_json,created_at,idempotency_key,provenance_class,authority_json,interaction_id,interaction_sequence,causation_event_id) VALUES (?1,?2,'local operator',?3,?4,?5,?6,?7,?8,'human_authored','{\"authority\":\"interaction\"}',?9,?10,?11)", params![event.id,SPACE,event.kind,event.thread_id,lamport,raw,event.timestamp,idempotency_key,event.interaction_id,event.sequence,event.causation_event_id]).map_err(|e| e.to_string())?;
    Ok(event)
}

pub fn snapshot(
    runtime: &Path,
    project_id: &str,
    thread_id: &str,
) -> Result<ThreadSnapshotV1, String> {
    let p = project(runtime, project_id)?;
    let t = thread(runtime, thread_id)?;
    if t.project_id != p.id {
        return Err("thread belongs to another project".into());
    }
    let c = connection(runtime)?;
    let mut s=c.prepare("SELECT payload_json FROM operational_operations WHERE space_id=?1 AND target_id=?2 AND interaction_id IS NOT NULL ORDER BY interaction_id,interaction_sequence,id").map_err(|e|e.to_string())?;
    let events = s
        .query_map(params![SPACE, t.id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let fg = foreground(runtime, &p.id)?.is_some_and(|f| f.foreground_thread_id == t.id);
    let next_sequence = events
        .iter()
        .map(|e: &InteractionEventV1| e.sequence)
        .max()
        .unwrap_or(0)
        + 1;
    Ok(ThreadSnapshotV1 {
        schema_version: 1,
        kind: "threadSnapshot".into(),
        project: p,
        thread: t,
        foreground: fg,
        interaction_events: events,
        next_sequence,
    })
}

pub fn assert_target(project: &ProjectBindingV1, target: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(&project.canonical_root).map_err(|e| e.to_string())?;
    let canonical = fs::canonicalize(target).map_err(|e| e.to_string())?;
    if canonical.components().any(|c| c.as_os_str() == ".git") {
        return Err("repository internals are outside project authority".into());
    }
    if canonical == root || canonical.starts_with(&root) {
        Ok(canonical)
    } else {
        Err("target resolves outside the canonical project root".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hii-adaptive-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn binding_ignores_content_changes_but_detects_missing_identity() {
        let runtime = Temp::new();
        let root = Temp::new();
        let binding = bind(&runtime.0, &root.0, Some("code")).unwrap();
        fs::write(root.0.join("source.txt"), "changed").unwrap();
        assert_eq!(
            validate(&runtime.0, &binding.id).unwrap().validation_status,
            "valid"
        );
        fs::remove_dir_all(&root.0).unwrap();
        assert_eq!(
            validate(&runtime.0, &binding.id).unwrap().validation_status,
            "needsRebind"
        );
    }

    #[test]
    fn threads_have_independent_foreground_and_events_replay_idempotently() {
        let runtime = Temp::new();
        let root = Temp::new();
        let project = bind(&runtime.0, &root.0, None).unwrap();
        let first = create_thread(&runtime.0, &project.id, "Fix the error").unwrap();
        let second = create_thread(&runtime.0, &project.id, "Explain the error").unwrap();
        assert_eq!(threads(&runtime.0, &project.id).unwrap().len(), 2);
        activate_thread(&runtime.0, &project.id, &second.id).unwrap();
        let event = InteractionEventV1 {
            schema_version: 1,
            id: String::new(),
            interaction_id: "turn-1".into(),
            project_id: project.id.clone(),
            thread_id: first.id.clone(),
            run_id: None,
            sequence: 0,
            timestamp: String::new(),
            kind: "interaction.respond".into(),
            text: Some("answer".into()),
            payload: json!({}),
            causation_event_id: None,
        };
        let one = append_event(&runtime.0, event.clone(), "turn-1:proposal").unwrap();
        let replay = append_event(&runtime.0, event, "turn-1:proposal").unwrap();
        assert_eq!(one.id, replay.id);
        assert_eq!(
            snapshot(&runtime.0, &project.id, &first.id)
                .unwrap()
                .interaction_events
                .len(),
            1
        );
        assert!(
            !snapshot(&runtime.0, &project.id, &first.id)
                .unwrap()
                .foreground
        );
        assert!(
            snapshot(&runtime.0, &project.id, &second.id)
                .unwrap()
                .foreground
        );
    }

    #[cfg(unix)]
    #[test]
    fn authority_rejects_symlink_escape_and_git_internals() {
        use std::os::unix::fs::symlink;
        let runtime = Temp::new();
        let root = Temp::new();
        let outside = Temp::new();
        fs::write(outside.0.join("secret"), "x").unwrap();
        symlink(outside.0.join("secret"), root.0.join("escape")).unwrap();
        let project = bind(&runtime.0, &root.0, None).unwrap();
        assert!(assert_target(&project, &root.0.join("escape"))
            .unwrap_err()
            .contains("outside"));
        fs::create_dir(root.0.join(".git")).unwrap();
        fs::write(root.0.join(".git/config"), "x").unwrap();
        assert!(assert_target(&project, &root.0.join(".git/config"))
            .unwrap_err()
            .contains("internals"));
    }
}
