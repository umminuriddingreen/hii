//! Explicit account-to-app linking and bounded workspace synchronization.

use crate::{SessionRow, api_error, hash_token, json_response, now_ms, random_token};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use wasm_bindgen::JsValue;
use worker::{D1Database, Method, Request, Response, Result};

const LINK_TTL_MS: i64 = 15 * 60 * 1000;
const MAX_DOCUMENT_BYTES: usize = 768 * 1024;

#[derive(Deserialize)]
struct LinkedDeviceRow {
    id: String,
    account_id: String,
    handle: String,
    name: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceView {
    id: String,
    name: String,
    created_at: i64,
    last_seen_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RedeemLink {
    code: String,
    device_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteDocument {
    expected_revision: i64,
    document: Value,
}

#[derive(Deserialize)]
struct WorkspaceRow {
    id: String,
    owner_account_id: String,
    name: String,
    document_json: String,
    revision: i64,
    created_at: i64,
    updated_at: i64,
    role: String,
}

#[derive(Deserialize)]
struct WorkspaceListRow {
    id: String,
    owner_account_id: String,
    name: String,
    revision: i64,
    updated_at: i64,
    role: String,
}

pub fn is_account_device_path(path: &str) -> bool {
    path == "/api/devices" || path == "/api/devices/link-codes" || path.starts_with("/api/devices/")
}

pub fn is_native_device_path(path: &str) -> bool {
    path == "/api/device/link"
        || path == "/api/device/workspaces"
        || path.starts_with("/api/device/workspaces/")
}

fn valid_id(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn clean_device_name(value: &str) -> Option<String> {
    let name = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!name.is_empty() && name.chars().count() <= 64).then_some(name)
}

fn valid_document(value: &Value) -> bool {
    value.get("version").and_then(Value::as_i64) == Some(1)
        && value
            .get("nodes")
            .and_then(Value::as_array)
            .is_some_and(|nodes| nodes.len() <= 500)
        && value
            .get("links")
            .and_then(Value::as_array)
            .is_some_and(|links| links.len() <= 1_000)
}

async fn read_json<T: for<'de> Deserialize<'de>>(request: &mut Request) -> Result<T> {
    if request
        .headers()
        .get("content-length")?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_DOCUMENT_BYTES)
    {
        return Err(worker::Error::RustError("body_too_large".into()));
    }
    let bytes = request.bytes().await?;
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(worker::Error::RustError("body_too_large".into()));
    }
    serde_json::from_slice(&bytes).map_err(Into::into)
}

fn document_hash(document: &str) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    URL_SAFE_NO_PAD.encode(Sha256::digest(document.as_bytes()))
}

fn bearer(request: &Request) -> Result<Option<String>> {
    Ok(request
        .headers()
        .get("authorization")?
        .and_then(|value| value.strip_prefix("Bearer ").map(str::to_owned))
        .filter(|value| (32..=256).contains(&value.len())))
}

async fn linked_device(request: &Request, db: &D1Database) -> Result<Option<LinkedDeviceRow>> {
    let Some(token) = bearer(request)? else {
        return Ok(None);
    };
    db.prepare(
        "SELECT d.id, d.account_id, a.handle, d.name
         FROM account_devices d JOIN accounts a ON a.id = d.account_id
         WHERE d.token_hash = ?1 AND d.revoked_at IS NULL LIMIT 1",
    )
    .bind(&[hash_token(&token).as_str().into()])?
    .first(None)
    .await
}

async fn workspace_row(
    db: &D1Database,
    workspace_id: &str,
    account_id: &str,
) -> Result<Option<WorkspaceRow>> {
    db.prepare(
        "SELECT w.id, w.owner_account_id, w.name, w.document_json, w.revision,
                w.created_at, w.updated_at, m.role
         FROM account_workspaces w JOIN workspace_members m ON m.workspace_id = w.id
         WHERE w.id = ?1 AND m.account_id = ?2 AND m.revoked_at IS NULL LIMIT 1",
    )
    .bind(&[workspace_id.into(), account_id.into()])?
    .first(None)
    .await
}

fn workspace_response(status: u16, row: WorkspaceRow) -> Result<Response> {
    let document: Value = serde_json::from_str(&row.document_json)?;
    json_response(
        status,
        json!({ "workspace": {
            "id": row.id,
            "ownerAccountId": row.owner_account_id,
            "name": row.name,
            "role": row.role,
            "revision": row.revision,
            "createdAt": row.created_at,
            "updatedAt": row.updated_at,
            "document": document
        }}),
    )
}

