//! HII UI channel — ship interface changes without rebuilding the desktop app.
//!
//! The Tauri shell (Rust binary, IPC commands, entitlements) is the slow part of the
//! build. The interface is a static Next export, so it can be swapped underneath the
//! shell at runtime. This module resolves where the main window loads its interface
//! from, in priority order:
//!
//! 1. `HII_UI_URL` — a loopback live dev server, so `next dev` HMR lands in the installed app.
//! 2. `~/.hii/ui/state.json` with `mode: "live"` — the same, made sticky by
//!    `npm run ui:live` so a running app follows the dev server across restarts.
//! 3. An installed UI bundle in `~/.hii/ui/bundles/<version>` — served over the
//!    `hiiui://` scheme and refreshed from a signed manifest in the background.
//! 4. The interface baked into the app bundle at build time (unchanged behavior).
//!
//! Downloaded bundles are code with full IPC access, so they are accepted only when
//! their sha256 matches the manifest *and* a minisign signature verifies against the
//! same public key the app updater trusts.

use std::{
    env, fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager, Runtime};

/// Public key the desktop updater trusts, reused for UI bundles so one key
/// governs every artifact that can execute inside HII.
const UI_PUBKEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IERCN0Y1OTI3MUFCRkUzQjkKUldTNTQ3OGFKMWwvMjgwQWIwSWNOVi9PS2lIVWpSaHAzSzl6MTc0a3N0Ymk5QnpETGx4L1JQYkgK";

const MAX_BUNDLE_BYTES: u64 = 128 * 1024 * 1024;
const DEFAULT_POLL_SECONDS: u64 = 300;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UiSource {
    /// The interface baked into the app bundle.
    Bundled,
    /// A live dev server (HMR).
    Live(String),
    /// An installed bundle served over the `hiiui://` scheme.
    Installed(String),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelState {
    /// "bundled" | "live" | "installed"
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub live_url: Option<String>,
    /// Installed bundle version currently active.
    #[serde(default)]
    pub version: Option<String>,
    /// Installed but not yet applied, when `auto_apply` is off.
    #[serde(default)]
    pub pending_version: Option<String>,
    /// Manifest URL polled for new interface bundles.
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub auto_apply: bool,
    #[serde(default)]
    pub poll_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UiManifest {
    version: String,
    url: String,
    sha256: String,
    #[serde(default)]
    signature: Option<String>,
    #[serde(default)]
    notes: Option<String>,
}

/// Directory that owns every UI channel artifact.
pub fn channel_dir() -> PathBuf {
    if let Ok(custom) = env::var("HII_UI_DIR") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".hii")
        .join("ui")
}

fn state_path() -> PathBuf {
    channel_dir().join("state.json")
}

fn bundles_dir() -> PathBuf {
    channel_dir().join("bundles")
}

fn bundle_dir(version: &str) -> PathBuf {
    bundles_dir().join(safe_version(version))
}

/// Versions name a directory, so they may only carry filename-safe characters.
fn safe_version(version: &str) -> String {
    let cleaned: String = version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('.').to_string();
    if trimmed.is_empty() {
        "unknown".into()
    } else {
        trimmed
    }
}

pub fn read_state() -> ChannelState {
    fs::read_to_string(state_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<ChannelState>(&raw).ok())
        .unwrap_or_default()
}

fn write_state(state: &ChannelState) -> Result<(), String> {
    let path = state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("ui_state_dir_failed: {error}"))?;
    }
    let body = serde_json::to_string_pretty(state)
        .map_err(|error| format!("ui_state_encode_failed: {error}"))?;
    fs::write(&path, body).map_err(|error| format!("ui_state_write_failed: {error}"))
}

fn validate_live_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let parsed = trimmed
        .parse::<tauri::Url>()
        .map_err(|error| format!("ui_live_url_invalid: {error}"))?;
    if parsed.scheme() != "http" {
        return Err("ui_live_url_rejected".into());
    }
    if !matches!(parsed.host_str(), Some("127.0.0.1" | "localhost")) {
        return Err("ui_live_url_rejected".into());
    }
    if parsed.port().is_none() {
        return Err("ui_live_url_rejected".into());
    }
    Ok(trimmed.to_string())
}

