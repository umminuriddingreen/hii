//! Named local Space states stored as immutable Runtime history events.
//! Restoring changes the canvas document, never external files or running processes.
use crate::operational::{database, migrate};
use crate::runtime::{self, IdentityRefV1, RuntimeSpaceApplyV1, RuntimeSpaceSnapshotV1};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use uuid::Uuid;

const EVENT: &str = "space.checkpoint.saved";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    pub name: String,
    pub space_id: String,
    pub source_sequence: u64,
    pub created_at: String,
    pub document: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub checkpoint: Checkpoint,
    pub expected_sequence: u64,
    pub current_document: Value,
    pub restored_document: Value,
}

pub fn save(runtime: &Path, space: &str, name: &str, expected: u64) -> Result<Checkpoint, String> {
    runtime::validate_space_id(space)?;
    if name.trim() != name
        || name.is_empty()
        || name.len() > 120
        || name.starts_with("checkpoint-")
        || name.chars().any(char::is_control)
    {
        return Err("Checkpoint name must be 1-120 bytes with no surrounding whitespace or control characters".into());
    }
    let current = runtime::read_space(runtime, space)?.ok_or("Space is not initialized")?;
    let mut connection = database(runtime)?;
    migrate(&connection)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let (sequence, owner): (u64, String) = tx
        .query_row(
            "SELECT sequence, owner_actor_id FROM runtime_spaces WHERE id=?1",
            [space],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    if owner != "human:local" {
        return Err("Named states require the local Space owner".into());
    }
    if sequence != expected || current.sequence != expected {
        return Err("Space sequence changed; preview the current state again".into());
    }
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM operational_operations WHERE space_id=?1 AND type=?2 AND json_extract(payload_json, '$.name')=?3)", params![space, EVENT, name], |row| row.get(0)).map_err(|error| error.to_string())?;
    if exists {
        return Err("Checkpoint name already exists; choose a new name".into());
    }
    let checkpoint = Checkpoint {
        id: format!("checkpoint-{}", Uuid::new_v4()),
        name: name.into(),
        space_id: space.into(),
        source_sequence: sequence,
        created_at: Utc::now().to_rfc3339(),
        document: current.document,
    };
    tx.execute("INSERT INTO operational_operations (id, space_id, actor_id, type, target_id, base_version, result_version, lamport, payload_json, created_at, provenance_class, authority_json) VALUES (?1, ?2, 'human:local', ?3, ?4, ?5, ?5, (SELECT COALESCE(MAX(lamport),0)+1 FROM operational_operations WHERE space_id=?2), ?6, ?7, 'human_authored', '{\"actorKind\":\"human\",\"bounded\":true}')", params![checkpoint.id, space, EVENT, format!("space:{space}"), sequence, serde_json::to_string(&checkpoint).map_err(|error| error.to_string())?, checkpoint.created_at]).map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(checkpoint)
}

pub fn list(runtime: &Path, space: &str) -> Result<Vec<Checkpoint>, String> {
    runtime::validate_space_id(space)?;
    let connection = database(runtime)?;
    migrate(&connection)?;
    let mut statement = connection.prepare("SELECT payload_json FROM operational_operations WHERE space_id=?1 AND type=?2 ORDER BY lamport DESC").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![space, EVENT], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())
    })
    .collect()
}

pub fn get(runtime: &Path, space: &str, id_or_name: &str) -> Result<Checkpoint, String> {
    runtime::validate_space_id(space)?;
    let connection = database(runtime)?;
    migrate(&connection)?;
    let raw: Option<String> = connection.query_row("SELECT payload_json FROM operational_operations WHERE space_id=?1 AND type=?2 AND (id=?3 OR json_extract(payload_json,'$.name')=?3) ORDER BY CASE WHEN id=?3 THEN 0 ELSE 1 END LIMIT 1", params![space, EVENT, id_or_name], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    serde_json::from_str(&raw.ok_or("Checkpoint not found in this Space")?)
        .map_err(|error| error.to_string())
}

pub fn preview(runtime: &Path, space: &str, id_or_name: &str) -> Result<RestorePreview, String> {
    let checkpoint = get(runtime, space, id_or_name)?;
    let current = runtime::read_space(runtime, space)?.ok_or("Space is not initialized")?;
    let mut restored_document = checkpoint.document.clone();
    restored_document["revision"] = json!(current.sequence);
    // Restoring a state must not restart old terminal/process sessions.
    for node in restored_document
        .get_mut("nodes")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if let Some(payload) = node.get_mut("payload").and_then(Value::as_object_mut) {
            for key in ["terminalSessionId", "terminalInitialInput"] {
                payload.remove(key);
            }
            if payload.get("role").and_then(Value::as_str) == Some("operator-terminal") {
                payload.insert("role".into(), json!("saved-terminal"));
                payload.insert("status".into(), json!("stopped"));
            }
        }
    }
    Ok(RestorePreview {
        checkpoint,
        expected_sequence: current.sequence,
        current_document: current.document,
        restored_document,
    })
}

