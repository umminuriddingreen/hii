use std::collections::HashSet;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wasm_bindgen::JsValue;
use worker::{D1Database, Date, Method, Request, Response, Result};

pub const MESSAGE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES: usize = 32 * 1024;
const MAX_ENVELOPE_BYTES: usize = 16 * 1024;
const MAX_RECIPIENT_WRAPS: usize = 16;
const MAX_CLOCK_SKEW_MS: i64 = 15 * 60 * 1000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegisterDeviceInput {
    ecdh_public_jwk: PublicJwk,
    signing_public_jwk: PublicJwk,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PublicJwk {
    kty: String,
    crv: String,
    x: String,
    y: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateConversationInput {
    recipient_handle: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendMessageInput {
    id: String,
    sender_device_id: String,
    envelope: MessageEnvelope,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MessageEnvelope {
    version: u8,
    algorithm: String,
    conversation_id: String,
    message_id: String,
    sender_device_id: String,
    client_created_at: i64,
    nonce: String,
    ciphertext: String,
    signature: String,
    recipient_wraps: Vec<RecipientWrap>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecipientWrap {
    device_id: String,
    ephemeral_public_jwk: PublicJwk,
    nonce: String,
    ciphertext: String,
}

#[derive(Deserialize)]
struct DeviceOwnerRow {
    account_id: String,
    signing_public_jwk: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationRow {
    id: String,
    created_at: i64,
    state: String,
    other_account_id: String,
    other_handle: String,
    other_state: String,
}

#[derive(Deserialize)]
struct DeviceRow {
    id: String,
    account_id: String,
    ecdh_public_jwk: String,
    signing_public_jwk: String,
    revoked_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceResponse {
    id: String,
    account_id: String,
    ecdh_public_jwk: Value,
    signing_public_jwk: Value,
    active: bool,
}

#[derive(Deserialize)]
struct MessageRow {
    seq: i64,
    id: String,
    sender_account_id: String,
    sender_device_id: String,
    envelope_json: String,
    created_at: i64,
    expires_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageResponse {
    seq: i64,
    id: String,
    sender_account_id: String,
    sender_device_id: String,
    envelope: Value,
    created_at: i64,
    expires_at: i64,
}

#[derive(Deserialize)]
struct CountRow {
    count: i64,
}

enum InputError {
    Invalid,
    TooLarge,
}

/// Handles authenticated chat routes. The caller must first enforce the exact
/// HII origin and pass an account ID and CSRF token from an active session.
/// `None` means the path is not owned by this module.
pub async fn handle_chat_api(
    request: &mut Request,
    db: &D1Database,
    account_id: &str,
    csrf_token: &str,
    passkey_recent: bool,
) -> Result<Option<Response>> {
    let url = request.url()?;
    let path = url.path().trim_end_matches('/');
    if !path.starts_with("/api/chat") {
        return Ok(None);
    }

    if matches!(request.method(), Method::Post | Method::Delete)
        && !csrf_allowed(request, csrf_token)?
    {
        return Ok(Some(api_error(403, "csrf_denied")?));
    }

    let now = now_ms();
    purge_expired_messages(db, now).await?;

    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    let response = match (request.method(), segments.as_slice()) {
        (Method::Post, ["api", "chat", "devices"]) => {
            if passkey_recent {
                register_device(request, db, account_id, now).await
            } else {
                api_error(403, "passkey_step_up_required")
            }
        }
        (Method::Delete, ["api", "chat", "devices", device_id]) => {
            revoke_device(db, account_id, device_id, now).await
        }
        (Method::Get, ["api", "chat", "conversations"]) => list_conversations(db, account_id).await,
        (Method::Post, ["api", "chat", "conversations"]) => {
            create_conversation(request, db, account_id, now).await
        }
        (Method::Post, ["api", "chat", "conversations", conversation_id, "accept"]) => {
            accept_conversation(db, account_id, conversation_id, now).await
        }
        (Method::Get, ["api", "chat", "conversations", conversation_id, "devices"]) => {
            list_devices(db, account_id, conversation_id, now).await
        }
        (Method::Get, ["api", "chat", "conversations", conversation_id, "messages"]) => {
            list_messages(db, account_id, conversation_id, &url, now).await
        }
        (Method::Post, ["api", "chat", "conversations", conversation_id, "messages"]) => {
            send_message(request, db, account_id, conversation_id, now).await
        }
        (Method::Delete, ["api", "chat", "messages", message_id]) => {
            delete_message(db, account_id, message_id).await
        }
        _ => api_error(404, "not_found"),
    }?;
    Ok(Some(response))
}

pub async fn purge_expired_messages(db: &D1Database, now: i64) -> Result<usize> {
    let results = db
        .batch(vec![
            db.prepare("DELETE FROM chat_messages WHERE seq IN (SELECT seq FROM chat_messages WHERE expires_at <= ?1 ORDER BY expires_at LIMIT 500)")
                .bind(&[JsValue::from_f64(now as f64)])?,
            db.prepare("DELETE FROM chat_rate_limits WHERE expires_at <= ?1")
                .bind(&[JsValue::from_f64(now as f64)])?,
        ])
        .await?;
    results
        .first()
        .map(changes)
        .transpose()
        .map(|value| value.unwrap_or(0))
}

async fn register_device(
    request: &mut Request,
    db: &D1Database,
    account_id: &str,
    now: i64,
) -> Result<Response> {
    if !rate_limit(db, account_id, "device-register", now, 60 * 60 * 1000, 5).await? {
        return api_error(429, "rate_limited");
    }
    let input: RegisterDeviceInput = match read_json(request).await? {
        Ok(value) => value,
        Err(InputError::Invalid) => return api_error(400, "invalid_request"),
        Err(InputError::TooLarge) => return api_error(413, "body_too_large"),
    };
    if !valid_public_jwk(&input.ecdh_public_jwk) || !valid_public_jwk(&input.signing_public_jwk) {
        return api_error(400, "invalid_device_key");
    }
    let device_id = random_id()?;
    let ecdh = serde_json::to_string(&input.ecdh_public_jwk)?;
    let signing = serde_json::to_string(&input.signing_public_jwk)?;
    db.prepare("INSERT INTO chat_devices (id, account_id, ecdh_public_jwk, signing_public_jwk, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(&[
            JsValue::from_str(&device_id),
            JsValue::from_str(account_id),
            JsValue::from_str(&ecdh),
            JsValue::from_str(&signing),
            JsValue::from_f64(now as f64),
        ])?
        .run()
        .await?;
    json_response(201, json!({ "deviceId": device_id }))
}

async fn revoke_device(
    db: &D1Database,
    account_id: &str,
    device_id: &str,
    now: i64,
) -> Result<Response> {
    if !valid_id(device_id) {
        return api_error(404, "not_found");
    }
    let result = db
        .prepare("UPDATE chat_devices SET revoked_at = ?1 WHERE id = ?2 AND account_id = ?3 AND revoked_at IS NULL")
        .bind(&[
            JsValue::from_f64(now as f64),
            JsValue::from_str(device_id),
            JsValue::from_str(account_id),
        ])?
        .run()
        .await?;
    if changes(&result)? != 1 {
        return api_error(404, "not_found");
    }
    json_response(200, json!({ "revoked": true }))
}

async fn create_conversation(
    request: &mut Request,
    db: &D1Database,
    account_id: &str,
    now: i64,
) -> Result<Response> {
    if !rate_limit(
        db,
        account_id,
        "conversation-create",
        now,
        60 * 60 * 1000,
        5,
    )
    .await?
    {
        return api_error(429, "rate_limited");
    }
    let input: CreateConversationInput = match read_json(request).await? {
        Ok(value) => value,
        Err(InputError::Invalid) => return api_error(400, "invalid_request"),
        Err(InputError::TooLarge) => return api_error(413, "body_too_large"),
    };
    let Some(handle) = normalize_handle(&input.recipient_handle) else {
        return api_error(400, "invalid_handle");
    };
    let recipient: Option<String> = db
        .prepare("SELECT id FROM accounts WHERE handle = ?1 LIMIT 1")
        .bind(&[JsValue::from_str(&handle)])?
        .first(Some("id"))
        .await?;
    let Some(recipient_id) = recipient.filter(|id| id != account_id) else {
        return api_error(404, "account_not_found");
    };
    let conversation_id = random_id()?;
    db.batch(vec![
        db.prepare("INSERT INTO chat_conversations (id, created_by, created_at) VALUES (?1, ?2, ?3)")
            .bind(&[
                JsValue::from_str(&conversation_id),
                JsValue::from_str(account_id),
                JsValue::from_f64(now as f64),
            ])?,
        db.prepare("INSERT INTO chat_members (conversation_id, account_id, state, created_at, accepted_at) VALUES (?1, ?2, 'active', ?3, ?3)")
            .bind(&[
                JsValue::from_str(&conversation_id),
                JsValue::from_str(account_id),
                JsValue::from_f64(now as f64),
            ])?,
        db.prepare("INSERT INTO chat_members (conversation_id, account_id, state, created_at) VALUES (?1, ?2, 'invited', ?3)")
            .bind(&[
                JsValue::from_str(&conversation_id),
                JsValue::from_str(&recipient_id),
                JsValue::from_f64(now as f64),
            ])?,
    ])
    .await?;
    json_response(
        201,
        json!({ "conversationId": conversation_id, "state": "pending" }),
    )
}

async fn accept_conversation(
    db: &D1Database,
    account_id: &str,
    conversation_id: &str,
    now: i64,
) -> Result<Response> {
    if !valid_id(conversation_id) {
        return api_error(404, "not_found");
    }
    let result = db
        .prepare("UPDATE chat_members SET state = 'active', accepted_at = ?1 WHERE conversation_id = ?2 AND account_id = ?3 AND state = 'invited'")
        .bind(&[
            JsValue::from_f64(now as f64),
            JsValue::from_str(conversation_id),
            JsValue::from_str(account_id),
        ])?
        .run()
        .await?;
    if changes(&result)? != 1 {
        return api_error(404, "not_found");
    }
    json_response(200, json!({ "accepted": true }))
}

async fn list_conversations(db: &D1Database, account_id: &str) -> Result<Response> {
    let result = db
        .prepare("SELECT c.id, c.created_at, mine.state, other.account_id AS other_account_id, a.handle AS other_handle, other.state AS other_state FROM chat_conversations c JOIN chat_members mine ON mine.conversation_id = c.id AND mine.account_id = ?1 JOIN chat_members other ON other.conversation_id = c.id AND other.account_id != ?1 JOIN accounts a ON a.id = other.account_id WHERE mine.state != 'left' ORDER BY c.created_at DESC LIMIT 100")
        .bind(&[JsValue::from_str(account_id)])?
        .all()
        .await?;
    json_response(
        200,
        json!({ "conversations": result.results::<ConversationRow>()? }),
    )
}

async fn list_devices(
    db: &D1Database,
    account_id: &str,
    conversation_id: &str,
    now: i64,
) -> Result<Response> {
    if !active_member(db, account_id, conversation_id).await? {
        return api_error(404, "not_found");
    }
    let result = db
        .prepare("SELECT d.id, d.account_id, d.ecdh_public_jwk, d.signing_public_jwk, d.revoked_at FROM chat_devices d JOIN chat_members m ON m.account_id = d.account_id WHERE m.conversation_id = ?1 AND m.state = 'active' AND (d.revoked_at IS NULL OR EXISTS (SELECT 1 FROM chat_messages msg WHERE msg.conversation_id = ?1 AND msg.sender_device_id = d.id AND msg.expires_at > ?2)) ORDER BY d.created_at")
        .bind(&[
            JsValue::from_str(conversation_id),
            JsValue::from_f64(now as f64),
        ])?
        .all()
        .await?;
    let devices = result
        .results::<DeviceRow>()?
        .into_iter()
        .map(|row| {
            Ok(DeviceResponse {
                id: row.id,
                account_id: row.account_id,
                ecdh_public_jwk: serde_json::from_str(&row.ecdh_public_jwk)?,
                signing_public_jwk: serde_json::from_str(&row.signing_public_jwk)?,
                active: row.revoked_at.is_none(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    json_response(200, json!({ "devices": devices }))
}

async fn send_message(
    request: &mut Request,
    db: &D1Database,
    account_id: &str,
    conversation_id: &str,
    now: i64,
) -> Result<Response> {
    if !valid_id(conversation_id)
        || !active_member(db, account_id, conversation_id).await?
        || !all_members_active(db, conversation_id).await?
    {
        return api_error(404, "not_found");
    }
    if !rate_limit(db, account_id, "message-send", now, 60 * 1000, 30).await?
        || !rate_limit(db, account_id, "message-send-day", now, MESSAGE_TTL_MS, 500).await?
    {
        return api_error(429, "rate_limited");
    }
    let input: SendMessageInput = match read_json(request).await? {
        Ok(value) => value,
        Err(InputError::Invalid) => return api_error(400, "invalid_request"),
        Err(InputError::TooLarge) => return api_error(413, "body_too_large"),
    };
    if !valid_id(&input.id)
        || !valid_id(&input.sender_device_id)
        || !valid_envelope(
            &input.envelope,
            &input.id,
            conversation_id,
            &input.sender_device_id,
            now,
        )
    {
        return api_error(400, "invalid_envelope");
    }
    let Some(sender_device) = device_owner(db, &input.sender_device_id, conversation_id).await?
    else {
        return api_error(403, "device_denied");
    };
    if sender_device.account_id != account_id {
        return api_error(403, "device_denied");
    }
    let Ok(signing_key) = serde_json::from_str::<PublicJwk>(&sender_device.signing_public_jwk)
    else {
        return api_error(400, "invalid_signature");
    };
    if !verify_envelope_signature(&input.envelope, &signing_key) {
        return api_error(400, "invalid_signature");
    }

    let mut wrapped_devices = HashSet::new();
    let mut wraps_other_member = false;
    for wrap in &input.envelope.recipient_wraps {
        if !wrapped_devices.insert(&wrap.device_id) {
            return api_error(400, "invalid_envelope");
        }
        let Some(owner) = device_owner(db, &wrap.device_id, conversation_id).await? else {
            return api_error(400, "invalid_envelope");
        };
        if owner.account_id != account_id {
            wraps_other_member = true;
        }
    }
    if !wraps_other_member {
        return api_error(400, "recipient_key_missing");
    }

    let envelope_json = serde_json::to_string(&input.envelope)?;
    if envelope_json.len() > MAX_ENVELOPE_BYTES {
        return api_error(413, "envelope_too_large");
    }
    let expires_at = now + MESSAGE_TTL_MS;
    let result = db
        .prepare("INSERT OR IGNORE INTO chat_messages (id, conversation_id, sender_account_id, sender_device_id, envelope_json, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
        .bind(&[
            JsValue::from_str(&input.id),
            JsValue::from_str(conversation_id),
            JsValue::from_str(account_id),
            JsValue::from_str(&input.sender_device_id),
            JsValue::from_str(&envelope_json),
            JsValue::from_f64(now as f64),
            JsValue::from_f64(expires_at as f64),
        ])?
        .run()
        .await?;
    if changes(&result)? != 1 {
        return api_error(409, "message_exists");
    }
    json_response(
        201,
        json!({ "id": input.id, "createdAt": now, "expiresAt": expires_at }),
    )
}

async fn list_messages(
    db: &D1Database,
    account_id: &str,
    conversation_id: &str,
    url: &worker::Url,
    now: i64,
) -> Result<Response> {
    if !valid_id(conversation_id) || !active_member(db, account_id, conversation_id).await? {
        return api_error(404, "not_found");
    }
    let Some((after, limit)) = message_query(url) else {
        return api_error(400, "invalid_query");
    };
    let result = db
        .prepare("SELECT seq, id, sender_account_id, sender_device_id, envelope_json, created_at, expires_at FROM chat_messages WHERE conversation_id = ?1 AND seq > ?2 AND expires_at > ?3 ORDER BY seq LIMIT ?4")
        .bind(&[
            JsValue::from_str(conversation_id),
            JsValue::from_f64(after as f64),
            JsValue::from_f64(now as f64),
            JsValue::from_f64(limit as f64),
        ])?
        .all()
        .await?;
    let rows = result.results::<MessageRow>()?;
    let next_after = rows.last().map(|row| row.seq).unwrap_or(after);
    let has_more = rows.len() as i64 == limit;
    let messages = rows
        .into_iter()
        .filter_map(|row| {
            let envelope = serde_json::from_str(&row.envelope_json).ok()?;
            Some(MessageResponse {
                seq: row.seq,
                id: row.id,
                sender_account_id: row.sender_account_id,
                sender_device_id: row.sender_device_id,
                envelope,
                created_at: row.created_at,
                expires_at: row.expires_at,
            })
        })
        .collect::<Vec<_>>();
    json_response(
        200,
        json!({ "messages": messages, "serverNow": now, "nextAfter": next_after, "hasMore": has_more }),
    )
}

async fn delete_message(db: &D1Database, account_id: &str, message_id: &str) -> Result<Response> {
    if !valid_id(message_id) {
        return api_error(404, "not_found");
    }
    let result = db
        .prepare("DELETE FROM chat_messages WHERE id = ?1 AND sender_account_id = ?2")
        .bind(&[JsValue::from_str(message_id), JsValue::from_str(account_id)])?
        .run()
        .await?;
    if changes(&result)? != 1 {
        return api_error(404, "not_found");
    }
    json_response(200, json!({ "deleted": true }))
}

async fn active_member(db: &D1Database, account_id: &str, conversation_id: &str) -> Result<bool> {
    let row: Option<i64> = db
        .prepare("SELECT 1 AS found FROM chat_members WHERE conversation_id = ?1 AND account_id = ?2 AND state = 'active' LIMIT 1")
        .bind(&[
            JsValue::from_str(conversation_id),
            JsValue::from_str(account_id),
        ])?
        .first(Some("found"))
        .await?;
    Ok(row.is_some())
}

async fn all_members_active(db: &D1Database, conversation_id: &str) -> Result<bool> {
    let row: Option<CountRow> = db
        .prepare("SELECT COUNT(*) AS count FROM chat_members WHERE conversation_id = ?1 AND state = 'active'")
        .bind(&[JsValue::from_str(conversation_id)])?
        .first(None)
        .await?;
    Ok(row.is_some_and(|value| value.count == 2))
}

async fn device_owner(
    db: &D1Database,
    device_id: &str,
    conversation_id: &str,
) -> Result<Option<DeviceOwnerRow>> {
    db.prepare("SELECT d.account_id, d.signing_public_jwk FROM chat_devices d JOIN chat_members m ON m.account_id = d.account_id WHERE d.id = ?1 AND d.revoked_at IS NULL AND m.conversation_id = ?2 AND m.state = 'active' LIMIT 1")
        .bind(&[
            JsValue::from_str(device_id),
            JsValue::from_str(conversation_id),
        ])?
        .first(None)
        .await
}

async fn rate_limit(
    db: &D1Database,
    account_id: &str,
    action: &str,
    now: i64,
    window_ms: i64,
    limit: i64,
) -> Result<bool> {
    let bucket = now / window_ms;
    let expires_at = now + window_ms + MESSAGE_TTL_MS;
    db.prepare("INSERT INTO chat_rate_limits (account_id, action, bucket, count, expires_at) VALUES (?1, ?2, ?3, 1, ?4) ON CONFLICT(account_id, action, bucket) DO UPDATE SET count = count + 1, expires_at = MAX(expires_at, excluded.expires_at)")
        .bind(&[
            JsValue::from_str(account_id),
            JsValue::from_str(action),
            JsValue::from_f64(bucket as f64),
            JsValue::from_f64(expires_at as f64),
        ])?
        .run()
        .await?;
    let count: Option<i64> = db
        .prepare("SELECT count FROM chat_rate_limits WHERE account_id = ?1 AND action = ?2 AND bucket = ?3")
        .bind(&[
            JsValue::from_str(account_id),
            JsValue::from_str(action),
            JsValue::from_f64(bucket as f64),
        ])?
        .first(Some("count"))
        .await?;
    Ok(count.is_some_and(|value| value <= limit))
}

async fn read_json<T: for<'de> Deserialize<'de>>(
    request: &mut Request,
) -> Result<std::result::Result<T, InputError>> {
    if !request.headers().get("content-type")?.is_some_and(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|media_type| media_type.trim() == "application/json")
    }) {
        return Ok(Err(InputError::Invalid));
    }
    if request
        .headers()
        .get("content-length")?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_BODY_BYTES)
    {
        return Ok(Err(InputError::TooLarge));
    }
    let bytes = request.bytes().await?;
    if bytes.len() > MAX_BODY_BYTES {
        return Ok(Err(InputError::TooLarge));
    }
    Ok(serde_json::from_slice(&bytes).map_err(|_| InputError::Invalid))
}

fn valid_envelope(
    envelope: &MessageEnvelope,
    message_id: &str,
    conversation_id: &str,
    sender_device_id: &str,
    now: i64,
) -> bool {
    envelope.version == 1
        && envelope.algorithm == "P256-HKDF-SHA256-A256GCM"
        && envelope.message_id == message_id
        && envelope.conversation_id == conversation_id
        && envelope.sender_device_id == sender_device_id
        && envelope.client_created_at.abs_diff(now) <= MAX_CLOCK_SKEW_MS as u64
        && decoded_len(&envelope.nonce) == Some(12)
        && decoded_len(&envelope.signature) == Some(64)
        && decoded_len(&envelope.ciphertext).is_some_and(|length| (17..=12_288).contains(&length))
        && (1..=MAX_RECIPIENT_WRAPS).contains(&envelope.recipient_wraps.len())
        && envelope.recipient_wraps.iter().all(valid_recipient_wrap)
}

fn signed_envelope_bytes(envelope: &MessageEnvelope) -> Option<Vec<u8>> {
    let wraps = envelope
        .recipient_wraps
        .iter()
        .map(|wrap| {
            json!([
                wrap.device_id,
                [
                    wrap.ephemeral_public_jwk.kty,
                    wrap.ephemeral_public_jwk.crv,
                    wrap.ephemeral_public_jwk.x,
                    wrap.ephemeral_public_jwk.y
                ],
                wrap.nonce,
                wrap.ciphertext
            ])
        })
        .collect::<Vec<_>>();
    serde_json::to_vec(&json!([
        envelope.version,
        envelope.algorithm,
        envelope.conversation_id,
        envelope.message_id,
        envelope.sender_device_id,
        envelope.client_created_at,
        envelope.nonce,
        envelope.ciphertext,
        wraps
    ]))
    .ok()
}

fn verify_envelope_signature(envelope: &MessageEnvelope, jwk: &PublicJwk) -> bool {
    if !valid_public_jwk(jwk) {
        return false;
    }
    let (Ok(x), Ok(y), Ok(signature)) = (
        URL_SAFE_NO_PAD.decode(&jwk.x),
        URL_SAFE_NO_PAD.decode(&jwk.y),
        URL_SAFE_NO_PAD.decode(&envelope.signature),
    ) else {
        return false;
    };
    let mut point = Vec::with_capacity(65);
    point.push(0x04);
    point.extend_from_slice(&x);
    point.extend_from_slice(&y);
    let (Ok(key), Ok(signature), Some(message)) = (
        VerifyingKey::from_sec1_bytes(&point),
        Signature::from_slice(&signature),
        signed_envelope_bytes(envelope),
    ) else {
        return false;
    };
    key.verify(&message, &signature).is_ok()
}

fn valid_recipient_wrap(wrap: &RecipientWrap) -> bool {
    valid_id(&wrap.device_id)
        && valid_public_jwk(&wrap.ephemeral_public_jwk)
        && decoded_len(&wrap.nonce) == Some(12)
        && decoded_len(&wrap.ciphertext) == Some(48)
}

fn valid_public_jwk(jwk: &PublicJwk) -> bool {
    jwk.kty == "EC"
        && jwk.crv == "P-256"
        && decoded_len(&jwk.x) == Some(32)
        && decoded_len(&jwk.y) == Some(32)
}

fn decoded_len(value: &str) -> Option<usize> {
    if value.is_empty()
        || value.contains('=')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    URL_SAFE_NO_PAD.decode(value).ok().map(|bytes| bytes.len())
}

fn valid_id(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn normalize_handle(input: &str) -> Option<String> {
    let handle = input.trim().to_ascii_lowercase();
    if !(3..=48).contains(&handle.len())
        || !handle
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return None;
    }
    Some(handle)
}

fn random_id() -> Result<String> {
    let mut value = [0_u8; 32];
    getrandom::fill(&mut value)
        .map_err(|_| worker::Error::RustError("secure random unavailable".into()))?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

fn csrf_allowed(request: &Request, expected: &str) -> Result<bool> {
    let supplied = request.headers().get("x-hii-csrf")?.unwrap_or_default();
    Ok(!expected.is_empty() && supplied == expected)
}

fn message_query(url: &worker::Url) -> Option<(i64, i64)> {
    let mut after = None;
    let mut limit = None;
    for (name, value) in url.query_pairs() {
        match name.as_ref() {
            "after" if after.is_none() => after = Some(value.parse::<i64>().ok()?),
            "limit" if limit.is_none() => limit = Some(value.parse::<i64>().ok()?),
            _ => return None,
        }
    }
    let after = after.unwrap_or(0);
    let limit = limit.unwrap_or(100);
    (after >= 0 && (1..=100).contains(&limit)).then_some((after, limit))
}

fn changes(result: &worker::D1Result) -> Result<usize> {
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0))
}

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

fn json_response<T: Serialize>(status: u16, value: T) -> Result<Response> {
    Ok(Response::from_json(&value)?.with_status(status))
}

fn api_error(status: u16, code: &str) -> Result<Response> {
    json_response(status, json!({ "error": code }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{SigningKey, signature::Signer};

    fn b64(bytes: usize) -> String {
        URL_SAFE_NO_PAD.encode(vec![7_u8; bytes])
    }

    fn public_jwk() -> PublicJwk {
        PublicJwk {
            kty: "EC".into(),
            crv: "P-256".into(),
            x: b64(32),
            y: b64(32),
        }
    }

    fn envelope(now: i64) -> MessageEnvelope {
        let id = b64(32);
        MessageEnvelope {
            version: 1,
            algorithm: "P256-HKDF-SHA256-A256GCM".into(),
            conversation_id: id.clone(),
            message_id: id.clone(),
            sender_device_id: id.clone(),
            client_created_at: now,
            nonce: b64(12),
            ciphertext: b64(32),
            signature: b64(64),
            recipient_wraps: vec![RecipientWrap {
                device_id: b64(32),
                ephemeral_public_jwk: public_jwk(),
                nonce: b64(12),
                ciphertext: b64(48),
            }],
        }
    }

    #[test]
    fn envelope_validation_accepts_only_the_bounded_v1_shape() {
        let now = 1_000_000;
        let id = b64(32);
        assert!(valid_envelope(&envelope(now), &id, &id, &id, now));

        let mut wrong_algorithm = envelope(now);
        wrong_algorithm.algorithm = "none".into();
        assert!(!valid_envelope(&wrong_algorithm, &id, &id, &id, now));

        let mut stale = envelope(now);
        stale.client_created_at = now - MAX_CLOCK_SKEW_MS - 1;
        assert!(!valid_envelope(&stale, &id, &id, &id, now));

        let mut padded_nonce = envelope(now);
        padded_nonce.nonce.push('=');
        assert!(!valid_envelope(&padded_nonce, &id, &id, &id, now));

        let mut rebound = envelope(now);
        rebound.message_id = b64(31);
        assert!(!valid_envelope(&rebound, &id, &id, &id, now));
    }

    #[test]
    fn envelope_signature_binds_the_browser_canonical_payload() {
        let now = 1_000_000;
        let key = SigningKey::from_slice(&[3_u8; 32]).expect("test signing key");
        let point = key.verifying_key().to_encoded_point(false);
        let jwk = PublicJwk {
            kty: "EC".into(),
            crv: "P-256".into(),
            x: URL_SAFE_NO_PAD.encode(point.x().expect("x coordinate")),
            y: URL_SAFE_NO_PAD.encode(point.y().expect("y coordinate")),
        };
        let mut message = envelope(now);
        let signature: Signature = key.sign(&signed_envelope_bytes(&message).expect("payload"));
        message.signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
        assert!(verify_envelope_signature(&message, &jwk));

        message.ciphertext = b64(33);
        assert!(!verify_envelope_signature(&message, &jwk));
    }

    #[test]
    fn public_keys_are_strict_p256_coordinates() {
        assert!(valid_public_jwk(&public_jwk()));
        let mut private = serde_json::to_value(public_jwk()).expect("serialize public JWK");
        private["d"] = Value::String(b64(32));
        assert!(serde_json::from_value::<PublicJwk>(private).is_err());

        let mut wrong_curve = public_jwk();
        wrong_curve.crv = "secp256k1".into();
        assert!(!valid_public_jwk(&wrong_curve));
    }

    #[test]
    fn opaque_ids_and_handles_are_narrow() {
        assert!(valid_id(&b64(32)));
        assert!(!valid_id("../conversation"));
        assert_eq!(
            normalize_handle(" Ummi.Green ").as_deref(),
            Some("ummi.green")
        );
        assert!(normalize_handle("name with space").is_none());
    }

    #[test]
    fn expiry_is_exactly_twenty_four_hours() {
        assert_eq!(MESSAGE_TTL_MS, 86_400_000);
    }

    #[test]
    fn message_pagination_rejects_duplicates_and_unknown_keys() {
        let valid = worker::Url::parse("https://example.com/api/chat/c/messages?after=4&limit=20")
            .expect("valid URL");
        assert_eq!(message_query(&valid), Some((4, 20)));

        let duplicate =
            worker::Url::parse("https://example.com/api/chat/c/messages?after=4&after=5")
                .expect("valid URL");
        assert_eq!(message_query(&duplicate), None);

        let unknown = worker::Url::parse("https://example.com/api/chat/c/messages?room=all")
            .expect("valid URL");
        assert_eq!(message_query(&unknown), None);
    }
}
