// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Project-aware access to HII's complete local conversation archive.
//!
//! ChatGPT exports and Codex sessions are imported by HII's archive sync. This
//! module keeps those complete transcripts in the canonical `hii.db`, links
//! them to bound projects through the operational graph, and provides the
//! read/search projection consumed by the HII MCP server.

use crate::adaptive::{self, AddProjectSourceInput, ProjectBindingV1, ProjectSourceV1};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveConversationSummaryV1 {
    pub schema_version: u8,
    pub kind: String,
    pub id: String,
    pub provider: String,
    pub title: String,
    pub excerpt: String,
    pub message_count: usize,
    pub imported_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveConversationV1 {
    pub schema_version: u8,
    pub kind: String,
    pub id: String,
    pub provider: String,
    pub title: String,
    pub source_path: String,
    pub content_hash: String,
    pub message_count: usize,
    pub messages: Vec<Value>,
    pub imported_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkflowV1 {
    pub schema_version: u8,
    pub kind: String,
    pub project: ProjectBindingV1,
    pub sources: Vec<ProjectSourceV1>,
    pub conversations: Vec<ArchiveConversationV1>,
    pub missing_conversation_ids: Vec<String>,
}

fn connection(runtime: &Path) -> Result<Connection, String> {
    let connection = crate::operational::database(runtime)?;
    crate::operational::migrate(&connection)?;
    migrate(&connection)?;
    Ok(connection)
}

fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS hii_imported_conversations (
               source_id TEXT PRIMARY KEY,
               provider TEXT NOT NULL,
               title TEXT NOT NULL,
               source_path TEXT NOT NULL,
               source_mtime_ms INTEGER NOT NULL,
               source_size INTEGER NOT NULL,
               content_hash TEXT NOT NULL,
               content TEXT NOT NULL,
               messages_json TEXT NOT NULL,
               imported_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_hii_imported_provider
               ON hii_imported_conversations(provider);
             CREATE VIRTUAL TABLE IF NOT EXISTS hii_imported_conversations_fts
               USING fts5(source_id UNINDEXED, title, content);
             CREATE TRIGGER IF NOT EXISTS hii_imported_conversations_ai
               AFTER INSERT ON hii_imported_conversations BEGIN
                 INSERT INTO hii_imported_conversations_fts(source_id,title,content)
                 VALUES(new.source_id,new.title,new.content);
               END;
             CREATE TRIGGER IF NOT EXISTS hii_imported_conversations_au
               AFTER UPDATE ON hii_imported_conversations BEGIN
                 DELETE FROM hii_imported_conversations_fts WHERE source_id=old.source_id;
                 INSERT INTO hii_imported_conversations_fts(source_id,title,content)
                 VALUES(new.source_id,new.title,new.content);
               END;
             INSERT OR IGNORE INTO schema_migrations(version)
               VALUES ('conversation-project-workflow-v1');",
        )
        .map_err(|error| error.to_string())
}

fn messages(raw: String) -> Result<Vec<Value>, String> {
    serde_json::from_str(&raw).map_err(|error| format!("invalid archived messages: {error}"))
}

fn message_count(raw: &str) -> usize {
    serde_json::from_str::<Vec<Value>>(raw).map_or(0, |messages| messages.len())
}

fn fts_query(query: &str) -> Result<String, String> {
    let terms = query
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return Err("workflow search requires a non-empty query".into());
    }
    Ok(terms.join(" AND "))
}

