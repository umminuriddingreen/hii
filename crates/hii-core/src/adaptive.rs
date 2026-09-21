// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Durable adaptive-project and objective-thread contracts over HII's operational graph.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::BufReader,
    path::{Path, PathBuf},
    process::Command,
    time::UNIX_EPOCH,
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
pub struct ProjectSourceV1 {
    pub schema_version: u8,
    pub kind: String,
    pub id: String,
    pub project_id: String,
    pub source_kind: String,
    pub locator: String,
    pub title: String,
    pub summary: String,
    pub fingerprint: String,
    pub metadata: Value,
    pub created_at: String,
    pub updated_at: String,
    pub provenance: Value,
}

#[derive(Debug, Clone)]
pub struct AddProjectSourceInput {
    pub source_kind: String,
    pub locator: String,
    pub title: String,
    pub summary: String,
    pub metadata: Value,
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

/// An interpreted claim about a thread: a decision, constraint, finding, failed
/// approach, question, rationale, or next action.
///
/// Separate from [`InteractionEventV1`] on purpose. Events are deterministic
/// facts about what happened; semantic items are meaning laid over them, and
/// meaning is replaceable. A model may write one whenever it re-reads the
/// situation; when the operator states something themselves it supersedes the
/// inferred item, so a correction is not overwritten by the next projection.
///
/// Semantic interpretation never changes execution facts and never counts as
/// proof.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticItemV1 {
    pub schema_version: u8,
    pub kind: String,
    pub id: String,
    pub project_id: String,
    pub thread_id: String,
    /// What sort of claim this is.
    pub item_kind: String,
    pub text: String,
    /// `inferred` for a model's reading, `userConfirmed` for the operator's.
    pub provenance_class: String,
    /// Item this one replaces, when it is a correction rather than an addition.
    pub supersedes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Claim types a semantic item may carry.
pub const SEMANTIC_ITEM_KINDS: &[&str] = &[
    "decision",
    "constraint",
    "finding",
    "failedApproach",
    "question",
    "rationale",
    "nextAction",
    "objectiveProjection",
];

pub const PROVENANCE_INFERRED: &str = "inferred";
pub const PROVENANCE_USER_CONFIRMED: &str = "userConfirmed";

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
    /// Interpretation still standing, superseded items removed.
    pub semantic_items: Vec<SemanticItemV1>,
    pub next_sequence: u64,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn object_id(kind: &str, id: &str) -> String {
    format!("adaptive:{kind}:{id}")
}

fn identity(path: &Path) -> Result<String, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
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

fn stable_id(parts: &[&str]) -> String {
    let mut hasher = blake3::Hasher::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update(&[0]);
    }
    hasher.finalize().to_hex()[..32].to_string()
}

fn bounded(value: &str, max_chars: usize) -> String {
    let value = value.trim();
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }
    let mut result = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    result.push('…');
    result
}

fn file_source(
    project: &ProjectBindingV1,
    locator: &str,
    metadata: &mut Value,
) -> Result<(String, String), String> {
    let canonical = assert_target(project, Path::new(locator))?;
    if !canonical.is_file() {
        return Err("project source must resolve to a file".into());
    }
    let file_metadata = fs::metadata(&canonical).map_err(|e| e.to_string())?;
    let modified = file_metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs());
    let details = json!({
        "sizeBytes": file_metadata.len(),
        "modifiedUnixSeconds": modified,
    });
    match metadata {
        Value::Object(values) => {
            values.insert("file".into(), details);
        }
        _ => *metadata = json!({"file": details}),
    }
    let canonical = canonical.display().to_string();
    let fingerprint = stable_id(&[
        &canonical,
        &file_metadata.len().to_string(),
        &modified.unwrap_or_default().to_string(),
    ]);
    Ok((canonical, fingerprint))
}