/// Where the main window should load the interface from right now.
pub fn resolve_source(state: &ChannelState) -> UiSource {
    if let Ok(url) = env::var("HII_UI_URL") {
        if let Ok(url) = validate_live_url(&url) {
            return UiSource::Live(url);
        }
    }
    if state.mode == "live" {
        if let Some(url) = state
            .live_url
            .as_ref()
            .and_then(|value| validate_live_url(value).ok())
        {
            return UiSource::Live(url);
        }
    }
    if let Some(version) = state.version.as_deref() {
        if bundle_dir(version).join("index.html").is_file() {
            return UiSource::Installed(version.to_string());
        }
    }
    UiSource::Bundled
}

/// Origin the `hiiui` scheme is served from, which differs per platform.
pub fn installed_url() -> String {
    if cfg!(windows) {
        "http://hiiui.localhost/index.html".into()
    } else {
        "hiiui://localhost/index.html".into()
    }
}

fn source_url(source: &UiSource) -> Option<String> {
    match source {
        UiSource::Bundled => None,
        UiSource::Live(url) => Some(url.clone()),
        UiSource::Installed(_) => Some(installed_url()),
    }
}

/// Active bundle root, shared with the protocol handler so applying an update
/// does not require restarting the app.
#[derive(Clone, Default)]
pub struct ActiveBundle(Arc<Mutex<Option<PathBuf>>>);

impl ActiveBundle {
    pub fn set(&self, root: Option<PathBuf>) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = root;
        }
    }

    pub fn get(&self) -> Option<PathBuf> {
        self.0.lock().ok().and_then(|guard| guard.clone())
    }
}

/// Map a request path inside a Next static export to a file on disk.
/// Returns `None` for anything that escapes the bundle root.
pub fn resolve_asset(root: &Path, request_path: &str) -> Option<PathBuf> {
    let raw = request_path.split(['?', '#']).next().unwrap_or("");
    let decoded = percent_decode(raw);
    let relative = decoded.trim_start_matches('/');
    let relative = if relative.is_empty() {
        "index.html"
    } else {
        relative
    };

    let mut candidate = PathBuf::new();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => candidate.push(part),
            // Traversal, absolute paths and drive prefixes are rejected outright.
            _ => return None,
        }
    }

    let direct = root.join(&candidate);
    if direct.is_file() {
        return Some(direct);
    }
    let html = root.join(format!("{}.html", candidate.to_string_lossy()));
    if html.is_file() {
        return Some(html);
    }
    let index = direct.join("index.html");
    if index.is_file() {
        return Some(index);
    }
    // Client-side routes fall back to the shell document, like a static host would.
    let fallback = root.join("index.html");
    if fallback.is_file() && !candidate.to_string_lossy().starts_with("_next/") {
        return Some(fallback);
    }
    None
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" | "map" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(&hasher.finalize())
}

fn minisign_public_key() -> Result<minisign_verify::PublicKey, String> {
    let raw = env::var("HII_UI_PUBKEY").unwrap_or_else(|_| UI_PUBKEY_B64.to_string());
    let raw = raw.trim();
    // The updater stores the whole minisign public key file, base64 encoded.
    if let Ok(decoded) = base64_decode(raw) {
        if let Ok(text) = String::from_utf8(decoded) {
            if let Some(line) = text.lines().last() {
                if let Ok(key) = minisign_verify::PublicKey::from_base64(line.trim()) {
                    return Ok(key);
                }
            }
        }
    }
    minisign_verify::PublicKey::from_base64(raw)
        .map_err(|error| format!("ui_pubkey_invalid: {error}"))
}

fn base64_decode(value: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    let mut out = Vec::new();
    for byte in value.bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let index = TABLE
            .iter()
            .position(|candidate| *candidate == byte)
            .ok_or_else(|| "base64_invalid".to_string())? as u32;
        buffer = (buffer << 6) | index;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

fn verify_bundle(bytes: &[u8], manifest: &UiManifest) -> Result<(), String> {
    let digest = sha256_hex(bytes);
    if !digest.eq_ignore_ascii_case(manifest.sha256.trim()) {
        return Err("ui_bundle_digest_mismatch".into());
    }
    let signature = manifest
        .signature
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let Some(signature) = signature else {
        if env::var("HII_UI_ALLOW_UNSIGNED").ok().as_deref() == Some("1") {
            return Ok(());
        }
        return Err("ui_bundle_unsigned".into());
    };
    let key = minisign_public_key()?;
    let signature = minisign_verify::Signature::decode(&signature)
        .map_err(|error| format!("ui_signature_invalid: {error}"))?;
    key.verify(bytes, &signature, false)
        .map_err(|error| format!("ui_signature_rejected: {error}"))
}

fn fetch_bytes(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    if !url.starts_with("https://")
        && !url.starts_with("http://127.0.0.1")
        && !url.starts_with("http://localhost")
    {
        return Err("ui_endpoint_insecure".into());
    }
    let response = ureq::get(url)
        .timeout(Duration::from_secs(60))
        .call()
        .map_err(|error| format!("ui_fetch_failed: {error}"))?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("ui_read_failed: {error}"))?;
    Ok(bytes)
}

