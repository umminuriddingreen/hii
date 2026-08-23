use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::{to_bytes, Body};
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use cookie::{Cookie, SameSite};
use rand::{distributions::Alphanumeric, Rng};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tower::limit::ConcurrencyLimitLayer;
use url::Url;
use webauthn_rs::prelude::{PublicKeyCredential, RegisterPublicKeyCredential};

use crate::store::{LedgerStore, StoreError};
use crate::{IdentityAuthority, IdentityConfig, IdentityError};

const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_HEADER_COUNT: usize = 64;
const SESSION_COOKIE: &str = "hii_session";
const SECURE_SESSION_COOKIE: &str = "__Host-hii_session";
const CSRF_COOKIE: &str = "hii_csrf";
const SECURE_CSRF_COOKIE: &str = "__Host-hii_csrf";
const CSRF_HEADER: &str = "x-hii-csrf";
const REGISTRATION_SECRET_HEADER: &str = "x-hii-registration-secret";

#[derive(Debug, Clone)]
pub struct IdentityHttpConfig {
    pub bind: SocketAddr,
    pub allowed_hosts: BTreeSet<String>,
    pub allowed_origin: Url,
    pub request_timeout: Duration,
    pub max_concurrency: usize,
    pub secure_cookies: bool,
    pub accept_local_registration_secret: bool,
}

impl IdentityHttpConfig {
    pub fn loopback(port: u16, allowed_origin: Url) -> Self {
        Self {
            bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
            allowed_hosts: BTreeSet::from([
                format!("127.0.0.1:{port}"),
                format!("localhost:{port}"),
            ]),
            secure_cookies: allowed_origin.scheme() == "https",
            allowed_origin,
            request_timeout: Duration::from_secs(10),
            max_concurrency: 32,
            accept_local_registration_secret: true,
        }
    }

    pub fn validate(&self) -> Result<(), HttpConfigError> {
        if self.allowed_hosts.is_empty()
            || self.max_concurrency == 0
            || self.request_timeout.is_zero()
            || self.allowed_origin.query().is_some()
            || self.allowed_origin.fragment().is_some()
        {
            return Err(HttpConfigError::Invalid);
        }
        if !self.bind.ip().is_loopback() {
            return Err(HttpConfigError::NonLoopbackDenied);
        }
        Ok(())
    }
}

pub struct IdentityService {
    authority: Mutex<IdentityAuthority>,
    identity_config: IdentityConfig,
    store: LedgerStore,
}

impl IdentityService {
    pub fn open(identity_config: IdentityConfig, store: LedgerStore) -> Result<Self, StoreError> {
        let authority = store.load_authority(identity_config.clone())?;
        Ok(Self {
            authority: Mutex::new(authority),
            identity_config,
            store,
        })
    }

    async fn mutate<T>(
        &self,
        operation: impl FnOnce(&mut IdentityAuthority) -> Result<T, IdentityError>,
    ) -> Result<T, ApiError> {
        let mut authority = self.authority.lock().await;
        let before = authority.ledger().clone();
        let result = operation(&mut authority);
        if authority.ledger().revision != before.revision
            && self
                .store
                .save_if_revision(authority.ledger(), before.revision)
                .is_err()
        {
            *authority = IdentityAuthority::from_ledger(self.identity_config.clone(), before)
                .map_err(|_| ApiError::Persistence)?;
            return Err(ApiError::Store);
        }
        result.map_err(ApiError::Identity)
    }

    async fn session_is_active(&self, session_id: &str, now: u64) -> bool {
        self.authority
            .lock()
            .await
            .session_is_active(session_id, now)
    }
}

#[derive(Clone)]
struct AppState {
    service: Arc<IdentityService>,
    http: IdentityHttpConfig,
}

pub fn router(
    service: Arc<IdentityService>,
    http: IdentityHttpConfig,
) -> Result<Router, HttpConfigError> {
    http.validate()?;
    let state = AppState { service, http };
    Ok(Router::new()
        .route("/health", get(health))
        .route("/v1/csrf", get(issue_csrf))
        .route("/v1/session", get(session_status))
        .route("/v1/session/logout", post(logout))
        .route("/v1/webauthn/registration/start", post(start_registration))
        .route(
            "/v1/webauthn/registration/finish",
            post(finish_registration),
        )
        .route(
            "/v1/webauthn/authentication/start",
            post(start_authentication),
        )
        .route(
            "/v1/webauthn/authentication/finish",
            post(finish_authentication),
        )
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), request_guard))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(ConcurrencyLimitLayer::new(state.http.max_concurrency))
        .layer(middleware::from_fn(no_store))
        .with_state(state))
}

