// SPDX-License-Identifier: LicenseRef-BSL-1.1
use crate::model::*;
use anyhow::{anyhow, bail, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::HashSet,
    path::Path,
    sync::{Mutex, MutexGuard},
};

pub struct Store {
    db: Mutex<Connection>,
}

fn conversation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: row.get(0)?,
        title: row.get(1)?,
        active_leaf_id: row.get(2)?,
        revision: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn put_parts(db: &Connection, message: &str, parts: &[MessagePart]) -> Result<()> {
    db.execute(
        "DELETE FROM chat_message_parts WHERE message_id=?1",
        [message],
    )?;
    for (position, part) in parts.iter().enumerate() {
        let (kind, text) = match part {
            MessagePart::Text { text } => ("text", text),
            MessagePart::Reasoning { text } => ("reasoning", text),
        };
        db.execute(
            "INSERT INTO chat_message_parts VALUES (?1,?2,?3,?4)",
            params![message, position as i64, kind, text],
        )?;
    }
    Ok(())
}

fn touch(db: &Connection, conversation_id: &str) -> Result<()> {
    db.execute(
        "UPDATE chat_conversations SET revision=revision+1,updated_at=?2 WHERE id=?1",
        params![conversation_id, now()],
    )?;
    Ok(())
}

pub fn ancestry(messages: &[Message], leaf: Option<&str>) -> Result<Vec<String>> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let mut current = leaf;
    while let Some(id) = current {
        ensure!(seen.insert(id), "Message ancestry contains a cycle");
        let message = messages
            .iter()
            .find(|m| m.id == id)
            .ok_or_else(|| anyhow!("Missing parent message"))?;
        result.push(id.to_owned());
        current = message.parent_id.as_deref();
    }
    result.reverse();
    Ok(result)
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let mut db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
        )?;
        // HII's other stores own their migrations; chat never changes user_version.
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS chat_schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );",
        )?;
        let version: i64 = tx.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM chat_schema_migrations",
            [],
            |r| r.get(0),
        )?;
        ensure!(
            version <= 1,
            "Database was created by a newer version of HII Chat"
        );
        if version == 0 {
            tx.execute_batch(include_str!("schema.sql"))?;
            tx.execute(
                "INSERT INTO chat_schema_migrations (version, applied_at) VALUES (1, ?1)",
                [now()],
            )?;
        }
        tx.commit()?;
        Ok(Self { db: Mutex::new(db) })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| anyhow!("Database lock poisoned"))
    }

    pub fn recover(&self) -> Result<usize> {
        let mut db = self.lock()?;
        let tx = db.transaction()?;
        tx.execute("UPDATE chat_conversations SET revision=revision+1 WHERE id IN (SELECT conversation_id FROM chat_generations WHERE status='streaming')", [])?;
        let count = tx.execute("UPDATE chat_generations SET status='interrupted',error='Application exited before generation finished',finished_at=?1 WHERE status='streaming'", [now()])?;
        tx.commit()?;
        Ok(count)
    }

    pub fn settings(&self) -> Result<Settings> {
        let value: Option<String> = self
            .lock()?
            .query_row(
                "SELECT value FROM chat_settings WHERE key='provider'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(match value {
            Some(value) => serde_json::from_str(&value)?,
            None => Settings::default(),
        })
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        self.lock()?.execute("INSERT INTO chat_settings VALUES ('provider',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(settings)?])?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Conversation>> {
        let db = self.lock()?;
        let mut stmt = db.prepare("SELECT id,title,active_leaf_id,revision,updated_at FROM chat_conversations ORDER BY updated_at DESC,rowid DESC")?;
        let rows = stmt
            .query_map([], conversation)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn create(&self) -> Result<Snapshot> {
        let id = id();
        self.lock()?.execute("INSERT INTO chat_conversations (id,title,created_at,updated_at) VALUES (?1,'New conversation',?2,?2)", params![id, now()])?;
        self.snapshot(&id)
    }

    pub fn snapshot(&self, id: &str) -> Result<Snapshot> {
        let mut db = self.lock()?;
        // Pin one WAL snapshot across all queries, including reads from other processes.
        // The read-only transaction releases its snapshot when it leaves this scope.
        let db = db.transaction()?;
        let conversation = db.query_row(
            "SELECT id,title,active_leaf_id,revision,updated_at FROM chat_conversations WHERE id=?1",
            [id],
            conversation,
        )?;
        let mut stmt = db.prepare("SELECT id,conversation_id,parent_id,role,created_at FROM chat_messages WHERE conversation_id=?1 ORDER BY rowid")?;
        let mut messages = stmt
            .query_map([id], |r| {
                Ok(Message {
                    id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    parent_id: r.get(2)?,
                    role: r.get(3)?,
                    parts: vec![],
                    created_at: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut parts = db.prepare(
            "SELECT kind,content FROM chat_message_parts WHERE message_id=?1 ORDER BY position",
        )?;
        for message in &mut messages {
            message.parts = parts
                .query_map([&message.id], |r| {
                    let kind: String = r.get(0)?;
                    let text = r.get(1)?;
                    Ok(if kind == "reasoning" {
                        MessagePart::Reasoning { text }
                    } else {
                        MessagePart::Text { text }
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
        }
        let mut stmt = db.prepare("SELECT id,conversation_id,message_id,status,model,endpoint,error,finish_reason,started_at,finished_at FROM chat_generations WHERE conversation_id=?1 ORDER BY rowid")?;
        let generations = stmt
            .query_map([id], |r| {
                Ok(Generation {
                    id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    message_id: r.get(2)?,
                    status: r.get(3)?,
                    model: r.get(4)?,
                    endpoint: r.get(5)?,
                    error: r.get(6)?,
                    finish_reason: r.get(7)?,
                    started_at: r.get(8)?,
                    finished_at: r.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let branch = ancestry(&messages, conversation.active_leaf_id.as_deref())?;
        Ok(Snapshot {
            conversation,
            messages,
            generations,
            branch,
        })
    }

    pub fn begin(&self, request: &SendRequest, settings: &Settings) -> Result<Generation> {
        ensure!(
            !request.parts.is_empty() && request.parts.len() <= 32,
            "Provide between 1 and 32 text parts"
        );
        let mut text = String::new();
        for part in &request.parts {
            match part {
                MessagePart::Text { text: value } => text.push_str(value),
                _ => bail!("User messages accept text parts only"),
            }
        }
        ensure!(!text.trim().is_empty(), "Message is empty");
        ensure!(text.len() <= 256_000, "Message is too large");
        ensure!(
            !settings.model.trim().is_empty(),
            "Select a local model in Runtime settings"
        );
        let mut db = self.lock()?;
        let tx = db.transaction()?;
        let title: String = tx.query_row(
            "SELECT title FROM chat_conversations WHERE id=?1",
            [&request.conversation_id],
            |r| r.get(0),
        )?;
        let busy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM chat_generations WHERE conversation_id=?1 AND status='streaming')", [&request.conversation_id], |r| r.get(0))?;
        ensure!(!busy, "This conversation already has a running generation");
        if let Some(parent) = &request.parent_id {
            let role: Option<String> = tx
                .query_row(
                    "SELECT role FROM chat_messages WHERE id=?1 AND conversation_id=?2",
                    params![parent, request.conversation_id],
                    |r| r.get(0),
                )
                .optional()?;
            ensure!(
                role.as_deref() == Some("assistant"),
                "Parent must be an assistant in this conversation"
            );
        }
        let user_id = id();
        let assistant_id = id();
        let generation = Generation {
            id: id(),
            conversation_id: request.conversation_id.clone(),
            message_id: assistant_id.clone(),
            status: "streaming".into(),
            model: settings.model.clone(),
            endpoint: settings.endpoint.clone(),
            error: None,
            finish_reason: None,
            started_at: now(),
            finished_at: None,
        };
        tx.execute(
            "INSERT INTO chat_messages VALUES (?1,?2,?3,'user',?4)",
            params![user_id, request.conversation_id, request.parent_id, now()],
        )?;
        put_parts(&tx, &user_id, &request.parts)?;
        tx.execute(
            "INSERT INTO chat_messages VALUES (?1,?2,?3,'assistant',?4)",
            params![assistant_id, request.conversation_id, user_id, now()],
        )?;
        tx.execute("INSERT INTO chat_generations (id,conversation_id,message_id,status,model,endpoint,max_tokens,started_at) VALUES (?1,?2,?3,'streaming',?4,?5,?6,?7)", params![generation.id, request.conversation_id, assistant_id, settings.model, settings.endpoint, settings.max_tokens, generation.started_at])?;
        let title = if title == "New conversation" {
            text.split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(64)
                .collect::<String>()
        } else {
            title
        };
        tx.execute(
            "UPDATE chat_conversations SET active_leaf_id=?2,title=?3 WHERE id=?1",
            params![request.conversation_id, assistant_id, title],
        )?;
        touch(&tx, &request.conversation_id)?;
        tx.commit()?;
        Ok(generation)
    }

    pub fn checkpoint(
        &self,
        generation: &Generation,
        parts: &[MessagePart],
        status: &str,
        error: Option<&str>,
        reason: Option<&str>,
    ) -> Result<()> {
        let mut db = self.lock()?;
        let tx = db.transaction()?;
        let changed = tx.execute("UPDATE chat_generations SET status=?2,error=?3,finish_reason=?4,finished_at=?5 WHERE id=?1 AND status='streaming'", params![generation.id, status, error, reason, if status == "streaming" { None } else { Some(now()) }])?;
        ensure!(changed == 1, "Generation is no longer running");
        put_parts(&tx, &generation.message_id, parts)?;
        touch(&tx, &generation.conversation_id)?;
        tx.commit()?;
        Ok(())
    }

    pub fn select_branch(&self, conversation_id: &str, leaf: &str) -> Result<Snapshot> {
        {
            let mut db = self.lock()?;
            let tx = db.transaction()?;
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_messages WHERE id=?1 AND conversation_id=?2)",
                params![leaf, conversation_id],
                |r| r.get(0),
            )?;
            ensure!(exists, "Branch does not belong to this conversation");
            tx.execute(
                "UPDATE chat_conversations SET active_leaf_id=?2 WHERE id=?1",
                params![conversation_id, leaf],
            )?;
            touch(&tx, conversation_id)?;
            tx.commit()?;
        }
        self.snapshot(conversation_id)
    }
}