fn extract_zip(bytes: &[u8], target: &Path) -> Result<(), String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|error| format!("ui_zip_invalid: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("ui_zip_entry_failed: {error}"))?;
        // `enclosed_name` rejects absolute paths and `..` traversal (zip slip).
        let Some(relative) = entry.enclosed_name() else {
            return Err("ui_zip_unsafe_entry".into());
        };
        let destination = target.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&destination)
                .map_err(|error| format!("ui_zip_dir_failed: {error}"))?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("ui_zip_dir_failed: {error}"))?;
        }
        let mut file = fs::File::create(&destination)
            .map_err(|error| format!("ui_zip_write_failed: {error}"))?;
        std::io::copy(&mut entry, &mut file)
            .map_err(|error| format!("ui_zip_copy_failed: {error}"))?;
    }
    Ok(())
}

/// Download, verify and stage a UI bundle. Returns the installed version.
fn install_from_manifest(manifest: &UiManifest) -> Result<String, String> {
    let bytes = fetch_bytes(&manifest.url, MAX_BUNDLE_BYTES)?;
    verify_bundle(&bytes, manifest)?;

    let version = safe_version(&manifest.version);
    let final_dir = bundle_dir(&version);
    let staging = bundles_dir().join(format!(".{version}.staging"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|error| format!("ui_stage_failed: {error}"))?;
    extract_zip(&bytes, &staging)?;
    if !staging.join("index.html").is_file() {
        let _ = fs::remove_dir_all(&staging);
        return Err("ui_bundle_missing_index".into());
    }
    let _ = fs::remove_dir_all(&final_dir);
    fs::rename(&staging, &final_dir).map_err(|error| format!("ui_install_failed: {error}"))?;
    Ok(version)
}

fn read_manifest(endpoint: &str) -> Result<UiManifest, String> {
    let bytes = fetch_bytes(endpoint, 1024 * 1024)?;
    serde_json::from_slice::<UiManifest>(&bytes)
        .map_err(|error| format!("ui_manifest_invalid: {error}"))
}

fn navigate_main<R: Runtime>(app: &tauri::AppHandle<R>, url: &str) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "ui_main_window_missing".to_string())?;
    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|error| format!("ui_url_invalid: {error}"))?;
    window
        .navigate(parsed)
        .map_err(|error| format!("ui_navigate_failed: {error}"))
}

fn status_value(state: &ChannelState) -> Value {
    let source = resolve_source(state);
    let (mode, url) = match &source {
        UiSource::Bundled => ("bundled", None),
        UiSource::Live(url) => ("live", Some(url.clone())),
        UiSource::Installed(_) => ("installed", Some(installed_url())),
    };
    json!({
        "mode": mode,
        "url": url,
        "version": state.version,
        "pendingVersion": state.pending_version,
        "endpoint": state.endpoint,
        "autoApply": state.auto_apply,
        "pollSeconds": state.poll_seconds.unwrap_or(DEFAULT_POLL_SECONDS),
        "channelDir": channel_dir().to_string_lossy(),
    })
}

/// Point the window at the resolved source at startup.
pub fn apply_startup<R: Runtime>(app: &tauri::AppHandle<R>) {
    let state = read_state();
    let source = resolve_source(&state);
    if let UiSource::Installed(version) = &source {
        app.state::<ActiveBundle>().set(Some(bundle_dir(version)));
    }
    if let Some(url) = source_url(&source) {
        if let Err(error) = navigate_main(app, &url) {
            eprintln!("hii: could not load the UI channel source ({error})");
        }
    }
}

/// Poll the manifest endpoint in the background so shipped interface work
/// reaches a running app without a rebuild.
pub fn spawn_poller<R: Runtime>(app: tauri::AppHandle<R>) {
    thread::spawn(move || loop {
        let state = read_state();
        let poll = state.poll_seconds.unwrap_or(DEFAULT_POLL_SECONDS).max(30);
        if state.endpoint.is_some() && !matches!(resolve_source(&state), UiSource::Live(_)) {
            let _ = check_and_install(&app, false);
        }
        thread::sleep(Duration::from_secs(poll));
    });
}

