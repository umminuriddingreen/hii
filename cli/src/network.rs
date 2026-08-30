// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! HII-owned browser/device network entrypoint.
//!
//! This is deliberately a narrow first transport: private HTTPS, one-time
//! browser pairing, a read-only canvas proxy, and authenticated bounded fabric
//! frames.  LAN, public-IP, and VPN addresses are merely route candidates; the
//! same HII identity and frame validation applies to every route.

use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    extract::{
        ws::{Message as WebSocketMessage, WebSocket, WebSocketUpgrade},
        Request, State,
    },
    http::{header, HeaderMap, Method, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use axum_server::tls_rustls::RustlsConfig;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use fs2::FileExt;
use hii_fabric_protocol::{Envelope, FrameCodec, Message, Pong};
use rand::{rngs::OsRng, RngCore};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, KeyUsagePurpose,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{config::AppPaths, store};

const SCHEMA_VERSION: u8 = 1;
const SESSION_TTL_SECS: u64 = 7 * 24 * 60 * 60;
const MAX_PROXY_BYTES: usize = 64 * 1024 * 1024;
const MAX_PAIRING_BODY_BYTES: usize = 32 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfig {
    pub schema_version: u8,
    pub node_id: String,
    pub display_name: String,
    pub owner_account_id: String,
    pub owner_handle: String,
    pub bind: SocketAddr,
    pub upstream: String,
    pub certificate_hosts: Vec<String>,
    pub allowed_origins: Vec<String>,
    pub lan_urls: Vec<String>,
    #[serde(default)]
    pub public_urls: Vec<String>,
    #[serde(default)]
    pub tailscale_urls: Vec<String>,
    pub certificate_not_after_unix: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingPermit {
    id: String,
    token_hash: String,
    created_at_unix: u64,
    expires_at_unix: u64,
    consumed_at_unix: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingStore {
    schema_version: u8,
    permits: Vec<PairingPermit>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserDevice {
    id: String,
    name: String,
    signing_public_key: Value,
    encryption_public_key: Value,
    signing_fingerprint: String,
    encryption_fingerprint: String,
    paired_at_unix: u64,
    revoked_at_unix: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceStore {
    schema_version: u8,
    devices: Vec<BrowserDevice>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSession {
    id: String,
    device_id: String,
    token_hash: String,
    csrf_token: String,
    created_at_unix: u64,
    expires_at_unix: u64,
    revoked_at_unix: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStore {
    schema_version: u8,
    sessions: Vec<BrowserSession>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingRequest {
    token: String,
    device_name: String,
    signing_public_key: Value,
    encryption_public_key: Value,
}

#[derive(Clone)]
struct GatewayState {
    root: PathBuf,
    config: NetworkConfig,
    client: reqwest::Client,
    mutation_lock: Arc<Mutex<()>>,
}

pub fn network_root(paths: &AppPaths) -> PathBuf {
    paths.runtime.join("network")
}

fn now_unix() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| error.to_string())
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn fingerprint(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn token_hash(token: &str) -> String {
    fingerprint(token.as_bytes())
}

fn local_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
    Some(socket.local_addr().ok()?.ip())
}

fn host_for_url(host: &str) -> String {
    host.parse::<IpAddr>()
        .ok()
        .filter(IpAddr::is_ipv6)
        .map(|_| format!("[{host}]"))
        .unwrap_or_else(|| host.to_string())
}

fn network_file(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

fn config_path(root: &Path) -> PathBuf {
    network_file(root, "config.json")
}

fn load_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> Result<T, String> {
    if !path.exists() {
        return Ok(T::default());
    }
    let bytes =
        fs::read(path).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("failed to decode {}: {error}", path.display()))
}

fn load_config(root: &Path) -> Result<NetworkConfig, String> {
    let path = config_path(root);
    let bytes = fs::read(&path).map_err(|_| {
        "HII Network is not configured; run `hii network certificate create`".to_string()
    })?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("failed to decode {}: {error}", path.display()))
}

fn with_store_lock<T>(
    root: &Path,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    store::set_directory_mode(root)?;
    let lock_path = root.join("state.lock");
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| format!("failed to open {}: {error}", lock_path.display()))?;
    lock.lock_exclusive().map_err(|error| error.to_string())?;
    let result = operation();
    let _ = FileExt::unlock(&lock);
    result
}

pub fn create_certificate(
    paths: &AppPaths,
    requested_hosts: &[String],
    port: u16,
) -> Result<NetworkConfig, String> {
    let identity = crate::identity::IdentityStore::open(paths)
        .current()?
        .ok_or_else(|| "HII Network needs a local identity; run `hii login` first".to_string())?;
    let root = network_root(paths);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    store::set_directory_mode(&root)?;

    let mut hosts = requested_hosts
        .iter()
        .map(|host| host.trim().to_string())
        .filter(|host| !host.is_empty())
        .collect::<Vec<_>>();
    if let Some(ip) = local_ip() {
        hosts.push(ip.to_string());
    }
    hosts.extend(["localhost".to_string(), "127.0.0.1".to_string()]);
    hosts.sort();
    hosts.dedup();

    let now = OffsetDateTime::now_utc();
    let not_after = now + time::Duration::days(30);
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).map_err(|e| e.to_string())?;
    ca_params.not_before = now - time::Duration::hours(1);
    ca_params.not_after = not_after;
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let mut ca_name = DistinguishedName::new();
    ca_name.push(DnType::CommonName, "HII Development Network");
    ca_params.distinguished_name = ca_name;
    let ca_key = KeyPair::generate().map_err(|error| error.to_string())?;
    let ca_cert = ca_params
        .self_signed(&ca_key)
        .map_err(|error| error.to_string())?;

    let mut server_params = CertificateParams::new(hosts.clone()).map_err(|e| e.to_string())?;
    server_params.not_before = now - time::Duration::hours(1);
    server_params.not_after = not_after;
    server_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let mut server_name = DistinguishedName::new();
    server_name.push(DnType::CommonName, "HII Network Gateway");
    server_params.distinguished_name = server_name;
    let server_key = KeyPair::generate().map_err(|error| error.to_string())?;
    let server_cert = server_params
        .signed_by(&server_key, &ca_cert, &ca_key)
        .map_err(|error| error.to_string())?;

    store::write_private_atomic(&root.join("ca-key.pem"), ca_key.serialize_pem().as_bytes())?;
    store::write_private_atomic(
        &root.join("server-key.pem"),
        server_key.serialize_pem().as_bytes(),
    )?;
    fs::write(root.join("ca-cert.pem"), ca_cert.pem()).map_err(|error| error.to_string())?;
    fs::write(root.join("server-cert.pem"), server_cert.pem())
        .map_err(|error| error.to_string())?;

    let profile_id = Uuid::new_v4().to_string().to_uppercase();
    let payload_id = Uuid::new_v4().to_string().to_uppercase();
    let profile = mobileconfig(&profile_id, &payload_id, ca_cert.der().as_ref());
    fs::write(root.join("hii-network.mobileconfig"), profile).map_err(|error| error.to_string())?;

    let lan_urls = hosts
        .iter()
        .filter(|host| host.as_str() != "localhost" && host.as_str() != "127.0.0.1")
        .map(|host| format!("https://{}:{port}", host_for_url(host)))
        .collect::<Vec<_>>();
    let allowed_origins = hosts
        .iter()
        .map(|host| format!("https://{}:{port}", host_for_url(host)))
        .collect::<Vec<_>>();
    let config = NetworkConfig {
        schema_version: SCHEMA_VERSION,
        node_id: format!("node_{}", Uuid::new_v4().simple()),
        display_name: "HII Network Gateway".into(),
        owner_account_id: identity.id,
        owner_handle: identity.name,
        bind: SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)),
        upstream: "http://127.0.0.1:3000".into(),
        certificate_hosts: hosts,
        allowed_origins,
        lan_urls,
        public_urls: Vec::new(),
        tailscale_urls: Vec::new(),
        certificate_not_after_unix: u64::try_from(not_after.unix_timestamp()).unwrap_or_default(),
    };
    store::write_json_private_atomic(&config_path(&root), &config)?;
    Ok(config)
}

fn mobileconfig(profile_id: &str, payload_id: &str, certificate_der: &[u8]) -> String {
    let certificate = BASE64.encode(certificate_der);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
<key>PayloadCertificateFileName</key><string>HII Network.cer</string>
<key>PayloadContent</key><data>{certificate}</data>
<key>PayloadDescription</key><string>Trusts only the owner-created HII development network.</string>
<key>PayloadDisplayName</key><string>HII Development Network Certificate</string>
<key>PayloadIdentifier</key><string>com.ummi.hii.network.cert</string>
<key>PayloadType</key><string>com.apple.security.root</string>
<key>PayloadUUID</key><string>{payload_id}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></array>
<key>PayloadDescription</key><string>Private development trust for HII on owner-controlled devices. Remove after testing.</string>
<key>PayloadDisplayName</key><string>HII Development Network</string>
<key>PayloadIdentifier</key><string>com.ummi.hii.network</string>
<key>PayloadOrganization</key><string>HII</string>
<key>PayloadRemovalDisallowed</key><false/>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadUUID</key><string>{profile_id}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></plist>
"#
    )
}

pub fn create_pairing(paths: &AppPaths, ttl_secs: u64) -> Result<Value, String> {
    if !(30..=900).contains(&ttl_secs) {
        return Err("pairing lifetime must be between 30 and 900 seconds".into());
    }
    let root = network_root(paths);
    let config = load_config(&root)?;
    let token = random_token();
    let now = now_unix()?;
    let permit = PairingPermit {
        id: format!("pair_{}", Uuid::new_v4().simple()),
        token_hash: token_hash(&token),
        created_at_unix: now,
        expires_at_unix: now + ttl_secs,
        consumed_at_unix: None,
    };
    with_store_lock(&root, || {
        let path = root.join("pairings.json");
        let mut store_value: PairingStore = load_json(&path)?;
        store_value.schema_version = SCHEMA_VERSION;
        store_value
            .permits
            .retain(|entry| entry.expires_at_unix >= now && entry.consumed_at_unix.is_none());
        store_value.permits.push(permit.clone());
        store::write_json_private_atomic(&path, &store_value)
    })?;
    let base = config
        .lan_urls
        .first()
        .or_else(|| config.allowed_origins.first())
        .ok_or_else(|| "network certificate has no usable URL".to_string())?;
    Ok(json!({
        "schemaVersion": SCHEMA_VERSION,
        "pairingId": permit.id,
        "expiresAtUnix": permit.expires_at_unix,
        "url": format!("{base}/hii/network/pair#token={token}"),
        "transport": "hii-direct",
        "note": "The fragment is a single-use secret. HII never stores it in plaintext."
    }))
}

pub fn status(paths: &AppPaths) -> Value {
    let root = network_root(paths);
    let config = load_config(&root).ok();
    let pid_path = root.join("gateway.pid");
    let pid = fs::read_to_string(&pid_path)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|pid| gateway_process_owned(*pid));
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "configured": config.is_some(),
        "running": pid.is_some(),
        "pid": pid,
        "nodeId": config.as_ref().map(|value| value.node_id.as_str()),
        "bind": config.as_ref().map(|value| value.bind.to_string()),
        "upstream": config.as_ref().map(|value| value.upstream.as_str()),
        "routes": {
            "lan": config.as_ref().map(|value| value.lan_urls.clone()).unwrap_or_default(),
            "directInternet": config.as_ref().map(|value| value.public_urls.clone()).unwrap_or_default(),
            "tailscale": config.as_ref().map(|value| value.tailscale_urls.clone()).unwrap_or_default()
        },
        "transportTruth": if pid.is_some() { "gateway-process-live; peer link not yet proven" } else { "gateway offline" },
        "profile": root.join("hii-network.mobileconfig"),
    })
}