pub fn add_project_source(
    runtime: &Path,
    project_id: &str,
    mut input: AddProjectSourceInput,
) -> Result<ProjectSourceV1, String> {
    let project = project(runtime, project_id)?;
    let source_kind = input.source_kind.trim();
    if !matches!(
        source_kind,
        "local-file" | "rhino" | "notion" | "chatgpt-conversation" | "conversation"
    ) {
        return Err(
            "source kind must be local-file, rhino, notion, chatgpt-conversation, or conversation"
                .into(),
        );
    }
    if input.locator.trim().is_empty() || input.title.trim().is_empty() {
        return Err("source locator and title cannot be empty".into());
    }

    let (locator, fingerprint) = match source_kind {
        "local-file" | "rhino" => file_source(&project, input.locator.trim(), &mut input.metadata)?,
        "notion" => {
            let locator = input.locator.trim();
            let parsed =
                url::Url::parse(locator).map_err(|_| "Notion locator must be a valid URL")?;
            let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
            if parsed.scheme() != "https"
                || !(host == "notion.so"
                    || host.ends_with(".notion.so")
                    || host == "notion.site"
                    || host.ends_with(".notion.site")
                    || host == "app.notion.com")
            {
                return Err("Notion locator must use an official HTTPS Notion host".into());
            }
            (locator.to_owned(), stable_id(&[source_kind, locator]))
        }
        "chatgpt-conversation" => {
            let locator = input.locator.trim();
            if !locator.starts_with("chatgpt://conversation/") {
                return Err(
                    "ChatGPT conversation locator must start with chatgpt://conversation/".into(),
                );
            }
            (locator.to_owned(), stable_id(&[source_kind, locator]))
        }
        "conversation" => {
            let locator = input.locator.trim();
            if locator
                .strip_prefix("hii://conversation/")
                .is_none_or(str::is_empty)
            {
                return Err(
                    "conversation locator must start with hii://conversation/ and include an archive id"
                        .into(),
                );
            }
            (locator.to_owned(), stable_id(&[source_kind, locator]))
        }
        _ => unreachable!(),
    };
    let id = stable_id(&[&project.id, source_kind, &locator]);
    let timestamp = now();
    let c = connection(runtime)?;
    let existing: Option<String> = c
        .query_row(
            "SELECT properties_json FROM operational_objects WHERE id=?1 AND deleted_at IS NULL",
            params![object_id("source", &id)],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let created_at = existing
        .and_then(|raw| serde_json::from_str::<ProjectSourceV1>(&raw).ok())
        .map(|source| source.created_at)
        .unwrap_or_else(|| timestamp.clone());
    let source = ProjectSourceV1 {
        schema_version: 1,
        kind: "projectSource".into(),
        id,
        project_id: project.id.clone(),
        source_kind: source_kind.into(),
        locator,
        title: bounded(&input.title, 300),
        summary: bounded(&input.summary, 1_200),
        fingerprint,
        metadata: input.metadata,
        created_at,
        updated_at: timestamp.clone(),
        provenance: input.provenance,
    };
    let source_object_id = object_id("source", &source.id);
    upsert(
        &c,
        &source_object_id,
        "adaptive-project-source",
        &source,
        &timestamp,
    )?;
    let relation_id = object_id("project-source-relation", &source.id);
    c.execute(
        "INSERT INTO operational_relations (id,space_id,type,from_object_id,to_object_id,properties_json,provenance_json,created_at,updated_at,deleted_at,relation_version,canonical_source,provenance_class)
         VALUES (?1,?2,'has-source',?3,?4,'{}','{\"source\":\"hii project source\"}',?5,?5,NULL,1,'graph','human_authored')
         ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,deleted_at=NULL,relation_version=operational_relations.relation_version+1",
        params![relation_id, SPACE, object_id("project", &project.id), source_object_id, timestamp],
    )
    .map_err(|e| e.to_string())?;
    Ok(source)
}

pub fn project_sources(runtime: &Path, project_id: &str) -> Result<Vec<ProjectSourceV1>, String> {
    let project = project(runtime, project_id)?;
    let mut sources = values(&connection(runtime)?, "adaptive-project-source")?
        .into_iter()
        .filter_map(|value| serde_json::from_value::<ProjectSourceV1>(value).ok())
        .filter(|source| source.project_id == project.id)
        .collect::<Vec<_>>();
    sources.sort_by(|a, b| {
        a.source_kind
            .cmp(&b.source_kind)
            .then(a.title.cmp(&b.title))
    });
    Ok(sources)
}

pub fn search_project_sources(
    runtime: &Path,
    project_id: &str,
    query: &str,
) -> Result<Vec<ProjectSourceV1>, String> {
    let terms = query
        .split_whitespace()
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    Ok(project_sources(runtime, project_id)?
        .into_iter()
        .filter(|source| {
            let haystack = format!(
                "{} {} {} {}",
                source.source_kind, source.title, source.summary, source.locator
            )
            .to_ascii_lowercase();
            terms.iter().all(|term| haystack.contains(term))
        })
        .collect())
}

fn chatgpt_message_text(conversation: &Value) -> String {
    let mut messages = conversation
        .get("mapping")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|mapping| mapping.values())
        .filter_map(|node| node.get("message"))
        .filter_map(|message| {
            let parts = message
                .pointer("/content/parts")?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ");
            if parts.trim().is_empty() {
                return None;
            }
            let time = message
                .get("create_time")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let role = message
                .pointer("/author/role")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            Some((time, format!("[{role}] {}", parts.trim())))
        })
        .collect::<Vec<_>>();
    messages.sort_by(|a, b| a.0.total_cmp(&b.0));
    messages
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n")
}