pub fn restore(
    runtime: &Path,
    space: &str,
    id_or_name: &str,
    expected: u64,
) -> Result<(RuntimeSpaceSnapshotV1, Checkpoint), String> {
    let preview = preview(runtime, space, id_or_name)?;
    if preview.expected_sequence != expected {
        return Err("Space sequence changed; preview the current state again".into());
    }
    let safety = save(
        runtime,
        space,
        &format!("before-restore-{}", Uuid::new_v4()),
        expected,
    )?;
    let mut document = preview.restored_document;
    document["updatedAt"] = json!(Utc::now().to_rfc3339());
    let result = crate::runtime_space_apply_at(
        runtime,
        RuntimeSpaceApplyV1 {
            version: 1,
            space_id: Some(space.into()),
            expected_sequence: expected,
            actor: IdentityRefV1 {
                id: "human:local".into(),
                kind: "human".into(),
            },
            authority_grant_id: None,
            run_id: None,
            idempotency_key: format!("restore-{}", safety.id),
            document,
        },
    )?;
    Ok((result, safety))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(text: &str) -> Value {
        json!({"version":1,"revision":0,"updatedAt":"2026-09-09T00:00:00Z","viewport":{"x":0,"y":0,"zoom":1},"nextZ":2,"links":[],"nodes":[{"id":"note","type":"canvas-text","x":0,"y":0,"w":100,"h":100,"z":1,"createdAt":"2026-09-09T00:00:00Z","updatedAt":"2026-09-09T00:00:00Z","payload":{"text":text}}]})
    }

    fn edit(root: &Path, space: &str, sequence: u64, text: &str) -> RuntimeSpaceSnapshotV1 {
        let mut document = document(text);
        document["revision"] = json!(sequence);
        runtime::apply_space(
            root,
            space,
            &RuntimeSpaceApplyV1 {
                version: 1,
                space_id: Some(space.into()),
                expected_sequence: sequence,
                actor: IdentityRefV1 {
                    id: "human:local".into(),
                    kind: "human".into(),
                },
                authority_grant_id: None,
                run_id: None,
                idempotency_key: Uuid::new_v4().to_string(),
                document,
            },
        )
        .unwrap()
    }

    #[test]
    fn save_edit_preview_restore_and_reopen_preserve_history() {
        let root = tempfile::tempdir().unwrap();
        runtime::initialize_space(root.path(), "local", &document("before")).unwrap();
        let saved = save(root.path(), "local", "before edit", 0).unwrap();
        assert_eq!(
            get(root.path(), "local", &saved.id).unwrap().document["nodes"][0]["payload"]["text"],
            "before"
        );
        let edited = edit(root.path(), "local", 0, "after");
        let before_events = runtime::history(root.path(), "local", 100).unwrap().len();
        let preview = preview(root.path(), "local", "before edit").unwrap();
        assert_eq!(preview.expected_sequence, edited.sequence);
        assert_eq!(
            preview.current_document["nodes"][0]["payload"]["text"],
            "after"
        );
        assert_eq!(
            preview.restored_document["nodes"][0]["payload"]["text"],
            "before"
        );
        assert_eq!(
            runtime::history(root.path(), "local", 100).unwrap().len(),
            before_events,
            "preview must not append events"
        );
        let (restored, safety) = restore(root.path(), "local", &saved.id, edited.sequence).unwrap();
        assert_eq!(restored.sequence, edited.sequence + 1);
        assert_eq!(restored.document["nodes"][0]["payload"]["text"], "before");
        assert_eq!(safety.document["nodes"][0]["payload"]["text"], "after");
        assert_eq!(list(root.path(), "local").unwrap().len(), 2);
        assert_eq!(
            runtime::read_space(root.path(), "local")
                .unwrap()
                .unwrap()
                .document,
            restored.document
        );
        let exported: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("workspace/workspaces/local.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(exported, restored.document);
    }

    #[test]
    fn duplicate_names_cross_space_and_stale_restore_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        for space in ["one", "two"] {
            runtime::initialize_space(root.path(), space, &document(space)).unwrap();
        }
        let saved = save(root.path(), "one", "named", 0).unwrap();
        assert!(save(root.path(), "one", "named", 0)
            .unwrap_err()
            .contains("already exists"));
        assert!(save(root.path(), "one", &saved.id, 0).is_err());
        assert!(get(root.path(), "two", &saved.id).is_err());
        assert!(restore(root.path(), "two", &saved.id, 0).is_err());
        assert!(list(root.path(), "two").unwrap().is_empty());
        edit(root.path(), "one", 0, "newer");
        assert!(save(root.path(), "one", "stale", 0)
            .unwrap_err()
            .contains("sequence changed"));
        assert!(restore(root.path(), "one", "named", 0)
            .unwrap_err()
            .contains("sequence changed"));
        assert_eq!(
            list(root.path(), "one").unwrap().len(),
            1,
            "a stale restore must not append a safety point"
        );
    }

    #[test]
    fn named_states_require_local_ownership_and_do_not_relaunch_terminals() {
        let root = tempfile::tempdir().unwrap();
        let mut doc = document("terminal");
        doc["nodes"][0]["type"] = json!("terminal");
        doc["nodes"][0]["payload"] = json!({"role":"operator-terminal","terminalSessionId":"old-process","terminalInitialInput":"dangerous command"});
        runtime::initialize_space(root.path(), "local", &doc).unwrap();
        save(root.path(), "local", "terminal", 0).unwrap();
        let preview = preview(root.path(), "local", "terminal").unwrap();
        let payload = &preview.restored_document["nodes"][0]["payload"];
        assert_eq!(payload["role"], "saved-terminal");
        assert!(payload.get("terminalInitialInput").is_none());
        let connection = database(root.path()).unwrap();
        connection
            .execute(
                "UPDATE runtime_spaces SET owner_actor_id='human:other' WHERE id='local'",
                [],
            )
            .unwrap();
        assert!(save(root.path(), "local", "denied", 0)
            .unwrap_err()
            .contains("owner"));
        assert!(restore(root.path(), "local", "terminal", 0)
            .unwrap_err()
            .contains("owner"));
    }
}