pub fn doctor(paths: &AppPaths) -> Value {
    let root = network_root(paths);
    let config = load_config(&root).ok();
    let certs = ["ca-cert.pem", "server-cert.pem", "server-key.pem"]
        .into_iter()
        .map(|name| (name, root.join(name).is_file()))
        .collect::<BTreeMap<_, _>>();
    let upstream_ready = config.as_ref().is_some_and(|config| {
        url::Url::parse(&config.upstream)
            .ok()
            .and_then(|url| {
                let host = url.host_str()?;
                let port = url.port_or_known_default()?;
                std::net::TcpStream::connect_timeout(
                    &format!("{host}:{port}").parse().ok()?,
                    Duration::from_millis(200),
                )
                .ok()
            })
            .is_some()
    });
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "configured": config.is_some(),
        "certificates": certs,
        "upstreamReady": upstream_ready,
        "lanCandidatePresent": config.as_ref().is_some_and(|value| !value.lan_urls.is_empty()),
        "directInternetConfigured": config.as_ref().is_some_and(|value| !value.public_urls.is_empty()),
        "tailscaleConfigured": config.as_ref().is_some_and(|value| !value.tailscale_urls.is_empty()),
        "internetGuarantee": "requires a proven public IPv6 address or explicit router mapping",
    })
}