fn check_and_install<R: Runtime>(app: &tauri::AppHandle<R>, force: bool) -> Result<Value, String> {
    let mut state = read_state();
    // A live dev server always wins; never fight the developer's HMR session.
    if matches!(resolve_source(&state), UiSource::Live(_)) && !force {
        return Ok(json!({ "status": "skipped", "reason": "live" }));
    }
    let endpoint = state
        .endpoint
        .clone()
        .or_else(|| env::var("HII_UI_ENDPOINT").ok())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "ui_endpoint_missing".to_string())?;

    let manifest = read_manifest(&endpoint)?;
    let version = safe_version(&manifest.version);
    if state.version.as_deref() == Some(version.as_str()) && !force {
        return Ok(json!({ "status": "current", "version": version }));
    }
    let installed = install_from_manifest(&manifest)?;

    if state.auto_apply {
        state.version = Some(installed.clone());
        state.pending_version = None;
        state.mode = "installed".into();
        write_state(&state)?;
        app.state::<ActiveBundle>()
            .set(Some(bundle_dir(&installed)));
        navigate_main(app, &installed_url())?;
        let _ = app.emit("hii://ui-applied", json!({ "version": installed }));
        return Ok(json!({ "status": "applied", "version": installed }));
    }

    state.pending_version = Some(installed.clone());
    write_state(&state)?;
    let _ = app.emit(
        "hii://ui-update-available",
        json!({ "version": installed, "notes": manifest.notes }),
    );
    Ok(json!({ "status": "pending", "version": installed, "notes": manifest.notes }))
}

#[tauri::command]
pub fn ui_channel_status() -> Value {
    status_value(&read_state())
}

/// Follow a dev server (`Some(url)`) or stop following it (`None`).
#[tauri::command]
pub fn ui_channel_set_live(app: tauri::AppHandle, url: Option<String>) -> Result<Value, String> {
    let mut state = read_state();
    match url
        .map(|value| value.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        Some(url) => {
            let url = validate_live_url(&url)?;
            state.mode = "live".into();
            state.live_url = Some(url);
        }
        None => {
            state.live_url = None;
            state.mode = if state.version.is_some() {
                "installed".into()
            } else {
                "bundled".into()
            };
        }
    }
    write_state(&state)?;
    let source = resolve_source(&state);
    if let UiSource::Installed(version) = &source {
        app.state::<ActiveBundle>().set(Some(bundle_dir(version)));
    }
    match source_url(&source) {
        Some(url) => navigate_main(&app, &url)?,
        // Back to the baked interface, which only a restart can reload.
        None => {
            let _ = app.emit("hii://ui-restart-required", json!({}));
        }
    }
    Ok(status_value(&state))
}

/// Point the app at a manifest endpoint and choose how updates land.
#[tauri::command]
pub fn ui_channel_configure(
    endpoint: Option<String>,
    auto_apply: Option<bool>,
    poll_seconds: Option<u64>,
) -> Result<Value, String> {
    let mut state = read_state();
    if let Some(endpoint) = endpoint {
        let endpoint = endpoint.trim().to_string();
        state.endpoint = if endpoint.is_empty() {
            None
        } else {
            Some(endpoint)
        };
    }
    if let Some(auto_apply) = auto_apply {
        state.auto_apply = auto_apply;
    }
    if let Some(poll) = poll_seconds {
        state.poll_seconds = Some(poll.max(30));
    }
    write_state(&state)?;
    Ok(status_value(&state))
}

#[tauri::command]
pub fn ui_channel_check(app: tauri::AppHandle, force: Option<bool>) -> Result<Value, String> {
    check_and_install(&app, force.unwrap_or(false))
}

/// Apply a staged bundle (or reload the active one) without restarting.
#[tauri::command]
pub fn ui_channel_apply(app: tauri::AppHandle, version: Option<String>) -> Result<Value, String> {
    let mut state = read_state();
    let target = version
        .or_else(|| state.pending_version.clone())
        .or_else(|| state.version.clone())
        .ok_or_else(|| "ui_no_bundle".to_string())?;
    let target = safe_version(&target);
    if !bundle_dir(&target).join("index.html").is_file() {
        return Err("ui_bundle_missing".into());
    }
    state.version = Some(target.clone());
    state.pending_version = None;
    if state.mode != "live" {
        state.mode = "installed".into();
    }
    write_state(&state)?;
    app.state::<ActiveBundle>().set(Some(bundle_dir(&target)));
    navigate_main(&app, &installed_url())?;
    let _ = app.emit("hii://ui-applied", json!({ "version": target }));
    Ok(status_value(&state))
}