pub async fn handle_account_device_api(
    request: &mut Request,
    db: &D1Database,
    session: &SessionRow,
) -> Result<Response> {
    let path = request.url()?.path().to_owned();
    if matches!(request.method(), Method::Post | Method::Delete)
        && request.headers().get("X-HII-CSRF")?.as_deref() != Some(session.csrf_token.as_str())
    {
        return api_error(403, "csrf_mismatch");
    }

    match (request.method(), path.as_str()) {
        (Method::Post, "/api/devices/link-codes") => {
            let id = random_token()?;
            let code = format!("hii_device_{}", random_token()?);
            let now = now_ms();
            let expires_at = now + LINK_TTL_MS;
            db.prepare(
                "INSERT INTO account_device_link_codes
                 (id, code_hash, account_id, created_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .bind(&[
                id.as_str().into(),
                hash_token(&code).as_str().into(),
                session.account_id.as_str().into(),
                JsValue::from_f64(now as f64),
                JsValue::from_f64(expires_at as f64),
            ])?
            .run()
            .await?;
            json_response(
                201,
                json!({ "code": code, "expiresAt": expires_at, "singleUse": true }),
            )
        }
        (Method::Get, "/api/devices") => {
            let devices = db
                .prepare(
                    "SELECT id, name, created_at, last_seen_at FROM account_devices
                     WHERE account_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC",
                )
                .bind(&[session.account_id.as_str().into()])?
                .all()
                .await?
                .results::<DeviceView>()?;
            json_response(200, json!({ "devices": devices }))
        }
        (Method::Delete, _) => {
            let Some(id) = path.strip_prefix("/api/devices/").filter(|id| valid_id(id)) else {
                return api_error(404, "not_found");
            };
            let changed = db
                .prepare(
                    "UPDATE account_devices SET revoked_at = ?1
                     WHERE id = ?2 AND account_id = ?3 AND revoked_at IS NULL",
                )
                .bind(&[
                    JsValue::from_f64(now_ms() as f64),
                    id.into(),
                    session.account_id.as_str().into(),
                ])?
                .run()
                .await?
                .meta()?
                .and_then(|meta| meta.changes)
                == Some(1);
            if changed {
                json_response(200, json!({ "revoked": true }))
            } else {
                api_error(404, "not_found")
            }
        }
        _ => api_error(404, "not_found"),
    }
}

pub async fn handle_native_device_api(request: &mut Request, db: &D1Database) -> Result<Response> {
    let path = request.url()?.path().to_owned();
    if request.method() == Method::Post && path == "/api/device/link" {
        let input: RedeemLink = read_json(request).await?;
        let code = input.code.trim();
        let Some(name) = clean_device_name(&input.device_name) else {
            return api_error(400, "invalid_device_name");
        };
        if !code.starts_with("hii_device_") || code.len() > 128 {
            return api_error(400, "invalid_link_code");
        }
        let code_hash = hash_token(code);
        let now = now_ms();
        let nonce = random_token()?;
        let token = random_token()?;
        let device_id = random_token()?;
        let results = db
            .batch(vec![
                db.prepare(
                    "UPDATE account_device_link_codes SET redeemed_at = ?1, redemption_nonce = ?2
                     WHERE code_hash = ?3 AND redeemed_at IS NULL AND expires_at > ?1",
                )
                .bind(&[
                    JsValue::from_f64(now as f64),
                    nonce.as_str().into(),
                    code_hash.as_str().into(),
                ])?,
                db.prepare(
                    "INSERT INTO account_devices
                     (id, account_id, name, token_hash, created_at, last_seen_at)
                     SELECT ?1, account_id, ?2, ?3, ?4, ?4 FROM account_device_link_codes
                     WHERE code_hash = ?5 AND redemption_nonce = ?6",
                )
                .bind(&[
                    device_id.as_str().into(),
                    name.as_str().into(),
                    hash_token(&token).as_str().into(),
                    JsValue::from_f64(now as f64),
                    code_hash.as_str().into(),
                    nonce.as_str().into(),
                ])?,
            ])
            .await?;
        let linked = results
            .first()
            .and_then(|result| result.meta().ok().flatten())
            .and_then(|meta| meta.changes)
            == Some(1);
        if !linked {
            return api_error(404, "link_code_unavailable");
        }
        return json_response(201, json!({ "deviceId": device_id, "token": token }));
    }

    let Some(device) = linked_device(request, db).await? else {
        return api_error(401, "authentication_required");
    };
    db.prepare("UPDATE account_devices SET last_seen_at = ?1 WHERE id = ?2")
        .bind(&[
            JsValue::from_f64(now_ms() as f64),
            device.id.as_str().into(),
        ])?
        .run()
        .await?;

    if request.method() == Method::Get && path == "/api/device/workspaces" {
        let rows = db
            .prepare(
                "SELECT w.id, w.owner_account_id, w.name, w.revision, w.updated_at, m.role
                 FROM account_workspaces w JOIN workspace_members m ON m.workspace_id = w.id
                 WHERE m.account_id = ?1 AND m.revoked_at IS NULL
                 ORDER BY w.updated_at DESC, w.id ASC",
            )
            .bind(&[device.account_id.as_str().into()])?
            .all()
            .await?
            .results::<WorkspaceListRow>()?;
        let workspaces = rows
            .into_iter()
            .map(|row| {
                json!({
                    "id": row.id, "ownerAccountId": row.owner_account_id, "name": row.name,
                    "revision": row.revision, "updatedAt": row.updated_at, "role": row.role
                })
            })
            .collect::<Vec<_>>();
        return json_response(
            200,
            json!({
                "device": { "id": device.id, "name": device.name },
                "account": { "handle": device.handle },
                "workspaces": workspaces
            }),
        );
    }

    let Some(rest) = path.strip_prefix("/api/device/workspaces/") else {
        return api_error(404, "not_found");
    };
    let parts = rest.split('/').collect::<Vec<_>>();
    let workspace_id = parts.first().copied().unwrap_or_default();
    if !valid_id(workspace_id) {
        return api_error(404, "not_found");
    }
    if request.method() == Method::Get && parts.len() == 1 {
        let Some(row) = workspace_row(db, workspace_id, &device.account_id).await? else {
            return api_error(404, "not_found");
        };
        return workspace_response(200, row);
    }
    if request.method() == Method::Post && parts.get(1) == Some(&"document") && parts.len() == 2 {
        let input: WriteDocument = read_json(request).await?;
        let Some(current) = workspace_row(db, workspace_id, &device.account_id).await? else {
            return api_error(404, "not_found");
        };
        if !matches!(current.role.as_str(), "owner" | "admin" | "editor") {
            return api_error(403, "workspace_read_only");
        }
        if input.expected_revision < 0 || !valid_document(&input.document) {
            return api_error(400, "invalid_workspace_document");
        }
        let next_revision = input.expected_revision + 1;
        let mut document = input.document;
        if let Some(object) = document.as_object_mut() {
            object.insert("revision".into(), Value::from(next_revision));
        }
        let document_json = document.to_string();
        if document_json.len() > MAX_DOCUMENT_BYTES {
            return api_error(413, "workspace_document_too_large");
        }
        let hash = document_hash(&document_json);
        let nonce = random_token()?;
        let event_id = random_token()?;
        let now = now_ms();
        let results = db
            .batch(vec![
                db.prepare(
                    "UPDATE account_workspaces SET document_json = ?1, document_hash = ?2,
                 revision = ?3, write_nonce = ?4, updated_at = ?5
                 WHERE id = ?6 AND revision = ?7 AND EXISTS (
                   SELECT 1 FROM workspace_members m WHERE m.workspace_id = account_workspaces.id
                   AND m.account_id = ?8 AND m.revoked_at IS NULL
                   AND m.role IN ('owner', 'admin', 'editor'))",
                )
                .bind(&[
                    document_json.as_str().into(),
                    hash.as_str().into(),
                    JsValue::from_f64(next_revision as f64),
                    nonce.as_str().into(),
                    JsValue::from_f64(now as f64),
                    workspace_id.into(),
                    JsValue::from_f64(input.expected_revision as f64),
                    device.account_id.as_str().into(),
                ])?,
                db.prepare(
                    "INSERT INTO workspace_events
                 (id, workspace_id, actor_account_id, kind, revision, detail_json, created_at)
                 SELECT ?1, id, ?2, 'workspace.document.updated', revision, ?3, ?4
                 FROM account_workspaces WHERE id = ?5 AND write_nonce = ?6",
                )
                .bind(&[
                    event_id.as_str().into(),
                    device.account_id.as_str().into(),
                    json!({ "documentHash": hash, "deviceId": device.id })
                        .to_string()
                        .as_str()
                        .into(),
                    JsValue::from_f64(now as f64),
                    workspace_id.into(),
                    nonce.as_str().into(),
                ])?,
            ])
            .await?;
        let updated = results
            .first()
            .and_then(|result| result.meta().ok().flatten())
            .and_then(|meta| meta.changes)
            == Some(1);
        let Some(row) = workspace_row(db, workspace_id, &device.account_id).await? else {
            return api_error(404, "not_found");
        };
        return workspace_response(if updated { 200 } else { 409 }, row);
    }
    api_error(404, "not_found")
}

#[cfg(test)]
mod tests {
    use super::{clean_device_name, valid_document, valid_id};
    use serde_json::json;

    #[test]
    fn device_authority_inputs_are_narrow() {
        assert!(valid_id(&"a".repeat(43)));
        assert!(!valid_id("../device"));
        assert_eq!(
            clean_device_name("  Ummi's   Mac ").as_deref(),
            Some("Ummi's Mac")
        );
        assert!(valid_document(
            &json!({ "version": 1, "nodes": [], "links": [] })
        ));
    }
}