pub fn archive_status(runtime: &Path) -> Result<Value, String> {
    let connection = connection(runtime)?;
    let mut statement = connection
        .prepare(
            "SELECT provider,COUNT(*) FROM hii_imported_conversations
             GROUP BY provider ORDER BY provider",
        )
        .map_err(|error| error.to_string())?;
    let counts = statement
        .query_map([], |row| {
            Ok(json!({
                "provider": row.get::<_, String>(0)?,
                "conversations": row.get::<_, u64>(1)?,
            }))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let default_codex = dirs::home_dir()
        .map(|home| home.join(".codex/sessions").display().to_string())
        .map(Value::String)
        .unwrap_or(Value::Null);
    let configured_sources = fs::read_to_string(runtime.join("imports/conversation-sources.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({"schemaVersion":1,"codex":default_codex,"chatgpt":[]}));
    let last_sync = fs::read_to_string(runtime.join("imports/last-sync.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let projects = adaptive::projects(runtime)?;
    Ok(json!({
        "schemaVersion": 1,
        "kind": "centralWorkflowStatus",
        "configuredSources": configured_sources,
        "lastSync": last_sync,
        "conversationCounts": counts,
        "projects": projects,
    }))
}

pub fn search_conversations(
    runtime: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<ArchiveConversationSummaryV1>, String> {
    let limit = limit.clamp(1, 100);
    let connection = connection(runtime)?;
    let mut statement = connection
        .prepare(
            "SELECT c.source_id,c.provider,c.title,
                    snippet(hii_imported_conversations_fts,2,'[',']','...',24),
                    c.messages_json,c.imported_at
             FROM hii_imported_conversations_fts
             JOIN hii_imported_conversations c USING(source_id)
             WHERE hii_imported_conversations_fts MATCH ?1
             ORDER BY rank LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![fts_query(query)?, limit as u64], |row| {
            let raw_messages = row.get::<_, String>(4)?;
            Ok(ArchiveConversationSummaryV1 {
                schema_version: 1,
                kind: "archivedConversationSummary".into(),
                id: row.get(0)?,
                provider: row.get(1)?,
                title: row.get(2)?,
                excerpt: row.get(3)?,
                message_count: message_count(&raw_messages),
                imported_at: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn conversation(runtime: &Path, id: &str) -> Result<ArchiveConversationV1, String> {
    let connection = connection(runtime)?;
    let row = connection
        .query_row(
            "SELECT source_id,provider,title,source_path,content_hash,messages_json,imported_at
             FROM hii_imported_conversations WHERE source_id=?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("archived conversation not found: {id}"))?;
    let messages = messages(row.5)?;
    Ok(ArchiveConversationV1 {
        schema_version: 1,
        kind: "archivedConversation".into(),
        id: row.0,
        provider: row.1,
        title: row.2,
        source_path: row.3,
        content_hash: row.4,
        message_count: messages.len(),
        messages,
        imported_at: row.6,
    })
}

pub fn link_conversation(
    runtime: &Path,
    project_id: &str,
    conversation_id: &str,
    note: Option<&str>,
    tags: &[String],
) -> Result<ProjectSourceV1, String> {
    let archived = conversation(runtime, conversation_id)?;
    let content = archived
        .messages
        .iter()
        .filter_map(|message| {
            let role = message.get("role")?.as_str()?;
            let text = message.get("text")?.as_str()?;
            Some(format!("{role}: {text}"))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let excerpt = content.chars().take(1_100).collect::<String>();
    let summary = match note.map(str::trim).filter(|note| !note.is_empty()) {
        Some(note) => format!("{note}\n\nArchive excerpt:\n{excerpt}"),
        None => excerpt,
    };
    adaptive::add_project_source(
        runtime,
        project_id,
        AddProjectSourceInput {
            source_kind: "conversation".into(),
            locator: format!("hii://conversation/{}", archived.id),
            title: archived.title,
            summary,
            metadata: json!({
                "archiveSourceId": archived.id,
                "provider": archived.provider,
                "contentHash": archived.content_hash,
                "messageCount": archived.messages.len(),
                "fullTranscriptStoredInArchive": true,
                "tags": tags,
            }),
            provenance: json!({
                "actor": "local operator",
                "source": "hii central conversation workflow",
            }),
        },
    )
}

fn linked_conversation_id(source: &ProjectSourceV1) -> Option<String> {
    if source.source_kind != "conversation" {
        return None;
    }
    source
        .metadata
        .get("archiveSourceId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            source
                .locator
                .strip_prefix("hii://conversation/")
                .map(str::to_owned)
        })
}

pub fn project_workflow(
    runtime: &Path,
    project_id: &str,
    include_messages: bool,
) -> Result<ProjectWorkflowV1, String> {
    let project = adaptive::project(runtime, project_id)?;
    let sources = adaptive::project_sources(runtime, &project.id)?;
    let mut conversations = Vec::new();
    let mut missing = Vec::new();
    for id in sources.iter().filter_map(linked_conversation_id) {
        match conversation(runtime, &id) {
            Ok(mut archived) => {
                if !include_messages {
                    archived.messages.clear();
                }
                conversations.push(archived);
            }
            Err(_) => missing.push(id),
        }
    }
    Ok(ProjectWorkflowV1 {
        schema_version: 1,
        kind: "centralProjectWorkflow".into(),
        project,
        sources,
        conversations,
        missing_conversation_ids: missing,
    })
}

pub fn search_workflow(
    runtime: &Path,
    query: &str,
    project_id: Option<&str>,
    limit: usize,
) -> Result<Value, String> {
    let conversations = search_conversations(runtime, query, limit)?;
    let (projects, sources, conversations) = match project_id {
        Some(project_id) => {
            let project = adaptive::project(runtime, project_id)?;
            let linked = adaptive::project_sources(runtime, &project.id)?;
            let linked_ids = linked
                .iter()
                .filter_map(linked_conversation_id)
                .collect::<Vec<_>>();
            let conversations = conversations
                .into_iter()
                .filter(|conversation| linked_ids.contains(&conversation.id))
                .collect();
            let sources = adaptive::search_project_sources(runtime, &project.id, query)?;
            (vec![project], sources, conversations)
        }
        None => {
            let terms = query
                .split_whitespace()
                .map(str::to_ascii_lowercase)
                .collect::<Vec<_>>();
            let all_projects = adaptive::projects(runtime)?;
            let projects = all_projects
                .iter()
                .filter(|project| {
                    let text =
                        format!("{} {}", project.name, project.canonical_root).to_ascii_lowercase();
                    terms.iter().all(|term| text.contains(term))
                })
                .cloned()
                .collect::<Vec<_>>();
            let mut sources = Vec::new();
            for project in all_projects {
                sources.extend(adaptive::search_project_sources(
                    runtime,
                    &project.id,
                    query,
                )?);
                if sources.len() >= limit {
                    sources.truncate(limit);
                    break;
                }
            }
            (projects, sources, conversations)
        }
    };
    Ok(json!({
        "schemaVersion": 1,
        "kind": "centralWorkflowSearch",
        "query": query,
        "projectId": project_id,
        "projects": projects,
        "sources": sources,
        "conversations": conversations,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use uuid::Uuid;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hii-workflow-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn archived_fixture(runtime: &Path) {
        let connection = connection(runtime).unwrap();
        let messages = json!([
            {"id":"m1","role":"user","text":"Develop the Natirar museum workflow","at":1},
            {"id":"m2","role":"assistant","text":"Link the Rhino model and project sources","at":2}
        ]);
        connection.execute(
            "INSERT INTO hii_imported_conversations
             (source_id,provider,title,source_path,source_mtime_ms,source_size,content_hash,content,messages_json,imported_at)
             VALUES (?1,'chatgpt','Natirar workflow','C:/export/conversations.json',1,2,'hash-1',?2,?3,'2026-09-18T00:00:00Z')",
            params!["chatgpt:one", "user: Develop the Natirar museum workflow\n\nassistant: Link the Rhino model and project sources", messages.to_string()],
        ).unwrap();
    }

    #[test]
    fn reads_and_searches_complete_archived_messages() {
        let runtime = Temp::new();
        archived_fixture(&runtime.0);
        let result = search_conversations(&runtime.0, "Natirar workflow", 10).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].message_count, 2);
        let complete = conversation(&runtime.0, "chatgpt:one").unwrap();
        assert_eq!(complete.messages.len(), 2);
        assert_eq!(complete.messages[1]["role"], "assistant");
        let status = archive_status(&runtime.0).unwrap();
        assert!(status["configuredSources"]["codex"].is_string());
        assert_eq!(status["conversationCounts"][0]["conversations"], 1);
    }

    #[test]
    fn links_one_complete_chat_into_one_project_workflow() {
        let runtime = Temp::new();
        let root = Temp::new();
        archived_fixture(&runtime.0);
        let project = adaptive::bind(&runtime.0, &root.0, Some("ARCH495")).unwrap();
        let source = link_conversation(
            &runtime.0,
            &project.id,
            "chatgpt:one",
            Some("Concept development reference"),
            &["studio".into(), "natirar".into()],
        )
        .unwrap();
        assert_eq!(source.source_kind, "conversation");
        assert_eq!(source.metadata["messageCount"], 2);
        let workflow = project_workflow(&runtime.0, &project.id, true).unwrap();
        assert_eq!(workflow.sources.len(), 1);
        assert_eq!(workflow.conversations.len(), 1);
        assert_eq!(workflow.conversations[0].messages.len(), 2);
    }
}