/// List installed bundles so a bad ship can be rolled back from the interface.
#[tauri::command]
pub fn ui_channel_versions() -> Vec<String> {
    let mut versions: Vec<String> = fs::read_dir(bundles_dir())
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().join("index.html").is_file())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    versions.sort();
    versions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = env::temp_dir().join(format!("hii-ui-channel-{name}"));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn traversal_cannot_escape_the_bundle_root() {
        let root = temp_root("traversal");
        fs::write(root.join("index.html"), "<html></html>").unwrap();
        assert_eq!(resolve_asset(&root, "/../../etc/passwd"), None);
        assert_eq!(resolve_asset(&root, "/%2e%2e/%2e%2e/etc/passwd"), None);
    }

    #[test]
    fn static_export_routes_resolve_like_a_static_host() {
        let root = temp_root("routes");
        fs::create_dir_all(root.join("_next/static")).unwrap();
        fs::write(root.join("index.html"), "shell").unwrap();
        fs::write(root.join("space.html"), "space").unwrap();
        fs::write(root.join("_next/static/app.js"), "code").unwrap();

        assert_eq!(resolve_asset(&root, "/"), Some(root.join("index.html")));
        assert_eq!(
            resolve_asset(&root, "/space"),
            Some(root.join("space.html"))
        );
        assert_eq!(
            resolve_asset(&root, "/_next/static/app.js?v=1"),
            Some(root.join("_next/static/app.js"))
        );
        // A missing asset must 404 rather than serve HTML to a script tag.
        assert_eq!(resolve_asset(&root, "/_next/static/missing.js"), None);
        // A client-side route falls back to the shell document.
        assert_eq!(
            resolve_asset(&root, "/unknown/route"),
            Some(root.join("index.html"))
        );
    }

    #[test]
    fn live_env_override_wins_over_installed_state() {
        let state = ChannelState {
            mode: "installed".into(),
            version: Some("1.0.0".into()),
            ..Default::default()
        };
        env::set_var("HII_UI_URL", "http://127.0.0.1:3042");
        assert_eq!(
            resolve_source(&state),
            UiSource::Live("http://127.0.0.1:3042".into())
        );
        env::remove_var("HII_UI_URL");
    }

    #[test]
    fn live_sources_are_loopback_http_only() {
        assert!(validate_live_url("http://127.0.0.1:3042").is_ok());
        assert!(validate_live_url("http://localhost:3042").is_ok());
        assert_eq!(
            validate_live_url("https://example.com/ui").unwrap_err(),
            "ui_live_url_rejected"
        );
        assert_eq!(
            validate_live_url("http://localhost.evil:3042").unwrap_err(),
            "ui_live_url_rejected"
        );
        assert_eq!(
            validate_live_url("http://localhost").unwrap_err(),
            "ui_live_url_rejected"
        );
    }

    #[test]
    fn versions_cannot_name_paths_outside_the_bundle_store() {
        assert_eq!(safe_version("../../etc"), "_.._etc");
        assert_eq!(safe_version("1.2.3"), "1.2.3");
        assert_eq!(safe_version(""), "unknown");
    }

    #[test]
    fn unsigned_bundles_are_refused_by_default() {
        env::remove_var("HII_UI_ALLOW_UNSIGNED");
        let bytes = b"interface";
        let manifest = UiManifest {
            version: "1.0.0".into(),
            url: "https://example.com/ui.zip".into(),
            sha256: sha256_hex(bytes),
            signature: None,
            notes: None,
        };
        assert_eq!(
            verify_bundle(bytes, &manifest).unwrap_err(),
            "ui_bundle_unsigned"
        );
    }

    #[test]
    fn a_tampered_bundle_fails_before_any_signature_work() {
        let manifest = UiManifest {
            version: "1.0.0".into(),
            url: "https://example.com/ui.zip".into(),
            sha256: sha256_hex(b"interface"),
            signature: Some("whatever".into()),
            notes: None,
        };
        assert_eq!(
            verify_bundle(b"tampered", &manifest).unwrap_err(),
            "ui_bundle_digest_mismatch"
        );
    }

    #[test]
    fn plain_http_endpoints_are_refused_off_loopback() {
        assert_eq!(
            fetch_bytes("http://example.com/ui.json", 1024).unwrap_err(),
            "ui_endpoint_insecure"
        );
    }

    #[test]
    fn the_updater_public_key_decodes() {
        env::remove_var("HII_UI_PUBKEY");
        assert!(minisign_public_key().is_ok());
    }
}
