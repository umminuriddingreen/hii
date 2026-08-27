// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Canonical local HII Runtime contracts for Space objects and events.
//!
//! The canvas is a projection over these records. Legacy Workspace JSON is an
//! import/export surface only; all normal mutations pass through `apply_space`.

use crate::operational::{database, migrate};
use chrono::Utc;
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
                    id: "human:test".into(),
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
                    id: "human:test".into(),
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