fn relevant_excerpt(text: &str, query: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let first_term = query
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let byte_start = lower.find(&first_term).unwrap_or(0).saturating_sub(200);
    let start = text
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= byte_start)
        .last()
        .unwrap_or(0);
    bounded(&text[start..], 1_000)
}

pub fn import_chatgpt_export(
    runtime: &Path,
    project_id: &str,
    export: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<ProjectSourceV1>, String> {
    project(runtime, project_id)?;
    if query.trim().is_empty() {
        return Err("ChatGPT import requires a non-empty relevance query".into());
    }
    if limit == 0 || limit > 500 {
        return Err("ChatGPT import limit must be between 1 and 500".into());
    }
    let export = if export.is_dir() {
        export.join("conversations.json")
    } else {
        export.to_path_buf()
    };
    if export.extension().and_then(|value| value.to_str()) == Some("zip") {
        return Err("extract the official ChatGPT export ZIP, then pass its directory or conversations.json".into());
    }
    let metadata =
        fs::metadata(&export).map_err(|e| format!("cannot read {}: {e}", export.display()))?;
    if metadata.len() > 512 * 1024 * 1024 {
        return Err("ChatGPT conversations.json exceeds the 512 MiB import limit".into());
    }
    let file = fs::File::open(&export).map_err(|e| e.to_string())?;
    let conversations: Value =
        serde_json::from_reader(BufReader::new(file)).map_err(|e| e.to_string())?;
    let conversations = conversations
        .as_array()
        .ok_or("ChatGPT conversations.json must contain a JSON array")?;
    let terms = query
        .split_whitespace()
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    let canonical_export = fs::canonicalize(&export).map_err(|e| e.to_string())?;
    let mut imported = Vec::new();
    for conversation in conversations {
        let title = conversation
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled ChatGPT conversation");
        let text = chatgpt_message_text(conversation);
        let haystack = format!("{title}\n{text}").to_ascii_lowercase();
        if !terms.iter().all(|term| haystack.contains(term)) {
            continue;
        }
        let id = conversation
            .get("id")
            .or_else(|| conversation.get("conversation_id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| stable_id(&[title, &text]));
        let source = add_project_source(
            runtime,
            project_id,
            AddProjectSourceInput {
                source_kind: "chatgpt-conversation".into(),
                locator: format!("chatgpt://conversation/{id}"),
                title: title.into(),
                summary: relevant_excerpt(&text, query),
                metadata: json!({
                    "createTime": conversation.get("create_time"),
                    "updateTime": conversation.get("update_time"),
                    "matchedQuery": query,
                    "exportFile": canonical_export.display().to_string(),
                    "fullTranscriptStored": false,
                }),
                provenance: json!({
                    "actor": "local operator",
                    "source": "official ChatGPT data export",
                }),
            },
        )?;
        imported.push(source);
        if imported.len() >= limit {
            break;
        }
    }
    Ok(imported)
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

/// Record an interpretation of a thread.
///
/// `supersedes` names the item this one replaces. An operator statement may
/// supersede a model's; the reverse is refused, so a confirmed item cannot be
/// quietly overwritten by the next projection.
pub fn record_semantic_item(
    runtime: &Path,
    project_id: &str,
    thread_id: &str,
    item_kind: &str,
    text: &str,
    provenance_class: &str,
    supersedes: Option<&str>,
) -> Result<SemanticItemV1, String> {
    let t = thread(runtime, thread_id)?;
    if t.project_id != project_id {
        return Err("thread belongs to another project".into());
    }
    if text.trim().is_empty() {
        return Err("semantic item text cannot be empty".into());
    }
    if !SEMANTIC_ITEM_KINDS.contains(&item_kind) {
        return Err(format!("unknown semantic item kind: {item_kind}"));
    }
    if !matches!(
        provenance_class,
        PROVENANCE_INFERRED | PROVENANCE_USER_CONFIRMED
    ) {
        return Err(format!("unknown provenance class: {provenance_class}"));
    }
    if let Some(superseded) = supersedes {
        let existing = semantic_items(runtime, thread_id)?
            .into_iter()
            .find(|item| item.id == superseded)
            .ok_or_else(|| format!("superseded item not found: {superseded}"))?;
        if existing.provenance_class == PROVENANCE_USER_CONFIRMED
            && provenance_class == PROVENANCE_INFERRED
        {
            return Err("an inferred item cannot supersede a user-confirmed one".into());
        }
    }
    let timestamp = now();
    let item = SemanticItemV1 {
        schema_version: 1,
        kind: "semanticItem".into(),
        id: Uuid::new_v4().to_string(),
        project_id: project_id.to_string(),
        thread_id: thread_id.to_string(),
        item_kind: item_kind.to_string(),
        text: text.trim().to_string(),
        provenance_class: provenance_class.to_string(),
        supersedes: supersedes.map(str::to_owned),
        created_at: timestamp.clone(),
        updated_at: timestamp.clone(),
    };
    upsert(
        &connection(runtime)?,
        &object_id("semantic", &item.id),
        "adaptive-semantic-item",
        &item,
        &timestamp,
    )?;
    Ok(item)
}

/// Every semantic item recorded against a thread, superseded ones included.
pub fn semantic_items(runtime: &Path, thread_id: &str) -> Result<Vec<SemanticItemV1>, String> {
    let mut items: Vec<SemanticItemV1> = values(&connection(runtime)?, "adaptive-semantic-item")?
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .filter(|item: &SemanticItemV1| item.thread_id == thread_id)
        .collect();
    items.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    Ok(items)
}

/// The interpretation still standing: items nothing has superseded.
///
/// Deterministic given the same records, so a snapshot regenerates identically.
pub fn effective_semantic_items(
    runtime: &Path,
    thread_id: &str,
) -> Result<Vec<SemanticItemV1>, String> {
    let items = semantic_items(runtime, thread_id)?;
    let superseded: std::collections::HashSet<&str> = items
        .iter()
        .filter_map(|item| item.supersedes.as_deref())
        .collect();
    Ok(items
        .iter()
        .filter(|item| !superseded.contains(item.id.as_str()))
        .cloned()
        .collect())
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
    let semantic_items = effective_semantic_items(runtime, &t.id)?;
    Ok(ThreadSnapshotV1 {
        schema_version: 1,
        kind: "threadSnapshot".into(),
        project: p,
        thread: t,
        foreground: fg,
        interaction_events: events,
        semantic_items,
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

    fn thread_fixture(runtime: &Path, root: &Path) -> (ProjectBindingV1, ObjectiveThreadV1) {
        let project = bind(runtime, root, None).unwrap();
        let thread = create_thread(runtime, &project.id, "Build a personal dashboard").unwrap();
        (project, thread)
    }

    #[test]
    fn a_user_confirmed_item_supersedes_the_model_reading_it_replaces() {
        let runtime = Temp::new();
        let root = Temp::new();
        let (project, thread) = thread_fixture(&runtime.0, &root.0);

        let inferred = record_semantic_item(
            &runtime.0,
            &project.id,
            &thread.id,
            "objectiveProjection",
            "Organizing active projects.",
            PROVENANCE_INFERRED,
            None,
        )
        .unwrap();
        let confirmed = record_semantic_item(
            &runtime.0,
            &project.id,
            &thread.id,
            "objectiveProjection",
            "Prioritizing school over HII.",
            PROVENANCE_USER_CONFIRMED,
            Some(&inferred.id),
        )
        .unwrap();

        let effective = effective_semantic_items(&runtime.0, &thread.id).unwrap();
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].id, confirmed.id);
        // Both are kept; only the standing reading changes.
        assert_eq!(semantic_items(&runtime.0, &thread.id).unwrap().len(), 2);
    }

    #[test]
    fn a_model_reading_cannot_overwrite_what_the_operator_stated() {
        let runtime = Temp::new();
        let root = Temp::new();
        let (project, thread) = thread_fixture(&runtime.0, &root.0);
        let confirmed = record_semantic_item(
            &runtime.0,
            &project.id,
            &thread.id,
            "constraint",
            "Keep it to one page.",
            PROVENANCE_USER_CONFIRMED,
            None,
        )
        .unwrap();
        let refused = record_semantic_item(
            &runtime.0,
            &project.id,
            &thread.id,
            "constraint",
            "Two pages is fine.",
            PROVENANCE_INFERRED,
            Some(&confirmed.id),
        );
        assert!(refused.is_err(), "inferred must not supersede confirmed");
        let effective = effective_semantic_items(&runtime.0, &thread.id).unwrap();
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].text, "Keep it to one page.");
    }

    #[test]
    fn a_snapshot_carries_standing_interpretation_and_regenerates_identically() {
        let runtime = Temp::new();
        let root = Temp::new();
        let (project, thread) = thread_fixture(&runtime.0, &root.0);
        record_semantic_item(
            &runtime.0,
            &project.id,
            &thread.id,
            "decision",
            "Start with the schedule section.",
            PROVENANCE_INFERRED,
            None,
        )
        .unwrap();
        let first = snapshot(&runtime.0, &project.id, &thread.id).unwrap();
        let second = snapshot(&runtime.0, &project.id, &thread.id).unwrap();
        assert_eq!(first.semantic_items.len(), 1);
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::to_value(&second).unwrap(),
            "snapshot must regenerate deterministically"
        );
    }

    #[test]
    fn semantic_items_reject_unknown_kinds_and_provenance() {
        let runtime = Temp::new();
        let root = Temp::new();
        let (project, thread) = thread_fixture(&runtime.0, &root.0);
        assert!(record_semantic_item(
            &runtime.0,
            &project.id,
            &thread.id,
            "vibe",
            "text",
            PROVENANCE_INFERRED,
            None
        )
        .is_err());
        assert!(record_semantic_item(
            &runtime.0,
            &project.id,
            &thread.id,
            "finding",
            "text",
            "guessed",
            None
        )
        .is_err());
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

    #[test]
    fn project_sources_are_scoped_searchable_and_idempotent() {
        let runtime = Temp::new();
        let root = Temp::new();
        let model = root.0.join("site.3dm");
        fs::write(&model, "rhino fixture").unwrap();
        let project = bind(&runtime.0, &root.0, Some("Museum")).unwrap();
        let input = || AddProjectSourceInput {
            source_kind: "rhino".into(),
            locator: model.display().to_string(),
            title: "Natirar contour model".into(),
            summary: "Live terrain and program massing source".into(),
            metadata: json!({"documentRole":"working-model"}),
            provenance: json!({"source":"test"}),
        };
        let first = add_project_source(&runtime.0, &project.id, input()).unwrap();
        let replay = add_project_source(&runtime.0, &project.id, input()).unwrap();
        assert_eq!(first.id, replay.id);
        assert_eq!(first.created_at, replay.created_at);
        assert_eq!(project_sources(&runtime.0, &project.id).unwrap().len(), 1);
        assert_eq!(
            search_project_sources(&runtime.0, &project.id, "terrain Natirar")
                .unwrap()
                .len(),
            1
        );
        assert!(search_project_sources(&runtime.0, &project.id, "unrelated")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn local_project_sources_cannot_escape_the_bound_root() {
        let runtime = Temp::new();
        let root = Temp::new();
        let outside = Temp::new();
        let file = outside.0.join("outside.3dm");
        fs::write(&file, "outside").unwrap();
        let project = bind(&runtime.0, &root.0, None).unwrap();
        let result = add_project_source(
            &runtime.0,
            &project.id,
            AddProjectSourceInput {
                source_kind: "rhino".into(),
                locator: file.display().to_string(),
                title: "Outside model".into(),
                summary: String::new(),
                metadata: json!({}),
                provenance: json!({"source":"test"}),
            },
        );
        assert!(result
            .unwrap_err()
            .contains("outside the canonical project root"));
    }

    #[test]
    fn chatgpt_export_import_keeps_only_relevant_bounded_references() {
        let runtime = Temp::new();
        let root = Temp::new();
        let export_dir = Temp::new();
        let project = bind(&runtime.0, &root.0, Some("ARCH495")).unwrap();
        let export = export_dir.0.join("conversations.json");
        fs::write(
            &export,
            serde_json::to_vec(&json!([
                {
                    "id":"relevant-1",
                    "title":"Natirar museum concept",
                    "create_time":1.0,
                    "update_time":2.0,
                    "mapping":{
                        "a":{"message":{"create_time":1.0,"author":{"role":"user"},"content":{"parts":["Develop the ARCH495 landscape museum at Natirar"]}}}
                    }
                },
                {
                    "id":"other-1",
                    "title":"Dinner",
                    "mapping":{
                        "a":{"message":{"create_time":1.0,"author":{"role":"user"},"content":{"parts":["Pasta recipe"]}}}
                    }
                }
            ]))
            .unwrap(),
        )
        .unwrap();
        let imported =
            import_chatgpt_export(&runtime.0, &project.id, &export, "ARCH495 Natirar", 10).unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].locator, "chatgpt://conversation/relevant-1");
        assert_eq!(imported[0].metadata["fullTranscriptStored"], false);
        assert!(imported[0].summary.contains("ARCH495"));
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
