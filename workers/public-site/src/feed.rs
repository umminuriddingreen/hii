use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use wasm_bindgen::JsValue;
use worker::{D1Database, Date, Method, Request, Response, Result};

const MAX_FEED_BODY_BYTES: usize = 64 * 1024;
const MAX_TEXT_CHARS: usize = 4_000;
const MAX_STICKER_CHARS: usize = 32;
const MAX_INK_STROKES: usize = 16;
const MAX_INK_POINTS: usize = 2_000;
const MAX_FEED_PAGE: usize = 50;
const DEFAULT_FEED_PAGE: usize = 20;
const DAILY_PUBLISH_LIMIT: i64 = 50;
const DAILY_REPORT_LIMIT: i64 = 200;

/// Authenticated account state constructed by the top-level Worker after it has
/// resolved the HttpOnly HII session cookie. No feed input accepts an author.
pub struct FeedActor<'a> {
    account_id: &'a str,
    handle: &'a str,
    csrf_token: &'a str,
}

impl<'a> FeedActor<'a> {
    pub fn new(account_id: &'a str, handle: &'a str, csrf_token: &'a str) -> Self {
        Self {
            account_id,
            handle,
            csrf_token,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum FeedRoute {
    List,
    Publish,
    Revoke(String),
    Report(String),
}

/// Used by the top-level router to send only the bounded feed namespace here.
pub fn is_feed_api_path(path: &str) -> bool {
    path == "/api/feed" || path.starts_with("/api/feed/")
}

pub fn feed_route(method: &Method, path: &str) -> Option<FeedRoute> {
    match (method, path) {
        (Method::Get, "/api/feed") => return Some(FeedRoute::List),
        (Method::Post, "/api/feed/items") => return Some(FeedRoute::Publish),
        _ => {}
    }

    if method != &Method::Post {
        return None;
    }
    let rest = path.strip_prefix("/api/feed/items/")?;
    let (id, action) = rest.split_once('/')?;
    if action.contains('/') || !valid_public_id(id) {
        return None;
    }
    match action {
        "revoke" => Some(FeedRoute::Revoke(id.to_owned())),
        "report" => Some(FeedRoute::Report(id.to_owned())),
        _ => None,
    }
}

/// Handle an authenticated feed request. The caller must still apply HII's
/// common no-store and security headers to the returned response.
pub async fn handle_feed_request(
    request: &mut Request,
    db: &D1Database,
    actor: &FeedActor<'_>,
) -> Result<Response> {
    let path = request.url()?.path().to_owned();
    let Some(route) = feed_route(&request.method(), &path) else {
        return api_error(404, "not_found");
    };
    match route {
        FeedRoute::List => list_feed(request, db, actor).await,
        FeedRoute::Publish => publish_item(request, db, actor).await,
        FeedRoute::Revoke(id) => revoke_item(request, db, actor, &id).await,
        FeedRoute::Report(id) => report_item(request, db, actor, &id).await,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublishInput {
    client_request_id: String,
    source_node_id: String,
    source_updated_at: String,
    snapshot: SnapshotInput,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum SnapshotInput {
    Text { text: String },
    Sticker { emoji: String },
    Ink { strokes: Vec<InkStrokeInput> },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InkStrokeInput {
    points: Vec<f64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum FeedSnapshot {
    Text { text: String },
    Sticker { emoji: String },
    Ink { strokes: Vec<FeedInkStroke> },
}

impl FeedSnapshot {
    fn kind(&self) -> &'static str {
        match self {
            Self::Text { .. } => "text",
            Self::Sticker { .. } => "sticker",
            Self::Ink { .. } => "ink",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct FeedInkStroke {
    points: Vec<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReportInput {
    reason: ReportReason,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ReportReason {
    Spam,
    Abuse,
    Private,
    Other,
}

impl ReportReason {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Spam => "spam",
            Self::Abuse => "abuse",
            Self::Private => "private",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Deserialize)]
struct FeedRow {
    id: String,
    author_account_id: String,
    handle: String,
    kind: String,
    snapshot_json: String,
    content_hash: String,
    source_updated_at: String,
    created_at: i64,
}

#[derive(Debug, Deserialize)]
struct ExistingPublishRow {
    id: String,
    kind: String,
    snapshot_json: String,
    source_ref_hash: String,
    content_hash: String,
    source_updated_at: String,
    created_at: i64,
}

#[derive(Debug, Deserialize)]
struct ItemOwnerRow {
    author_account_id: String,
    moderation_state: String,
    revoked_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RateRow {
    count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedAuthor<'a> {
    handle: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedProvenance<'a> {
    source: &'static str,
    assurance: &'static str,
    source_updated_at: &'a str,
    shared_at: i64,
    content_hash: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedItemResponse<'a> {
    id: &'a str,
    author: FeedAuthor<'a>,
    kind: &'a str,
    snapshot: &'a FeedSnapshot,
    published_at: i64,
    mine: bool,
    provenance: FeedProvenance<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedPage<'a> {
    items: Vec<FeedItemResponse<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

async fn list_feed(request: &Request, db: &D1Database, actor: &FeedActor<'_>) -> Result<Response> {
    let url = request.url()?;
    let mut cursor = None;
    let mut limit = DEFAULT_FEED_PAGE;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "cursor" if cursor.is_none() => cursor = Some(value.into_owned()),
            "limit" => {
                let Ok(parsed) = value.parse::<usize>() else {
                    return api_error(400, "invalid_pagination");
                };
                if !(1..=MAX_FEED_PAGE).contains(&parsed) {
                    return api_error(400, "invalid_pagination");
                }
                limit = parsed;
            }
            _ => {}
        }
    }

    let page_size = (limit + 1) as f64;
    let rows: Vec<FeedRow> = if let Some(encoded) = cursor {
        let Some((created_at, id)) = decode_cursor(&encoded) else {
            return api_error(400, "invalid_cursor");
        };
        db.prepare(
            "SELECT f.id, f.author_account_id, a.handle, f.kind, f.snapshot_json, f.content_hash, f.source_updated_at, f.created_at \
             FROM feed_items f JOIN accounts a ON a.id = f.author_account_id \
             LEFT JOIN feed_reports r ON r.item_id = f.id AND r.reporter_account_id = ?1 \
             WHERE f.moderation_state = 'visible' AND f.revoked_at IS NULL AND r.item_id IS NULL \
             AND (f.created_at < ?2 OR (f.created_at = ?2 AND f.id < ?3)) \
             ORDER BY f.created_at DESC, f.id DESC LIMIT ?4",
        )
        .bind(&[
            JsValue::from_str(actor.account_id),
            JsValue::from_f64(created_at as f64),
            JsValue::from_str(&id),
            JsValue::from_f64(page_size),
        ])?
        .all()
        .await?
        .results()?
    } else {
        db.prepare(
            "SELECT f.id, f.author_account_id, a.handle, f.kind, f.snapshot_json, f.content_hash, f.source_updated_at, f.created_at \
             FROM feed_items f JOIN accounts a ON a.id = f.author_account_id \
             LEFT JOIN feed_reports r ON r.item_id = f.id AND r.reporter_account_id = ?1 \
             WHERE f.moderation_state = 'visible' AND f.revoked_at IS NULL AND r.item_id IS NULL \
             ORDER BY f.created_at DESC, f.id DESC LIMIT ?2",
        )
        .bind(&[
            JsValue::from_str(actor.account_id),
            JsValue::from_f64(page_size),
        ])?
        .all()
        .await?
        .results()?
    };

    let has_more = rows.len() > limit;
    let selected = &rows[..rows.len().min(limit)];
    let snapshots: Vec<Option<FeedSnapshot>> = selected
        .iter()
        .map(|row| stored_snapshot(&row.kind, &row.snapshot_json))
        .collect();
    let items = selected
        .iter()
        .zip(snapshots.iter())
        .filter_map(|(row, snapshot)| {
            snapshot
                .as_ref()
                .map(|snapshot| response_item(row, snapshot, actor.account_id))
        })
        .collect();
    let next_cursor = has_more
        .then(|| selected.last())
        .flatten()
        .map(|row| encode_cursor(row.created_at, &row.id));
    json_response(200, FeedPage { items, next_cursor })
}

async fn publish_item(
    request: &mut Request,
    db: &D1Database,
    actor: &FeedActor<'_>,
) -> Result<Response> {
    if !csrf_allowed(request, actor)? {
        return api_error(403, "csrf_denied");
    }
    let input: PublishInput = match read_json(request).await {
        Ok(value) => value,
        Err(code) => return api_error(400, code),
    };
    if !valid_bounded_token(&input.client_request_id)
        || !valid_bounded_token(&input.source_node_id)
        || !valid_source_timestamp(&input.source_updated_at)
    {
        return api_error(400, "invalid_feed_source");
    }
    let snapshot = match canonicalize_snapshot(input.snapshot) {
        Ok(value) => value,
        Err(code) => return api_error(400, code),
    };
    let snapshot_json = serde_json::to_string(&snapshot)?;
    let content_hash = digest(snapshot_json.as_bytes());
    let source_ref_hash =
        digest(format!("{}\0{}", actor.account_id, input.source_node_id).as_bytes());

    if let Some(existing) = existing_publish(db, actor.account_id, &input.client_request_id).await?
    {
        return existing_publish_response(
            existing,
            &snapshot,
            &snapshot_json,
            &content_hash,
            &source_ref_hash,
            &input.source_updated_at,
            actor,
        );
    }
    if !consume_daily_limit(db, actor.account_id, "feed-publish", DAILY_PUBLISH_LIMIT).await? {
        return api_error(429, "rate_limited");
    }

    let id = random_token()?;
    let event_id = random_token()?;
    let created_at = now_ms();
    let results = db
        .batch(vec![
            db.prepare(
                "INSERT INTO feed_items \
                 (id, author_account_id, kind, snapshot_json, source_ref_hash, content_hash, source_updated_at, client_request_id, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
                 ON CONFLICT(author_account_id, client_request_id) DO NOTHING",
            )
            .bind(&[
                JsValue::from_str(&id),
                JsValue::from_str(actor.account_id),
                JsValue::from_str(snapshot.kind()),
                JsValue::from_str(&snapshot_json),
                JsValue::from_str(&source_ref_hash),
                JsValue::from_str(&content_hash),
                JsValue::from_str(&input.source_updated_at),
                JsValue::from_str(&input.client_request_id),
                JsValue::from_f64(created_at as f64),
            ])?,
            db.prepare(
                "INSERT INTO feed_events (id, item_id, actor_account_id, kind, created_at) \
                 SELECT ?1, ?2, ?3, 'published', ?4 WHERE changes() > 0",
            )
            .bind(&[
                JsValue::from_str(&event_id),
                JsValue::from_str(&id),
                JsValue::from_str(actor.account_id),
                JsValue::from_f64(created_at as f64),
            ])?,
        ])
        .await?;
    let inserted = results
        .first()
        .and_then(|result| result.meta().ok().flatten())
        .and_then(|meta| meta.changes)
        .unwrap_or(0)
        > 0;
    if !inserted {
        let Some(existing) =
            existing_publish(db, actor.account_id, &input.client_request_id).await?
        else {
            return api_error(409, "publish_conflict");
        };
        return existing_publish_response(
            existing,
            &snapshot,
            &snapshot_json,
            &content_hash,
            &source_ref_hash,
            &input.source_updated_at,
            actor,
        );
    }

    let row = FeedRow {
        id,
        author_account_id: actor.account_id.to_owned(),
        handle: actor.handle.to_owned(),
        kind: snapshot.kind().to_owned(),
        snapshot_json,
        content_hash,
        source_updated_at: input.source_updated_at,
        created_at,
    };
    json_response(201, response_item(&row, &snapshot, actor.account_id))
}

async fn revoke_item(
    request: &Request,
    db: &D1Database,
    actor: &FeedActor<'_>,
    id: &str,
) -> Result<Response> {
    if !csrf_allowed(request, actor)? {
        return api_error(403, "csrf_denied");
    }
    let owner: Option<ItemOwnerRow> = db
        .prepare(
            "SELECT author_account_id, moderation_state, revoked_at FROM feed_items WHERE id = ?1 LIMIT 1",
        )
        .bind(&[JsValue::from_str(id)])?
        .first(None)
        .await?;
    let Some(owner) = owner else {
        return api_error(404, "feed_item_not_found");
    };
    if owner.author_account_id != actor.account_id {
        return api_error(404, "feed_item_not_found");
    }
    if owner.revoked_at.is_some() || owner.moderation_state == "revoked" {
        return json_response(200, json!({ "id": id, "revoked": true }));
    }

    let revoked_at = now_ms();
    let event_id = random_token()?;
    db.batch(vec![
        db.prepare(
            "UPDATE feed_items SET snapshot_json = '{}', moderation_state = 'revoked', revoked_at = ?1 \
             WHERE id = ?2 AND author_account_id = ?3 AND revoked_at IS NULL",
        )
        .bind(&[
            JsValue::from_f64(revoked_at as f64),
            JsValue::from_str(id),
            JsValue::from_str(actor.account_id),
        ])?,
        db.prepare(
            "INSERT INTO feed_events (id, item_id, actor_account_id, kind, created_at) \
             SELECT ?1, ?2, ?3, 'revoked', ?4 WHERE changes() > 0",
        )
        .bind(&[
            JsValue::from_str(&event_id),
            JsValue::from_str(id),
            JsValue::from_str(actor.account_id),
            JsValue::from_f64(revoked_at as f64),
        ])?,
    ])
    .await?;
    json_response(200, json!({ "id": id, "revoked": true }))
}

async fn report_item(
    request: &mut Request,
    db: &D1Database,
    actor: &FeedActor<'_>,
    id: &str,
) -> Result<Response> {
    if !csrf_allowed(request, actor)? {
        return api_error(403, "csrf_denied");
    }
    let input: ReportInput = match read_json(request).await {
        Ok(value) => value,
        Err(code) => return api_error(400, code),
    };
    let owner: Option<ItemOwnerRow> = db
        .prepare(
            "SELECT author_account_id, moderation_state, revoked_at FROM feed_items WHERE id = ?1 LIMIT 1",
        )
        .bind(&[JsValue::from_str(id)])?
        .first(None)
        .await?;
    let Some(owner) = owner else {
        return api_error(404, "feed_item_not_found");
    };
    if owner.revoked_at.is_some() || owner.moderation_state != "visible" {
        return api_error(404, "feed_item_not_found");
    }
    if owner.author_account_id == actor.account_id {
        return api_error(400, "cannot_report_own_item");
    }
    if !consume_daily_limit(db, actor.account_id, "feed-report", DAILY_REPORT_LIMIT).await? {
        return api_error(429, "rate_limited");
    }
    db.prepare(
        "INSERT INTO feed_reports (item_id, reporter_account_id, reason, created_at) \
         VALUES (?1, ?2, ?3, ?4) ON CONFLICT(item_id, reporter_account_id) DO NOTHING",
    )
    .bind(&[
        JsValue::from_str(id),
        JsValue::from_str(actor.account_id),
        JsValue::from_str(input.reason.as_str()),
        JsValue::from_f64(now_ms() as f64),
    ])?
    .run()
    .await?;
    json_response(200, json!({ "id": id, "reported": true }))
}

async fn existing_publish(
    db: &D1Database,
    account_id: &str,
    client_request_id: &str,
) -> Result<Option<ExistingPublishRow>> {
    db.prepare(
        "SELECT id, kind, snapshot_json, source_ref_hash, content_hash, source_updated_at, created_at \
         FROM feed_items WHERE author_account_id = ?1 AND client_request_id = ?2 LIMIT 1",
    )
    .bind(&[
        JsValue::from_str(account_id),
        JsValue::from_str(client_request_id),
    ])?
    .first(None)
    .await
}

fn existing_publish_response(
    existing: ExistingPublishRow,
    snapshot: &FeedSnapshot,
    snapshot_json: &str,
    content_hash: &str,
    source_ref_hash: &str,
    source_updated_at: &str,
    actor: &FeedActor<'_>,
) -> Result<Response> {
    if existing.kind != snapshot.kind()
        || existing.snapshot_json != snapshot_json
        || existing.content_hash != content_hash
        || existing.source_ref_hash != source_ref_hash
        || existing.source_updated_at != source_updated_at
    {
        return api_error(409, "idempotency_conflict");
    }
    let row = FeedRow {
        id: existing.id,
        author_account_id: actor.account_id.to_owned(),
        handle: actor.handle.to_owned(),
        kind: existing.kind,
        snapshot_json: existing.snapshot_json,
        content_hash: existing.content_hash,
        source_updated_at: existing.source_updated_at,
        created_at: existing.created_at,
    };
    json_response(200, response_item(&row, snapshot, actor.account_id))
}

async fn consume_daily_limit(
    db: &D1Database,
    account_id: &str,
    action: &str,
    limit: i64,
) -> Result<bool> {
    let bucket = now_ms() / 86_400_000;
    let key = format!("{action}:{}", digest(account_id.as_bytes()));
    db.batch(vec![
        db.prepare("DELETE FROM rate_limits WHERE bucket < ?1")
            .bind(&[JsValue::from_f64((bucket - 7) as f64)])?,
        db.prepare(
            "INSERT INTO rate_limits (key, bucket, count) VALUES (?1, ?2, 1) \
             ON CONFLICT(key, bucket) DO UPDATE SET count = count + 1",
        )
        .bind(&[JsValue::from_str(&key), JsValue::from_f64(bucket as f64)])?,
    ])
    .await?;
    let row: Option<RateRow> = db
        .prepare("SELECT count FROM rate_limits WHERE key = ?1 AND bucket = ?2")
        .bind(&[JsValue::from_str(&key), JsValue::from_f64(bucket as f64)])?
        .first(None)
        .await?;
    Ok(row.is_some_and(|row| row.count <= limit))
}

fn canonicalize_snapshot(input: SnapshotInput) -> std::result::Result<FeedSnapshot, &'static str> {
    match input {
        SnapshotInput::Text { text } => {
            let text = normalize_public_text(text, MAX_TEXT_CHARS, "invalid_text")?;
            Ok(FeedSnapshot::Text { text })
        }
        SnapshotInput::Sticker { emoji } => {
            let emoji = normalize_public_text(emoji, MAX_STICKER_CHARS, "invalid_sticker")?;
            if emoji.len() > 128 || emoji.contains(char::is_whitespace) {
                return Err("invalid_sticker");
            }
            Ok(FeedSnapshot::Sticker { emoji })
        }
        SnapshotInput::Ink { strokes } => {
            if strokes.is_empty() || strokes.len() > MAX_INK_STROKES {
                return Err("invalid_ink");
            }
            let mut point_count = 0usize;
            let mut normalized = Vec::with_capacity(strokes.len());
            for stroke in strokes {
                if stroke.points.len() < 4 || stroke.points.len() % 2 != 0 {
                    return Err("invalid_ink");
                }
                point_count += stroke.points.len() / 2;
                if point_count > MAX_INK_POINTS {
                    return Err("invalid_ink");
                }
                let mut points = Vec::with_capacity(stroke.points.len());
                for value in stroke.points {
                    if !value.is_finite() || value.abs() > 10_000.0 {
                        return Err("invalid_ink");
                    }
                    let rounded = (value * 1_000.0).round() / 1_000.0;
                    points.push(if rounded == -0.0 { 0.0 } else { rounded });
                }
                normalized.push(FeedInkStroke { points });
            }
            Ok(FeedSnapshot::Ink {
                strokes: normalized,
            })
        }
    }
}

fn normalize_public_text(
    value: String,
    max_chars: usize,
    error: &'static str,
) -> std::result::Result<String, &'static str> {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.chars().any(is_disallowed_public_character) {
        return Err(error);
    }
    let trimmed = normalized.trim();
    if trimmed.is_empty() || trimmed.chars().count() > max_chars {
        return Err(error);
    }
    Ok(trimmed.to_owned())
}

fn is_disallowed_public_character(character: char) -> bool {
    (character.is_control() && character != '\n' && character != '\t')
        || matches!(
            character,
            '\u{061c}'
                | '\u{200e}'
                | '\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2066}'..='\u{2069}'
                | '\u{feff}'
        )
}

fn stored_snapshot(kind: &str, encoded: &str) -> Option<FeedSnapshot> {
    let snapshot: FeedSnapshot = serde_json::from_str(encoded).ok()?;
    (snapshot.kind() == kind).then_some(snapshot)
}

fn response_item<'a>(
    row: &'a FeedRow,
    snapshot: &'a FeedSnapshot,
    viewer_account_id: &str,
) -> FeedItemResponse<'a> {
    FeedItemResponse {
        id: &row.id,
        author: FeedAuthor {
            handle: &row.handle,
        },
        kind: &row.kind,
        snapshot,
        published_at: row.created_at,
        mine: row.author_account_id == viewer_account_id,
        provenance: FeedProvenance {
            source: "hii.canvas",
            assurance: "session-authenticated-account-asserted",
            source_updated_at: &row.source_updated_at,
            shared_at: row.created_at,
            content_hash: &row.content_hash,
        },
    }
}

fn valid_source_timestamp(value: &str) -> bool {
    (20..=64).contains(&value.len())
        && value.contains('T')
        && value.ends_with('Z')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'-' | b':' | b'.' | b'T' | b'Z'))
}

fn valid_bounded_token(value: &str) -> bool {
    (8..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_public_id(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn csrf_allowed(request: &Request, actor: &FeedActor<'_>) -> Result<bool> {
    let supplied = request.headers().get("x-hii-csrf")?.unwrap_or_default();
    Ok(!supplied.is_empty() && supplied == actor.csrf_token)
}

async fn read_json<T: for<'de> Deserialize<'de>>(
    request: &mut Request,
) -> std::result::Result<T, &'static str> {
    if request
        .headers()
        .get("content-length")
        .map_err(|_| "invalid_body")?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_FEED_BODY_BYTES)
    {
        return Err("body_too_large");
    }
    let bytes = request.bytes().await.map_err(|_| "invalid_body")?;
    if bytes.len() > MAX_FEED_BODY_BYTES {
        return Err("body_too_large");
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid_body")
}

fn encode_cursor(created_at: i64, id: &str) -> String {
    URL_SAFE_NO_PAD.encode(format!("{created_at}:{id}"))
}

fn decode_cursor(encoded: &str) -> Option<(i64, String)> {
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let decoded = String::from_utf8(bytes).ok()?;
    let (created_at, id) = decoded.split_once(':')?;
    let created_at = created_at.parse::<i64>().ok()?;
    (created_at >= 0 && valid_public_id(id)).then(|| (created_at, id.to_owned()))
}

fn random_token() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| worker::Error::RustError("secure random unavailable".into()))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn digest(value: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value))
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
    use serde_json::Value;

    fn snapshot(value: Value) -> SnapshotInput {
        serde_json::from_value(value).expect("valid fixture")
    }

    #[test]
    fn routes_only_the_exact_feed_contract() {
        assert_eq!(feed_route(&Method::Get, "/api/feed"), Some(FeedRoute::List));
        assert_eq!(
            feed_route(&Method::Post, "/api/feed/items"),
            Some(FeedRoute::Publish)
        );
        let id = "a".repeat(43);
        assert_eq!(
            feed_route(&Method::Post, &format!("/api/feed/items/{id}/revoke")),
            Some(FeedRoute::Revoke(id.clone()))
        );
        assert_eq!(
            feed_route(&Method::Post, &format!("/api/feed/items/{id}/report")),
            Some(FeedRoute::Report(id))
        );
        assert_eq!(feed_route(&Method::Get, "/api/feed/items"), None);
        assert_eq!(
            feed_route(&Method::Post, "/api/feed/items/../../secret/revoke"),
            None
        );
    }

    #[test]
    fn canonicalizes_text_without_accepting_private_canvas_fields() {
        let input: PublishInput = serde_json::from_value(json!({
            "clientRequestId": "request-1234",
            "sourceNodeId": "node-1234",
            "sourceUpdatedAt": "2026-08-28T03:00:00.000Z",
            "snapshot": { "kind": "text", "text": "  hello\r\nworld  " }
        }))
        .expect("strict public shape");
        assert_eq!(
            canonicalize_snapshot(input.snapshot),
            Ok(FeedSnapshot::Text {
                text: "hello\nworld".into()
            })
        );
        assert!(
            serde_json::from_value::<PublishInput>(json!({
                "clientRequestId": "request-1234",
                "sourceNodeId": "node-1234",
                "sourceUpdatedAt": "2026-08-28T03:00:00.000Z",
                "spaceId": "private-space",
                "snapshot": { "kind": "text", "text": "hello" }
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<PublishInput>(json!({
                "clientRequestId": "request-1234",
                "sourceNodeId": "node-1234",
                "sourceUpdatedAt": "2026-08-28T03:00:00.000Z",
                "snapshot": { "kind": "text", "text": "hello", "localPath": "/secret" }
            }))
            .is_err()
        );
    }

    #[test]
    fn rejects_oversized_or_control_bearing_text_and_stickers() {
        assert_eq!(
            canonicalize_snapshot(snapshot(json!({
                "kind": "text",
                "text": "x".repeat(MAX_TEXT_CHARS + 1)
            }))),
            Err("invalid_text")
        );
        assert_eq!(
            canonicalize_snapshot(snapshot(json!({ "kind": "text", "text": "a\u{0000}b" }))),
            Err("invalid_text")
        );
        assert_eq!(
            canonicalize_snapshot(snapshot(
                json!({ "kind": "text", "text": "safe\u{202e}txt" })
            )),
            Err("invalid_text")
        );
        assert_eq!(
            canonicalize_snapshot(snapshot(json!({ "kind": "sticker", "emoji": "two words" }))),
            Err("invalid_sticker")
        );
    }

    #[test]
    fn canonicalizes_bounded_ink_and_rejects_hidden_style_fields() {
        assert_eq!(
            canonicalize_snapshot(snapshot(json!({
                "kind": "ink",
                "strokes": [{ "points": [-0.0, 0.12345, 9.87654, 10.0] }]
            }))),
            Ok(FeedSnapshot::Ink {
                strokes: vec![FeedInkStroke {
                    points: vec![0.0, 0.123, 9.877, 10.0]
                }]
            })
        );
        assert!(
            serde_json::from_value::<SnapshotInput>(json!({
                "kind": "ink",
                "strokes": [{ "points": [0, 0, 1, 1], "color": "red" }]
            }))
            .is_err()
        );
        assert_eq!(
            canonicalize_snapshot(snapshot(json!({
                "kind": "ink",
                "strokes": [{ "points": [0, 0, 1] }]
            }))),
            Err("invalid_ink")
        );
    }

    #[test]
    fn cursor_is_opaque_bounded_and_round_trips() {
        let id = "Z".repeat(43);
        let cursor = encode_cursor(1_777_777_777_777, &id);
        assert_eq!(decode_cursor(&cursor), Some((1_777_777_777_777, id)));
        assert_eq!(decode_cursor("not-base64!!!"), None);
        assert_eq!(
            decode_cursor(&URL_SAFE_NO_PAD.encode("123:../../private")),
            None
        );
    }

    #[test]
    fn content_hash_tracks_only_the_canonical_snapshot() {
        let first = canonicalize_snapshot(snapshot(json!({ "kind": "text", "text": " hello " })))
            .expect("canonical text");
        let second = canonicalize_snapshot(snapshot(json!({ "kind": "text", "text": "hello" })))
            .expect("canonical text");
        let first = serde_json::to_string(&first).expect("serializes");
        let second = serde_json::to_string(&second).expect("serializes");
        assert_eq!(first, second);
        assert_eq!(digest(first.as_bytes()), digest(second.as_bytes()));
        assert_eq!(digest(first.as_bytes()).len(), 43);
    }

    #[test]
    fn stored_snapshots_must_match_the_indexed_kind() {
        let encoded = serde_json::to_string(&FeedSnapshot::Sticker {
            emoji: "✦".into()
        })
        .expect("serializes");
        assert!(stored_snapshot("sticker", &encoded).is_some());
        assert!(stored_snapshot("text", &encoded).is_none());
        assert!(stored_snapshot("sticker", "{}").is_none());
    }
}
