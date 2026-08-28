// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Canonical local HII Runtime contracts for Space objects and events.
//!
//! The canvas is a projection over these records. Legacy Workspace JSON is an
//! import/export surface only; all normal mutations pass through `apply_space`.

use crate::operational::{database, migrate};
use chrono::Utc;
use ring::digest::{digest, SHA256};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use uuid::Uuid;

pub const RUNTIME_VERSION: u8 = 1;
const SPATIAL_PROJECTION: &str = "space.canvas";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRefV1 {
    pub id: String,
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSpaceApplyV1 {
    pub version: u8,
    #[serde(default)]
    pub space_id: Option<String>,
    pub expected_sequence: u64,
    pub actor: IdentityRefV1,
    #[serde(default)]
    pub authority_grant_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    pub idempotency_key: String,
    pub document: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeObjectV1 {
    pub version: u8,
    pub id: String,
    pub schema_version: u64,
    #[serde(rename = "type")]
    pub object_type: String,
    pub owner: String,
    pub space_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub payload: Value,
    pub provenance: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub available_actions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEdgeV1 {
    pub version: u8,
    pub id: String,
    #[serde(rename = "type")]
    pub edge_type: String,
    pub space_id: String,
    pub from_object_id: String,
    pub to_object_id: String,
    pub properties: Value,
    pub provenance: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventV1 {
    pub version: u8,
    pub id: String,
    pub space_id: String,
    pub sequence: u64,
    pub actor: IdentityRefV1,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_grant_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSpaceSnapshotV1 {
    pub version: u8,
    pub space_id: String,
    pub sequence: u64,
    pub document: Value,
    pub objects: Vec<RuntimeObjectV1>,
    pub edges: Vec<RuntimeEdgeV1>,
    pub recent_events: Vec<RuntimeEventV1>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeShareModeV1 {
    LiveReference,
    Snapshot,
    Fork,
    Publish,
    Export,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeShareRequestV1 {
    pub version: u8,
    #[serde(default)]
    pub space_id: Option<String>,
    pub mode: RuntimeShareModeV1,
    #[serde(default)]
    pub object_ids: Vec<String>,
    pub actor: IdentityRefV1,
    #[serde(default)]
    pub recipient_id: Option<String>,
    #[serde(default)]
    pub authority_grant_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeShareBundleV1 {
    pub version: u8,
    pub kind: String,
    pub id: String,
    pub mode: RuntimeShareModeV1,
    pub source_space_id: String,
    pub source_sequence: u64,
    pub owner: IdentityRefV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient_id: Option<String>,
    pub created_at: String,
    pub objects: Vec<RuntimeObjectV1>,
    pub edges: Vec<RuntimeEdgeV1>,
    pub document: Value,
    pub content_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeShareRecordV1 {
    pub id: String,
    pub source_space_id: String,
    pub mode: RuntimeShareModeV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient_id: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeShareRevokeRequestV1 {
    pub version: u8,
    pub share_id: String,
    pub actor: IdentityRefV1,
    #[serde(default)]
    pub authority_grant_id: Option<String>,
}

struct PendingEvent {
    event_type: &'static str,
    target_id: Option<String>,
    payload: Value,
}

pub fn read_space(
    runtime: &Path,
    space_id: &str,
) -> Result<Option<RuntimeSpaceSnapshotV1>, String> {
    validate_space_id(space_id)?;
    let connection = database(runtime)?;
    migrate(&connection)?;
    let exists = connection
        .query_row(
            "SELECT 1 FROM runtime_spaces WHERE id = ?1",
            [space_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    if !exists {
        return Ok(None);
    }
    snapshot(&connection, space_id).map(Some)
}

pub fn initialize_space(
    runtime: &Path,
    space_id: &str,
    document: &Value,
) -> Result<RuntimeSpaceSnapshotV1, String> {
    validate_space_id(space_id)?;
    validate_document(document)?;
    let mut connection = database(runtime)?;
    migrate(&connection)?;
    if connection
        .query_row(
            "SELECT 1 FROM runtime_spaces WHERE id = ?1",
            [space_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return snapshot(&connection, space_id);
    }

    let now = document_timestamp(document);
    let sequence = document
        .get("revision")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO runtime_spaces
             (id, schema_version, owner_actor_id, sequence, viewport_json, next_z, created_at, updated_at)
             VALUES (?1, 1, 'human:local', ?2, ?3, ?4, ?5, ?5)",
            params![
                space_id,
                sequence,
                json_string(document.get("viewport").unwrap_or(&json!({"x":0,"y":0,"zoom":1})))?,
                document.get("nextZ").and_then(Value::as_u64).unwrap_or(1),
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    insert_event(
        &transaction,
        EventInsert {
            space_id,
            sequence,
            actor: &IdentityRefV1 {
                id: "human:local".into(),
                kind: "human".into(),
            },
            event_type: if document
                .get("nodes")
                .and_then(Value::as_array)
                .is_some_and(|nodes| !nodes.is_empty())
            {
                "space.imported"
            } else {
                "space.created"
            },
            target_id: Some(&format!("space:{space_id}")),
            payload: &json!({"legacyRevision": sequence}),
            authority_grant_id: None,
            run_id: None,
            idempotency_key: Some(&format!("space:{space_id}:initialize")),
            created_at: &now,
        },
    )?;
    write_projection(&transaction, space_id, document, "migration", &now)?;
    transaction.commit().map_err(|error| error.to_string())?;
    snapshot(&connection, space_id)
}

pub fn apply_space(
    runtime: &Path,
    space_id: &str,
    request: &RuntimeSpaceApplyV1,
) -> Result<RuntimeSpaceSnapshotV1, String> {
    validate_space_id(space_id)?;
    validate_apply_request(request)?;
    validate_document(&request.document)?;
    let mut connection = database(runtime)?;
    migrate(&connection)?;
    let Some(current) = read_space(runtime, space_id)? else {
        return Err(format!("runtime space {space_id} is not initialized"));
    };

    let duplicate = connection
        .query_row(
            "SELECT 1 FROM operational_operations WHERE space_id = ?1 AND idempotency_key = ?2",
            params![space_id, request.idempotency_key],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    if duplicate {
        return snapshot(&connection, space_id);
    }
    if current.sequence != request.expected_sequence {
        return Err(format!(
            "runtime sequence changed from {} to {}",
            request.expected_sequence, current.sequence
        ));
    }
    if request.document.get("revision").and_then(Value::as_u64) != Some(current.sequence) {
        return Err("runtime document revision does not match expectedSequence".into());
    }

    let mut events = diff_documents(&current.document, &request.document, space_id);
    if events.is_empty() {
        return Ok(current);
    }
    events.insert(
        0,
        PendingEvent {
            event_type: "space.transaction.applied",
            target_id: Some(format!("space:{space_id}")),
            payload: json!({"mutationCount": events.len()}),
        },
    );

    let next_sequence = current.sequence + 1;
    let now = document_timestamp(&request.document);
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for (index, event) in events.iter().enumerate() {
        let idempotency = if index == 0 {
            request.idempotency_key.clone()
        } else {
            format!("{}:{index}", request.idempotency_key)
        };
        insert_event(
            &transaction,
            EventInsert {
                space_id,
                sequence: next_sequence,
                actor: &request.actor,
                event_type: event.event_type,
                target_id: event.target_id.as_deref(),
                payload: &event.payload,
                authority_grant_id: request.authority_grant_id.as_deref(),
                run_id: request.run_id.as_deref(),
                idempotency_key: Some(&idempotency),
                created_at: &now,
            },
        )?;
    }
    transaction
        .execute(
            "UPDATE runtime_spaces SET sequence = ?2, viewport_json = ?3, next_z = ?4, updated_at = ?5 WHERE id = ?1",
            params![
                space_id,
                next_sequence,
                json_string(request.document.get("viewport").unwrap_or(&Value::Null))?,
                request.document.get("nextZ").and_then(Value::as_u64).unwrap_or(1),
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    write_projection(
        &transaction,
        space_id,
        &request.document,
        "human_authored",
        &now,
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    snapshot(&connection, space_id)
}

pub fn history(
    runtime: &Path,
    space_id: &str,
    limit: usize,
) -> Result<Vec<RuntimeEventV1>, String> {
    let connection = database(runtime)?;
    migrate(&connection)?;
    read_events(&connection, space_id, limit.clamp(1, 500))
}

pub fn create_share_bundle(
    runtime: &Path,
    request: &RuntimeShareRequestV1,
) -> Result<RuntimeShareBundleV1, String> {
    if request.version != RUNTIME_VERSION {
        return Err(format!("unsupported Runtime version {}", request.version));
    }
    if request.actor.id.trim().is_empty() || request.actor.kind.trim().is_empty() {
        return Err("share actor identity is required".into());
    }
    if matches!(request.actor.kind.as_str(), "agent" | "service")
        && request
            .authority_grant_id
            .as_deref()
            .is_none_or(str::is_empty)
    {
        return Err("agent and service sharing requires an explicit authority grant".into());
    }
    match request.mode {
        RuntimeShareModeV1::LiveReference => {
            return Err("live references require an authorized HII Network sync transport".into())
        }
        RuntimeShareModeV1::Publish => {
            return Err("publishing requires an explicit HII Network publication service".into())
        }
        RuntimeShareModeV1::Snapshot | RuntimeShareModeV1::Fork | RuntimeShareModeV1::Export => {}
    }
    let space_id = request.space_id.as_deref().unwrap_or("default");
    validate_space_id(space_id)?;
    let current = read_space(runtime, space_id)?
        .ok_or_else(|| format!("runtime space {space_id} is not initialized"))?;
    authorize_share_action(
        runtime,
        space_id,
        &request.actor,
        request.authority_grant_id.as_deref(),
        "object.share",
    )?;
    let selected = selected_object_ids(&current, &request.object_ids)?;
    let objects = current
        .objects
        .iter()
        .filter(|object| selected.contains(&object.id))
        .cloned()
        .collect::<Vec<_>>();
    let edges = current
        .edges
        .iter()
        .filter(|edge| {
            selected.contains(&edge.from_object_id) && selected.contains(&edge.to_object_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    let document = filtered_share_document(&current.document, &selected);
    let now = Utc::now().to_rfc3339();
    let mut bundle = RuntimeShareBundleV1 {
        version: RUNTIME_VERSION,
        kind: "hii.runtime.share-bundle".into(),
        id: format!("share-{}", Uuid::new_v4()),
        mode: request.mode,
        source_space_id: space_id.into(),
        source_sequence: current.sequence,
        owner: request.actor.clone(),
        recipient_id: request.recipient_id.clone(),
        created_at: now.clone(),
        objects,
        edges,
        document,
        content_hash: String::new(),
    };
    bundle.content_hash = share_bundle_hash(&bundle)?;

    let mut connection = database(runtime)?;
    migrate(&connection)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let next_sequence = current.sequence + 1;
    let event_type = match request.mode {
        RuntimeShareModeV1::Export => "artifact.exported",
        RuntimeShareModeV1::Snapshot | RuntimeShareModeV1::Fork => "artifact.shared",
        RuntimeShareModeV1::LiveReference | RuntimeShareModeV1::Publish => unreachable!(),
    };
    insert_event(
        &transaction,
        EventInsert {
            space_id,
            sequence: next_sequence,
            actor: &request.actor,
            event_type,
            target_id: Some(&bundle.id),
            payload: &json!({
                "mode": request.mode,
                "objectIds": selected,
                "recipientId": request.recipient_id,
                "contentHash": bundle.content_hash,
            }),
            authority_grant_id: request.authority_grant_id.as_deref(),
            run_id: None,
            idempotency_key: Some(&format!("share:{}", bundle.id)),
            created_at: &now,
        },
    )?;
    transaction
        .execute(
            "INSERT INTO runtime_shares
             (id, source_space_id, mode, recipient_id, bundle_json, created_at, revoked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
            params![
                bundle.id,
                space_id,
                share_mode_name(request.mode),
                request.recipient_id,
                json_string(&serde_json::to_value(&bundle).map_err(|error| error.to_string())?)?,
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE runtime_spaces SET sequence=?2, updated_at=?3 WHERE id=?1",
            params![space_id, next_sequence, now],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(bundle)
}

pub fn list_shares(runtime: &Path, space_id: &str) -> Result<Vec<RuntimeShareRecordV1>, String> {
    validate_space_id(space_id)?;
    let connection = database(runtime)?;
    migrate(&connection)?;
    let mut statement = connection
        .prepare(
            "SELECT id, source_space_id, mode, recipient_id, created_at, revoked_at
             FROM runtime_shares WHERE source_space_id=?1 ORDER BY created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map([space_id], |row| {
            let mode: String = row.get(2)?;
            Ok(RuntimeShareRecordV1 {
                id: row.get(0)?,
                source_space_id: row.get(1)?,
                mode: parse_share_mode(&mode).unwrap_or(RuntimeShareModeV1::Export),
                recipient_id: row.get(3)?,
                created_at: row.get(4)?,
                revoked_at: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(records)
}

pub fn revoke_share(
    runtime: &Path,
    request: &RuntimeShareRevokeRequestV1,
) -> Result<RuntimeShareRecordV1, String> {
    if request.version != RUNTIME_VERSION || request.share_id.trim().is_empty() {
        return Err("valid Runtime share revocation is required".into());
    }
    if request.actor.id.trim().is_empty() || request.actor.kind.trim().is_empty() {
        return Err("share revocation actor identity is required".into());
    }
    if matches!(request.actor.kind.as_str(), "agent" | "service")
        && request
            .authority_grant_id
            .as_deref()
            .is_none_or(str::is_empty)
    {
        return Err("agent and service revocation requires an explicit authority grant".into());
    }
    let mut connection = database(runtime)?;
    migrate(&connection)?;
    let existing = connection
        .query_row(
            "SELECT source_space_id, mode, recipient_id, created_at, revoked_at
             FROM runtime_shares WHERE id=?1",
            [&request.share_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "share does not exist".to_string())?;
    let mode = parse_share_mode(&existing.1).ok_or_else(|| "share mode is invalid".to_string())?;
    if let Some(revoked_at) = existing.4 {
        return Ok(RuntimeShareRecordV1 {
            id: request.share_id.clone(),
            source_space_id: existing.0,
            mode,
            recipient_id: existing.2,
            created_at: existing.3,
            revoked_at: Some(revoked_at),
        });
    }
    let current = read_space(runtime, &existing.0)?
        .ok_or_else(|| "share source Space does not exist".to_string())?;
    authorize_share_action(
        runtime,
        &existing.0,
        &request.actor,
        request.authority_grant_id.as_deref(),
        "object.share.revoke",
    )?;
    let now = Utc::now().to_rfc3339();
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE runtime_shares SET revoked_at=?2 WHERE id=?1 AND revoked_at IS NULL",
            params![request.share_id, now],
        )
        .map_err(|error| error.to_string())?;
    let idempotency_key = format!("share:{}:revoke", request.share_id);
    insert_event(
        &transaction,
        EventInsert {
            space_id: &existing.0,
            sequence: current.sequence + 1,
            actor: &request.actor,
            event_type: "artifact.share.revoked",
            target_id: Some(&request.share_id),
            payload: &json!({"mode": mode, "recipientId": existing.2}),
            authority_grant_id: request.authority_grant_id.as_deref(),
            run_id: None,
            idempotency_key: Some(&idempotency_key),
            created_at: &now,
        },
    )?;
    transaction
        .execute(
            "UPDATE runtime_spaces SET sequence=?2, updated_at=?3 WHERE id=?1",
            params![existing.0, current.sequence + 1, now],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(RuntimeShareRecordV1 {
        id: request.share_id.clone(),
        source_space_id: existing.0,
        mode,
        recipient_id: existing.2,
        created_at: existing.3,
        revoked_at: Some(now),
    })
}

fn selected_object_ids(
    snapshot: &RuntimeSpaceSnapshotV1,
    requested: &[String],
) -> Result<BTreeSet<String>, String> {
    let available = snapshot
        .objects
        .iter()
        .map(|object| object.id.clone())
        .collect::<BTreeSet<_>>();
    if requested.is_empty() {
        if available.is_empty() {
            return Err("share requires at least one object".into());
        }
        return Ok(available);
    }
    let mut selected = BTreeSet::new();
    for requested_id in requested {
        let direct = available.get(requested_id).cloned();
        let by_legacy = available
            .iter()
            .find(|candidate| legacy_object_id(candidate) == requested_id)
            .cloned();
        let Some(id) = direct.or(by_legacy) else {
            return Err(format!(
                "share object does not exist in Space: {requested_id}"
            ));
        };
        selected.insert(id);
    }
    Ok(selected)
}

fn authorize_share_action(
    runtime: &Path,
    space_id: &str,
    actor: &IdentityRefV1,
    grant_id: Option<&str>,
    action: &str,
) -> Result<(), String> {
    let connection = database(runtime)?;
    migrate(&connection)?;
    let owner: String = connection
        .query_row(
            "SELECT owner_actor_id FROM runtime_spaces WHERE id=?1",
            [space_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if actor.kind == "human" && actor.id == owner {
        return Ok(());
    }
    let Some(grant_id) = grant_id.filter(|id| !id.is_empty()) else {
        return Err("sharing requires the Space owner or an explicit Runtime grant".into());
    };
    let now = Utc::now().to_rfc3339();
    let resource = format!("space:{space_id}");
    let valid = connection
        .query_row(
            "SELECT 1 FROM runtime_grants
             WHERE id=?1 AND subject_id=?2 AND action=?3 AND resource_id=?4
               AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?5)",
            params![grant_id, actor.id, action, resource, now],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    if valid {
        Ok(())
    } else {
        Err("Runtime grant does not authorize this share action".into())
    }
}

fn filtered_share_document(document: &Value, selected: &BTreeSet<String>) -> Value {
    let selected_legacy = selected
        .iter()
        .map(|id| legacy_object_id(id).to_string())
        .collect::<BTreeSet<_>>();
    let nodes = document
        .get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|node| {
            node.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| selected_legacy.contains(id))
        })
        .cloned()
        .collect::<Vec<_>>();
    let links = document
        .get("links")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|link| {
            link.get("fromId")
                .and_then(Value::as_str)
                .is_some_and(|id| selected_legacy.contains(id))
                && link
                    .get("toId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| selected_legacy.contains(id))
        })
        .cloned()
        .collect::<Vec<_>>();
    json!({
        "version": 1,
        "revision": document.get("revision").cloned().unwrap_or(json!(0)),
        "updatedAt": document.get("updatedAt").cloned().unwrap_or(Value::Null),
        "viewport": document.get("viewport").cloned().unwrap_or(json!({"x":0,"y":0,"zoom":1})),
        "nextZ": document.get("nextZ").cloned().unwrap_or(json!(1)),
        "nodes": nodes,
        "links": links,
    })
}

fn share_bundle_hash(bundle: &RuntimeShareBundleV1) -> Result<String, String> {
    let mut hashable = bundle.clone();
    hashable.content_hash.clear();
    let bytes = serde_json::to_vec(&hashable).map_err(|error| error.to_string())?;
    Ok(digest(&SHA256, &bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn share_mode_name(mode: RuntimeShareModeV1) -> &'static str {
    match mode {
        RuntimeShareModeV1::LiveReference => "liveReference",
        RuntimeShareModeV1::Snapshot => "snapshot",
        RuntimeShareModeV1::Fork => "fork",
        RuntimeShareModeV1::Publish => "publish",
        RuntimeShareModeV1::Export => "export",
    }
}

fn parse_share_mode(value: &str) -> Option<RuntimeShareModeV1> {
    match value {
        "liveReference" => Some(RuntimeShareModeV1::LiveReference),
        "snapshot" => Some(RuntimeShareModeV1::Snapshot),
        "fork" => Some(RuntimeShareModeV1::Fork),
        "publish" => Some(RuntimeShareModeV1::Publish),
        "export" => Some(RuntimeShareModeV1::Export),
        _ => None,
    }
}

fn validate_apply_request(request: &RuntimeSpaceApplyV1) -> Result<(), String> {
    if request.version != RUNTIME_VERSION {
        return Err(format!("unsupported Runtime version {}", request.version));
    }
    if request.actor.id.trim().is_empty() || request.actor.kind.trim().is_empty() {
        return Err("Runtime actor identity is required".into());
    }
    if matches!(request.actor.kind.as_str(), "agent" | "service")
        && request
            .authority_grant_id
            .as_deref()
            .is_none_or(str::is_empty)
    {
        return Err("agent and service mutations require an explicit authority grant".into());
    }
    if request.idempotency_key.trim().is_empty() || request.idempotency_key.len() > 240 {
        return Err("Runtime idempotencyKey is required and must be at most 240 characters".into());
    }
    Ok(())
}

fn validate_space_id(space_id: &str) -> Result<(), String> {
    if space_id.is_empty()
        || space_id.len() > 120
        || !space_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid Runtime spaceId".into());
    }
    Ok(())
}

fn validate_document(document: &Value) -> Result<(), String> {
    if document.get("version").and_then(Value::as_u64) != Some(1)
        || !document.get("revision").is_some_and(Value::is_u64)
        || !document.get("nodes").is_some_and(Value::is_array)
        || !document.get("links").is_some_and(Value::is_array)
        || !document.get("viewport").is_some_and(Value::is_object)
    {
        return Err("HII Runtime rejected an invalid Space document".into());
    }
    Ok(())
}

fn object_id(space_id: &str, legacy_id: &str) -> String {
    format!("workspace:{space_id}:object:{legacy_id}")
}

fn relation_id(space_id: &str, legacy_id: &str) -> String {
    format!("workspace:{space_id}:relation:{legacy_id}")
}

fn document_timestamp(document: &Value) -> String {
    document
        .get("updatedAt")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Utc::now().to_rfc3339())
}

fn json_string(value: &Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}

fn node_map(document: &Value) -> BTreeMap<String, Value> {
    document
        .get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|node| Some((node.get("id")?.as_str()?.to_string(), node.clone())))
        .collect()
}

fn link_map(document: &Value) -> BTreeMap<String, Value> {
    document
        .get("links")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|link| Some((link.get("id")?.as_str()?.to_string(), link.clone())))
        .collect()
}

fn semantic_node(node: &Value) -> Value {
    let mut value = Map::new();
    for key in [
        "id",
        "type",
        "spaceId",
        "creatorId",
        "createdAt",
        "updatedAt",
        "permissions",
        "object",
        "objectRef",
        "frameId",
        "payload",
    ] {
        if let Some(entry) = node.get(key) {
            value.insert(key.to_string(), entry.clone());
        }
    }
    Value::Object(value)
}

fn spatial_node(node: &Value) -> Value {
    json!({
        "legacyId": node.get("id").cloned().unwrap_or(Value::Null),
        "x": node.get("x").cloned().unwrap_or(json!(0)),
        "y": node.get("y").cloned().unwrap_or(json!(0)),
        "w": node.get("w").cloned().unwrap_or(json!(320)),
        "h": node.get("h").cloned().unwrap_or(json!(180)),
        "z": node.get("z").cloned().unwrap_or(json!(1)),
        "rotation": node.get("rotation").cloned().unwrap_or(json!(0)),
    })
}

fn diff_documents(before: &Value, after: &Value, space_id: &str) -> Vec<PendingEvent> {
    let old_nodes = node_map(before);
    let new_nodes = node_map(after);
    let old_links = link_map(before);
    let new_links = link_map(after);
    let mut events = Vec::new();

    for (id, node) in &new_nodes {
        let target = object_id(space_id, id);
        match old_nodes.get(id) {
            None => events.push(PendingEvent {
                event_type: "object.created",
                target_id: Some(target),
                payload: json!({"legacyId": id, "type": node.get("type")}),
            }),
            Some(previous) => {
                if semantic_node(previous) != semantic_node(node) {
                    events.push(PendingEvent {
                        event_type: "object.updated",
                        target_id: Some(target.clone()),
                        payload: json!({"legacyId": id}),
                    });
                }
                if spatial_node(previous) != spatial_node(node) {
                    events.push(PendingEvent {
                        event_type: "object.moved",
                        target_id: Some(target),
                        payload: spatial_node(node),
                    });
                }
            }
        }
    }
    for id in old_nodes.keys() {
        if !new_nodes.contains_key(id) {
            events.push(PendingEvent {
                event_type: "object.deleted",
                target_id: Some(object_id(space_id, id)),
                payload: json!({"legacyId": id}),
            });
        }
    }
    for (id, link) in &new_links {
        let target = relation_id(space_id, id);
        match old_links.get(id) {
            None => events.push(PendingEvent {
                event_type: "edge.created",
                target_id: Some(target),
                payload: link.clone(),
            }),
            Some(previous) if previous != link => events.push(PendingEvent {
                event_type: "edge.updated",
                target_id: Some(target),
                payload: link.clone(),
            }),
            _ => {}
        }
    }
    for id in old_links.keys() {
        if !new_links.contains_key(id) {
            events.push(PendingEvent {
                event_type: "edge.deleted",
                target_id: Some(relation_id(space_id, id)),
                payload: json!({"legacyId": id}),
            });
        }
    }
    if before.get("viewport") != after.get("viewport") || before.get("nextZ") != after.get("nextZ")
    {
        events.push(PendingEvent {
            event_type: "space.viewport.updated",
            target_id: Some(format!("space:{space_id}")),
            payload: json!({"viewport": after.get("viewport"), "nextZ": after.get("nextZ")}),
        });
    }
    events
}

struct EventInsert<'a> {
    space_id: &'a str,
    sequence: u64,
    actor: &'a IdentityRefV1,
    event_type: &'a str,
    target_id: Option<&'a str>,
    payload: &'a Value,
    authority_grant_id: Option<&'a str>,
    run_id: Option<&'a str>,
    idempotency_key: Option<&'a str>,
    created_at: &'a str,
}

fn insert_event(transaction: &Transaction<'_>, event: EventInsert<'_>) -> Result<(), String> {
    let lamport: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(lamport), 0) + 1 FROM operational_operations WHERE space_id = ?1",
            [event.space_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO operational_operations
             (id, space_id, actor_id, device_id, type, target_id, base_version, lamport,
              payload_json, authority_grant_id, created_at, result_version, idempotency_key,
              operation_hash, provenance_class, authority_json, run_id)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                     NULL, ?13, ?14, ?15)",
            params![
                Uuid::new_v4().to_string(),
                event.space_id,
                event.actor.id,
                event.event_type,
                event.target_id,
                event.sequence.saturating_sub(1),
                lamport,
                json_string(event.payload)?,
                event.authority_grant_id,
                event.created_at,
                event.sequence,
                event.idempotency_key,
                if event.actor.kind == "human" {
                    "human_authored"
                } else {
                    "derived"
                },
                json_string(&json!({"actorKind": event.actor.kind, "bounded": true}))?,
                event.run_id,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn write_projection(
    transaction: &Transaction<'_>,
    space_id: &str,
    document: &Value,
    provenance_class: &str,
    now: &str,
) -> Result<(), String> {
    let nodes = node_map(document);
    let links = link_map(document);
    let active_objects: BTreeSet<String> = nodes.keys().map(|id| object_id(space_id, id)).collect();
    let active_relations: BTreeSet<String> =
        links.keys().map(|id| relation_id(space_id, id)).collect();

    for (legacy_id, node) in &nodes {
        let id = object_id(space_id, legacy_id);
        let semantic = semantic_node(node);
        let projection = spatial_node(node);
        let object_type = node
            .pointer("/object/kind")
            .and_then(Value::as_str)
            .or_else(|| node.get("type").and_then(Value::as_str))
            .unwrap_or("object");
        let owner = node
            .pointer("/object/owner")
            .and_then(Value::as_str)
            .or_else(|| node.get("creatorId").and_then(Value::as_str))
            .unwrap_or("human:local");
        let created_at = node.get("createdAt").and_then(Value::as_str).unwrap_or(now);
        let updated_at = node.get("updatedAt").and_then(Value::as_str).unwrap_or(now);
        let previous: Option<(String, String, i64, Option<String>)> = transaction
            .query_row(
                "SELECT type, properties_json, semantic_version, deleted_at FROM operational_objects WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let semantic_json = json_string(&semantic)?;
        let semantic_version = previous
            .as_ref()
            .map(|(kind, properties, version, deleted)| {
                version
                    + i64::from(
                        kind != object_type || properties != &semantic_json || deleted.is_some(),
                    )
            })
            .unwrap_or(1);
        transaction
            .execute(
                "INSERT INTO operational_objects
                 (id, space_id, type, schema_version, properties_json, provenance_json,
                  owner_actor_id, created_at, updated_at, deleted_at, semantic_version,
                  canonical_source, provenance_class)
                 VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, NULL, ?9, 'graph', ?10)
                 ON CONFLICT(id) DO UPDATE SET type=excluded.type, properties_json=excluded.properties_json,
                  provenance_json=excluded.provenance_json, owner_actor_id=excluded.owner_actor_id,
                  updated_at=excluded.updated_at, deleted_at=NULL, semantic_version=excluded.semantic_version,
                  canonical_source='graph', provenance_class=excluded.provenance_class",
                params![
                    id,
                    space_id,
                    object_type,
                    semantic_json,
                    json_string(&json!({"source":"hii-runtime","spaceId":space_id}))?,
                    owner,
                    created_at,
                    updated_at,
                    semantic_version,
                    provenance_class,
                ],
            )
            .map_err(|error| error.to_string())?;
        let previous_projection: Option<(String, i64, Option<String>)> = transaction
            .query_row(
                "SELECT state_json, projection_version, deleted_at FROM object_projections
                 WHERE space_id = ?1 AND object_id = ?2 AND projection = ?3",
                params![space_id, id, SPATIAL_PROJECTION],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let projection_json = json_string(&projection)?;
        let projection_version = previous_projection
            .as_ref()
            .map(|(state, version, deleted)| {
                version + i64::from(state != &projection_json || deleted.is_some())
            })
            .unwrap_or(1);
        transaction
            .execute(
                "INSERT INTO object_projections
                 (space_id, object_id, projection, state_json, updated_at, projection_version, canonical_source, deleted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'graph', NULL)
                 ON CONFLICT(space_id, object_id, projection) DO UPDATE SET
                  state_json=excluded.state_json, updated_at=excluded.updated_at,
                  projection_version=excluded.projection_version, canonical_source='graph', deleted_at=NULL",
                params![space_id, id, SPATIAL_PROJECTION, projection_json, updated_at, projection_version],
            )
            .map_err(|error| error.to_string())?;
    }

    let existing_objects = query_ids(transaction, "operational_objects", space_id)?;
    for id in existing_objects.difference(&active_objects) {
        if id.starts_with(&format!("workspace:{space_id}:object:")) {
            transaction
                .execute(
                    "UPDATE operational_objects SET deleted_at=?2, updated_at=?2, semantic_version=semantic_version+1
                     WHERE id=?1 AND deleted_at IS NULL",
                    params![id, now],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "UPDATE object_projections SET deleted_at=?3, updated_at=?3, projection_version=projection_version+1
                     WHERE space_id=?1 AND object_id=?2 AND deleted_at IS NULL",
                    params![space_id, id, now],
                )
                .map_err(|error| error.to_string())?;
        }
    }

    for (legacy_id, link) in &links {
        let id = relation_id(space_id, legacy_id);
        let from = object_id(
            space_id,
            link.get("fromId").and_then(Value::as_str).unwrap_or(""),
        );
        let to = object_id(
            space_id,
            link.get("toId").and_then(Value::as_str).unwrap_or(""),
        );
        let properties = json!({
            "legacyId": legacy_id,
            "label": link.get("label"),
            "arrow": link.get("arrow").cloned().unwrap_or(json!("end")),
        });
        let properties_json = json_string(&properties)?;
        let previous: Option<(String, String, String, i64, Option<String>)> = transaction
            .query_row(
                "SELECT from_object_id, to_object_id, properties_json, relation_version, deleted_at
                 FROM operational_relations WHERE id=?1",
                [&id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let relation_version = previous
            .as_ref()
            .map(|(old_from, old_to, old_properties, version, deleted)| {
                version
                    + i64::from(
                        old_from != &from
                            || old_to != &to
                            || old_properties != &properties_json
                            || deleted.is_some(),
                    )
            })
            .unwrap_or(1);
        transaction
            .execute(
                "INSERT INTO operational_relations
                 (id, space_id, type, from_object_id, to_object_id, properties_json, provenance_json,
                  created_at, updated_at, deleted_at, relation_version, canonical_source, provenance_class)
                 VALUES (?1, ?2, 'AUTHORED_LINK', ?3, ?4, ?5, ?6, ?7, ?7, NULL, ?8, 'graph', ?9)
                 ON CONFLICT(id) DO UPDATE SET from_object_id=excluded.from_object_id,
                  to_object_id=excluded.to_object_id, properties_json=excluded.properties_json,
                  provenance_json=excluded.provenance_json, updated_at=excluded.updated_at,
                  deleted_at=NULL, relation_version=excluded.relation_version,
                  canonical_source='graph', provenance_class=excluded.provenance_class",
                params![
                    id,
                    space_id,
                    from,
                    to,
                    properties_json,
                    json_string(&json!({"source":"human-authored-link"}))?,
                    now,
                    relation_version,
                    provenance_class,
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    let existing_relations = query_ids(transaction, "operational_relations", space_id)?;
    for id in existing_relations.difference(&active_relations) {
        if id.starts_with(&format!("workspace:{space_id}:relation:")) {
            transaction
                .execute(
                    "UPDATE operational_relations SET deleted_at=?2, updated_at=?2,
                     relation_version=relation_version+1 WHERE id=?1 AND deleted_at IS NULL",
                    params![id, now],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn query_ids(
    transaction: &Transaction<'_>,
    table: &str,
    space_id: &str,
) -> Result<BTreeSet<String>, String> {
    let mut statement = transaction
        .prepare(&format!("SELECT id FROM {table} WHERE space_id=?1"))
        .map_err(|error| error.to_string())?;
    let ids = statement
        .query_map([space_id], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<BTreeSet<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(ids)
}

fn snapshot(connection: &Connection, space_id: &str) -> Result<RuntimeSpaceSnapshotV1, String> {
    let (sequence, viewport_json, next_z, updated_at): (u64, String, u64, String) = connection
        .query_row(
            "SELECT sequence, viewport_json, next_z, updated_at FROM runtime_spaces WHERE id=?1",
            [space_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|error| error.to_string())?;
    let viewport: Value =
        serde_json::from_str(&viewport_json).unwrap_or_else(|_| json!({"x":0,"y":0,"zoom":1}));

    let mut objects = Vec::new();
    let mut nodes = Vec::new();
    let mut statement = connection
        .prepare(
            "SELECT o.id, o.schema_version, o.type, o.owner_actor_id, o.properties_json,
                    o.provenance_json, o.created_at, o.updated_at, p.state_json
             FROM operational_objects o JOIN object_projections p ON p.object_id=o.id AND p.space_id=o.space_id
             WHERE o.space_id=?1 AND o.deleted_at IS NULL AND p.projection=?2 AND p.deleted_at IS NULL
             ORDER BY o.created_at, o.id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![space_id, SPATIAL_PROJECTION], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (
            id,
            schema_version,
            object_type,
            owner,
            properties_raw,
            provenance_raw,
            created_at,
            updated_at,
            projection_raw,
        ) = row.map_err(|error| error.to_string())?;
        let properties: Value = serde_json::from_str(&properties_raw).unwrap_or_else(|_| json!({}));
        let provenance: Value = serde_json::from_str(&provenance_raw).unwrap_or_else(|_| json!({}));
        let projection: Value = serde_json::from_str(&projection_raw).unwrap_or_else(|_| json!({}));
        let mut node = properties.as_object().cloned().unwrap_or_default();
        for key in ["x", "y", "w", "h", "z", "rotation"] {
            if let Some(value) = projection.get(key) {
                node.insert(key.to_string(), value.clone());
            }
        }
        nodes.push(Value::Object(node));
        let title = properties
            .pointer("/payload/title")
            .or_else(|| properties.pointer("/payload/name"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let status = properties
            .pointer("/object/status")
            .and_then(Value::as_str)
            .map(str::to_string);
        objects.push(RuntimeObjectV1 {
            version: RUNTIME_VERSION,
            id,
            schema_version,
            object_type,
            owner: owner.unwrap_or_else(|| "human:local".into()),
            space_id: space_id.into(),
            title,
            payload: properties,
            provenance,
            status,
            created_at,
            updated_at,
            available_actions: vec![
                "inspect".into(),
                "move".into(),
                "share".into(),
                "export".into(),
            ],
        });
    }

    let mut edges = Vec::new();
    let mut links = Vec::new();
    let mut statement = connection
        .prepare(
            "SELECT id, type, from_object_id, to_object_id, properties_json, provenance_json, created_at, updated_at
             FROM operational_relations WHERE space_id=?1 AND deleted_at IS NULL ORDER BY created_at, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([space_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (id, edge_type, from, to, properties_raw, provenance_raw, created_at, updated_at) =
            row.map_err(|error| error.to_string())?;
        let properties: Value = serde_json::from_str(&properties_raw).unwrap_or_else(|_| json!({}));
        let provenance: Value = serde_json::from_str(&provenance_raw).unwrap_or_else(|_| json!({}));
        links.push(json!({
            "id": properties.get("legacyId").and_then(Value::as_str).unwrap_or(&id),
            "fromId": legacy_object_id(&from),
            "toId": legacy_object_id(&to),
            "label": properties.get("label").cloned().unwrap_or(Value::Null),
            "arrow": properties.get("arrow").cloned().unwrap_or(json!("end")),
        }));
        edges.push(RuntimeEdgeV1 {
            version: RUNTIME_VERSION,
            id,
            edge_type,
            space_id: space_id.into(),
            from_object_id: from,
            to_object_id: to,
            properties,
            provenance,
            created_at,
            updated_at,
        });
    }

    Ok(RuntimeSpaceSnapshotV1 {
        version: RUNTIME_VERSION,
        space_id: space_id.into(),
        sequence,
        document: json!({
            "version": 1,
            "revision": sequence,
            "updatedAt": updated_at,
            "viewport": viewport,
            "nextZ": next_z,
            "nodes": nodes,
            "links": links,
        }),
        objects,
        edges,
        recent_events: read_events(connection, space_id, 50)?,
    })
}

fn legacy_object_id(id: &str) -> &str {
    id.rsplit(':').next().unwrap_or(id)
}

fn read_events(
    connection: &Connection,
    space_id: &str,
    limit: usize,
) -> Result<Vec<RuntimeEventV1>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, actor_id, type, target_id, result_version, payload_json,
                    authority_grant_id, run_id, created_at, authority_json
             FROM operational_operations WHERE space_id=?1 ORDER BY lamport DESC LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![space_id, limit as u64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<u64>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut events = rows
        .map(|row| {
            let (
                id,
                actor_id,
                event_type,
                target_id,
                sequence,
                payload,
                grant,
                run_id,
                created_at,
                authority,
            ) = row.map_err(|error| error.to_string())?;
            let actor_kind = serde_json::from_str::<Value>(&authority)
                .ok()
                .and_then(|value| value.get("actorKind")?.as_str().map(str::to_string))
                .unwrap_or_else(|| "unknown".into());
            Ok(RuntimeEventV1 {
                version: RUNTIME_VERSION,
                id,
                space_id: space_id.into(),
                sequence: sequence.unwrap_or(0),
                actor: IdentityRefV1 {
                    id: actor_id,
                    kind: actor_kind,
                },
                event_type,
                target_id,
                payload: serde_json::from_str(&payload).unwrap_or_else(|_| json!({})),
                authority_grant_id: grant,
                run_id,
                created_at,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    events.reverse();
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs};

    struct TempRuntime(std::path::PathBuf);
    impl TempRuntime {
        fn new() -> Self {
            let path = env::temp_dir().join(format!("hii-runtime-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempRuntime {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn node(id: &str, x: i64) -> Value {
        json!({
            "id": id, "type": "canvas-text", "x": x, "y": 0, "w": 240, "h": 100,
            "z": 1, "createdAt": "2026-08-27T00:00:00Z", "updatedAt": "2026-08-27T00:00:00Z",
            "payload": {"text": "hello"}
        })
    }

    fn document(revision: u64, nodes: Vec<Value>) -> Value {
        json!({"version":1,"revision":revision,"updatedAt":"2026-08-27T00:00:00Z",
            "viewport":{"x":0,"y":0,"zoom":1},"nextZ":2,"nodes":nodes,"links":[]})
    }

    #[test]
    fn runtime_is_canonical_and_records_create_move_delete_events() {
        let runtime = TempRuntime::new();
        let initialized = initialize_space(&runtime.0, "default", &document(0, vec![])).unwrap();
        assert_eq!(initialized.sequence, 0);
        let created = apply_space(
            &runtime.0,
            "default",
            &RuntimeSpaceApplyV1 {
                version: 1,
                space_id: Some("default".into()),
                expected_sequence: 0,
                actor: IdentityRefV1 {
                    id: "human:local".into(),
                    kind: "human".into(),
                },
                authority_grant_id: None,
                run_id: None,
                idempotency_key: "create-one".into(),
                document: document(0, vec![node("one", 0)]),
            },
        )
        .unwrap();
        assert_eq!(created.sequence, 1);
        assert_eq!(created.document["nodes"][0]["id"], "one");
        assert!(created
            .recent_events
            .iter()
            .any(|event| event.event_type == "object.created"));

        let moved = apply_space(
            &runtime.0,
            "default",
            &RuntimeSpaceApplyV1 {
                version: 1,
                space_id: Some("default".into()),
                expected_sequence: 1,
                actor: IdentityRefV1 {
                    id: "human:local".into(),
                    kind: "human".into(),
                },
                authority_grant_id: None,
                run_id: None,
                idempotency_key: "move-one".into(),
                document: document(1, vec![node("one", 42)]),
            },
        )
        .unwrap();
        assert_eq!(moved.document["nodes"][0]["x"], 42);
        assert!(moved
            .recent_events
            .iter()
            .any(|event| event.event_type == "object.moved"));
    }

    #[test]
    fn agent_mutations_require_a_run_bound_grant() {
        let runtime = TempRuntime::new();
        initialize_space(&runtime.0, "default", &document(0, vec![])).unwrap();
        let error = apply_space(
            &runtime.0,
            "default",
            &RuntimeSpaceApplyV1 {
                version: 1,
                space_id: Some("default".into()),
                expected_sequence: 0,
                actor: IdentityRefV1 {
                    id: "agent:test".into(),
                    kind: "agent".into(),
                },
                authority_grant_id: None,
                run_id: Some("run:test".into()),
                idempotency_key: "agent-without-grant".into(),
                document: document(0, vec![node("one", 0)]),
            },
        )
        .unwrap_err();
        assert!(error.contains("explicit authority grant"));
    }

    #[test]
    fn snapshot_shares_are_filtered_hashed_and_recorded_as_events() {
        let runtime = TempRuntime::new();
        initialize_space(
            &runtime.0,
            "default",
            &document(0, vec![node("one", 0), node("two", 20)]),
        )
        .unwrap();
        let bundle = create_share_bundle(
            &runtime.0,
            &RuntimeShareRequestV1 {
                version: 1,
                space_id: Some("default".into()),
                mode: RuntimeShareModeV1::Snapshot,
                object_ids: vec!["one".into()],
                actor: IdentityRefV1 {
                    id: "human:local".into(),
                    kind: "human".into(),
                },
                recipient_id: Some("human:recipient".into()),
                authority_grant_id: None,
            },
        )
        .unwrap();
        assert_eq!(bundle.objects.len(), 1);
        assert_eq!(bundle.document["nodes"].as_array().unwrap().len(), 1);
        assert_eq!(bundle.content_hash.len(), 64);
        assert_eq!(share_bundle_hash(&bundle).unwrap(), bundle.content_hash);
        let shares = list_shares(&runtime.0, "default").unwrap();
        assert_eq!(shares.len(), 1);
        assert_eq!(shares[0].mode, RuntimeShareModeV1::Snapshot);
        let updated = read_space(&runtime.0, "default").unwrap().unwrap();
        assert_eq!(updated.sequence, 1);
        assert!(updated
            .recent_events
            .iter()
            .any(|event| event.event_type == "artifact.shared"));
        let revoked = revoke_share(
            &runtime.0,
            &RuntimeShareRevokeRequestV1 {
                version: 1,
                share_id: bundle.id,
                actor: IdentityRefV1 {
                    id: "human:local".into(),
                    kind: "human".into(),
                },
                authority_grant_id: None,
            },
        )
        .unwrap();
        assert!(revoked.revoked_at.is_some());
        let after_revoke = read_space(&runtime.0, "default").unwrap().unwrap();
        assert_eq!(after_revoke.sequence, 2);
        assert!(after_revoke
            .recent_events
            .iter()
            .any(|event| event.event_type == "artifact.share.revoked"));
    }

    #[test]
    fn unsupported_network_modes_fail_closed_without_events() {
        let runtime = TempRuntime::new();
        initialize_space(&runtime.0, "default", &document(0, vec![node("one", 0)])).unwrap();
        for mode in [
            RuntimeShareModeV1::LiveReference,
            RuntimeShareModeV1::Publish,
        ] {
            let error = create_share_bundle(
                &runtime.0,
                &RuntimeShareRequestV1 {
                    version: 1,
                    space_id: Some("default".into()),
                    mode,
                    object_ids: vec!["one".into()],
                    actor: IdentityRefV1 {
                        id: "human:local".into(),
                        kind: "human".into(),
                    },
                    recipient_id: None,
                    authority_grant_id: None,
                },
            )
            .unwrap_err();
            assert!(error.contains("HII Network"));
        }
        assert!(list_shares(&runtime.0, "default").unwrap().is_empty());
        assert_eq!(
            read_space(&runtime.0, "default").unwrap().unwrap().sequence,
            0
        );
    }

    #[test]
    fn non_owner_cannot_share_by_claiming_a_human_identity() {
        let runtime = TempRuntime::new();
        initialize_space(&runtime.0, "default", &document(0, vec![node("one", 0)])).unwrap();
        let error = create_share_bundle(
            &runtime.0,
            &RuntimeShareRequestV1 {
                version: 1,
                space_id: Some("default".into()),
                mode: RuntimeShareModeV1::Snapshot,
                object_ids: vec!["one".into()],
                actor: IdentityRefV1 {
                    id: "human:not-owner".into(),
                    kind: "human".into(),
                },
                recipient_id: None,
                authority_grant_id: None,
            },
        )
        .unwrap_err();
        assert!(error.contains("Space owner"));
        assert!(list_shares(&runtime.0, "default").unwrap().is_empty());
    }

    #[test]
    fn stale_and_duplicate_mutations_are_handled_deterministically() {
        let runtime = TempRuntime::new();
        initialize_space(&runtime.0, "default", &document(0, vec![])).unwrap();
        let request = RuntimeSpaceApplyV1 {
            version: 1,
            space_id: Some("default".into()),
            expected_sequence: 0,
            actor: IdentityRefV1 {
                id: "human:test".into(),
                kind: "human".into(),
            },
            authority_grant_id: None,
            run_id: None,
            idempotency_key: "same-request".into(),
            document: document(0, vec![node("one", 0)]),
        };
        let first = apply_space(&runtime.0, "default", &request).unwrap();
        let duplicate = apply_space(&runtime.0, "default", &request).unwrap();
        assert_eq!(first.sequence, duplicate.sequence);
        let mut stale = request;
        stale.idempotency_key = "different-request".into();
        assert!(apply_space(&runtime.0, "default", &stale)
            .unwrap_err()
            .contains("sequence changed"));
    }
}