pub fn start(paths: &AppPaths) -> Result<u32, String> {
    let root = network_root(paths);
    let _ = load_config(&root)?;
    if status(paths)["running"].as_bool().unwrap_or(false) {
        return status(paths)["pid"]
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok())
            .ok_or_else(|| "HII Network is already running".to_string());
    }
    fs::create_dir_all(root.join("logs")).map_err(|error| error.to_string())?;
    let log_path = root.join("logs/gateway.log");
    let log = File::create(&log_path).map_err(|error| error.to_string())?;
    let error_log = log.try_clone().map_err(|error| error.to_string())?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut child = Command::new(executable)
        .args(["network", "serve"])
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log))
        .spawn()
        .map_err(|error| format!("failed to start HII Network: {error}"))?;
    store::write_private_atomic(&root.join("gateway.pid"), child.id().to_string().as_bytes())?;
    let pid = child.id();
    let ready_at = SocketAddr::from((Ipv4Addr::LOCALHOST, load_config(&root)?.bind.port()));
    for _ in 0..40 {
        if std::net::TcpStream::connect_timeout(&ready_at, Duration::from_millis(50)).is_ok() {
            return Ok(pid);
        }
        if let Some(exit) = child.try_wait().map_err(|error| error.to_string())? {
            let detail = fs::read_to_string(&log_path).unwrap_or_default();
            return Err(format!(
                "HII Network exited before readiness ({exit}): {}",
                detail.trim()
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("HII Network did not become ready within 2 seconds; inspect gateway.log".into())
}

pub fn stop(paths: &AppPaths) -> Result<bool, String> {
    let root = network_root(paths);
    let path = root.join("gateway.pid");
    let Some(pid) = fs::read_to_string(&path)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
    else {
        return Ok(false);
    };
    if !process_alive(pid) {
        let _ = fs::remove_file(path);
        return Ok(false);
    }
    if !gateway_process_owned(pid) {
        return Err(format!(
            "refusing to stop pid {pid}: it is not an owned HII Network gateway"
        ));
    }
    #[cfg(unix)]
    {
        let status = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        if status != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    #[cfg(windows)]
    {
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string()])
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err(format!("taskkill could not stop HII Network pid {pid}"));
        }
    }
    let _ = fs::remove_file(path);
    Ok(true)
}

fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(windows)]
    {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .ok()
            .is_some_and(|output| {
                String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
            })
    }
}

