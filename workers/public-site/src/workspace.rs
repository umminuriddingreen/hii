//! Account-owned business workspaces and explicit delegated studio access.

use crate::{SessionRow, api_error, hash_token, json_response, now_ms, random_token};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use wasm_bindgen::JsValue;
use worker::{D1Database, Method, Request, Response, Result};

const MAX_DOCUMENT_BYTES: usize = 768 * 1024;
const MAX_WORKSPACES_PER_ACCOUNT: i64 = 100;
const MAX_SHARE_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;

pub fn is_workspace_api_path(path: &str) -> bool {
    path == "/api/workspaces" || path.starts_with("/api/workspaces/")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateWorkspace {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteDocument {
    expected_revision: i64,
    document: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateShareCode {
    role: Option<String>,
    ttl_seconds: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RedeemShareCode {
    code: String,
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
struct AccessRow {
    role: String,
}

#[derive(Deserialize)]
struct ShareRow {
    id: String,
    workspace_id: String,
    owner_account_id: String,
    role: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemberRow {
    account_id: String,
    handle: String,
    role: String,
    granted_by: String,
    created_at: i64,
}

fn valid_workspace_id(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn clean_name(value: &str) -> Option<String> {
    let name = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!name.is_empty() && name.chars().count() <= 80).then_some(name)
}

fn writable(role: &str) -> bool {
    matches!(role, "owner" | "admin" | "editor")
}

fn share_role(value: Option<&str>) -> Option<&'static str> {
    match value.unwrap_or("admin") {
        "admin" => Some("admin"),
        "editor" => Some("editor"),
        "viewer" => Some("viewer"),
        _ => None,
    }
}

fn document_hash(document: &str) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    URL_SAFE_NO_PAD.encode(Sha256::digest(document.as_bytes()))
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

async fn access(
    db: &D1Database,
    workspace_id: &str,
    account_id: &str,
) -> Result<Option<AccessRow>> {
    db.prepare(
        "SELECT role FROM workspace_members
         WHERE workspace_id = ?1 AND account_id = ?2 AND revoked_at IS NULL LIMIT 1",
    )
    .bind(&[workspace_id.into(), account_id.into()])?
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
         FROM account_workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id
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
        json!({
            "workspace": {
                "id": row.id,
                "ownerAccountId": row.owner_account_id,
                "name": row.name,
                "role": row.role,
                "revision": row.revision,
                "createdAt": row.created_at,
                "updatedAt": row.updated_at,
                "document": document
            }
        }),
    )
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

fn event_detail(value: Value) -> String {
    let mut text = value.to_string();
    text.truncate(4096);
    text
}

pub async fn handle_workspace_api(
    request: &mut Request,
    db: &D1Database,
    session: &SessionRow,
) -> Result<Response> {
    let path = request.url()?.path().to_owned();
    let method = request.method();
    if matches!(method, Method::Post | Method::Delete)
        && request.headers().get("X-HII-CSRF")?.as_deref() != Some(session.csrf_token.as_str())
    {
        return api_error(403, "csrf_mismatch");
    }

    if method == Method::Get && path == "/api/workspaces" {
        let rows = db
            .prepare(
                "SELECT w.id, w.owner_account_id, w.name, w.revision, w.updated_at, m.role
                 FROM account_workspaces w
                 JOIN workspace_members m ON m.workspace_id = w.id
                 WHERE m.account_id = ?1 AND m.revoked_at IS NULL
                 ORDER BY w.updated_at DESC, w.id ASC",
            )
            .bind(&[session.account_id.as_str().into()])?
            .all()
            .await?
            .results::<WorkspaceListRow>()?;
        let workspaces = rows
            .into_iter()
            .map(|row| {
                json!({
                    "id": row.id,
                    "ownerAccountId": row.owner_account_id,
                    "name": row.name,
                    "revision": row.revision,
                    "updatedAt": row.updated_at,
                    "role": row.role
                })
            })
            .collect::<Vec<_>>();
        return json_response(200, json!({ "workspaces": workspaces }));
    }

    if method == Method::Post && path == "/api/workspaces" {
        let input: CreateWorkspace = read_json(request).await?;
        let Some(name) = clean_name(&input.name) else {
            return api_error(400, "invalid_workspace_name");
        };
        let count = db
            .prepare(
                "SELECT COUNT(*) AS count FROM workspace_members
                 WHERE account_id = ?1 AND revoked_at IS NULL",
            )
            .bind(&[session.account_id.as_str().into()])?
            .first::<Value>(None)
            .await?
            .and_then(|row| row.get("count").and_then(Value::as_i64))
            .unwrap_or(0);
        if count >= MAX_WORKSPACES_PER_ACCOUNT {
            return api_error(409, "workspace_limit_reached");
        }
        let id = random_token()?;
        let nonce = random_token()?;
        let event_id = random_token()?;
        let now = now_ms();
        let document = json!({
            "version": 1,
            "revision": 0,
            "updatedAt": now.to_string(),
            "viewport": { "x": 0, "y": 0, "zoom": 1 },
            "nextZ": 1,
            "nodes": [],
            "links": []
        });
        let document_json = document.to_string();
        let hash = document_hash(&document_json);
        db.batch(vec![
            db.prepare(
                "INSERT INTO account_workspaces
                 (id, owner_account_id, name, document_json, document_hash, revision, write_nonce, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?7)",
            )
            .bind(&[
                id.as_str().into(),
                session.account_id.as_str().into(),
                name.as_str().into(),
                document_json.as_str().into(),
                hash.as_str().into(),
                nonce.as_str().into(),
                JsValue::from_f64(now as f64),
            ])?,
            db.prepare(
                "INSERT INTO workspace_members
                 (workspace_id, account_id, role, granted_by, created_at)
                 VALUES (?1, ?2, 'owner', ?2, ?3)",
            )
            .bind(&[
                id.as_str().into(),
                session.account_id.as_str().into(),
                JsValue::from_f64(now as f64),
            ])?,
            db.prepare(
                "INSERT INTO workspace_events
                 (id, workspace_id, actor_account_id, kind, revision, detail_json, created_at)
                 VALUES (?1, ?2, ?3, 'workspace.created', 0, ?4, ?5)",
            )
            .bind(&[
                event_id.as_str().into(),
                id.as_str().into(),
                session.account_id.as_str().into(),
                event_detail(json!({ "name": name })).as_str().into(),
                JsValue::from_f64(now as f64),
            ])?,
        ])
        .await?;
        let row = workspace_row(db, &id, &session.account_id)
            .await?
            .ok_or_else(|| worker::Error::RustError("workspace_create_failed".into()))?;
        return workspace_response(201, row);
    }

    if method == Method::Post && path == "/api/workspaces/share-codes/redeem" {
        let input: RedeemShareCode = read_json(request).await?;
        let code = input.code.trim();
        if !code.starts_with("hii_ws_") || code.len() > 96 {
            return api_error(400, "invalid_share_code");
        }
        let code_hash = hash_token(code);
        let now = now_ms();
        let Some(share) = db
            .prepare(
                "SELECT s.id, s.workspace_id, w.owner_account_id, s.role
                 FROM workspace_share_codes s
                 JOIN account_workspaces w ON w.id = s.workspace_id
                 WHERE s.code_hash = ?1 AND s.redeemed_at IS NULL
                   AND s.revoked_at IS NULL AND s.expires_at > ?2 LIMIT 1",
            )
            .bind(&[code_hash.as_str().into(), JsValue::from_f64(now as f64)])?
            .first::<ShareRow>(None)
            .await?
        else {
            return api_error(404, "share_code_unavailable");
        };
        if share.owner_account_id == session.account_id {
            return api_error(409, "workspace_owner_already_has_access");
        }
        let nonce = random_token()?;
        let event_id = random_token()?;
        let results = db
            .batch(vec![
                db.prepare(
                    "UPDATE workspace_share_codes
                     SET redeemed_by = ?1, redeemed_at = ?2, redemption_nonce = ?3
                     WHERE code_hash = ?4 AND redeemed_at IS NULL
                       AND revoked_at IS NULL AND expires_at > ?2",
                )
                .bind(&[
                    session.account_id.as_str().into(),
                    JsValue::from_f64(now as f64),
                    nonce.as_str().into(),
                    code_hash.as_str().into(),
                ])?,
                db.prepare(
                    "INSERT INTO workspace_members
                     (workspace_id, account_id, role, granted_by, created_at, revoked_at)
                     SELECT workspace_id, ?1, role, created_by, ?2, NULL
                     FROM workspace_share_codes WHERE code_hash = ?3 AND redemption_nonce = ?4
                     ON CONFLICT(workspace_id, account_id) DO UPDATE SET
                       role = excluded.role, granted_by = excluded.granted_by,
                       created_at = excluded.created_at, revoked_at = NULL
                     WHERE workspace_members.role <> 'owner'",
                )
                .bind(&[
                    session.account_id.as_str().into(),
                    JsValue::from_f64(now as f64),
                    code_hash.as_str().into(),
                    nonce.as_str().into(),
                ])?,
                db.prepare(
                    "INSERT INTO workspace_events
                     (id, workspace_id, actor_account_id, kind, revision, detail_json, created_at)
                     SELECT ?1, s.workspace_id, ?2, 'workspace.share.redeemed', w.revision, ?3, ?4
                     FROM workspace_share_codes s JOIN account_workspaces w ON w.id = s.workspace_id
                     WHERE s.code_hash = ?5 AND s.redemption_nonce = ?6",
                )
                .bind(&[
                    event_id.as_str().into(),
                    session.account_id.as_str().into(),
                    event_detail(json!({ "shareId": share.id, "role": share.role }))
                        .as_str()
                        .into(),
                    JsValue::from_f64(now as f64),
                    code_hash.as_str().into(),
                    nonce.as_str().into(),
                ])?,
            ])
            .await?;
        let redeemed = results
            .first()
            .and_then(|result| result.meta().ok().flatten())
            .and_then(|meta| meta.changes)
            == Some(1);
        if !redeemed {
            return api_error(404, "share_code_unavailable");
        }
        let row = workspace_row(db, &share.workspace_id, &session.account_id)
            .await?
            .ok_or_else(|| worker::Error::RustError("workspace_grant_failed".into()))?;
        return workspace_response(200, row);
    }

    let Some(rest) = path.strip_prefix("/api/workspaces/") else {
        return api_error(404, "not_found");
    };
    let parts = rest.split('/').collect::<Vec<_>>();
    let workspace_id = parts.first().copied().unwrap_or_default();
    if !valid_workspace_id(workspace_id) {
        return api_error(404, "not_found");
    }

    if method == Method::Get && parts.len() == 1 {
        let Some(row) = workspace_row(db, workspace_id, &session.account_id).await? else {
            return api_error(404, "not_found");
        };
        return workspace_response(200, row);
    }

    if method == Method::Post && parts.get(1) == Some(&"document") && parts.len() == 2 {
        let Some(current_access) = access(db, workspace_id, &session.account_id).await? else {
            return api_error(404, "not_found");
        };
        if !writable(&current_access.role) {
            return api_error(403, "workspace_read_only");
        }
        let input: WriteDocument = read_json(request).await?;
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
                    "UPDATE account_workspaces
                     SET document_json = ?1, document_hash = ?2, revision = ?3,
                         write_nonce = ?4, updated_at = ?5
                     WHERE id = ?6 AND revision = ?7
                       AND EXISTS (
                         SELECT 1 FROM workspace_members m
                         WHERE m.workspace_id = account_workspaces.id
                           AND m.account_id = ?8 AND m.revoked_at IS NULL
                           AND m.role IN ('owner', 'admin', 'editor')
                       )",
                )
                .bind(&[
                    document_json.as_str().into(),
                    hash.as_str().into(),
                    JsValue::from_f64(next_revision as f64),
                    nonce.as_str().into(),
                    JsValue::from_f64(now as f64),
                    workspace_id.into(),
                    JsValue::from_f64(input.expected_revision as f64),
                    session.account_id.as_str().into(),
                ])?,
                db.prepare(
                    "INSERT INTO workspace_events
                     (id, workspace_id, actor_account_id, kind, revision, detail_json, created_at)
                     SELECT ?1, id, ?2, 'workspace.document.updated', revision, ?3, ?4
                     FROM account_workspaces WHERE id = ?5 AND write_nonce = ?6",
                )
                .bind(&[
                    event_id.as_str().into(),
                    session.account_id.as_str().into(),
                    event_detail(json!({ "documentHash": hash }))
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
        let Some(row) = workspace_row(db, workspace_id, &session.account_id).await? else {
            return api_error(404, "not_found");
        };
        return workspace_response(if updated { 200 } else { 409 }, row);
    }

    if method == Method::Post && parts.get(1) == Some(&"share-codes") && parts.len() == 2 {
        let Some(current_access) = access(db, workspace_id, &session.account_id).await? else {
            return api_error(404, "not_found");
        };
        if current_access.role != "owner" {
            return api_error(403, "workspace_owner_required");
        }
        let input: CreateShareCode = read_json(request).await?;
        let Some(role) = share_role(input.role.as_deref()) else {
            return api_error(400, "invalid_workspace_role");
        };
        let ttl = input
            .ttl_seconds
            .unwrap_or(15 * 60)
            .clamp(60, MAX_SHARE_TTL_SECONDS);
        let code = format!("hii_ws_{}", random_token()?);
        let code_hash = hash_token(&code);
        let share_id = random_token()?;
        let event_id = random_token()?;
        let now = now_ms();
        let expires_at = now + ttl * 1000;
        db.batch(vec![
            db.prepare(
                "INSERT INTO workspace_share_codes
                 (id, code_hash, workspace_id, role, created_by, created_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .bind(&[
                share_id.as_str().into(),
                code_hash.as_str().into(),
                workspace_id.into(),
                role.into(),
                session.account_id.as_str().into(),
                JsValue::from_f64(now as f64),
                JsValue::from_f64(expires_at as f64),
            ])?,
            db.prepare(
                "INSERT INTO workspace_events
                 (id, workspace_id, actor_account_id, kind, revision, detail_json, created_at)
                 SELECT ?1, id, ?2, 'workspace.share.created', revision, ?3, ?4
                 FROM account_workspaces WHERE id = ?5",
            )
            .bind(&[
                event_id.as_str().into(),
                session.account_id.as_str().into(),
                event_detail(json!({ "shareId": share_id, "role": role, "expiresAt": expires_at }))
                    .as_str()
                    .into(),
                JsValue::from_f64(now as f64),
                workspace_id.into(),
            ])?,
        ])
        .await?;
        return json_response(
            201,
            json!({
                "shareId": share_id,
                "code": code,
                "workspaceId": workspace_id,
                "role": role,
                "expiresAt": expires_at,
                "singleUse": true
            }),
        );
    }

    if method == Method::Get && parts.get(1) == Some(&"members") && parts.len() == 2 {
        let Some(current_access) = access(db, workspace_id, &session.account_id).await? else {
            return api_error(404, "not_found");
        };
        if !matches!(current_access.role.as_str(), "owner" | "admin") {
            return api_error(403, "workspace_admin_required");
        }
        let members = db
            .prepare(
                "SELECT m.account_id, a.handle, m.role, m.granted_by, m.created_at
                 FROM workspace_members m JOIN accounts a ON a.id = m.account_id
                 WHERE m.workspace_id = ?1 AND m.revoked_at IS NULL
                 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                          m.created_at ASC",
            )
            .bind(&[workspace_id.into()])?
            .all()
            .await?
            .results::<MemberRow>()?;
        return json_response(200, json!({ "members": members }));
    }

    if method == Method::Delete && parts.get(1) == Some(&"members") && parts.len() == 3 {
        let Some(current_access) = access(db, workspace_id, &session.account_id).await? else {
            return api_error(404, "not_found");
        };
        if current_access.role != "owner" {
            return api_error(403, "workspace_owner_required");
        }
        let member_id = parts[2];
        if member_id == session.account_id {
            return api_error(409, "workspace_owner_cannot_be_revoked");
        }
        let now = now_ms();
        let result = db
            .prepare(
                "UPDATE workspace_members SET revoked_at = ?1
                 WHERE workspace_id = ?2 AND account_id = ?3
                   AND role <> 'owner' AND revoked_at IS NULL",
            )
            .bind(&[
                JsValue::from_f64(now as f64),
                workspace_id.into(),
                member_id.into(),
            ])?
            .run()
            .await?;
        let changed = result
            .meta()?
            .and_then(|meta| meta.changes)
            .is_some_and(|changes| changes == 1);
        if !changed {
            return api_error(404, "workspace_member_not_found");
        }
        let event_id = random_token()?;
        db.prepare(
            "INSERT INTO workspace_events
             (id, workspace_id, actor_account_id, kind, revision, detail_json, created_at)
             SELECT ?1, id, ?2, 'workspace.member.revoked', revision, ?3, ?4
             FROM account_workspaces WHERE id = ?5",
        )
        .bind(&[
            event_id.as_str().into(),
            session.account_id.as_str().into(),
            event_detail(json!({ "accountId": member_id }))
                .as_str()
                .into(),
            JsValue::from_f64(now as f64),
            workspace_id.into(),
        ])?
        .run()
        .await?;
        return json_response(200, json!({ "revoked": true }));
    }

    api_error(404, "not_found")
}

#[cfg(test)]
mod tests {
    use super::{clean_name, share_role, valid_document, valid_workspace_id, writable};
    use serde_json::json;

    #[test]
    fn roles_keep_ownership_and_execution_separate() {
        assert!(writable("owner"));
        assert!(writable("admin"));
        assert!(writable("editor"));
        assert!(!writable("viewer"));
        assert_eq!(share_role(None), Some("admin"));
        assert_eq!(share_role(Some("owner")), None);
    }

    #[test]
    fn workspace_inputs_are_bounded() {
        assert!(valid_workspace_id(&"a".repeat(43)));
        assert!(!valid_workspace_id("../workspace"));
        assert_eq!(
            clean_name("  Goetia   operations ").as_deref(),
            Some("Goetia operations")
        );
        assert!(valid_document(
            &json!({ "version": 1, "nodes": [], "links": [] })
        ));
        assert!(!valid_document(
            &json!({ "version": 2, "nodes": [], "links": [] })
        ));
    }
}
