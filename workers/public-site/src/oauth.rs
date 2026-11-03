//! OAuth 2.1 authorization-code + PKCE boundary for the private HII connector.

use crate::{
    RP_ORIGIN, SESSION_COOKIE, active_session, cookie, hash_token, json_response, now_ms,
    random_token,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use wasm_bindgen::JsValue;
use worker::{D1Database, Method, Request, Response, Result};

pub const MCP_RESOURCE: &str = "https://humaninformationinterface.com/mcp";
pub const READ_SCOPE: &str = "hii.context.read";
pub const ACTION_SCOPE: &str = "hii.actions.write";
const CODE_TTL_MS: i64 = 5 * 60 * 1000;
const ACCESS_TTL_MS: i64 = 60 * 60 * 1000;
const REFRESH_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY: usize = 16 * 1024;

#[derive(Deserialize)]
struct ClientRow {
    redirect_uris_json: String,
}

#[derive(Deserialize)]
struct CodeRow {
    client_id_hash: String,
    account_id: String,
    redirect_uri: String,
    resource: String,
    scopes: String,
    code_challenge: String,
}

#[derive(Deserialize)]
struct RefreshRow {
    client_id_hash: String,
    account_id: String,
    resource: String,
    scopes: String,
    grant_id: String,
    expires_at: i64,
    revoked_at: Option<i64>,
}

#[derive(Deserialize)]
struct RegisterInput {
    redirect_uris: Vec<String>,
    token_endpoint_auth_method: Option<String>,
}

pub struct OAuthIdentity {
    pub account_id: String,
    scopes: String,
}

impl OAuthIdentity {
    pub fn has_scope(&self, expected: &str) -> bool {
        self.scopes
            .split_whitespace()
            .any(|scope| scope == expected)
    }
}

pub fn is_oauth_path(path: &str) -> bool {
    matches!(
        path,
        "/.well-known/oauth-protected-resource"
            | "/.well-known/oauth-authorization-server"
            | "/oauth/register"
            | "/oauth/authorize"
            | "/oauth/token"
            | "/oauth/revoke"
    )
}

pub async fn handle(request: &mut Request, db: &D1Database) -> Result<Response> {
    let path = request.url()?.path().to_owned();
    match (request.method(), path.as_str()) {
        (Method::Get, "/.well-known/oauth-protected-resource") => json_response(
            200,
            json!({
                "resource": MCP_RESOURCE,
                "authorization_servers": [RP_ORIGIN],
                "scopes_supported": [READ_SCOPE, ACTION_SCOPE],
                "bearer_methods_supported": ["header"]
            }),
        ),
        (Method::Get, "/.well-known/oauth-authorization-server") => json_response(
            200,
            json!({
                "issuer": RP_ORIGIN,
                "authorization_endpoint": format!("{RP_ORIGIN}/oauth/authorize"),
                "token_endpoint": format!("{RP_ORIGIN}/oauth/token"),
                "registration_endpoint": format!("{RP_ORIGIN}/oauth/register"),
                "revocation_endpoint": format!("{RP_ORIGIN}/oauth/revoke"),
                "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
                "token_endpoint_auth_methods_supported": ["none"],
                "code_challenge_methods_supported": ["S256"],
                "scopes_supported": [READ_SCOPE, ACTION_SCOPE]
            }),
        ),
        (Method::Post, "/oauth/register") => register_client(request, db).await,
        (Method::Get, "/oauth/authorize") => authorize_get(request, db).await,
        (Method::Post, "/oauth/authorize") => authorize_post(request, db).await,
        (Method::Post, "/oauth/token") => token(request, db).await,
        (Method::Post, "/oauth/revoke") => revoke(request, db).await,
        _ => oauth_error(405, "invalid_request", "Unsupported OAuth method."),
    }
}

async fn register_client(request: &mut Request, db: &D1Database) -> Result<Response> {
    let input: RegisterInput = read_json(request).await?;
    if input.redirect_uris.is_empty()
        || input.redirect_uris.len() > 8
        || input
            .token_endpoint_auth_method
            .as_deref()
            .is_some_and(|v| v != "none")
        || !input.redirect_uris.iter().all(|uri| valid_redirect(uri))
    {
        return oauth_error(
            400,
            "invalid_client_metadata",
            "Only ChatGPT HTTPS callback URLs are accepted.",
        );
    }
    let client_id = format!("hii_{}", random_token()?);
    let created_at = now_ms();
    db.prepare("INSERT INTO oauth_clients (client_id_hash, redirect_uris_json, created_at) VALUES (?1, ?2, ?3)")
        .bind(&[
            hash_token(&client_id).as_str().into(),
            serde_json::to_string(&input.redirect_uris)?.as_str().into(),
            JsValue::from_f64(created_at as f64),
        ])?.run().await?;
    json_response(
        201,
        json!({
            "client_id": client_id,
            "client_id_issued_at": created_at / 1000,
            "redirect_uris": input.redirect_uris,
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"]
        }),
    )
}

async fn authorize_get(request: &Request, db: &D1Database) -> Result<Response> {
    let params = authorize_params(request)?;
    if !validate_authorize(db, &params).await? {
        return oauth_error(
            400,
            "invalid_request",
            "The OAuth request is invalid or the client is not registered.",
        );
    }
    let session = match cookie(request, SESSION_COOKIE)? {
        Some(token) => active_session(db, &token).await?,
        None => None,
    };
    let Some(session) = session else {
        let target = format!(
            "{}?{}",
            request.url()?.path(),
            request.url()?.query().unwrap_or_default()
        );
        let mut response = Response::empty()?.with_status(302);
        response.headers_mut().set(
            "Location",
            &format!("/?oauth_return={}", percent_encode(&target)),
        )?;
        return Ok(response);
    };
    let writes = params
        .scope
        .split_whitespace()
        .any(|scope| scope == ACTION_SCOPE);
    let access_copy = if writes {
        "ChatGPT can read your authorized HII spaces, add notes, and queue governed objectives for a linked HII device. Every action remains visible on the canvas and is recorded in HII."
    } else {
        "ChatGPT can read titles, text, links, and source metadata from HII spaces you authorize."
    };
    let boundary_copy = if writes {
        "Cannot directly access your terminal, local files, passwords, cookies, browser sessions, or private HII database. Device work runs through the installed HII agent and its local approval and receipt policy."
    } else {
        "Cannot read your Mac files, local HII database, terminal, passwords, cookies, or browser history."
    };
    let button_copy = if writes {
        "Allow HII control"
    } else {
        "Allow read-only access"
    };
    let form = format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect ChatGPT to HII</title><style>:root{{color-scheme:light dark}}*{{box-sizing:border-box}}body{{margin:0;background:#f7f7f5;color:#171716;font:15px ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}main{{width:min(520px,calc(100% - 32px));margin:12vh auto;background:#fff;border:1px solid #deded9;border-radius:20px;padding:28px;box-shadow:0 18px 60px #00000010}}small{{color:#686863}}h1{{font-size:24px;letter-spacing:-.03em;margin:12px 0}}p{{line-height:1.5}}.scope{{padding:14px;border:1px solid #e6e6e1;border-radius:12px;background:#fafaf8}}button{{width:100%;border:0;border-radius:999px;background:#171716;color:#fff;padding:12px 16px;font-weight:650;cursor:pointer}}a{{display:block;text-align:center;margin-top:14px;color:inherit}}@media(prefers-color-scheme:dark){{body{{background:#111;color:#ecece8}}main{{background:#1c1c1a;border-color:#333}}.scope{{background:#242421;border-color:#383835}}small{{color:#aaa}}button{{background:#ecece8;color:#171716}}}}</style></head><body><main><small>HII / connected app</small><h1>Connect ChatGPT</h1><p>Signed in as <strong>{}</strong>.</p><p class="scope"><strong>Access:</strong> {}<br><br><strong>Boundary:</strong> {}</p><form method="post" action="/oauth/authorize">{}<input type="hidden" name="csrf" value="{}"><button type="submit">{}</button></form><a href="{}">Cancel</a></main></body></html>"#,
        html_escape(&session.handle),
        access_copy,
        boundary_copy,
        hidden_inputs(&params),
        html_escape(&session.csrf_token),
        button_copy,
        html_escape(&oauth_redirect_error_url(&params, "access_denied"))
    );
    let mut response = Response::ok(form)?;
    response
        .headers_mut()
        .set("Content-Type", "text/html; charset=utf-8")?;
    Ok(response)
}

async fn authorize_post(request: &mut Request, db: &D1Database) -> Result<Response> {
    let values = read_form(request).await?;
    let params = AuthParams::from_pairs(&values)?;
    if !validate_authorize(db, &params).await? {
        return oauth_error(
            400,
            "invalid_request",
            "The OAuth request is invalid or the client is not registered.",
        );
    }
    let Some(token_value) = cookie(request, SESSION_COOKIE)? else {
        return oauth_redirect_error(&params, "access_denied");
    };
    let Some(session) = active_session(db, &token_value).await? else {
        return oauth_redirect_error(&params, "access_denied");
    };
    if values.get("csrf").map(String::as_str) != Some(session.csrf_token.as_str()) {
        return oauth_redirect_error(&params, "access_denied");
    }
    let code = random_token()?;
    let now = now_ms();
    db.prepare("INSERT INTO oauth_authorization_codes (code_hash,client_id_hash,account_id,redirect_uri,resource,scopes,code_challenge,expires_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)")
        .bind(&[
            hash_token(&code).as_str().into(), hash_token(&params.client_id).as_str().into(), session.account_id.as_str().into(),
            params.redirect_uri.as_str().into(), params.resource.as_str().into(), params.scope.as_str().into(), params.code_challenge.as_str().into(),
            JsValue::from_f64((now + CODE_TTL_MS) as f64), JsValue::from_f64(now as f64),
        ])?.run().await?;
    let separator = if params.redirect_uri.contains('?') {
        '&'
    } else {
        '?'
    };
    let mut location = format!(
        "{}{}code={}",
        params.redirect_uri,
        separator,
        percent_encode(&code)
    );
    if !params.state.is_empty() {
        location.push_str("&state=");
        location.push_str(&percent_encode(&params.state));
    }
    let mut response = Response::empty()?.with_status(302);
    response.headers_mut().set("Location", &location)?;
    Ok(response)
}

async fn token(request: &mut Request, db: &D1Database) -> Result<Response> {
    let values = read_form(request).await?;
    match values.get("grant_type").map(String::as_str) {
        Some("authorization_code") => exchange_code(&values, db).await,
        Some("refresh_token") => exchange_refresh(&values, db).await,
        _ => oauth_error(
            400,
            "unsupported_grant_type",
            "Supported grants are authorization_code and refresh_token.",
        ),
    }
}

async fn exchange_code(
    values: &std::collections::HashMap<String, String>,
    db: &D1Database,
) -> Result<Response> {
    let Some(code) = values.get("code").filter(|value| !value.is_empty()) else {
        return oauth_error(400, "invalid_request", "code is required.");
    };
    let Some(client_id) = values.get("client_id").filter(|value| !value.is_empty()) else {
        return oauth_error(400, "invalid_request", "client_id is required.");
    };
    let Some(redirect_uri) = values.get("redirect_uri").filter(|value| !value.is_empty()) else {
        return oauth_error(400, "invalid_request", "redirect_uri is required.");
    };
    let Some(verifier) = values
        .get("code_verifier")
        .filter(|value| !value.is_empty())
    else {
        return oauth_error(400, "invalid_request", "code_verifier is required.");
    };
    let resource = values
        .get("resource")
        .cloned()
        .unwrap_or_else(|| MCP_RESOURCE.into());
    let Some(row) = db.prepare("SELECT client_id_hash,account_id,redirect_uri,resource,scopes,code_challenge FROM oauth_authorization_codes WHERE code_hash=?1 AND used_at IS NULL AND expires_at>?2")
        .bind(&[hash_token(code).as_str().into(), JsValue::from_f64(now_ms() as f64)])?.first::<CodeRow>(None).await? else {
        return oauth_error(400, "invalid_grant", "The authorization code is invalid or expired.");
    };
    if row.client_id_hash != hash_token(client_id)
        || row.redirect_uri != *redirect_uri
        || row.resource != resource
        || pkce_challenge(verifier) != row.code_challenge
    {
        return oauth_error(
            400,
            "invalid_grant",
            "The authorization code did not match this client.",
        );
    }
    let exchange_nonce = random_token()?;
    let changed = db.prepare("UPDATE oauth_authorization_codes SET used_at=?1,exchange_nonce=?2 WHERE code_hash=?3 AND used_at IS NULL")
        .bind(&[JsValue::from_f64(now_ms() as f64), exchange_nonce.as_str().into(), hash_token(code).as_str().into()])?.run().await?
        .meta()?.and_then(|m| m.changes) == Some(1);
    if !changed {
        return oauth_error(
            400,
            "invalid_grant",
            "The authorization code was already used.",
        );
    }
    let grant_id = random_token()?;
    issue_tokens(
        db,
        &row.account_id,
        &row.client_id_hash,
        &row.resource,
        &row.scopes,
        &grant_id,
    )
    .await
}

async fn exchange_refresh(
    values: &std::collections::HashMap<String, String>,
    db: &D1Database,
) -> Result<Response> {
    let Some(refresh) = values.get("refresh_token") else {
        return oauth_error(400, "invalid_request", "refresh_token is required.");
    };
    let Some(client_id) = values.get("client_id") else {
        return oauth_error(400, "invalid_request", "client_id is required.");
    };
    let Some(row) = db.prepare("SELECT client_id_hash,account_id,resource,scopes,grant_id,expires_at,revoked_at FROM oauth_refresh_tokens WHERE token_hash=?1")
        .bind(&[hash_token(refresh).as_str().into()])?.first::<RefreshRow>(None).await? else {
        return oauth_error(400, "invalid_grant", "The refresh token is invalid or expired.");
    };
    if row.revoked_at.is_some() {
        revoke_family(db, &row.grant_id).await?;
        return oauth_error(
            400,
            "invalid_grant",
            "Refresh token reuse revoked this connector grant.",
        );
    }
    if row.expires_at <= now_ms() {
        revoke_family(db, &row.grant_id).await?;
        return oauth_error(
            400,
            "invalid_grant",
            "The refresh token is invalid or expired.",
        );
    }
    if row.client_id_hash != hash_token(client_id)
        || values
            .get("resource")
            .is_some_and(|resource| resource != &row.resource)
    {
        return oauth_error(
            400,
            "invalid_grant",
            "The refresh token belongs to another client or resource.",
        );
    }
    let rotated = db.prepare(
        "UPDATE oauth_refresh_tokens SET revoked_at=?1 WHERE token_hash=?2 AND revoked_at IS NULL",
    )
    .bind(&[
        JsValue::from_f64(now_ms() as f64),
        hash_token(refresh).as_str().into(),
    ])?
    .run()
    .await?
    .meta()?
    .and_then(|meta| meta.changes)
        == Some(1);
    if !rotated {
        revoke_family(db, &row.grant_id).await?;
        return oauth_error(400, "invalid_grant", "The refresh token was already used.");
    }
    issue_tokens(
        db,
        &row.account_id,
        &row.client_id_hash,
        &row.resource,
        &row.scopes,
        &row.grant_id,
    )
    .await
}

async fn issue_tokens(
    db: &D1Database,
    account_id: &str,
    client_hash: &str,
    resource: &str,
    scopes: &str,
    grant_id: &str,
) -> Result<Response> {
    let access = random_token()?;
    let refresh = random_token()?;
    let now = now_ms();
    db.batch(vec![
        db.prepare("INSERT INTO oauth_access_tokens (token_hash,grant_id,client_id_hash,account_id,resource,scopes,expires_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)")
            .bind(&[hash_token(&access).as_str().into(),grant_id.into(),client_hash.into(),account_id.into(),resource.into(),scopes.into(),JsValue::from_f64((now+ACCESS_TTL_MS) as f64),JsValue::from_f64(now as f64)])?,
        db.prepare("INSERT INTO oauth_refresh_tokens (token_hash,grant_id,client_id_hash,account_id,resource,scopes,expires_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)")
            .bind(&[hash_token(&refresh).as_str().into(),grant_id.into(),client_hash.into(),account_id.into(),resource.into(),scopes.into(),JsValue::from_f64((now+REFRESH_TTL_MS) as f64),JsValue::from_f64(now as f64)])?,
    ]).await?;
    json_response(
        200,
        json!({"access_token":access,"token_type":"Bearer","expires_in":ACCESS_TTL_MS/1000,"refresh_token":refresh,"scope":scopes,"resource":resource}),
    )
}

async fn revoke(request: &mut Request, db: &D1Database) -> Result<Response> {
    let values = read_form(request).await?;
    if let Some(token) = values.get("token") {
        let hash = hash_token(token);
        let now = now_ms();
        #[derive(Deserialize)]
        struct GrantRow {
            grant_id: String,
        }
        if let Some(row) = db.prepare("SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash=?1 UNION SELECT grant_id FROM oauth_access_tokens WHERE token_hash=?1 LIMIT 1")
            .bind(&[hash.as_str().into()])?.first::<GrantRow>(None).await? {
            revoke_family(db, &row.grant_id).await?;
        } else { db.batch(vec![
            db.prepare("UPDATE oauth_access_tokens SET revoked_at=?1 WHERE token_hash=?2 AND revoked_at IS NULL").bind(&[JsValue::from_f64(now as f64),hash.as_str().into()])?,
            db.prepare("UPDATE oauth_refresh_tokens SET revoked_at=?1 WHERE token_hash=?2 AND revoked_at IS NULL").bind(&[JsValue::from_f64(now as f64),hash.as_str().into()])?,
        ]).await?; }
    }
    Ok(Response::empty()?.with_status(200))
}

async fn revoke_family(db: &D1Database, grant_id: &str) -> Result<()> {
    let now = now_ms();
    db.batch(vec![
        db.prepare("UPDATE oauth_access_tokens SET revoked_at=?1 WHERE grant_id=?2 AND revoked_at IS NULL")
            .bind(&[JsValue::from_f64(now as f64), grant_id.into()])?,
        db.prepare("UPDATE oauth_refresh_tokens SET revoked_at=?1 WHERE grant_id=?2 AND revoked_at IS NULL")
            .bind(&[JsValue::from_f64(now as f64), grant_id.into()])?,
    ]).await?;
    Ok(())
}

pub async fn bearer_identity(request: &Request, db: &D1Database) -> Result<Option<OAuthIdentity>> {
    let Some(value) = request.headers().get("authorization")? else {
        return Ok(None);
    };
    let Some(token) = value.strip_prefix("Bearer ").filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    #[derive(Deserialize)]
    struct Row {
        account_id: String,
        scopes: String,
    }
    let row = db.prepare("SELECT account_id,scopes FROM oauth_access_tokens WHERE token_hash=?1 AND resource=?2 AND revoked_at IS NULL AND expires_at>?3")
        .bind(&[hash_token(token).as_str().into(), MCP_RESOURCE.into(), JsValue::from_f64(now_ms() as f64)])?.first::<Row>(None).await?;
    Ok(row
        .filter(|r| r.scopes.split_whitespace().any(|scope| scope == READ_SCOPE))
        .map(|r| OAuthIdentity {
            account_id: r.account_id,
            scopes: r.scopes,
        }))
}

pub fn auth_challenge() -> Result<Response> {
    let mut response = json_response(401, json!({"error":"authentication_required"}))?;
    response.headers_mut().set("WWW-Authenticate", &format!("Bearer error=\"invalid_token\", resource_metadata=\"{RP_ORIGIN}/.well-known/oauth-protected-resource\", scope=\"{READ_SCOPE} {ACTION_SCOPE}\""))?;
    Ok(response)
}

pub async fn purge_expired(db: &D1Database, now: i64) -> Result<()> {
    db.batch(vec![
        db.prepare("DELETE FROM oauth_authorization_codes WHERE expires_at <= ?1")
            .bind(&[JsValue::from_f64(now as f64)])?,
        db.prepare("DELETE FROM oauth_access_tokens WHERE expires_at <= ?1 OR (revoked_at IS NOT NULL AND revoked_at <= ?2)")
            .bind(&[
                JsValue::from_f64(now as f64),
                JsValue::from_f64((now - 24 * 60 * 60 * 1000) as f64),
            ])?,
        // Revoked refresh tokens stay until their natural expiry so reuse can
        // invalidate every successor in the same grant family.
        db.prepare("DELETE FROM oauth_refresh_tokens WHERE expires_at <= ?1")
            .bind(&[JsValue::from_f64(now as f64)])?,
        db.prepare("DELETE FROM oauth_clients WHERE created_at < ?1 AND NOT EXISTS (SELECT 1 FROM oauth_authorization_codes c WHERE c.client_id_hash = oauth_clients.client_id_hash) AND NOT EXISTS (SELECT 1 FROM oauth_access_tokens a WHERE a.client_id_hash = oauth_clients.client_id_hash) AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens r WHERE r.client_id_hash = oauth_clients.client_id_hash)")
            .bind(&[JsValue::from_f64((now - 30 * 24 * 60 * 60 * 1000) as f64)])?,
    ]).await?;
    Ok(())
}

#[derive(Clone)]
struct AuthParams {
    client_id: String,
    redirect_uri: String,
    response_type: String,
    scope: String,
    state: String,
    code_challenge: String,
    code_challenge_method: String,
    resource: String,
}

impl AuthParams {
    fn from_pairs(values: &std::collections::HashMap<String, String>) -> Result<Self> {
        let value = |key: &str| values.get(key).cloned().unwrap_or_default();
        Ok(Self {
            client_id: value("client_id"),
            redirect_uri: value("redirect_uri"),
            response_type: value("response_type"),
            scope: value("scope"),
            state: value("state"),
            code_challenge: value("code_challenge"),
            code_challenge_method: value("code_challenge_method"),
            resource: value("resource"),
        })
    }
}

fn authorize_params(request: &Request) -> Result<AuthParams> {
    let values = request
        .url()?
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    AuthParams::from_pairs(&values)
}

async fn validate_authorize(db: &D1Database, p: &AuthParams) -> Result<bool> {
    if p.response_type != "code"
        || p.code_challenge_method != "S256"
        || p.code_challenge.len() != 43
        || p.resource != MCP_RESOURCE
        || p.scope.is_empty()
        || !valid_scope_set(&p.scope)
        || !valid_redirect(&p.redirect_uri)
        || p.client_id.is_empty()
    {
        return Ok(false);
    }
    let row = db.prepare("SELECT redirect_uris_json FROM oauth_clients WHERE client_id_hash=?1 AND revoked_at IS NULL")
        .bind(&[hash_token(&p.client_id).as_str().into()])?.first::<ClientRow>(None).await?;
    let allowed = row
        .and_then(|r| serde_json::from_str::<Vec<String>>(&r.redirect_uris_json).ok())
        .is_some_and(|uris| uris.iter().any(|uri| uri == &p.redirect_uri));
    Ok(allowed)
}

fn valid_scope_set(value: &str) -> bool {
    value.split_whitespace().any(|scope| scope == READ_SCOPE)
        && value
            .split_whitespace()
            .all(|scope| matches!(scope, READ_SCOPE | ACTION_SCOPE))
}

fn valid_redirect(value: &str) -> bool {
    let Ok(url) = worker::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("chatgpt.com")
        && (url.path().starts_with("/connector/oauth/")
            || url.path() == "/connector_platform_oauth_redirect")
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

async fn read_json<T: for<'de> Deserialize<'de>>(request: &mut Request) -> Result<T> {
    let bytes = request.bytes().await?;
    if bytes.len() > MAX_BODY {
        return Err(worker::Error::RustError("body_too_large".into()));
    }
    serde_json::from_slice(&bytes).map_err(Into::into)
}
async fn read_form(request: &mut Request) -> Result<std::collections::HashMap<String, String>> {
    let bytes = request.bytes().await?;
    if bytes.len() > MAX_BODY {
        return Err(worker::Error::RustError("body_too_large".into()));
    }
    serde_urlencoded::from_bytes(&bytes).map_err(|e| worker::Error::RustError(e.to_string()))
}
fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn hidden_inputs(p: &AuthParams) -> String {
    [
        ("client_id", &p.client_id),
        ("redirect_uri", &p.redirect_uri),
        ("response_type", &p.response_type),
        ("scope", &p.scope),
        ("state", &p.state),
        ("code_challenge", &p.code_challenge),
        ("code_challenge_method", &p.code_challenge_method),
        ("resource", &p.resource),
    ]
    .into_iter()
    .map(|(k, v)| {
        format!(
            "<input type=\"hidden\" name=\"{}\" value=\"{}\">",
            k,
            html_escape(v)
        )
    })
    .collect()
}
fn oauth_error(status: u16, error: &str, description: &str) -> Result<Response> {
    json_response(
        status,
        json!({"error":error,"error_description":description}),
    )
}

fn oauth_redirect_error_url(params: &AuthParams, error: &str) -> String {
    let separator = if params.redirect_uri.contains('?') {
        '&'
    } else {
        '?'
    };
    let mut location = format!(
        "{}{}error={}",
        params.redirect_uri,
        separator,
        percent_encode(error)
    );
    if !params.state.is_empty() {
        location.push_str("&state=");
        location.push_str(&percent_encode(&params.state));
    }
    location
}

fn oauth_redirect_error(params: &AuthParams, error: &str) -> Result<Response> {
    let mut response = Response::empty()?.with_status(302);
    response
        .headers_mut()
        .set("Location", &oauth_redirect_error_url(params, error))?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redirect_allowlist_is_chatgpt_only() {
        assert!(valid_redirect(
            "https://chatgpt.com/connector_platform_oauth_redirect"
        ));
        assert!(valid_redirect("https://chatgpt.com/connector/oauth/abc"));
        assert!(!valid_redirect("https://evil.example/callback"));
    }
    #[test]
    fn pkce_is_base64url_sha256() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn denial_redirect_preserves_state_and_existing_query() {
        let params = AuthParams {
            client_id: "client".into(),
            redirect_uri: "https://chatgpt.com/connector/oauth/callback?source=hii".into(),
            response_type: "code".into(),
            scope: READ_SCOPE.into(),
            state: "space and/slash".into(),
            code_challenge: "challenge".into(),
            code_challenge_method: "S256".into(),
            resource: MCP_RESOURCE.into(),
        };
        assert_eq!(
            oauth_redirect_error_url(&params, "access_denied"),
            "https://chatgpt.com/connector/oauth/callback?source=hii&error=access_denied&state=space%20and%2Fslash"
        );
    }

    #[test]
    fn oauth_scopes_are_incremental_and_bounded() {
        assert!(valid_scope_set(READ_SCOPE));
        assert!(valid_scope_set(&format!("{READ_SCOPE} {ACTION_SCOPE}")));
        assert!(!valid_scope_set(ACTION_SCOPE));
        assert!(!valid_scope_set(&format!("{READ_SCOPE} hii.full")));
    }
}