fn gateway_process_owned(pid: u32) -> bool {
    if !process_alive(pid) {
        return false;
    }
    #[cfg(unix)]
    {
        Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .is_some_and(|output| {
                let command = String::from_utf8_lossy(&output.stdout);
                command.contains("hii") && command.contains("network serve")
            })
    }
    #[cfg(windows)]
    {
        false
    }
}

pub fn serve(paths: &AppPaths) -> Result<(), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let root = network_root(paths);
    let config = load_config(&root)?;
    let cert = root.join("server-cert.pem");
    let key = root.join("server-key.pem");
    let tls = tokio::runtime::Runtime::new()
        .map_err(|error| error.to_string())?
        .block_on(RustlsConfig::from_pem_file(cert, key))
        .map_err(|error| error.to_string())?;
    let state = GatewayState {
        root: root.clone(),
        config: config.clone(),
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| error.to_string())?,
        mutation_lock: Arc::new(Mutex::new(())),
    };
    store::write_private_atomic(
        &root.join("gateway.pid"),
        std::process::id().to_string().as_bytes(),
    )?;
    let app = router(state);
    tokio::runtime::Runtime::new()
        .map_err(|error| error.to_string())?
        .block_on(async move {
            axum_server::bind_rustls(config.bind, tls)
                .serve(app.into_make_service_with_connect_info::<SocketAddr>())
                .await
                .map_err(|error| error.to_string())
        })
}

