//! Opaque, account-private browser snapshot storage. Plaintext never reaches this worker.

use crate::{api_error, hash_token, json_response, now_ms};
use serde::{Deserialize, Serialize};
use serde_json::json;
use wasm_bindgen::JsValue;
use worker::{D1Database, Env, Method, Request, Response, Result};

const MAX_BODY_BYTES: usize = 768 * 1024;
const MAX_WRAPS: usize = 16;
const ACCOUNT_QUOTA_BYTES: i64 = 1024 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotEnvelope {
    version: u8,
    algorithm: String,
    id: String,
    source_id: String,
    sender_device_id: String,
    created_at: i64,
    nonce: String,
    ciphertext: String,
    recipient_wraps: Vec<RecipientWrap>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecipientWrap {
    device_id: String,
    ephemeral_public_jwk: serde_json::Value,
    nonce: String,
    ciphertext: String,
}

#[derive(Deserialize)]
struct DeviceRow {
    id: String,
    ecdh_public_jwk: String,
    signing_public_jwk: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotRow {
    seq: i64,
    id: String,
    source_id: String,
    sender_device_id: String,
    bytes_used: i64,
    created_at: i64,
    deleted_at: Option<i64>,
}

fn valid_id(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_envelope(envelope: &SnapshotEnvelope) -> bool {
    envelope.version == 1
        && envelope.algorithm == "P256-HKDF-SHA256-A256GCM"
        && valid_id(&envelope.id)
        && valid_id(&envelope.source_id)
        && valid_id(&envelope.sender_device_id)
        && envelope.created_at > 0
        && envelope.nonce.len() == 16
        && !envelope.ciphertext.is_empty()
        && envelope.ciphertext.len() <= MAX_BODY_BYTES
        && (1..=MAX_WRAPS).contains(&envelope.recipient_wraps.len())
        && envelope.recipient_wraps.iter().all(|wrap| {
            valid_id(&wrap.device_id) && wrap.nonce.len() == 16 && !wrap.ciphertext.is_empty()
        })
        && envelope
            .recipient_wraps
            .iter()
            .any(|wrap| wrap.device_id == envelope.sender_device_id)
}

fn object_key(account_id: &str, id: &str) -> String {
    format!("private/browser-snapshots/{account_id}/{id}.json")
}

fn changes(result: &worker::D1Result) -> Result<usize> {
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0))
}

pub fn is_browser_snapshot_path(path: &str) -> bool {
    path == "/api/browser-snapshots" || path.starts_with("/api/browser-snapshots/")
}

pub fn is_native_browser_snapshot_path(path: &str) -> bool {
    path == "/api/device/browser-snapshots/keys"
        || path == "/api/device/browser-snapshots/devices"
        || path == "/api/device/browser-snapshots"
}

#[derive(Deserialize)]
struct NativeDeviceRow {
    id: String,
    account_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegisterNativeKeys {
    ecdh_public_jwk: serde_json::Value,
    signing_public_jwk: serde_json::Value,
}

pub async fn handle_native_browser_snapshot_api(
    request: &mut Request,
    env: &Env,
    db: &D1Database,
) -> Result<Response> {
    let token = request
        .headers()
        .get("authorization")?
        .and_then(|value| value.strip_prefix("Bearer ").map(str::to_owned));
    let Some(token) = token else {
        return api_error(401, "authentication_required");
    };
    let device = db
        .prepare(
            "SELECT id,account_id FROM account_devices WHERE token_hash=?1 AND revoked_at IS NULL",
        )
        .bind(&[hash_token(&token).into()])?
        .first::<NativeDeviceRow>(None)
        .await?;
    let Some(device) = device else {
        return api_error(401, "authentication_required");
    };
    let path = request.url()?.path().to_owned();
    match (request.method(), path.as_str()) {
        (Method::Post, "/api/device/browser-snapshots/keys") => {
            let body = request.bytes().await?;
            if body.len() > 4096 {
                return api_error(413, "body_too_large");
            }
            let keys: RegisterNativeKeys = match serde_json::from_slice(&body) {
                Ok(value) => value,
                Err(_) => return api_error(400, "invalid_keys"),
            };
            let valid = [&keys.ecdh_public_jwk, &keys.signing_public_jwk]
                .iter()
                .all(|jwk| {
                    jwk.get("kty").and_then(|value| value.as_str()) == Some("EC")
                        && jwk.get("crv").and_then(|value| value.as_str()) == Some("P-256")
                        && ["x", "y"].iter().all(|field| {
                            jwk.get(field)
                                .and_then(|value| value.as_str())
                                .is_some_and(|value| value.len() == 43)
                        })
                });
            if !valid {
                return api_error(400, "invalid_keys");
            }
            let ecdh = serde_json::to_string(&keys.ecdh_public_jwk)?;
            let signing = serde_json::to_string(&keys.signing_public_jwk)?;
            db.prepare("INSERT OR IGNORE INTO chat_devices(id,account_id,ecdh_public_jwk,signing_public_jwk,created_at) VALUES (?1,?2,?3,?4,?5)")
                .bind(&[device.id.clone().into(), device.account_id.clone().into(), ecdh.clone().into(), signing.clone().into(), JsValue::from_f64(now_ms() as f64)])?.run().await?;
            let existing = db.prepare("SELECT id,ecdh_public_jwk,signing_public_jwk FROM chat_devices WHERE id=?1 AND account_id=?2 AND revoked_at IS NULL")
                .bind(&[device.id.clone().into(), device.account_id.into()])?.first::<DeviceRow>(None).await?;
            if !existing
                .is_some_and(|row| row.ecdh_public_jwk == ecdh && row.signing_public_jwk == signing)
            {
                return api_error(409, "device_key_conflict");
            }
            json_response(200, json!({"deviceId": device.id}))
        }
        (Method::Get, "/api/device/browser-snapshots/devices") => {
            devices(db, &device.account_id).await
        }
        (Method::Post, "/api/device/browser-snapshots") => {
            // A native link token is bound to one device; the envelope cannot impersonate another.
            upload_for_device(request, env, db, &device.account_id, &device.id).await
        }
        _ => api_error(404, "not_found"),
    }
}

pub async fn handle_browser_snapshot_api(
    request: &mut Request,
    env: &Env,
    db: &D1Database,
    account_id: &str,
    csrf_token: &str,
) -> Result<Response> {
    if matches!(request.method(), Method::Post | Method::Delete)
        && request.headers().get("x-hii-csrf")?.as_deref() != Some(csrf_token)
    {
        return api_error(403, "csrf_denied");
    }
    let url = request.url()?;
    let path = url.path().trim_end_matches('/');
    match (
        request.method(),
        path.strip_prefix("/api/browser-snapshots").unwrap_or(""),
    ) {
        (Method::Get, "/devices") => devices(db, account_id).await,
        (Method::Get, "") => list(request, db, account_id).await,
        (Method::Post, "") => upload(request, env, db, account_id).await,
        (Method::Get, suffix) if suffix.starts_with('/') => {
            download(env, db, account_id, &suffix[1..]).await
        }
        (Method::Delete, suffix) if suffix.starts_with('/') => {
            delete(env, db, account_id, &suffix[1..]).await
        }
        _ => api_error(404, "not_found"),
    }
}

async fn devices(db: &D1Database, account_id: &str) -> Result<Response> {
    let rows = db.prepare("SELECT id,ecdh_public_jwk,signing_public_jwk FROM chat_devices WHERE account_id=?1 AND revoked_at IS NULL AND (NOT EXISTS (SELECT 1 FROM account_devices ad WHERE ad.id=chat_devices.id) OR EXISTS (SELECT 1 FROM account_devices ad WHERE ad.id=chat_devices.id AND ad.revoked_at IS NULL)) ORDER BY created_at")
        .bind(&[account_id.into()])?.all().await?.results::<DeviceRow>()?;
    let devices: Vec<_> = rows.into_iter().filter_map(|row| {
        Some(json!({
            "id": row.id,
            "ecdhPublicJwk": serde_json::from_str::<serde_json::Value>(&row.ecdh_public_jwk).ok()?,
            "signingPublicJwk": serde_json::from_str::<serde_json::Value>(&row.signing_public_jwk).ok()?,
        }))
    }).collect();
    json_response(200, json!({"devices": devices}))
}

async fn list(request: &Request, db: &D1Database, account_id: &str) -> Result<Response> {
    let url = request.url()?;
    let mut after = 0_i64;
    for (key, value) in url.query_pairs() {
        if key != "after" || after != 0 {
            return api_error(400, "invalid_cursor");
        }
        after = match value.parse() {
            Ok(value) if value >= 0 => value,
            _ => return api_error(400, "invalid_cursor"),
        };
    }
    let rows = db.prepare("SELECT seq,id,source_id,sender_device_id,bytes_used,created_at,deleted_at FROM browser_snapshots WHERE account_id=?1 AND seq>?2 ORDER BY seq LIMIT 100")
        .bind(&[account_id.into(), JsValue::from_f64(after as f64)])?.all().await?.results::<SnapshotRow>()?;
    let next = rows.last().map_or(after, |row| row.seq);
    json_response(200, json!({"snapshots": rows, "next": next}))
}

async fn upload(
    request: &mut Request,
    env: &Env,
    db: &D1Database,
    account_id: &str,
) -> Result<Response> {
    upload_inner(request, env, db, account_id, None).await
}

async fn upload_for_device(
    request: &mut Request,
    env: &Env,
    db: &D1Database,
    account_id: &str,
    device_id: &str,
) -> Result<Response> {
    upload_inner(request, env, db, account_id, Some(device_id)).await
}

async fn upload_inner(
    request: &mut Request,
    env: &Env,
    db: &D1Database,
    account_id: &str,
    required_device_id: Option<&str>,
) -> Result<Response> {
    if request
        .headers()
        .get("content-length")?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_BODY_BYTES)
    {
        return api_error(413, "body_too_large");
    }
    let body = request.bytes().await?;
    if body.len() > MAX_BODY_BYTES {
        return api_error(413, "body_too_large");
    }
    let envelope: SnapshotEnvelope = match serde_json::from_slice(&body) {
        Ok(value) if valid_envelope(&value) => value,
        _ => return api_error(400, "invalid_envelope"),
    };
    if required_device_id.is_some_and(|id| id != envelope.sender_device_id) {
        return api_error(403, "device_mismatch");
    }
    let active = db.prepare("SELECT 1 AS present FROM chat_devices WHERE id=?1 AND account_id=?2 AND revoked_at IS NULL")
        .bind(&[envelope.sender_device_id.clone().into(), account_id.into()])?.first::<serde_json::Value>(None).await?.is_some();
    if !active {
        return api_error(403, "device_revoked");
    }
    for wrap in &envelope.recipient_wraps {
        let active = db.prepare("SELECT 1 AS present FROM chat_devices WHERE id=?1 AND account_id=?2 AND revoked_at IS NULL")
            .bind(&[wrap.device_id.clone().into(), account_id.into()])?.first::<serde_json::Value>(None).await?.is_some();
        if !active {
            return api_error(400, "invalid_recipient");
        }
    }
    let existing = db
        .prepare("SELECT 1 AS present FROM browser_snapshots WHERE account_id=?1 AND id=?2")
        .bind(&[account_id.into(), envelope.id.clone().into()])?
        .first::<serde_json::Value>(None)
        .await?
        .is_some();
    if existing {
        return api_error(409, "snapshot_exists");
    }
    let size = body.len() as i64;
    db.prepare("INSERT OR IGNORE INTO browser_snapshot_usage(account_id,bytes_used) VALUES (?1,0)")
        .bind(&[account_id.into()])?
        .run()
        .await?;
    let reserved = db.prepare("UPDATE browser_snapshot_usage SET bytes_used=bytes_used+?1 WHERE account_id=?2 AND bytes_used+?1<=?3")
        .bind(&[JsValue::from_f64(size as f64), account_id.into(), JsValue::from_f64(ACCOUNT_QUOTA_BYTES as f64)])?.run().await?;
    if changes(&reserved)? != 1 {
        return api_error(413, "account_quota_exceeded");
    }
    let bucket = env.bucket("DOWNLOADS")?;
    let key = object_key(account_id, &envelope.id);
    if let Err(error) = bucket.put(&key, body).execute().await {
        refund(db, account_id, size).await?;
        return Err(error);
    }
    let inserted = db.prepare("INSERT OR IGNORE INTO browser_snapshots(id,account_id,source_id,sender_device_id,bytes_used,created_at) VALUES (?1,?2,?3,?4,?5,?6)")
        .bind(&[
            envelope.id.clone().into(), account_id.into(), envelope.source_id.into(),
            envelope.sender_device_id.into(), JsValue::from_f64(size as f64), JsValue::from_f64(envelope.created_at as f64),
        ])?.run().await;
    match inserted {
        Ok(result) if changes(&result)? == 1 => {
            json_response(201, json!({"id": envelope.id, "bytesUsed": size}))
        }
        _ => {
            bucket.delete(&key).await?;
            refund(db, account_id, size).await?;
            api_error(409, "snapshot_exists")
        }
    }
}

async fn download(env: &Env, db: &D1Database, account_id: &str, id: &str) -> Result<Response> {
    if !valid_id(id) {
        return api_error(404, "not_found");
    }
    let row = db.prepare("SELECT 1 AS present FROM browser_snapshots WHERE account_id=?1 AND id=?2 AND deleted_at IS NULL")
        .bind(&[account_id.into(), id.into()])?.first::<serde_json::Value>(None).await?;
    if row.is_none() {
        return api_error(404, "not_found");
    }
    let Some(object) = env
        .bucket("DOWNLOADS")?
        .get(object_key(account_id, id))
        .execute()
        .await?
    else {
        return api_error(404, "snapshot_blob_missing");
    };
    let Some(body) = object.body() else {
        return api_error(502, "snapshot_blob_invalid");
    };
    let mut response = Response::from_body(body.response_body()?)?;
    response
        .headers_mut()
        .set("Content-Type", "application/json; charset=utf-8")?;
    Ok(response)
}

async fn delete(env: &Env, db: &D1Database, account_id: &str, id: &str) -> Result<Response> {
    if !valid_id(id) {
        return api_error(404, "not_found");
    }
    let row = db.prepare("SELECT seq,id,source_id,sender_device_id,bytes_used,created_at,deleted_at FROM browser_snapshots WHERE account_id=?1 AND id=?2 AND deleted_at IS NULL")
        .bind(&[account_id.into(), id.into()])?.first::<SnapshotRow>(None).await?;
    let Some(row) = row else {
        return api_error(404, "not_found");
    };
    let now = now_ms();
    // Move the row past every earlier cursor so incremental readers see the tombstone.
    let result = db.prepare("UPDATE browser_snapshots SET seq=(SELECT COALESCE(MAX(seq),0)+1 FROM browser_snapshots),deleted_at=?1,bytes_used=0 WHERE account_id=?2 AND id=?3 AND deleted_at IS NULL")
        .bind(&[JsValue::from_f64(now as f64), account_id.into(), id.into()])?.run().await?;
    if changes(&result)? != 1 {
        return api_error(409, "snapshot_changed");
    }
    refund(db, account_id, row.bytes_used).await?;
    env.bucket("DOWNLOADS")?
        .delete(object_key(account_id, id))
        .await?;
    json_response(200, json!({"deleted": true, "id": id}))
}

async fn refund(db: &D1Database, account_id: &str, size: i64) -> Result<()> {
    db.prepare(
        "UPDATE browser_snapshot_usage SET bytes_used=MAX(0,bytes_used-?1) WHERE account_id=?2",
    )
    .bind(&[JsValue::from_f64(size as f64), account_id.into()])?
    .run()
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_ids_and_envelopes_are_bounded() {
        assert!(valid_id(&"a".repeat(43)));
        assert!(!valid_id("../private"));
        assert_eq!(
            object_key("account", &"a".repeat(43)),
            format!("private/browser-snapshots/account/{}.json", "a".repeat(43))
        );
    }
}
