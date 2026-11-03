//! Shared identity and content storage for every HII-controlled run.

use ring::digest::{digest, Context as DigestContext, SHA256};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const RUN_ENVELOPE_VERSION: u8 = 2;
pub const INLINE_EVENT_MAX_BYTES: usize = 64 * 1024;
pub const RECEIPT_MAX_BYTES: usize = 256 * 1024;
pub const DEFAULT_MIN_FREE_BYTES: u64 = 5 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunEnvelopeV2 {
    pub version: u8,
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    pub surface: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interaction_id: Option<String>,
    pub trace_id: String,
    pub span_id: String,
    pub actor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routed_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub served_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routing_reason: Option<String>,
    pub created_at_unix_ms: u128,
}

impl RunEnvelopeV2 {
    pub fn current(surface: &str, created_at_unix_ms: u128) -> Self {
        let explicit_run_id = env_id("HII_RUN_ID");
        let daemon_run_id = env_id("HII_DAEMON_RUN_ID");
        let run_id = explicit_run_id.unwrap_or_else(new_run_id);
        Self {
            version: RUN_ENVELOPE_VERSION,
            trace_id: env_id("HII_TRACE_ID")
                .or_else(|| daemon_run_id.clone())
                .unwrap_or_else(|| run_id.clone()),
            span_id: env_id("HII_SPAN_ID").unwrap_or_else(new_span_id),
            run_id: run_id.clone(),
            parent_run_id: env_id("HII_PARENT_RUN_ID").or(daemon_run_id),
            conversation_id: env_id("HII_CONVERSATION_ID"),
            surface: env::var("HII_SURFACE")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| surface.to_string()),
            external_request_id: env_id("HII_EXTERNAL_REQUEST_ID"),
            interaction_id: env_id("HII_INTERACTION_ID").or_else(|| Some(run_id.clone())),
            actor: env::var("HII_ACTOR")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "operator".into()),
            authority: env::var("HII_AUTHORITY")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            requested_model: env_text("HII_REQUESTED_MODEL"),
            routed_model: env_text("HII_ROUTED_MODEL"),
            served_model: env_text("HII_SERVED_MODEL"),
            routing_reason: env_text("HII_ROUTING_REASON"),
            created_at_unix_ms,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlobRef {
    pub sha256: String,
    pub path: String,
    pub encoding: String,
    pub media_type: String,
    pub original_bytes: u64,
    pub stored_bytes: u64,
}

pub struct RunLedger {
    pub envelope: RunEnvelopeV2,
    pub dir: PathBuf,
    runtime: PathBuf,
    events: PathBuf,
    state: Mutex<LedgerState>,
}

#[derive(Default)]
struct LedgerState {
    sequence: u64,
    previous_hash: String,
}

impl RunLedger {
    pub fn create(runtime: &Path, namespace: &str, surface: &str) -> Result<Self, String> {
        Self::create_linked(runtime, namespace, surface, None, None)
    }