fn router(state: GatewayState) -> Router {
    Router::new()
        .route("/hii/network/health", get(health))
        .route("/hii/network/session", get(session))
        .route("/hii/network/status", get(network_status))
        .route("/hii/network/pair", get(pair_page))
        .route("/hii/network/pair/redeem", post(redeem_pairing))
        .route("/hii/network/ws", get(websocket))
        .fallback(proxy_read_only)
        .with_state(state)
}

async fn health(State(state): State<GatewayState>) -> Json<Value> {
    Json(json!({
        "schemaVersion": SCHEMA_VERSION,
        "status": "ok",
        "nodeId": state.config.node_id,
        "transport": "hii-direct"
    }))
}

async fn pair_page() -> Html<&'static str> {
    Html(PAIR_PAGE)
}

async fn redeem_pairing(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    request: Request,
) -> Response {
    if !valid_mutation_origin(&state.config, &headers) {
        return problem(StatusCode::FORBIDDEN, "origin_not_allowed");
    }
    let body = match axum::body::to_bytes(request.into_body(), MAX_PAIRING_BODY_BYTES).await {
        Ok(body) => body,
        Err(_) => return problem(StatusCode::PAYLOAD_TOO_LARGE, "pairing_request_too_large"),
    };
    let input: PairingRequest = match serde_json::from_slice(&body) {
        Ok(input) => input,
        Err(_) => return problem(StatusCode::BAD_REQUEST, "invalid_pairing_request"),
    };
    if input.token.len() != 43
        || input.device_name.trim().is_empty()
        || input.device_name.len() > 80
        || serde_json::to_vec(&input.signing_public_key).map_or(true, |value| value.len() > 8_192)
        || serde_json::to_vec(&input.encryption_public_key)
            .map_or(true, |value| value.len() > 8_192)
    {
        return problem(StatusCode::BAD_REQUEST, "invalid_pairing_request");
    }
    let _guard = state.mutation_lock.lock().await;
    match redeem(&state.root, input) {
        Ok((session, token)) => {
            let mut response = Json(json!({
                "authenticated": true,
                "accountId": state.config.owner_account_id,
                "handle": state.config.owner_handle,
                "csrfToken": session.csrf_token,
                "deviceId": session.device_id,
            }))
            .into_response();
            let cookie = format!(
                "hii_network_session={token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age={SESSION_TTL_SECS}"
            );
            if let Ok(value) = cookie.parse() {
                response.headers_mut().insert(header::SET_COOKIE, value);
            }
            response
        }
        Err(code) => problem(StatusCode::UNAUTHORIZED, &code),
    }
}

