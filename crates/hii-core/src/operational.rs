// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Minimal Rust ownership of graph-native operational objects.
//!
//! The web projection already uses these tables. Native CLI capabilities need
//! the same authority rather than inventing adjacent JSON registries, so this
//! module provides a deliberately small typed boundary for whole-object state.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::{env, fs, path::Path};
use uuid::Uuid;

const PROJECT_SPACE: &str = "hii-projects";

pub fn upsert_project(
    runtime: &Path,
    id: &str,
    revision: u64,
    value: &Value,
    actor: &str,
    timestamp: &str,
) -> Result<(), String> {
    let mut connection = database(runtime)?;
    migrate(&connection)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let object_id = format!("hii-project:{id}");
    let existing = transaction
        .query_row(
            "SELECT canonical_source FROM operational_objects WHERE id = ?1",
            [&object_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if existing.as_deref().is_some_and(|source| source != "graph") {
        return Err(format!(
            "operational object {object_id} is owned by {existing:?}, not the project engine"
        ));
    }
    let properties = serde_json::to_string(value).map_err(|error| error.to_string())?;
    let operation_hash = sha256(&properties);
    let provenance = serde_json::json!({
        "source": "hii project",
        "actor": actor,
        "projectRevision": revision,
    })
    .to_string();
    transaction
        .execute(
            "INSERT INTO operational_objects
             (id, space_id, type, schema_version, properties_json, provenance_json,
              owner_actor_id, created_at, updated_at, deleted_at, semantic_version,
              canonical_source, provenance_class)
             VALUES (?1, ?2, 'hii-project', 1, ?3, ?4, ?5, ?6, ?6, NULL, ?7, 'graph', 'human_authored')
             ON CONFLICT(id) DO UPDATE SET
               properties_json = excluded.properties_json,
               provenance_json = excluded.provenance_json,
               owner_actor_id = excluded.owner_actor_id,
               updated_at = excluded.updated_at,
               deleted_at = NULL,
               semantic_version = excluded.semantic_version,
               canonical_source = 'graph',
               provenance_class = excluded.provenance_class",
            params![
                object_id,
                PROJECT_SPACE,
                properties,
                provenance,
                actor,
                timestamp,
                revision,
            ],
        )
        .map_err(|error| error.to_string())?;
    let lamport: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(lamport), 0) + 1 FROM operational_operations WHERE space_id = ?1",
            [PROJECT_SPACE],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let operation_id = Uuid::new_v4().to_string();
    // A semantic revision can contain several append-only evidence events
    // (supplier research, approvals, receipts). Deduplicate an identical
    // snapshot, not every snapshot that happens to share the same revision.
    let idempotency = format!("project:{id}:revision:{revision}:hash:{operation_hash}");
    let payload = serde_json::json!({
        "projectId": id,
        "revision": revision,
        "kind": "hii.project.snapshot",
    })
    .to_string();
    transaction
        .execute(
            "INSERT OR IGNORE INTO operational_operations
             (id, space_id, actor_id, device_id, type, target_id, base_version,
              lamport, payload_json, authority_grant_id, created_at, result_version,
              idempotency_key, operation_hash, provenance_class, authority_json)
             VALUES (?1, ?2, ?3, NULL, 'project.snapshot.saved', ?4, ?5, ?6, ?7,
                     NULL, ?8, ?9, ?10, ?11, 'human_authored', ?12)",
            params![
                operation_id,
                PROJECT_SPACE,
                actor,
                object_id,
                revision.saturating_sub(1),
                lamport,
                payload,
                timestamp,
                revision,
                idempotency,
                operation_hash,
                r#"{"authority":"workspace"}"#,
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn list_projects(runtime: &Path) -> Result<Vec<Value>, String> {
    let connection = database(runtime)?;
    migrate(&connection)?;
    let mut statement = connection
        .prepare(
            "SELECT properties_json FROM operational_objects
             WHERE space_id = ?1 AND type = 'hii-project' AND deleted_at IS NULL
             ORDER BY updated_at DESC, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([PROJECT_SPACE], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let raw = row.map_err(|error| error.to_string())?;
        serde_json::from_str(&raw).map_err(|error| error.to_string())
    })
    .collect()
}

pub(crate) fn database(runtime: &Path) -> Result<Connection, String> {
    fs::create_dir_all(runtime).map_err(|error| error.to_string())?;
    let path = env::var_os("HII_DB_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| runtime.join("hii.db"));
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
               version TEXT PRIMARY KEY,
               applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             );
             CREATE TABLE IF NOT EXISTS operational_objects (
               id TEXT PRIMARY KEY,
               space_id TEXT NOT NULL,
               type TEXT NOT NULL,
               schema_version INTEGER NOT NULL DEFAULT 1,
               properties_json TEXT NOT NULL DEFAULT '{}',
               provenance_json TEXT NOT NULL DEFAULT '{}',
               owner_actor_id TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               deleted_at TEXT,
               semantic_version INTEGER NOT NULL DEFAULT 1,
               canonical_source TEXT NOT NULL DEFAULT 'graph',
               provenance_class TEXT NOT NULL DEFAULT 'human_authored'
             );
             CREATE INDEX IF NOT EXISTS idx_operational_objects_space
               ON operational_objects(space_id, deleted_at, type);
             CREATE TABLE IF NOT EXISTS operational_relations (
               id TEXT PRIMARY KEY,
               space_id TEXT NOT NULL,
               type TEXT NOT NULL,
               from_object_id TEXT NOT NULL,
               to_object_id TEXT NOT NULL,
               properties_json TEXT NOT NULL DEFAULT '{}',
               provenance_json TEXT NOT NULL DEFAULT '{}',
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               deleted_at TEXT,
               relation_version INTEGER NOT NULL DEFAULT 1,
               canonical_source TEXT NOT NULL DEFAULT 'graph',
               provenance_class TEXT NOT NULL DEFAULT 'human_authored',
               FOREIGN KEY (from_object_id) REFERENCES operational_objects(id),
               FOREIGN KEY (to_object_id) REFERENCES operational_objects(id)
             );
             CREATE INDEX IF NOT EXISTS idx_operational_relations_space
               ON operational_relations(space_id, deleted_at, type);
             CREATE TABLE IF NOT EXISTS operational_operations (
               id TEXT PRIMARY KEY,
               space_id TEXT NOT NULL,
               actor_id TEXT NOT NULL,
               device_id TEXT,
               type TEXT NOT NULL,
               target_id TEXT,
               base_version INTEGER,
               lamport INTEGER NOT NULL,
               payload_json TEXT NOT NULL DEFAULT '{}',
               authority_grant_id TEXT,
               created_at TEXT NOT NULL,
               result_version INTEGER,
               idempotency_key TEXT,
               operation_hash TEXT,
               provenance_class TEXT,
               authority_json TEXT NOT NULL DEFAULT '{}'
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_operations_lamport
               ON operational_operations(space_id, lamport);
             CREATE TABLE IF NOT EXISTS object_projections (
               space_id TEXT NOT NULL,
               object_id TEXT NOT NULL,
               projection TEXT NOT NULL,
               state_json TEXT NOT NULL DEFAULT '{}',
               updated_at TEXT NOT NULL,
               projection_version INTEGER NOT NULL DEFAULT 1,
               canonical_source TEXT NOT NULL DEFAULT 'graph',
               deleted_at TEXT,
               PRIMARY KEY (space_id, object_id, projection),
               FOREIGN KEY (object_id) REFERENCES operational_objects(id) ON DELETE CASCADE
             );
             CREATE TABLE IF NOT EXISTS runtime_spaces (
               id TEXT PRIMARY KEY,
               schema_version INTEGER NOT NULL DEFAULT 1,
               owner_actor_id TEXT NOT NULL,
               sequence INTEGER NOT NULL DEFAULT 0,
               viewport_json TEXT NOT NULL DEFAULT '{\"x\":0,\"y\":0,\"zoom\":1}',
               next_z INTEGER NOT NULL DEFAULT 1,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS runtime_grants (
               id TEXT PRIMARY KEY,
               subject_id TEXT NOT NULL,
               action TEXT NOT NULL,
               resource_id TEXT NOT NULL,
               conditions_json TEXT NOT NULL DEFAULT '{}',
               issued_at TEXT NOT NULL,
               expires_at TEXT,
               revoked_at TEXT
             );
             CREATE TABLE IF NOT EXISTS runtime_shares (
               id TEXT PRIMARY KEY,
               source_space_id TEXT NOT NULL,
               mode TEXT NOT NULL,
               recipient_id TEXT,
               bundle_json TEXT NOT NULL,
               created_at TEXT NOT NULL,
               revoked_at TEXT
             );
             INSERT OR IGNORE INTO schema_migrations(version)
               VALUES ('hii-runtime-v1');
             ",
        )
        .map_err(|error| error.to_string())?;
    add_column(
        connection,
        "operational_objects",
        "semantic_version",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column(
        connection,
        "operational_objects",
        "canonical_source",
        "TEXT NOT NULL DEFAULT 'workspace-json'",
    )?;
    add_column(
        connection,
        "operational_objects",
        "provenance_class",
        "TEXT NOT NULL DEFAULT 'migration'",
    )?;
    add_column(
        connection,
        "operational_operations",
        "result_version",
        "INTEGER",
    )?;
    add_column(
        connection,
        "operational_operations",
        "idempotency_key",
        "TEXT",
    )?;
    add_column(
        connection,
        "operational_operations",
        "operation_hash",
        "TEXT",
    )?;
    add_column(
        connection,
        "operational_operations",
        "provenance_class",
        "TEXT",
    )?;
    add_column(
        connection,
        "operational_operations",
        "authority_json",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    add_column(connection, "operational_operations", "run_id", "TEXT")?;
    add_column(
        connection,
        "operational_relations",
        "relation_version",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column(
        connection,
        "operational_relations",
        "canonical_source",
        "TEXT NOT NULL DEFAULT 'workspace-json'",
    )?;
    add_column(
        connection,
        "operational_relations",
        "provenance_class",
        "TEXT NOT NULL DEFAULT 'migration'",
    )?;
    add_column(
        connection,
        "object_projections",
        "projection_version",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column(
        connection,
        "object_projections",
        "canonical_source",
        "TEXT NOT NULL DEFAULT 'workspace-json'",
    )?;
    add_column(connection, "object_projections", "deleted_at", "TEXT")?;
    connection
        .execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_operations_idempotency
               ON operational_operations(space_id, idempotency_key)
               WHERE idempotency_key IS NOT NULL;",
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn sha256(value: &str) -> String {
    use ring::digest::{digest, SHA256};
    digest(&SHA256, value.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn add_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if !names.iter().any(|name| name == column) {
        connection
            .execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempRuntime(std::path::PathBuf);
    impl TempRuntime {
        fn new() -> Self {
            let path = env::temp_dir().join(format!("hii-operational-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempRuntime {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn project_snapshots_are_graph_native_and_revisioned() {
        let runtime = TempRuntime::new();
        upsert_project(
            &runtime.0,
            "one",
            1,
            &serde_json::json!({"id":"one","revision":1}),
            "tester",
            "2026-08-18T00:00:00Z",
        )
        .unwrap();
        upsert_project(
            &runtime.0,
            "one",
            2,
            &serde_json::json!({"id":"one","revision":2}),
            "tester",
            "2026-08-18T00:01:00Z",
        )
        .unwrap();
        upsert_project(
            &runtime.0,
            "one",
            2,
            &serde_json::json!({"id":"one","revision":2,"evidence":"supplier research"}),
            "tester",
            "2026-08-18T00:02:00Z",
        )
        .unwrap();
        // Retrying an identical snapshot stays idempotent.
        upsert_project(
            &runtime.0,
            "one",
            2,
            &serde_json::json!({"id":"one","revision":2,"evidence":"supplier research"}),
            "tester",
            "2026-08-18T00:02:00Z",
        )
        .unwrap();
        let values = list_projects(&runtime.0).unwrap();
        assert_eq!(
            values,
            vec![serde_json::json!({
                "id":"one",
                "revision":2,
                "evidence":"supplier research"
            })]
        );
        let connection = database(&runtime.0).unwrap();
        let operations: i64 = connection
            .query_row("SELECT COUNT(*) FROM operational_operations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(operations, 3);
    }
}
