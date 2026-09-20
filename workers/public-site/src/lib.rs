#![forbid(unsafe_code)]

mod admin;
mod browser_snapshot;
mod chat;
mod device;
mod feed;
mod remote;
mod search;
mod site_records;
mod workspace;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use passkey_rp::{
    AuthenticationVerification, Challenge, PasskeyRp, RegistrationVerification, RelyingParty,
    StoredCredential, UserHandleVerification, decode_base64url,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use wasm_bindgen::JsValue;
use worker::{Context, D1Database, Date, Env, Headers, Method, Request, Response, Result, event};

const RP_ID: &str = "humaninformationinterface.com";
const RP_ORIGIN: &str = "https://humaninformationinterface.com";
const CEREMONY_TTL_MS: i64 = 5 * 60 * 1000;
const SESSION_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
const SESSION_TTL_MS: i64 = SESSION_TTL_SECONDS * 1000;
const MAX_BODY_BYTES: usize = 32 * 1024;
const SESSION_COOKIE: &str = "__Host-hii_session";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegisterStart {
    handle: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegisterFinish {
    ceremony_id: String,
    credential: RegistrationCredential,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginFinish {
    ceremony_id: String,
    credential: LoginCredential,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationCredential {
    id: String,
    raw_id: String,
    #[serde(rename = "type")]
    kind: String,
    response: RegistrationResponse,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationResponse {
    #[serde(rename = "clientDataJSON")]
    client_data_json: String,
    attestation_object: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginCredential {
    id: String,
    raw_id: String,
    #[serde(rename = "type")]
    kind: String,
    response: LoginResponse,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginResponse {
    #[serde(rename = "clientDataJSON")]
    client_data_json: String,
    authenticator_data: String,
    signature: String,
    user_handle: Option<String>,
}

#[derive(Deserialize)]
struct CeremonyRow {
    account_id: Option<String>,
    handle: Option<String>,
    challenge: String,
}

#[derive(Deserialize)]
struct CredentialRow {
    account_id: String,
    credential_json: String,
}

#[derive(Deserialize)]
struct SessionRow {
    account_id: String,
    handle: String,
    csrf_token: String,
    created_at: i64,
}

#[derive(Deserialize)]
struct RateRow {
    count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse<'a> {
    authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    handle: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    csrf_token: Option<&'a str>,
}

#[event(fetch)]
pub async fn main(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    match handle_request(&mut request, &env).await {
        Ok(response) => Ok(response),
        Err(error) => {
            worker::console_error!("request failed: {error}");
            secure_no_store(api_error(500, "internal_error")?)
        }
    }
}

async fn handle_request(request: &mut Request, env: &Env) -> Result<Response> {
    let url = request.url()?;
    if url.host_str() == Some("www.humaninformationinterface.com") {
        let mut canonical = url;
        canonical
            .set_host(Some(RP_ID))
            .map_err(|_| "invalid canonical host")?;
        let mut response = Response::empty()?.with_status(308);
        response.headers_mut().set("Location", canonical.as_str())?;
        return secure(response);
    }

    let path = url.path().to_owned();
    let method = request.method();
    let db = env.d1("IDENTITY")?;

    if path.starts_with("/api/") {
        if method == Method::Get && path == "/api/site-osm" {
            if !rate_limit(request, env, &db, "site-osm", 1_000_000).await? {
                return secure_no_store(api_error(429, "rate_limited")?);
            }
            return secure_no_store(site_records::osm_map(request).await?);
        }
        if method == Method::Get && path == "/api/site-history" {
            if !rate_limit(request, env, &db, "site-history", 1_000_000).await? {
                return secure_no_store(api_error(429, "rate_limited")?);
            }
            return secure_no_store(site_records::nearby_history(request).await?);
        }
        if method == Method::Get && path == "/api/site-records" {
            return secure_no_store(site_records::list(request, &db).await?);
        }
        if method == Method::Get && path == "/api/search" {
            if !rate_limit(request, env, &db, "web-search", 100_000).await? {
                return secure_no_store(api_error(429, "rate_limited")?);
            }
            return secure_no_store(search::handle_search(request).await?);
        }
        if remote::is_remote_host_socket(&path) {
            return remote::handle_host_socket(request, env).await;
        }
        if browser_snapshot::is_native_browser_snapshot_path(&path) {
            if request.headers().get("origin")?.is_some() {
                return secure_no_store(api_error(403, "native_device_required")?);
            }
            return secure_no_store(
                browser_snapshot::handle_native_browser_snapshot_api(request, env, &db).await?,
            );
        }
        if device::is_native_device_path(&path) {
            if request.headers().get("origin")?.is_some() {
                return secure_no_store(api_error(403, "native_device_required")?);
            }
            return secure_no_store(device::handle_native_device_api(request, &db).await?);
        }
        if matches!(method, Method::Post | Method::Delete) && !origin_allowed(request)? {
            return secure_no_store(api_error(403, "cross_origin_denied")?);
        }
        if path.starts_with("/api/chat")
            || device::is_account_device_path(&path)
            || workspace::is_workspace_api_path(&path)
            || browser_snapshot::is_browser_snapshot_path(&path)
            || feed::is_feed_api_path(&path)
            || remote::is_remote_api_path(&path)
            || site_records::is_path(&path)
        {
            let Some(token) = cookie(request, SESSION_COOKIE)? else {
                return secure_no_store(api_error(401, "authentication_required")?);
            };
            let Some(session) = active_session(&db, &token).await? else {
                return secure_no_store(api_error(401, "authentication_required")?);
            };
            if matches!(method, Method::Post | Method::Delete) {
                let action = if path.starts_with("/api/chat") {
                    "chat-write"
                } else if device::is_account_device_path(&path) {
                    "device-write"
                } else if workspace::is_workspace_api_path(&path) {
                    "workspace-write"
                } else if browser_snapshot::is_browser_snapshot_path(&path) {
                    "browser-snapshot-write"
                } else if remote::is_remote_api_path(&path) {
                    "remote-write"
                } else if site_records::is_path(&path) {
                    "site-record-write"
                } else {
                    "feed-write"
                };
                if !rate_limit(request, env, &db, action, 5_000_000).await? {
                    return secure_no_store(api_error(429, "rate_limited")?);
                }
            }
            if remote::is_remote_api_path(&path) {
                let response = remote::handle_remote_api(request, env, &session).await?;
                // The viewer upgrade must pass through untouched: a 101 carries
                // no body and cannot take the no-store security headers.
                if response.status_code() == 101 {
                    return Ok(response);
                }
                return secure_no_store(response);
            }
            if site_records::is_path(&path) {
                return secure_no_store(site_records::write(request, &db, &session).await?);
            }
            if path.starts_with("/api/chat") {
                let passkey_recent = now_ms().saturating_sub(session.created_at) <= CEREMONY_TTL_MS;
                let response = chat::handle_chat_api(
                    request,
                    &db,
                    &session.account_id,
                    &session.csrf_token,
                    passkey_recent,
                )
                .await?
                .unwrap_or(api_error(404, "not_found")?);
                return secure_no_store(response);
            }
            if admin::is_admin_api_path(&path) {
                return secure_no_store(
                    admin::handle_admin_api(request, env, &db, &session).await?,
                );
            }
            if device::is_account_device_path(&path) {
                return secure_no_store(
                    device::handle_account_device_api(request, &db, &session).await?,
                );
            }
            if workspace::is_workspace_api_path(&path) {
                return secure_no_store(
                    workspace::handle_workspace_api(request, &db, &session).await?,
                );
            }
            if browser_snapshot::is_browser_snapshot_path(&path) {
                return secure_no_store(
                    browser_snapshot::handle_browser_snapshot_api(
                        request,
                        env,
                        &db,
                        &session.account_id,
                        &session.csrf_token,
                    )
                    .await?,
                );
            }
            let actor =
                feed::FeedActor::new(&session.account_id, &session.handle, &session.csrf_token);
            return secure_no_store(feed::handle_feed_request(request, &db, &actor).await?);
        }
        let response = match (method, path.as_str()) {
            (Method::Get, "/api/auth/session") => session_status(request, &db).await,
            (Method::Post, "/api/auth/register/start") => {
                if rate_limit(request, env, &db, "register-start", 1_000_000).await? {
                    register_start(request, &db).await
                } else {
                    api_error(429, "rate_limited")
                }
            }
            (Method::Post, "/api/auth/register/finish") => {
                if rate_limit(request, env, &db, "register-finish", 1_000_000).await? {
                    register_finish(request, &db).await
                } else {
                    api_error(429, "rate_limited")
                }
            }
            (Method::Post, "/api/auth/login/start") => {
                if rate_limit(request, env, &db, "login-start", 2_000_000).await? {
                    login_start(&db).await
                } else {
                    api_error(429, "rate_limited")
                }
            }
            (Method::Post, "/api/auth/login/finish") => {
                if rate_limit(request, env, &db, "login-finish", 2_000_000).await? {
                    login_finish(request, &db).await
                } else {
                    api_error(429, "rate_limited")
                }
            }
            (Method::Post, "/api/auth/logout") => logout(request, &db).await,
            _ => api_error(404, "not_found"),
        }?;
        return secure_no_store(response);
    }

    if method != Method::Get && method != Method::Head {
        return secure_no_store(api_error(405, "method_not_allowed")?);
    }

    if path == "/install" {
        let mut response = if method == Method::Head {
            Response::empty()?
        } else {
            Response::ok(include_str!("../../../scripts/install.sh"))?
        };
        response
            .headers_mut()
            .set("Content-Type", "text/plain; charset=utf-8")?;
        return secure_no_store(response);
    }

    if let Some(target) = path
        .strip_prefix("/download/")
        .filter(|target| matches!(*target, "windows" | "macos" | "windows.json" | "macos.json"))
    {
        let Some(token) = cookie(request, SESSION_COOKIE)? else {
            return secure_no_store(api_error(401, "authentication_required")?);
        };
        if active_session(&db, &token).await?.is_none() {
            return secure_no_store(api_error(401, "authentication_required")?);
        }
        // The download page is a static export, so it cannot read R2 at build
        // time. It fetches the manifest from here to show the version, size
        // and digest of the build it is about to hand over.
        return match target.strip_suffix(".json") {
            Some(platform) => secure_no_store(release_manifest(env, platform).await?),
            None => secure_no_store(download_desktop(request, env, target).await?),
        };
    }

    if let Some(asset) = path.strip_prefix("/cli/releases/latest/") {
        return secure_no_store(download_cli(request, env, asset).await?);
    }

    if let Some(asset) = path.strip_prefix("/ui/") {
        return secure(download_ui(request, env, asset).await?);
    }

    let response = env.assets("ASSETS")?.fetch_request(request.clone()?).await?;
    if path == "/site-analysis" || path == "/site-analysis.html" {
        // Asset responses have immutable fetch headers. Copy them before adding
        // route-specific map permissions, preserving status and streaming body.
        let headers = Headers::new();
        for (name, value) in response.headers().entries() {
            headers.append(&name, &value)?;
        }
        headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.googleapis.com https://*.gstatic.com *.google.com https://*.ggpht.com *.googleusercontent.com blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https://tile.openstreetmap.org https://gibs.earthdata.nasa.gov https://*.googleapis.com https://*.gstatic.com *.google.com *.googleusercontent.com; media-src 'self' blob:; connect-src 'self' https://tile.openstreetmap.org https://gibs.earthdata.nasa.gov https://*.googleapis.com *.google.com https://*.gstatic.com data: blob:; font-src 'self' https://fonts.gstatic.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; frame-src *.google.com; worker-src 'self' blob:; manifest-src 'self'; upgrade-insecure-requests")?;
        headers.set("Referrer-Policy", "strict-origin-when-cross-origin")?;
        let (builder, body) = response.into_parts();
        return Ok(builder.with_headers(headers).body(body));
    }
    Ok(response)
}

async fn register_start(request: &mut Request, db: &D1Database) -> Result<Response> {
    let input: RegisterStart = read_json(request).await?;
    let Some(handle) = normalize_handle(&input.handle) else {
        return api_error(400, "invalid_handle");
    };

    let account_bytes = random_bytes(32)?;
    let account_id = URL_SAFE_NO_PAD.encode(&account_bytes);
    let ceremony_id = random_token()?;
    let challenge = Challenge::generate().map_err(passkey_error)?;
    let now = now_ms();

    db.prepare(
        "INSERT INTO ceremonies (id_hash, kind, account_id, handle, challenge, expires_at, created_at) VALUES (?1, 'register', ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(&[
        JsValue::from_str(&hash_token(&ceremony_id)),
        JsValue::from_str(&account_id),
        JsValue::from_str(&handle),
        JsValue::from_str(&challenge.to_base64url()),
        JsValue::from_f64((now + CEREMONY_TTL_MS) as f64),
        JsValue::from_f64(now as f64),
    ])?
    .run()
    .await?;

    json_response(
        200,
        json!({
            "ceremonyId": ceremony_id,
            "publicKey": {
                "rp": { "id": RP_ID, "name": "HII" },
                "user": { "id": account_id, "name": handle, "displayName": handle },
                "challenge": challenge.to_base64url(),
                "pubKeyCredParams": [{ "type": "public-key", "alg": -7 }],
                "timeout": 60000,
                "authenticatorSelection": {
                    "residentKey": "required",
                    "requireResidentKey": true,
                    "userVerification": "required"
                },
                "attestation": "none"
            }
        }),
    )
}

async fn register_finish(request: &mut Request, db: &D1Database) -> Result<Response> {
    let input: RegisterFinish = read_json(request).await?;
    if input.credential.kind != "public-key" || input.credential.id != input.credential.raw_id {
        return api_error(400, "registration_failed");
    }
    let state = ceremony(db, &input.ceremony_id, "register").await?;
    let account_id = state.account_id.ok_or_else(|| worker::Error::BadEncoding)?;
    let handle = state.handle.ok_or_else(|| worker::Error::BadEncoding)?;
    let challenge = challenge(&state.challenge)?;
    let credential_id = decode(&input.credential.raw_id)?;
    let client_data = decode(&input.credential.response.client_data_json)?;
    let attestation = decode(&input.credential.response.attestation_object)?;
    let verifier = verifier()?;
    let verified = verifier
        .verify_registration(RegistrationVerification::new(
            &challenge,
            &credential_id,
            &client_data,
            &attestation,
        ))
        .map_err(passkey_error)?;
    let stored = serde_json::to_string(verified.credential())?;
    let (session_token, session_hash, csrf) = new_session()?;
    let now = now_ms();

    let result = db
        .batch(vec![
            db.prepare("INSERT INTO accounts (id, handle, created_at) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM ceremonies WHERE id_hash = ?4 AND kind = 'register' AND expires_at > ?3)")
                .bind(&[
                    JsValue::from_str(&account_id),
                    JsValue::from_str(&handle),
                    JsValue::from_f64(now as f64),
                    JsValue::from_str(&hash_token(&input.ceremony_id)),
                ])?,
            db.prepare("INSERT INTO credentials (id, account_id, credential_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)")
                .bind(&[
                    JsValue::from_str(&input.credential.raw_id),
                    JsValue::from_str(&account_id),
                    JsValue::from_str(&stored),
                    JsValue::from_f64(now as f64),
                ])?,
            db.prepare("INSERT INTO sessions (token_hash, account_id, csrf_token, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
                .bind(&[
                    JsValue::from_str(&session_hash),
                    JsValue::from_str(&account_id),
                    JsValue::from_str(&csrf),
                    JsValue::from_f64((now + SESSION_TTL_MS) as f64),
                    JsValue::from_f64(now as f64),
                ])?,
            db.prepare("DELETE FROM ceremonies WHERE id_hash = ?1")
                .bind(&[JsValue::from_str(&hash_token(&input.ceremony_id))])?,
        ])
        .await;
    if result.is_err() {
        return api_error(409, "registration_failed");
    }

    authenticated_response(&account_id, &handle, &csrf, &session_token)
}

async fn login_start(db: &D1Database) -> Result<Response> {
    let ceremony_id = random_token()?;
    let challenge = Challenge::generate().map_err(passkey_error)?;
    let now = now_ms();
    db.prepare(
        "INSERT INTO ceremonies (id_hash, kind, challenge, expires_at, created_at) VALUES (?1, 'login', ?2, ?3, ?4)",
    )
    .bind(&[
        JsValue::from_str(&hash_token(&ceremony_id)),
        JsValue::from_str(&challenge.to_base64url()),
        JsValue::from_f64((now + CEREMONY_TTL_MS) as f64),
        JsValue::from_f64(now as f64),
    ])?
    .run()
    .await?;
    json_response(
        200,
        json!({
            "ceremonyId": ceremony_id,
            "publicKey": {
                "challenge": challenge.to_base64url(),
                "rpId": RP_ID,
                "timeout": 60000,
                "userVerification": "required"
            }
        }),
    )
}

async fn login_finish(request: &mut Request, db: &D1Database) -> Result<Response> {
    let input: LoginFinish = read_json(request).await?;
    if input.credential.kind != "public-key" || input.credential.id != input.credential.raw_id {
        return api_error(401, "authentication_failed");
    }
    let state = ceremony(db, &input.ceremony_id, "login").await?;
    let row: CredentialRow = db
        .prepare("SELECT account_id, credential_json FROM credentials WHERE id = ?1 LIMIT 1")
        .bind(&[JsValue::from_str(&input.credential.raw_id)])?
        .first(None)
        .await?
        .ok_or_else(|| worker::Error::BadEncoding)?;
    let stored: StoredCredential = serde_json::from_str(&row.credential_json)?;
    let challenge = challenge(&state.challenge)?;
    let credential_id = decode(&input.credential.raw_id)?;
    let client_data = decode(&input.credential.response.client_data_json)?;
    let authenticator_data = decode(&input.credential.response.authenticator_data)?;
    let signature = decode(&input.credential.response.signature)?;
    let response_handle = input
        .credential
        .response
        .user_handle
        .as_deref()
        .map(decode)
        .transpose()?;
    let expected_handle = decode(&row.account_id)?;
    let verifier = verifier()?;
    let verified = verifier
        .verify_authentication(AuthenticationVerification::new(
            &challenge,
            &credential_id,
            &client_data,
            &authenticator_data,
            &signature,
            &stored,
            UserHandleVerification::for_discoverable_credential(
                &expected_handle,
                response_handle.as_deref(),
            ),
        ))
        .map_err(passkey_error)?;
    let updated = serde_json::to_string(verified.credential())?;
    let account: Option<String> = db
        .prepare("SELECT handle FROM accounts WHERE id = ?1 LIMIT 1")
        .bind(&[JsValue::from_str(&row.account_id)])?
        .first(Some("handle"))
        .await?;
    let handle = account.ok_or_else(|| worker::Error::BadEncoding)?;
    let (session_token, session_hash, csrf) = new_session()?;
    let now = now_ms();
    let results = db
        .batch(vec![
            db.prepare("UPDATE credentials SET credential_json = ?1, updated_at = ?2 WHERE id = ?3 AND credential_json = ?4")
                .bind(&[
                    JsValue::from_str(&updated),
                    JsValue::from_f64(now as f64),
                    JsValue::from_str(&input.credential.raw_id),
                    JsValue::from_str(&row.credential_json),
                ])?,
            db.prepare("INSERT INTO sessions (token_hash, account_id, csrf_token, expires_at, created_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM ceremonies WHERE id_hash = ?6 AND kind = 'login' AND expires_at > ?5) AND EXISTS (SELECT 1 FROM credentials WHERE id = ?7 AND credential_json = ?8)")
                .bind(&[
                    JsValue::from_str(&session_hash),
                    JsValue::from_str(&row.account_id),
                    JsValue::from_str(&csrf),
                    JsValue::from_f64((now + SESSION_TTL_MS) as f64),
                    JsValue::from_f64(now as f64),
                    JsValue::from_str(&hash_token(&input.ceremony_id)),
                    JsValue::from_str(&input.credential.raw_id),
                    JsValue::from_str(&updated),
                ])?,
            db.prepare("DELETE FROM ceremonies WHERE id_hash = ?1")
                .bind(&[JsValue::from_str(&hash_token(&input.ceremony_id))])?,
        ])
        .await?;
    let session_created = results
        .get(1)
        .and_then(|result| result.meta().ok().flatten())
        .and_then(|meta| meta.changes)
        == Some(1);
    if !session_created {
        return api_error(401, "authentication_failed");
    }
    authenticated_response(&row.account_id, &handle, &csrf, &session_token)
}

async fn session_status(request: &Request, db: &D1Database) -> Result<Response> {
    let Some(token) = cookie(request, SESSION_COOKIE)? else {
        return json_response(
            200,
            SessionResponse {
                authenticated: false,
                account_id: None,
                handle: None,
                csrf_token: None,
            },
        );
    };
    let row = active_session(db, &token).await?;
    match row {
        Some(session) => json_response(
            200,
            SessionResponse {
                authenticated: true,
                account_id: Some(&session.account_id),
                handle: Some(&session.handle),
                csrf_token: Some(&session.csrf_token),
            },
        ),
        None => json_response(
            200,
            SessionResponse {
                authenticated: false,
                account_id: None,
                handle: None,
                csrf_token: None,
            },
        ),
    }
}

async fn logout(request: &Request, db: &D1Database) -> Result<Response> {
    let token = cookie(request, SESSION_COOKIE)?.ok_or_else(|| worker::Error::BadEncoding)?;
    let session = active_session(db, &token)
        .await?
        .ok_or_else(|| worker::Error::BadEncoding)?;
    let supplied = request.headers().get("x-hii-csrf")?.unwrap_or_default();
    if supplied.is_empty() || supplied != session.csrf_token {
        return api_error(403, "csrf_denied");
    }
    db.prepare("DELETE FROM sessions WHERE token_hash = ?1")
        .bind(&[JsValue::from_str(&hash_token(&token))])?
        .run()
        .await?;
    let mut response = json_response(
        200,
        SessionResponse {
            authenticated: false,
            account_id: None,
            handle: None,
            csrf_token: None,
        },
    )?;
    response
        .headers_mut()
        .append("Set-Cookie", &clear_session_cookie())?;
    Ok(response)
}

async fn active_session(db: &D1Database, token: &str) -> Result<Option<SessionRow>> {
    db.prepare("SELECT a.id AS account_id, a.handle, s.csrf_token, s.created_at FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?1 AND s.expires_at > ?2 LIMIT 1")
        .bind(&[
            JsValue::from_str(&hash_token(token)),
            JsValue::from_f64(now_ms() as f64),
        ])?
        .first(None)
        .await
}

#[event(scheduled)]
pub async fn scheduled(
    _event: worker::ScheduledEvent,
    env: Env,
    _context: worker::ScheduleContext,
) {
    if let Ok(db) = env.d1("IDENTITY") {
        let now = now_ms();
        for _ in 0..20 {
            match chat::purge_expired_messages(&db, now).await {
                Ok(500) => continue,
                _ => break,
            }
        }
    }
}

async fn ceremony(db: &D1Database, token: &str, kind: &str) -> Result<CeremonyRow> {
    db.prepare("SELECT account_id, handle, challenge FROM ceremonies WHERE id_hash = ?1 AND kind = ?2 AND expires_at > ?3 LIMIT 1")
        .bind(&[
            JsValue::from_str(&hash_token(token)),
            JsValue::from_str(kind),
            JsValue::from_f64(now_ms() as f64),
        ])?
        .first(None)
        .await?
        .ok_or_else(|| worker::Error::BadEncoding)
}

async fn rate_limit(
    request: &Request,
    env: &Env,
    db: &D1Database,
    action: &str,
    daily_limit: i64,
) -> Result<bool> {
    // Cloudflare overwrites this header on traffic reaching a Worker. The
    // workers.dev and preview routes are disabled, so auth is reachable only
    // through HII's configured custom domains.
    let client_ip = request
        .headers()
        .get("cf-connecting-ip")?
        .unwrap_or_else(|| "missing-edge-ip".into());
    let edge_key = format!("{action}:{client_ip}");
    if !env
        .rate_limiter("AUTH_RATE_LIMITER")?
        .limit(edge_key)
        .await?
        .success
    {
        return Ok(false);
    }

    let now = now_ms();
    let bucket = now / 86_400_000;
    db.batch(vec![
        db.prepare("DELETE FROM ceremonies WHERE expires_at <= ?1")
            .bind(&[JsValue::from_f64(now as f64)])?,
        db.prepare("DELETE FROM sessions WHERE expires_at <= ?1")
            .bind(&[JsValue::from_f64(now as f64)])?,
        db.prepare("DELETE FROM rate_limits WHERE bucket < ?1")
            .bind(&[JsValue::from_f64((bucket - 7) as f64)])?,
    ])
    .await?;

    // One row per action per UTC day is an emergency allocation backstop. Its
    // ceiling is intentionally far above normal use so a single requester,
    // already constrained at the edge, cannot cheaply deny service globally.
    db.prepare("INSERT INTO rate_limits (key, bucket, count) VALUES (?1, ?2, 1) ON CONFLICT(key, bucket) DO UPDATE SET count = count + 1")
        .bind(&[JsValue::from_str(action), JsValue::from_f64(bucket as f64)])?
        .run()
        .await?;
    let row: Option<RateRow> = db
        .prepare("SELECT count FROM rate_limits WHERE key = ?1 AND bucket = ?2")
        .bind(&[JsValue::from_str(action), JsValue::from_f64(bucket as f64)])?
        .first(None)
        .await?;
    Ok(row.is_none_or(|value| value.count <= daily_limit))
}

async fn read_json<T: for<'de> Deserialize<'de>>(request: &mut Request) -> Result<T> {
    if request
        .headers()
        .get("content-length")?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_BODY_BYTES)
    {
        return Err(worker::Error::RustError("body_too_large".into()));
    }
    let bytes = request.bytes().await?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(worker::Error::RustError("body_too_large".into()));
    }
    serde_json::from_slice(&bytes).map_err(Into::into)
}

fn origin_allowed(request: &Request) -> Result<bool> {
    Ok(request.headers().get("origin")?.as_deref() == Some(RP_ORIGIN))
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

fn verifier() -> Result<PasskeyRp> {
    let rp = RelyingParty::new(RP_ID, RP_ORIGIN).map_err(passkey_error)?;
    Ok(PasskeyRp::new(rp))
}

fn challenge(encoded: &str) -> Result<Challenge> {
    Challenge::from_bytes(decode(encoded)?).map_err(passkey_error)
}

fn decode(encoded: &str) -> Result<Vec<u8>> {
    decode_base64url(encoded).map_err(passkey_error)
}

fn passkey_error(error: passkey_rp::PasskeyError) -> worker::Error {
    worker::Error::RustError(format!("passkey verification failed: {error}"))
}

fn random_bytes(length: usize) -> Result<Vec<u8>> {
    let mut value = vec![0; length];
    getrandom::fill(&mut value)
        .map_err(|_| worker::Error::RustError("secure random unavailable".into()))?;
    Ok(value)
}

fn random_token() -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(random_bytes(32)?))
}

fn hash_token(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

fn new_session() -> Result<(String, String, String)> {
    let token = random_token()?;
    let hash = hash_token(&token);
    let csrf = random_token()?;
    Ok((token, hash, csrf))
}

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

fn cookie(request: &Request, name: &str) -> Result<Option<String>> {
    Ok(request.headers().get("cookie")?.and_then(|value| {
        value.split(';').find_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (key == name && !value.is_empty()).then(|| value.to_owned())
        })
    }))
}

fn session_cookie(token: &str) -> String {
    format!(
        "{SESSION_COOKIE}={token}; Path=/; Max-Age={SESSION_TTL_SECONDS}; Secure; HttpOnly; SameSite=Strict"
    )
}

fn clear_session_cookie() -> String {
    format!("{SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict")
}

fn authenticated_response(
    account_id: &str,
    handle: &str,
    csrf: &str,
    token: &str,
) -> Result<Response> {
    let mut response = json_response(
        200,
        SessionResponse {
            authenticated: true,
            account_id: Some(account_id),
            handle: Some(handle),
            csrf_token: Some(csrf),
        },
    )?;
    response
        .headers_mut()
        .append("Set-Cookie", &session_cookie(token))?;
    Ok(response)
}

fn json_response<T: Serialize>(status: u16, value: T) -> Result<Response> {
    Ok(Response::from_json(&value)?.with_status(status))
}

fn api_error(status: u16, code: &str) -> Result<Response> {
    json_response(status, json!({ "error": code }))
}

fn secure(mut response: Response) -> Result<Response> {
    let headers = response.headers_mut();
    headers.set("Cross-Origin-Opener-Policy", "same-origin")?;
    headers.set("Cross-Origin-Resource-Policy", "same-origin")?;
    headers.set(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()",
    )?;
    headers.set("Referrer-Policy", "no-referrer")?;
    headers.set("X-Content-Type-Options", "nosniff")?;
    headers.set("X-Frame-Options", "DENY")?;
    Ok(response)
}

fn secure_no_store(mut response: Response) -> Result<Response> {
    response.headers_mut().set("Cache-Control", "no-store")?;
    secure(response)
}

/// The release manifest for a platform, as published by
/// `scripts/hii-release-publish.mjs`. Behind the same session gate as the
/// artifact itself: what is being shipped is as private as the shipping.
async fn release_manifest(env: &Env, platform: &str) -> Result<Response> {
    let bucket = env.bucket("DOWNLOADS")?;
    let Some(manifest) = bucket
        .get(format!("releases/latest-{platform}.json"))
        .execute()
        .await?
    else {
        return api_error(404, "release_not_available");
    };
    let Some(body) = manifest.body() else {
        return api_error(502, "release_metadata_invalid");
    };
    let value: Value = serde_json::from_str(&body.text().await?)?;
    let mut response = Response::from_json(&value)?;
    response
        .headers_mut()
        .set("content-type", "application/json; charset=utf-8")?;
    Ok(response)
}

async fn download_desktop(request: &Request, env: &Env, platform: &str) -> Result<Response> {
    let bucket = env.bucket("DOWNLOADS")?;
    let Some(manifest) = bucket
        .get(format!("releases/latest-{platform}.json"))
        .execute()
        .await?
    else {
        return api_error(404, "release_not_available");
    };
    let Some(body) = manifest.body() else {
        return api_error(502, "release_metadata_invalid");
    };
    let value: Value = serde_json::from_str(&body.text().await?)?;
    let Some(filename) = value.get("filename").and_then(Value::as_str) else {
        return api_error(502, "release_metadata_invalid");
    };
    if filename.is_empty()
        || !filename
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return api_error(502, "release_metadata_invalid");
    }
    let Some(object) = bucket.get(format!("releases/{filename}")).execute().await? else {
        return api_error(404, "release_not_found");
    };
    downloadable(
        request,
        object,
        filename,
        value.get("sha256").and_then(Value::as_str),
    )
}

async fn download_cli(request: &Request, env: &Env, asset: &str) -> Result<Response> {
    if !valid_cli_asset(asset) {
        return api_error(404, "release_not_found");
    }
    let bucket = env.bucket("DOWNLOADS")?;
    let Some(manifest) = bucket.get("cli/releases/latest.json").execute().await? else {
        return api_error(404, "release_not_available");
    };
    let Some(body) = manifest.body() else {
        return api_error(502, "release_metadata_invalid");
    };
    let value: Value = serde_json::from_str(&body.text().await?)?;
    let Some(tag) = value.get("tag").and_then(Value::as_str) else {
        return api_error(502, "release_metadata_invalid");
    };
    if !valid_cli_tag(tag) {
        return api_error(502, "release_metadata_invalid");
    }
    let Some(object) = bucket
        .get(format!("cli/releases/{tag}/{asset}"))
        .execute()
        .await?
    else {
        return api_error(404, "release_not_found");
    };
    downloadable(request, object, asset, None)
}

fn valid_cli_asset(asset: &str) -> bool {
    const LEGACY_ASSETS: &[&str] = &[
        "hii-macos-arm64.tar.gz",
        "hii-macos-arm64.tar.gz.sha256",
        "hii-linux-x64.tar.gz",
        "hii-linux-x64.tar.gz.sha256",
        "hii-windows-x64.zip",
        "hii-windows-x64.zip.sha256",
    ];
    const TARGETS: &[&str] = &[
        "aarch64-apple-darwin",
        "x86_64-apple-darwin",
        "aarch64-unknown-linux-gnu",
        "x86_64-unknown-linux-gnu",
    ];
    asset == "SHA256SUMS"
        || LEGACY_ASSETS.contains(&asset)
        || TARGETS
            .iter()
            .any(|target| asset == format!("hii-{target}.tar.gz"))
}

async fn download_ui(request: &Request, env: &Env, asset: &str) -> Result<Response> {
    if !valid_ui_asset(asset) {
        return api_error(404, "ui_release_not_found");
    }
    let bucket = env.bucket("DOWNLOADS")?;
    let Some(object) = bucket.get(format!("ui/{asset}")).execute().await? else {
        return api_error(404, "ui_release_not_found");
    };
    let size = object.size();
    let etag = object.http_etag();
    let mut response = if request.method() == Method::Head {
        Response::empty()?
    } else {
        let body = object
            .body()
            .ok_or_else(|| worker::Error::RustError("UI release body unavailable".into()))?;
        Response::from_body(body.response_body()?)?
    };
    let headers = response.headers_mut();
    headers.set("Content-Length", &size.to_string())?;
    headers.set("ETag", &etag)?;
    if asset.ends_with(".json") {
        headers.set("Content-Type", "application/json; charset=utf-8")?;
        headers.set("Cache-Control", "no-store")?;
    } else {
        headers.set("Content-Type", "application/zip")?;
        headers.set("Cache-Control", "public, max-age=31536000, immutable")?;
    }
    Ok(response)
}

fn valid_ui_asset(asset: &str) -> bool {
    asset == "ui-latest.json"
        || (asset.starts_with("hii-ui-")
            && asset.ends_with(".zip")
            && asset
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')))
}

fn downloadable(
    request: &Request,
    object: worker::Object,
    filename: &str,
    sha256: Option<&str>,
) -> Result<Response> {
    let size = object.size();
    let etag = object.http_etag();
    let mut response = if request.method() == Method::Head {
        Response::empty()?
    } else {
        let body = object
            .body()
            .ok_or_else(|| worker::Error::RustError("release body unavailable".into()))?;
        Response::from_body(body.response_body()?)?
    };
    let headers = response.headers_mut();
    headers.set("Cache-Control", "private, no-store")?;
    headers.set(
        "Content-Disposition",
        &format!("attachment; filename=\"{filename}\""),
    )?;
    headers.set("Content-Length", &size.to_string())?;
    headers.set("Content-Type", "application/octet-stream")?;
    headers.set("ETag", &etag)?;
    if let Some(value) = sha256 {
        headers.set("X-HII-SHA256", value)?;
    }
    Ok(response)
}

fn valid_cli_tag(tag: &str) -> bool {
    let Some(version) = tag.strip_prefix("cli-v") else {
        return false;
    };
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::{
        SessionResponse, normalize_handle, valid_cli_asset, valid_cli_tag, valid_ui_asset,
    };

    #[test]
    fn cli_distribution_accepts_installer_contract_and_legacy_assets_only() {
        for asset in [
            "SHA256SUMS",
            "hii-aarch64-apple-darwin.tar.gz",
            "hii-x86_64-apple-darwin.tar.gz",
            "hii-aarch64-unknown-linux-gnu.tar.gz",
            "hii-x86_64-unknown-linux-gnu.tar.gz",
            "hii-macos-arm64.tar.gz",
            "hii-macos-arm64.tar.gz.sha256",
            "hii-windows-x64.zip",
        ] {
            assert!(valid_cli_asset(asset), "{asset}");
        }
        for asset in [
            "../SHA256SUMS",
            "latest.json",
            "hii-unknown.tar.gz",
            "hii-aarch64-apple-darwin.tar.gz/extra",
        ] {
            assert!(!valid_cli_asset(asset), "{asset}");
        }
    }

    #[test]
    fn authenticated_sessions_expose_an_opaque_canvas_scope() {
        let value = serde_json::to_value(SessionResponse {
            authenticated: true,
            account_id: Some("opaque-account-id"),
            handle: Some("ummi"),
            csrf_token: Some("csrf"),
        })
        .expect("session response serializes");
        assert_eq!(value["accountId"], "opaque-account-id");
        assert_eq!(value["handle"], "ummi");
    }

    #[test]
    fn handles_are_small_and_url_safe() {
        assert_eq!(
            normalize_handle(" Ummi.Green ").as_deref(),
            Some("ummi.green")
        );
        assert!(normalize_handle("ab").is_none());
        assert!(normalize_handle("name with space").is_none());
        assert!(normalize_handle("../../owner").is_none());
    }

    #[test]
    fn release_tags_are_bounded_to_semver_shape() {
        assert!(valid_cli_tag("cli-v1.2.3"));
        assert!(!valid_cli_tag("cli-v1.2.3/../../secret"));
        assert!(!valid_cli_tag("v1.2.3"));
    }

    #[test]
    fn ui_channel_serves_only_the_manifest_and_versioned_archives() {
        assert!(valid_ui_asset("ui-latest.json"));
        assert!(valid_ui_asset("hii-ui-0.1.1-ui.1.zip"));
        assert!(!valid_ui_asset("hii-ui-latest.json"));
        assert!(!valid_ui_asset("../ui-latest.json"));
        assert!(!valid_ui_asset("hii-ui-../../secret.zip"));
    }
}