fn redeem(root: &Path, input: PairingRequest) -> Result<(BrowserSession, String), String> {
    with_store_lock(root, || {
        let now = now_unix()?;
        let pairing_path = root.join("pairings.json");
        let mut pairings: PairingStore = load_json(&pairing_path)?;
        let hash = token_hash(&input.token);
        let permit = pairings
            .permits
            .iter_mut()
            .find(|permit| permit.token_hash == hash)
            .ok_or_else(|| "pairing_not_found".to_string())?;
        if permit.consumed_at_unix.is_some() {
            return Err("pairing_already_used".into());
        }
        if now > permit.expires_at_unix {
            return Err("pairing_expired".into());
        }
        permit.consumed_at_unix = Some(now);
        store::write_json_private_atomic(&pairing_path, &pairings)?;

        let signing_bytes =
            serde_json::to_vec(&input.signing_public_key).map_err(|e| e.to_string())?;
        let encryption_bytes =
            serde_json::to_vec(&input.encryption_public_key).map_err(|e| e.to_string())?;
        let device = BrowserDevice {
            id: format!("browser_{}", Uuid::new_v4().simple()),
            name: input.device_name.trim().to_string(),
            signing_fingerprint: fingerprint(&signing_bytes),
            encryption_fingerprint: fingerprint(&encryption_bytes),
            signing_public_key: input.signing_public_key,
            encryption_public_key: input.encryption_public_key,
            paired_at_unix: now,
            revoked_at_unix: None,
        };
        let device_path = root.join("devices.json");
        let mut devices: DeviceStore = load_json(&device_path)?;
        devices.schema_version = SCHEMA_VERSION;
        devices.devices.push(device.clone());
        store::write_json_private_atomic(&device_path, &devices)?;

        let token = random_token();
        let session = BrowserSession {
            id: format!("session_{}", Uuid::new_v4().simple()),
            device_id: device.id,
            token_hash: token_hash(&token),
            csrf_token: random_token(),
            created_at_unix: now,
            expires_at_unix: now + SESSION_TTL_SECS,
            revoked_at_unix: None,
        };
        let session_path = root.join("sessions.json");
        let mut sessions: SessionStore = load_json(&session_path)?;
        sessions.schema_version = SCHEMA_VERSION;
        sessions
            .sessions
            .retain(|entry| entry.expires_at_unix >= now && entry.revoked_at_unix.is_none());
        sessions.sessions.push(session.clone());
        store::write_json_private_atomic(&session_path, &sessions)?;
        Ok((session, token))
    })
}

async fn session(State(state): State<GatewayState>, headers: HeaderMap) -> Json<Value> {
    let found = authenticated_session(&state.root, &headers);
    Json(match found {
        Some(session) => json!({
            "authenticated": true,
            "accountId": state.config.owner_account_id,
            "handle": state.config.owner_handle,
            "csrfToken": session.csrf_token,
            "deviceId": session.device_id,
        }),
        None => json!({ "authenticated": false }),
    })
}

async fn network_status(State(state): State<GatewayState>, headers: HeaderMap) -> Response {
    if authenticated_session(&state.root, &headers).is_none() {
        return problem(StatusCode::UNAUTHORIZED, "authentication_required");
    }
    Json(json!({
        "schemaVersion": SCHEMA_VERSION,
        "nodeId": state.config.node_id,
        "transport": "hii-direct",
        "routes": {
            "lan": state.config.lan_urls,
            "directInternet": state.config.public_urls,
            "tailscale": state.config.tailscale_urls,
        },
        "authority": "identity-bound; route-independent",
    }))
    .into_response()
}

async fn websocket(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !valid_websocket_origin(&state.config, &headers)
        || authenticated_session(&state.root, &headers).is_none()
    {
        return problem(StatusCode::UNAUTHORIZED, "authentication_required");
    }
    upgrade
        .max_message_size(hii_fabric_protocol::HARD_MAX_FRAME_BYTES)
        .on_upgrade(handle_socket)
}

async fn handle_socket(mut socket: WebSocket) {
    let codec = FrameCodec::default();
    while let Some(Ok(message)) = socket.recv().await {
        let WebSocketMessage::Binary(bytes) = message else {
            let _ = socket.send(WebSocketMessage::Close(None)).await;
            return;
        };
        let Ok(envelope) = codec.decode(&bytes) else {
            let _ = socket.send(WebSocketMessage::Close(None)).await;
            return;
        };
        let Message::Ping(ping) = envelope.message else {
            continue;
        };
        let response = Envelope {
            message_id: format!("msg_{}", Uuid::new_v4().simple()),
            correlation_id: Some(envelope.message_id),
            sent_at_unix_ms: now_unix().unwrap_or_default() * 1_000,
            message: Message::Pong(Pong {
                sequence: ping.sequence,
                ping_sent_at_unix_ms: ping.sent_at_unix_ms,
                pong_sent_at_unix_ms: now_unix().unwrap_or_default() * 1_000,
            }),
        };
        let Ok(frame) = codec.encode(&response) else {
            return;
        };
        if socket
            .send(WebSocketMessage::Binary(frame.into()))
            .await
            .is_err()
        {
            return;
        }
    }
}