    pub fn create_linked(
        runtime: &Path,
        namespace: &str,
        surface: &str,
        conversation_id: Option<&str>,
        external_request_id: Option<&str>,
    ) -> Result<Self, String> {
        ensure_writable(runtime)?;
        if !valid_id(namespace) {
            return Err(format!("invalid HII ledger namespace: {namespace}"));
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let mut envelope = RunEnvelopeV2::current(surface, now);
        if envelope.conversation_id.is_none() {
            envelope.conversation_id = conversation_id
                .filter(|value| valid_id(value))
                .map(str::to_owned);
        }
        if envelope.external_request_id.is_none() {
            envelope.external_request_id = external_request_id
                .filter(|value| valid_id(value))
                .map(str::to_owned);
        }
        let namespace_dir = runtime.join("runs").join(namespace);
        fs::create_dir_all(&namespace_dir).map_err(|error| error.to_string())?;
        let dir = namespace_dir.join(&envelope.run_id);
        fs::create_dir(&dir).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                format!("HII run id collision: {}", envelope.run_id)
            } else {
                error.to_string()
            }
        })?;
        write_private_atomic(
            &dir.join("run.json"),
            &serde_json::to_vec_pretty(&envelope).map_err(|error| error.to_string())?,
        )?;
        Ok(Self {
            events: dir.join("events.jsonl"),
            dir,
            runtime: runtime.to_path_buf(),
            envelope,
            state: Mutex::new(LedgerState::default()),
        })
    }

    pub fn events_path(&self) -> &Path {
        &self.events
    }

    /// Complete the routing portion of the envelope once provider selection is
    /// known. This happens before inference and rewrites only the small identity
    /// file, never the append-only event journal.
    pub fn set_model_route(
        &mut self,
        requested: Option<&str>,
        routed: &str,
        served: &str,
        reason: &str,
    ) -> Result<(), String> {
        self.envelope.requested_model = requested
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        self.envelope.routed_model = nonempty(routed);
        self.envelope.served_model = nonempty(served);
        self.envelope.routing_reason = nonempty(reason);
        write_private_atomic(
            &self.dir.join("run.json"),
            &serde_json::to_vec_pretty(&self.envelope).map_err(|error| error.to_string())?,
        )
    }

    pub fn set_authority(&mut self, authority: &str) -> Result<(), String> {
        self.envelope.authority = nonempty(authority);
        write_private_atomic(
            &self.dir.join("run.json"),
            &serde_json::to_vec_pretty(&self.envelope).map_err(|error| error.to_string())?,
        )
    }

    pub fn chain_root(&self) -> Option<String> {
        self.state
            .lock()
            .ok()
            .map(|state| state.previous_hash.clone())
            .filter(|value| !value.is_empty())
    }

    pub fn event(&self, kind: &str, data: serde_json::Value) -> Result<(), String> {
        let raw = serde_json::to_vec(&data).map_err(|error| error.to_string())?;
        let data = if raw.len() > INLINE_EVENT_MAX_BYTES {
            let blob = store_blob(&self.runtime, "application/vnd.hii.event+json", &raw)?;
            serde_json::json!({
                "contentRef": blob,
                "inline": false,
                "originalBytes": raw.len()
            })
        } else {
            data
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| "HII ledger lock was poisoned".to_string())?;
        state.sequence += 1;
        let previous = (!state.previous_hash.is_empty()).then(|| state.previous_hash.clone());
        let mut entry = serde_json::json!({
            "ts_unix_ms": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            "run_id": self.envelope.run_id,
            "sequence": state.sequence,
            "previous_hash": previous,
            "kind": kind,
            "data": data
        });
        let canonical = serde_json::to_vec(&entry).map_err(|error| error.to_string())?;
        let mut event_hash = sha256_hex(&canonical);
        entry["event_hash"] = serde_json::json!(event_hash);
        let mut line = serde_json::to_vec(&entry).map_err(|error| error.to_string())?;
        if line.len() + 1 > INLINE_EVENT_MAX_BYTES {
            let blob = store_blob(&self.runtime, "application/vnd.hii.event+json", &raw)?;
            entry["data"] = serde_json::json!({
                "contentRef": blob,
                "inline": false,
                "originalBytes": raw.len()
            });
            if let Some(object) = entry.as_object_mut() {
                object.remove("event_hash");
            }
            let canonical = serde_json::to_vec(&entry).map_err(|error| error.to_string())?;
            event_hash = sha256_hex(&canonical);
            entry["event_hash"] = serde_json::json!(event_hash);
            line = serde_json::to_vec(&entry).map_err(|error| error.to_string())?;
        }
        if line.len() + 1 > INLINE_EVENT_MAX_BYTES {
            return Err("HII could not compact an event below 64 KiB".into());
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.events)
            .map_err(|error| error.to_string())?;
        set_private(&self.events)?;
        file.write_all(&line).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.sync_data().map_err(|error| error.to_string())?;
        state.previous_hash = event_hash;
        Ok(())
    }

    pub fn finish(&self, mut receipt: serde_json::Value) -> Result<PathBuf, String> {
        receipt["run"] = serde_json::to_value(&self.envelope).map_err(|error| error.to_string())?;
        receipt["eventChainRoot"] =
            serde_json::to_value(self.chain_root()).map_err(|error| error.to_string())?;
        let original = serde_json::to_vec(&receipt).map_err(|error| error.to_string())?;
        if original.len() > RECEIPT_MAX_BYTES {
            let blob = store_blob(&self.runtime, "application/vnd.hii.receipt+json", &original)?;
            receipt = serde_json::json!({
                "schemaVersion": 2,
                "id": self.envelope.run_id,
                "status": receipt.get("status").cloned().unwrap_or(serde_json::Value::Null),
                "summary": "Receipt compacted; full local record is in contentBlobs.",
                "receiptCompacted": true,
                "run": self.envelope,
                "eventChainRoot": self.chain_root(),
                "contentBlobs": [blob]
            });
        }
        let path = self.dir.join("receipt.json");
        let bytes = serde_json::to_vec_pretty(&receipt).map_err(|error| error.to_string())?;
        if bytes.len() > RECEIPT_MAX_BYTES {
            return Err("HII could not compact the run receipt below 256 KiB".into());
        }
        write_private_atomic(&path, &bytes)?;
        Ok(path)
    }
}