pub async fn serve(
    service: Arc<IdentityService>,
    http: IdentityHttpConfig,
) -> Result<(), ServeError> {
    let app = router(service, http.clone())?;
    let listener = tokio::net::TcpListener::bind(http.bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn request_guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if !headers_within_bounds(request.headers()) {
        return safe_error(
            StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
            "request_rejected",
        );
    }
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    if !host.is_some_and(|value| state.http.allowed_hosts.contains(value)) {
        return safe_error(StatusCode::BAD_REQUEST, "invalid_host");
    }
    let is_mutation = request.method() != Method::GET && request.method() != Method::HEAD;
    if is_mutation {
        let origin = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok());
        if origin != Some(state.http.allowed_origin.as_str().trim_end_matches('/')) {
            return safe_error(StatusCode::FORBIDDEN, "cross_origin_denied");
        }
        if !valid_csrf(request.headers(), state.http.secure_cookies) {
            return safe_error(StatusCode::FORBIDDEN, "csrf_denied");
        }
    }
    let request = if is_mutation {
        let (parts, body) = request.into_parts();
        let bytes =
            match tokio::time::timeout(state.http.request_timeout, to_bytes(body, MAX_BODY_BYTES))
                .await
            {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(_)) => return safe_error(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large"),
                Err(_) => return safe_error(StatusCode::REQUEST_TIMEOUT, "request_timeout"),
            };
        Request::from_parts(parts, Body::from(bytes))
    } else {
        request
    };
    match tokio::time::timeout(state.http.request_timeout, next.run(request)).await {
        Ok(response) => response,
        Err(_) => safe_error(StatusCode::REQUEST_TIMEOUT, "request_timeout"),
    }
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn issue_csrf(State(state): State<AppState>) -> Response {
    let token = random_token();
    let cookie = build_cookie(
        csrf_cookie_name(state.http.secure_cookies),
        &token,
        false,
        state.http.secure_cookies,
    );
    response_with_cookie(StatusCode::OK, json!({ "csrfToken": token }), cookie)
}

async fn session_status(State(state): State<AppState>, headers: HeaderMap) -> Json<Value> {
    let active = session_from_headers(&headers, state.http.secure_cookies)
        .map(|session| async move { state.service.session_is_active(&session, now_ms()).await });
    let authenticated = match active {
        Some(future) => future.await,
        None => false,
    };
    Json(json!({ "authenticated": authenticated }))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    let session_id = session_from_headers(&headers, state.http.secure_cookies)
        .ok_or(ApiError::Identity(IdentityError::AuthenticationRequired))?;
    state
        .service
        .mutate(|authority| authority.revoke_session(&session_id, now_ms()))
        .await?;
    let mut response = Json(json!({ "authenticated": false })).into_response();
    append_cookie(
        response.headers_mut(),
        clear_cookie(
            session_cookie_name(state.http.secure_cookies),
            true,
            state.http.secure_cookies,
        ),
    );
    append_cookie(
        response.headers_mut(),
        clear_cookie(
            csrf_cookie_name(state.http.secure_cookies),
            false,
            state.http.secure_cookies,
        ),
    );
    Ok(response)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartRegistrationRequest {
    user_name: String,
}

async fn start_registration(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<StartRegistrationRequest>,
) -> Result<Json<Value>, ApiError> {
    let session = session_from_headers(&headers, state.http.secure_cookies);
    let permit = if session.is_none() && state.http.accept_local_registration_secret {
        headers
            .get(REGISTRATION_SECRET_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    } else {
        None
    };
    let authorization = session.as_deref().or(permit.as_deref());
    let ceremony = state
        .service
        .mutate(|authority| {
            authority.start_passkey_registration(authorization, &body.user_name, now_ms())
        })
        .await?;
    Ok(Json(json!({
        "ceremonyId": ceremony.ceremony_id,
        "expiresAtUnixMs": ceremony.expires_at_unix_ms,
        "publicKey": ceremony.public_options,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinishRegistrationRequest {
    ceremony_id: String,
    credential: RegisterPublicKeyCredential,
}

async fn finish_registration(
    State(state): State<AppState>,
    Json(body): Json<FinishRegistrationRequest>,
) -> Result<Json<Value>, ApiError> {
    let credential_id = state
        .service
        .mutate(|authority| {
            authority.finish_passkey_registration(&body.ceremony_id, &body.credential, now_ms())
        })
        .await?;
    Ok(Json(json!({ "credentialId": credential_id })))
}

async fn start_authentication(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let ceremony = state
        .service
        .mutate(|authority| authority.start_authentication(now_ms()))
        .await?;
    Ok(Json(json!({
        "ceremonyId": ceremony.ceremony_id,
        "expiresAtUnixMs": ceremony.expires_at_unix_ms,
        "publicKey": ceremony.public_options,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinishAuthenticationRequest {
    ceremony_id: String,
    credential: PublicKeyCredential,
}

async fn finish_authentication(
    State(state): State<AppState>,
    Json(body): Json<FinishAuthenticationRequest>,
) -> Result<Response, ApiError> {
    let session = state
        .service
        .mutate(|authority| {
            authority.finish_authentication(&body.ceremony_id, &body.credential, now_ms())
        })
        .await?;
    let session_cookie = build_cookie(
        session_cookie_name(state.http.secure_cookies),
        &session.session_id,
        true,
        state.http.secure_cookies,
    );
    let csrf = random_token();
    let csrf_cookie = build_cookie(
        csrf_cookie_name(state.http.secure_cookies),
        &csrf,
        false,
        state.http.secure_cookies,
    );
    let mut response = Json(json!({
        "authenticated": true,
        "expiresAtUnixMs": session.expires_at_unix_ms,
        "csrfToken": csrf,
    }))
    .into_response();
    append_cookie(response.headers_mut(), session_cookie);
    append_cookie(response.headers_mut(), csrf_cookie);
    Ok(response)
}

async fn not_found() -> Response {
    safe_error(StatusCode::NOT_FOUND, "not_found")
}

async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn headers_within_bounds(headers: &HeaderMap) -> bool {
    headers.len() <= MAX_HEADER_COUNT
        && headers
            .iter()
            .try_fold(0usize, |size, (name, value)| {
                size.checked_add(name.as_str().len())?
                    .checked_add(value.as_bytes().len())
            })
            .is_some_and(|size| size <= MAX_HEADER_BYTES)
}

fn valid_csrf(headers: &HeaderMap, secure: bool) -> bool {
    let supplied = headers
        .get(CSRF_HEADER)
        .and_then(|value| value.to_str().ok());
    let cookie = cookie_value(headers, csrf_cookie_name(secure));
    supplied.is_some_and(|value| !value.is_empty() && cookie.as_deref() == Some(value))
}

fn session_from_headers(headers: &HeaderMap, secure: bool) -> Option<String> {
    cookie_value(headers, session_cookie_name(secure))
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|cookie| Cookie::parse(cookie.trim().to_owned()).ok())
        .find(|cookie| cookie.name() == name)
        .map(|cookie| cookie.value().to_owned())
}

fn build_cookie(name: &'static str, value: &str, http_only: bool, secure: bool) -> Cookie<'static> {
    Cookie::build((name, value.to_owned()))
        .path("/")
        .http_only(http_only)
        .secure(secure)
        .same_site(SameSite::Strict)
        .build()
}

fn clear_cookie(name: &'static str, http_only: bool, secure: bool) -> Cookie<'static> {
    Cookie::build((name, String::new()))
        .path("/")
        .http_only(http_only)
        .secure(secure)
        .same_site(SameSite::Strict)
        .max_age(cookie::time::Duration::ZERO)
        .expires(cookie::time::OffsetDateTime::UNIX_EPOCH)
        .build()
}

fn append_cookie(headers: &mut HeaderMap, cookie: Cookie<'static>) {
    if let Ok(value) = HeaderValue::from_str(&cookie.to_string()) {
        headers.append(header::SET_COOKIE, value);
    }
}

fn response_with_cookie(status: StatusCode, body: Value, cookie: Cookie<'static>) -> Response {
    let mut response = (status, Json(body)).into_response();
    append_cookie(response.headers_mut(), cookie);
    response
}

fn safe_error(status: StatusCode, code: &'static str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

fn random_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn session_cookie_name(secure: bool) -> &'static str {
    if secure {
        SECURE_SESSION_COOKIE
    } else {
        SESSION_COOKIE
    }
}

fn csrf_cookie_name(secure: bool) -> &'static str {
    if secure {
        SECURE_CSRF_COOKIE
    } else {
        CSRF_COOKIE
    }
}

#[derive(Debug, thiserror::Error)]
pub enum HttpConfigError {
    #[error("identity HTTP configuration is invalid")]
    Invalid,
    #[error("identity HTTP is a local adapter and may only bind to loopback")]
    NonLoopbackDenied,
}

#[derive(Debug, thiserror::Error)]
pub enum ServeError {
    #[error(transparent)]
    Config(#[from] HttpConfigError),
    #[error("identity HTTP listener failed: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug)]
enum ApiError {
    Identity(IdentityError),
    Store,
    Persistence,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Self::Identity(
                IdentityError::AuthenticationRequired | IdentityError::SessionInactive,
            ) => (StatusCode::UNAUTHORIZED, "authentication_required"),
            Self::Identity(IdentityError::NoPasskeys) => (StatusCode::CONFLICT, "passkey_required"),
            Self::Identity(IdentityError::CeremonyNotFound | IdentityError::CeremonyExpired) => {
                (StatusCode::BAD_REQUEST, "invalid_ceremony")
            }
            Self::Identity(_) => (StatusCode::BAD_REQUEST, "request_rejected"),
            Self::Store | Self::Persistence => {
                (StatusCode::INTERNAL_SERVER_ERROR, "identity_unavailable")
            }
        };
        safe_error(status, code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tempfile::TempDir;
    use tower::ServiceExt;

    use crate::{DeviceKeySubmission, IdentityAuthority};

    #[tokio::test]
    async fn logout_persists_exact_revocation_clears_cookies_and_denies_replay() {
        let temp = TempDir::new().unwrap();
        let store = LedgerStore::new(temp.path().join("identity.json")).unwrap();
        let identity_config =
            IdentityConfig::new("localhost", Url::parse("https://localhost:8788").unwrap());
        let now = now_ms();
        let (mut authority, _) = IdentityAuthority::bootstrap(
            identity_config.clone(),
            "owner-1",
            "Ummi",
            DeviceKeySubmission {
                device_id: "mac".into(),
                display_name: "Mac".into(),
                signing_public_key: vec![1; 32],
                encryption_public_key: vec![2; 32],
            },
            1,
            now,
        )
        .unwrap();
        let session = authority.insert_verified_session_for_test(now);
        store.create(authority.ledger()).unwrap();
        let service = Arc::new(IdentityService {
            authority: Mutex::new(authority),
            identity_config: identity_config.clone(),
            store: store.clone(),
        });
        let app = router(
            service,
            IdentityHttpConfig::loopback(8788, Url::parse("https://localhost:8788").unwrap()),
        )
        .unwrap();
        let csrf = "test-csrf-token";
        let request = || {
            Request::builder()
                .method("POST")
                .uri("/v1/session/logout")
                .header(header::HOST, "localhost:8788")
                .header(header::ORIGIN, "https://localhost:8788")
                .header(
                    header::COOKIE,
                    format!(
                        "{SECURE_SESSION_COOKIE}={}; {SECURE_CSRF_COOKIE}={csrf}",
                        session.session_id
                    ),
                )
                .header(CSRF_HEADER, csrf)
                .body(Body::empty())
                .unwrap()
        };

        let response = app.clone().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let cleared = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .collect::<Vec<_>>();
        assert_eq!(cleared.len(), 2);
        assert!(cleared.iter().all(|cookie| cookie.contains("Max-Age=0")));

        let reopened = store.load_authority(identity_config).unwrap();
        assert!(!reopened.session_is_active(&session.session_id, now_ms()));
        let revision_after_logout = reopened.ledger().revision;

        let replay = app.oneshot(request()).await.unwrap();
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(replay.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(store.load().unwrap().revision, revision_after_logout);
    }
}