async fn proxy_read_only(State(state): State<GatewayState>, request: Request) -> Response {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return problem(StatusCode::METHOD_NOT_ALLOWED, "network_proxy_is_read_only");
    }
    let path = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let target = format!("{}{}", state.config.upstream.trim_end_matches('/'), path);
    let mut outbound = state.client.request(request.method().clone(), target);
    for (name, value) in request.headers() {
        if !is_hop_header(name.as_str()) && name != header::HOST && name != header::COOKIE {
            outbound = outbound.header(name, value);
        }
    }
    let response = match outbound.send().await {
        Ok(response) => response,
        Err(_) => return problem(StatusCode::BAD_GATEWAY, "canvas_upstream_unavailable"),
    };
    let status = response.status();
    let headers = response.headers().clone();
    let body = match response.bytes().await {
        Ok(body) if body.len() <= MAX_PROXY_BYTES => body,
        _ => return problem(StatusCode::BAD_GATEWAY, "canvas_upstream_response_invalid"),
    };
    let mut output = Response::builder().status(status);
    for (name, value) in &headers {
        if !is_hop_header(name.as_str()) && name != header::CONTENT_LENGTH {
            output = output.header(name, value);
        }
    }
    output
        .header("x-hii-network", "hii-direct")
        .body(Body::from(body))
        .unwrap_or_else(|_| problem(StatusCode::INTERNAL_SERVER_ERROR, "proxy_response_failed"))
}

fn is_hop_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailers"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn valid_mutation_origin(config: &NetworkConfig, headers: &HeaderMap) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|origin| {
            config
                .allowed_origins
                .iter()
                .any(|allowed| allowed == origin)
        })
}

fn valid_websocket_origin(config: &NetworkConfig, headers: &HeaderMap) -> bool {
    valid_mutation_origin(config, headers)
}

fn authenticated_session(root: &Path, headers: &HeaderMap) -> Option<BrowserSession> {
    let token = headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|field| field.trim().split_once('='))
        .find_map(|(name, value)| (name == "hii_network_session").then_some(value))?;
    let sessions: SessionStore = load_json(&root.join("sessions.json")).ok()?;
    let now = now_unix().ok()?;
    let hash = token_hash(token);
    sessions.sessions.into_iter().find(|session| {
        session.token_hash == hash
            && session.revoked_at_unix.is_none()
            && session.expires_at_unix >= now
    })
}