pub fn new_run_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn new_span_id() -> String {
    uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(16)
        .collect()
}

fn env_id(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| valid_id(value))
}

fn env_text(name: &str) -> Option<String> {
    env::var(name).ok().and_then(|value| nonempty(&value))
}

fn nonempty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Redact credential-bearing transcript lines before they enter the private
/// operational ledger. HII retains model-visible content, not secrets.
pub fn redact_sensitive_text(value: &str) -> String {
    value
        .lines()
        .map(|line| {
            let upper = line.to_ascii_uppercase();
            let sensitive_key = [
                "API_KEY",
                "ACCESS_KEY",
                "SECRET",
                "TOKEN",
                "PASSWORD",
                "PRIVATE KEY",
                "AUTHORIZATION:",
            ]
            .iter()
            .any(|marker| upper.contains(marker));
            let sensitive_value =
                line.contains("sk-") || line.contains("ghp_") || line.contains("hii_runner_");
            if sensitive_key || sensitive_value {
                "[redacted]".to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn minimum_free_bytes() -> u64 {
    env::var("HII_LEDGER_MIN_FREE_BYTES")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_MIN_FREE_BYTES)
}

/// Logging is part of an HII-controlled run, so a run does not begin when its
/// ledger cannot be initialized safely.
pub fn ensure_writable(runtime: &Path) -> Result<(), String> {
    fs::create_dir_all(runtime).map_err(|error| error.to_string())?;
    let available = fs2::available_space(runtime).map_err(|error| error.to_string())?;
    let minimum = minimum_free_bytes();
    if available < minimum {
        return Err(format!(
            "HII run ledger needs at least {minimum} free bytes; only {available} are available"
        ));
    }
    let probe = runtime.join(".ledger-write-probe");
    fs::write(&probe, b"ok").map_err(|error| error.to_string())?;
    fs::remove_file(&probe).map_err(|error| error.to_string())
}

/// Store large private content once, addressed by the SHA-256 of its original
/// bytes. The returned path is relative to the runtime root and portable with
/// a local HII archive.
pub fn store_blob(runtime: &Path, media_type: &str, bytes: &[u8]) -> Result<BlobRef, String> {
    ensure_writable(runtime)?;
    let hash = sha256_hex(bytes);
    let relative = PathBuf::from("runs")
        .join("blobs")
        .join("sha256")
        .join(&hash[..2])
        .join(format!("{hash}.zst"));
    let path = runtime.join(&relative);
    if !path.is_file() {
        let parent = path.parent().ok_or("invalid HII blob path")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let compressed = zstd::stream::encode_all(bytes, 7).map_err(|error| error.to_string())?;
        let temp = path.with_extension(format!("zst.tmp-{}", std::process::id()));
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| error.to_string())?;
        file.write_all(&compressed)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        set_private(&temp)?;
        match fs::rename(&temp, &path) {
            Ok(()) => {}
            Err(error) if path.is_file() => {
                let _ = fs::remove_file(&temp);
                let _ = error;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let stored_bytes = fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len();
    Ok(BlobRef {
        sha256: hash,
        path: relative.to_string_lossy().to_string(),
        encoding: "zstd".into(),
        media_type: media_type.into(),
        original_bytes: bytes.len() as u64,
        stored_bytes,
    })
}

pub fn read_blob(runtime: &Path, blob: &BlobRef) -> Result<Vec<u8>, String> {
    let compressed = fs::read(runtime.join(&blob.path)).map_err(|error| error.to_string())?;
    let bytes =
        zstd::stream::decode_all(compressed.as_slice()).map_err(|error| error.to_string())?;
    let actual = sha256_hex(&bytes);
    if actual != blob.sha256 {
        return Err(format!(
            "HII blob hash mismatch: expected {}, got {actual}",
            blob.sha256
        ));
    }
    Ok(bytes)
}

/// Read the last V2 event hash from a bounded tail window. New event records
/// are capped at 64 KiB, so this never scans a historical multi-gigabyte log.
pub fn event_chain_root(path: &Path) -> Result<Option<String>, String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    let window = length.min((INLINE_EVENT_MAX_BYTES * 2) as u64);
    file.seek(SeekFrom::End(-(window as i64)))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(window as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    let Some(line) = text.lines().rev().find(|line| !line.trim().is_empty()) else {
        return Ok(None);
    };
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|error| format!("invalid final HII event: {error}"))?;
    Ok(value
        .get("event_hash")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned))
}

/// Streaming archival for legacy files that are too large to hold in memory.
pub fn store_file_blob(runtime: &Path, source: &Path, media_type: &str) -> Result<BlobRef, String> {
    ensure_writable(runtime)?;
    let original_bytes = fs::metadata(source)
        .map_err(|error| error.to_string())?
        .len();
    let temporary_dir = runtime.join("runs/blobs/tmp");
    fs::create_dir_all(&temporary_dir).map_err(|error| error.to_string())?;
    let temporary = temporary_dir.join(format!(
        "archive-{}-{}.zst",
        std::process::id(),
        new_run_id()
    ));
    let input = fs::File::open(source).map_err(|error| error.to_string())?;
    let output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    set_private(&temporary)?;
    let mut reader = std::io::BufReader::new(input);
    let mut encoder =
        zstd::stream::write::Encoder::new(output, 7).map_err(|error| error.to_string())?;
    let mut hasher = DigestContext::new(&SHA256);
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        encoder
            .write_all(&buffer[..count])
            .map_err(|error| error.to_string())?;
    }
    let output = encoder.finish().map_err(|error| error.to_string())?;
    output.sync_all().map_err(|error| error.to_string())?;
    let hash = hasher
        .finish()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let relative = PathBuf::from("runs/blobs/sha256")
        .join(&hash[..2])
        .join(format!("{hash}.zst"));
    let destination = runtime.join(&relative);
    fs::create_dir_all(destination.parent().ok_or("invalid HII archive path")?)
        .map_err(|error| error.to_string())?;
    if destination.is_file() {
        fs::remove_file(&temporary).map_err(|error| error.to_string())?;
    } else {
        fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
    }
    let stored_bytes = fs::metadata(&destination)
        .map_err(|error| error.to_string())?
        .len();
    let blob = BlobRef {
        sha256: hash,
        path: relative.to_string_lossy().to_string(),
        encoding: "zstd".into(),
        media_type: media_type.into(),
        original_bytes,
        stored_bytes,
    };
    verify_blob(runtime, &blob)?;
    Ok(blob)
}

pub fn verify_blob(runtime: &Path, blob: &BlobRef) -> Result<(), String> {
    let file = fs::File::open(runtime.join(&blob.path)).map_err(|error| error.to_string())?;
    let mut decoder = zstd::stream::read::Decoder::new(file).map_err(|error| error.to_string())?;
    let mut hasher = DigestContext::new(&SHA256);
    let mut total = 0u64;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let count = decoder
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        total += count as u64;
    }
    let actual = hasher
        .finish()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if actual != blob.sha256 || total != blob.original_bytes {
        return Err(format!(
            "archived blob verification failed for {}",
            blob.path
        ));
    }
    Ok(())
}

pub fn restore_blob(runtime: &Path, blob: &BlobRef, destination: &Path) -> Result<(), String> {
    verify_blob(runtime, blob)?;
    let parent = destination.parent().ok_or("invalid HII restore path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = destination.with_extension(format!("restore-{}", std::process::id()));
    let input = fs::File::open(runtime.join(&blob.path)).map_err(|error| error.to_string())?;
    let mut decoder = zstd::stream::read::Decoder::new(input).map_err(|error| error.to_string())?;
    let mut output = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    std::io::copy(&mut decoder, &mut output).map_err(|error| error.to_string())?;
    output.sync_all().map_err(|error| error.to_string())?;
    set_private(&temporary)?;
    fs::rename(&temporary, destination).map_err(|error| error.to_string())
}

#[cfg(unix)]
fn set_private(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn set_private(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("invalid HII ledger path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    set_private(&temp)?;
    fs::rename(&temp, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex as TestMutex, MutexGuard};

    static ENV_LOCK: TestMutex<()> = TestMutex::new(());

    fn ledger_env() -> MutexGuard<'static, ()> {
        let guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::set_var("HII_LEDGER_MIN_FREE_BYTES", "0");
        guard
    }

    #[test]
    fn inherited_identity_is_validated() {
        assert!(valid_id("019f-run_remote.2"));
        assert!(!valid_id("../escape"));
        assert!(!valid_id("space id"));
    }

    #[test]
    fn blob_round_trip_is_content_addressed() {
        let _guard = ledger_env();
        let runtime = tempfile::tempdir().unwrap();
        let first = store_blob(
            runtime.path(),
            "application/json",
            br#"{"full":"transcript"}"#,
        )
        .unwrap();
        let second = store_blob(
            runtime.path(),
            "application/json",
            br#"{"full":"transcript"}"#,
        )
        .unwrap();
        assert_eq!(first, second);
        assert_eq!(
            read_blob(runtime.path(), &first).unwrap(),
            br#"{"full":"transcript"}"#
        );
        std::env::remove_var("HII_LEDGER_MIN_FREE_BYTES");
    }

    #[test]
    fn events_are_bounded_and_hash_chained() {
        let _guard = ledger_env();
        let runtime = tempfile::tempdir().unwrap();
        let ledger = RunLedger::create(runtime.path(), "tests", "unit").unwrap();
        ledger
            .event(
                "large",
                serde_json::json!({"content": "x".repeat(INLINE_EVENT_MAX_BYTES - 128)}),
            )
            .unwrap();
        ledger
            .event("small", serde_json::json!({"ok": true}))
            .unwrap();
        let lines = fs::read_to_string(ledger.events_path()).unwrap();
        let values = lines
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(values.len(), 2);
        assert!(lines
            .lines()
            .all(|line| line.len() + 1 <= INLINE_EVENT_MAX_BYTES));
        assert_eq!(values[0]["sequence"], 1);
        assert_eq!(values[0]["data"]["inline"], false);
        assert_eq!(values[1]["sequence"], 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(ledger.events_path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert_eq!(values[1]["previous_hash"], values[0]["event_hash"]);
        assert_eq!(
            event_chain_root(ledger.events_path()).unwrap().as_deref(),
            values[1]["event_hash"].as_str()
        );
        std::env::remove_var("HII_LEDGER_MIN_FREE_BYTES");
    }

    #[test]
    fn envelope_persists_identity_authority_and_model_route() {
        let _guard = ledger_env();
        std::env::set_var("HII_INTERACTION_ID", "test-interaction");
        let runtime = tempfile::tempdir().unwrap();
        let mut ledger = RunLedger::create(runtime.path(), "tests", "unit").unwrap();
        ledger.set_authority("workspace").unwrap();
        ledger
            .set_model_route(
                Some("requested-model"),
                "routed-model",
                "served-model",
                "hardware fit",
            )
            .unwrap();
        let persisted: RunEnvelopeV2 =
            serde_json::from_slice(&fs::read(ledger.dir.join("run.json")).unwrap()).unwrap();
        assert_eq!(
            persisted.interaction_id.as_deref(),
            Some("test-interaction")
        );
        assert_eq!(persisted.trace_id, persisted.run_id);
        assert_eq!(persisted.authority.as_deref(), Some("workspace"));
        assert_eq!(
            persisted.requested_model.as_deref(),
            Some("requested-model")
        );
        assert_eq!(persisted.routed_model.as_deref(), Some("routed-model"));
        assert_eq!(persisted.served_model.as_deref(), Some("served-model"));
        assert_eq!(persisted.routing_reason.as_deref(), Some("hardware fit"));
        std::env::remove_var("HII_INTERACTION_ID");
        std::env::remove_var("HII_LEDGER_MIN_FREE_BYTES");
    }

    #[test]
    fn transcript_redaction_removes_secret_lines() {
        let text = "hello\nAPI_KEY=super-secret\nworld";
        assert_eq!(redact_sensitive_text(text), "hello\n[redacted]\nworld");
    }
}
