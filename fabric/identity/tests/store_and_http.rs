use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use hii_fabric_identity::server::{router, IdentityHttpConfig, IdentityService};
use hii_fabric_identity::store::{LedgerStore, StoreError};
use hii_fabric_identity::{DeviceKeySubmission, IdentityAuthority, IdentityConfig};
use tempfile::TempDir;
use tower::ServiceExt;
use url::Url;

fn identity_config() -> IdentityConfig {
    IdentityConfig::new("localhost", Url::parse("https://localhost:8788").unwrap())
}

fn bootstrap(temp: &TempDir) -> (LedgerStore, String) {
    let store = LedgerStore::new(temp.path().join("identity.json")).unwrap();
    let (authority, material) = IdentityAuthority::bootstrap(
        identity_config(),
        "owner-1",
        "Ummi",
        DeviceKeySubmission {
            device_id: "mac".into(),
            display_name: "Mac".into(),
            signing_public_key: vec![1; 32],
            encryption_public_key: vec![2; 32],
        },
        2,
        now_ms(),
    )
    .unwrap();
    store.create(authority.ledger()).unwrap();
    (store, material.passkey_registration_secret)
}

#[test]
fn ledger_is_atomic_owner_only_and_survives_a_separate_open() {
    let temp = TempDir::new().unwrap();
    let (store, secret) = bootstrap(&temp);
    let first = store.load_authority(identity_config()).unwrap();
    assert_eq!(first.ledger().account_id, "owner-1");
    assert!(!serde_json::to_string(first.ledger())
        .unwrap()
        .contains(&secret));

    let reopened = LedgerStore::new(store.path()).unwrap();
    let second = reopened.load_authority(identity_config()).unwrap();
    assert_eq!(second.ledger().revision, first.ledger().revision);
    assert_eq!(second.ledger().devices.len(), 1);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(store.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o077,
            0
        );
    }
}

#[test]
fn refuses_existing_bootstrap_and_insecure_ledger_permissions() {
    let temp = TempDir::new().unwrap();
    let (store, _) = bootstrap(&temp);
    let ledger = store.load().unwrap();
    assert!(matches!(
        store.create(&ledger),
        Err(StoreError::AlreadyExists)
    ));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(store.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(store.load(), Err(StoreError::InsecurePermissions)));
    }
}

async fn app() -> (axum::Router, String) {
    let temp = TempDir::new().unwrap();
    let (_store, secret) = bootstrap(&temp);
    let persistent_path = temp.keep().join("identity.json");
    let store = LedgerStore::new(persistent_path).unwrap();
    let service = Arc::new(IdentityService::open(identity_config(), store).unwrap());
    let http = IdentityHttpConfig::loopback(8788, Url::parse("https://localhost:8788").unwrap());
    (router(service, http).unwrap(), secret)
}

async fn csrf_pair(app: &axum::Router) -> (String, String) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/csrf")
                .header(header::HOST, "localhost:8788")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    (cookie, json["csrfToken"].as_str().unwrap().to_owned())
}

#[tokio::test]
async fn registration_start_returns_real_virtual_ceremony_shape_and_persists() {
    let (app, secret) = app().await;
    let (cookie, csrf) = csrf_pair(&app).await;
    let request = Request::builder()
        .method("POST")
        .uri("/v1/webauthn/registration/start")
        .header(header::HOST, "localhost:8788")
        .header(header::ORIGIN, "https://localhost:8788")
        .header(header::COOKIE, cookie)
        .header("x-hii-csrf", csrf)
        .header("x-hii-registration-secret", secret)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"userName":"ummi"}"#))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(json["ceremonyId"].as_str().unwrap().starts_with("reg_"));
    assert!(json["expiresAtUnixMs"].is_number());
    assert!(json["publicKey"]["publicKey"]["challenge"].is_string());
}

#[tokio::test]
async fn denies_host_origin_csrf_oversize_and_bootstrap_routes() {
    let (app, _) = app().await;
    let cases = [
        Request::builder()
            .uri("/health")
            .header(header::HOST, "evil.example")
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .method("POST")
            .uri("/v1/webauthn/authentication/start")
            .header(header::HOST, "localhost:8788")
            .header(header::ORIGIN, "https://evil.example")
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .method("POST")
            .uri("/v1/webauthn/authentication/start")
            .header(header::HOST, "localhost:8788")
            .header(header::ORIGIN, "https://localhost:8788")
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .method("POST")
            .uri("/bootstrap?secret=leak")
            .header(header::HOST, "localhost:8788")
            .header(header::ORIGIN, "https://localhost:8788")
            .body(Body::empty())
            .unwrap(),
    ];
    let expected = [
        StatusCode::BAD_REQUEST,
        StatusCode::FORBIDDEN,
        StatusCode::FORBIDDEN,
        StatusCode::FORBIDDEN,
    ];
    for (request, expected) in cases.into_iter().zip(expected) {
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), expected);
    }

    let (cookie, csrf) = csrf_pair(&app).await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/webauthn/authentication/start")
                .header(header::HOST, "localhost:8788")
                .header(header::ORIGIN, "https://localhost:8788")
                .header(header::COOKIE, cookie)
                .header("x-hii-csrf", csrf)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(vec![b'x'; 65 * 1024]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let (cookie, csrf) = csrf_pair(&app).await;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/bootstrap?registrationSecret=must-not-be-accepted")
                .header(header::HOST, "localhost:8788")
                .header(header::ORIGIN, "https://localhost:8788")
                .header(header::COOKIE, cookie)
                .header("x-hii-csrf", csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[test]
fn public_bind_cannot_accept_bootstrap_secret_or_insecure_cookies() {
    let mut config =
        IdentityHttpConfig::loopback(8788, Url::parse("http://localhost:8788").unwrap());
    config.bind = "0.0.0.0:8788".parse().unwrap();
    assert!(config.validate().is_err());
    config.accept_local_registration_secret = false;
    assert!(config.validate().is_err());

    config.allowed_origin = Url::parse("https://app.humaninformationinterface.com").unwrap();
    config.secure_cookies = true;
    assert!(config.validate().is_err());
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap()
}