fn problem(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

const PAIR_PAGE: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Pair with HII</title><style>
:root{color-scheme:light;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f7f8f4;color:#101213}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;box-sizing:border-box}.card{width:min(100%,430px);border:1px solid #161917;border-radius:24px;padding:28px;background:#fff;box-shadow:0 24px 80px #1920191a}.mark{display:flex;align-items:center;gap:9px;font-size:11px;letter-spacing:.16em;text-transform:uppercase}.dot{width:10px;height:10px;border-radius:50%;background:#9cff38;box-shadow:0 0 0 5px #9cff3826}h1{font:500 clamp(30px,9vw,48px)/1.02 system-ui,sans-serif;letter-spacing:-.05em;margin:38px 0 14px}p{color:#59605b;line-height:1.55;font-size:13px}button{width:100%;margin-top:24px;border:0;border-radius:14px;background:#101213;color:#fff;padding:16px;font:600 13px ui-monospace,monospace}button:disabled{opacity:.45}#status{min-height:20px;color:#34412f}</style></head>
<body><main class="card"><div class="mark"><span class="dot"></span>HII network</div><h1>Pair this browser.</h1><p>This creates device keys on this iPhone and binds only their public fingerprints to your local HII authority.</p><button id="pair">Pair with HII</button><p id="status">The permit is single-use and expires quickly.</p></main>
<script type="module">
const status=document.querySelector('#status'),button=document.querySelector('#pair');
const token=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'',location.pathname);
button.disabled=!token;if(!token)status.textContent='The pairing permit is missing or was already removed.';
function db(){return new Promise((resolve,reject)=>{const r=indexedDB.open('hii-device-keys-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('keys');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function save(key,value){const d=await db();await new Promise((resolve,reject)=>{const t=d.transaction('keys','readwrite');t.objectStore('keys').put(value,key);t.oncomplete=resolve;t.onerror=()=>reject(t.error)});d.close()}
button.onclick=async()=>{button.disabled=true;status.textContent='Creating private device keys…';try{
const signing=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
const encryption=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveKey','deriveBits']);
const signingPublicKey=await crypto.subtle.exportKey('jwk',signing.publicKey),encryptionPublicKey=await crypto.subtle.exportKey('jwk',encryption.publicKey);
await save('signing-private',signing.privateKey);await save('encryption-private',encryption.privateKey);
status.textContent='Binding this browser to HII…';const response=await fetch('/hii/network/pair/redeem',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({token,deviceName:navigator.userAgent.includes('iPhone')?'iPhone Safari':'Browser',signingPublicKey,encryptionPublicKey})});
if(!response.ok)throw new Error((await response.json().catch(()=>({}))).error||'pairing_failed');status.textContent='Paired. Opening your HII canvas…';location.replace('/');
}catch(error){status.textContent=`Could not pair: ${error.message}`;button.disabled=false}};
</script></body></html>"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppPaths;
    use tempfile::tempdir;

    fn paths() -> (tempfile::TempDir, AppPaths) {
        let temp = tempdir().unwrap();
        let paths = AppPaths {
            repo: temp.path().join("repo"),
            runtime: temp.path().join("runtime"),
        };
        crate::identity::IdentityStore::open(&paths)
            .create_or_update("Test Owner", None)
            .unwrap();
        (temp, paths)
    }

    #[test]
    fn certificate_is_private_and_names_the_local_route() {
        let (_temp, paths) = paths();
        let config = create_certificate(&paths, &["hii.test".into()], 7443).unwrap();
        assert!(config
            .allowed_origins
            .contains(&"https://hii.test:7443".into()));
        assert!(network_root(&paths)
            .join("hii-network.mobileconfig")
            .is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(network_root(&paths).join("server-key.pem"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn pairing_permit_is_hash_only_and_single_use() {
        let (_temp, paths) = paths();
        create_certificate(&paths, &["hii.test".into()], 7443).unwrap();
        let pairing = create_pairing(&paths, 60).unwrap();
        let url = pairing["url"].as_str().unwrap();
        let token = url.split("#token=").nth(1).unwrap();
        let stored = fs::read_to_string(network_root(&paths).join("pairings.json")).unwrap();
        assert!(!stored.contains(token));
        let request = || PairingRequest {
            token: token.into(),
            device_name: "test phone".into(),
            signing_public_key: json!({"kty":"EC","x":"a","y":"b"}),
            encryption_public_key: json!({"kty":"EC","x":"c","y":"d"}),
        };
        assert!(redeem(&network_root(&paths), request()).is_ok());
        assert_eq!(
            redeem(&network_root(&paths), request()).unwrap_err(),
            "pairing_already_used"
        );
    }

    #[test]
    fn network_truth_does_not_infer_internet_or_tailscale() {
        let (_temp, paths) = paths();
        create_certificate(&paths, &["hii.test".into()], 7443).unwrap();
        let report = doctor(&paths);
        assert_eq!(report["directInternetConfigured"], false);
        assert_eq!(report["tailscaleConfigured"], false);
        assert!(report["internetGuarantee"]
            .as_str()
            .unwrap()
            .contains("public IPv6"));
    }

    #[test]
    fn frame_codec_rejects_unbounded_input_before_network_handling() {
        let codec = FrameCodec::default();
        let oversized = vec![0_u8; codec.max_frame_bytes() + 1];
        assert!(codec.decode(&oversized).is_err());
    }
}
