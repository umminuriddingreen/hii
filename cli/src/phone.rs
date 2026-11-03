// SPDX-License-Identifier: Apache-2.0
//! A short-lived, account-relayed projection of one active CLI conversation.
//! The handoff file contains scope only; transcript events stay in the CLI
//! journal and are projected only after an account-authenticated phone attaches.

use qrcode::{EcLevel, QrCode, render::unicode::Dense1x2};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use url::Url;

use crate::{
    budget::{Cancel, CancelReason},
    config::AppPaths,
    receipt::redact_text,
};

const GRANT_TTL_SECS: u64 = 3_600;
const MAX_PHONE_TEXT_BYTES: usize = 8_000;
const MAX_INBOX_BYTES: u64 = 1_048_576;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneGrant {
    pub schema_version: u8,
    pub handoff_id: String,
    pub host_id: String,
    pub conversation_id: String,
    pub created_at_unix: u64,
    pub expires_at_unix: u64,
    #[serde(default)]
    pub revoked_at_unix: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhoneRequest {
    request_id: String,
    handoff_id: String,
    kind: String,
    text: Option<String>,
    created_at_unix: u64,
}

#[derive(Clone, Debug)]
pub struct PhoneInput {
    pub request_id: String,
    pub text: String,
}

fn now_unix() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .map_err(|error| error.to_string())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn root(paths: &AppPaths) -> PathBuf {
    paths.runtime.join("phone")
}

fn grant_path(paths: &AppPaths, handoff_id: &str) -> Result<PathBuf, String> {
    if !valid_id(handoff_id) {
        return Err("invalid phone handoff ID".into());
    }
    Ok(root(paths)
        .join("handoffs")
        .join(format!("{handoff_id}.json")))
}

fn input_path(paths: &AppPaths, handoff_id: &str) -> Result<PathBuf, String> {
    let _ = grant_path(paths, handoff_id)?;
    Ok(root(paths)
        .join("inbox")
        .join(format!("{handoff_id}.inputs.jsonl")))
}

fn cancel_path(paths: &AppPaths, handoff_id: &str) -> Result<PathBuf, String> {
    let _ = grant_path(paths, handoff_id)?;
    Ok(root(paths)
        .join("inbox")
        .join(format!("{handoff_id}.cancels.jsonl")))
}

fn statuses_path(paths: &AppPaths, handoff_id: &str) -> Result<PathBuf, String> {
    let _ = grant_path(paths, handoff_id)?;
    Ok(root(paths)
        .join("inbox")
        .join(format!("{handoff_id}.status.jsonl")))
}

fn ensure_private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn load_grant(paths: &AppPaths, handoff_id: &str) -> Result<PhoneGrant, String> {
    let path = grant_path(paths, handoff_id)?;
    let bytes = fs::read(path).map_err(|_| "phone handoff is unavailable".to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "phone handoff record is invalid".to_string())
}

fn active_grant(paths: &AppPaths, handoff_id: &str, host_id: &str) -> Result<PhoneGrant, String> {
    let grant = load_grant(paths, handoff_id)?;
    if grant.host_id != host_id {
        return Err("phone handoff is bound to a different account host".into());
    }
    if grant.revoked_at_unix.is_some() {
        return Err("phone handoff was revoked".into());
    }
    if grant.expires_at_unix <= now_unix()? {
        let mut expired = grant.clone();
        expired.revoked_at_unix = Some(grant.expires_at_unix);
        crate::store::write_json_private_atomic(&grant_path(paths, handoff_id)?, &expired)?;
        append_status(paths, handoff_id, "expired", None)?;
        return Err("phone handoff has expired".into());
    }
    Ok(grant)
}

fn host_config(paths: &AppPaths) -> Result<(String, Url), String> {
    let path = paths.runtime.join("remote/host.json");
    let bytes = fs::read(&path).map_err(|_| {
        "No account-paired HII host is configured on this computer. Pair this computer from the signed-in HII account first.".to_string()
    })?;
    let config: Value =
        serde_json::from_slice(&bytes).map_err(|_| "paired host config is invalid".to_string())?;
    let token = config
        .get("token")
        .and_then(Value::as_str)
        .ok_or("paired host credential is unavailable")?;
    let (host_id, secret) = token
        .split_once('.')
        .ok_or("paired host credential has invalid format")?;
    if !valid_id(host_id) {
        return Err("paired host identity is invalid".into());
    }
    if secret.len() < 32
        || !secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("paired host credential has invalid format".into());
    }
    let relay = config
        .get("relay")
        .and_then(Value::as_str)
        .unwrap_or("wss://humaninformationinterface.com/api/remote/host");
    let mut url = Url::parse(relay).map_err(|_| "paired host relay URL is invalid")?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("paired host relay URL must not contain credentials".into());
    }
    let scheme = match url.scheme() {
        "wss" => "https".to_string(),
        "ws" => "http".to_string(),
        "https" | "http" => url.scheme().to_string(),
        _ => return Err("paired host relay must use HTTP(S) or WS(S)".into()),
    };
    url.set_scheme(&scheme)
        .map_err(|_| "paired host relay URL is invalid")?;
    url.set_path("/phone");
    url.set_query(None);
    url.set_fragment(None);
    Ok((host_id.to_string(), url))
}

pub fn render_qr(url: &str) -> Result<String, String> {
    let code = QrCode::with_error_correction_level(url.as_bytes(), EcLevel::M)
        .map_err(|error| format!("could not render phone QR: {error}"))?;
    Ok(code.render::<Dense1x2>().quiet_zone(true).build())
}

pub fn create_grant(
    paths: &AppPaths,
    conversation_id: &str,
) -> Result<(PhoneGrant, String), String> {
    if !valid_id(conversation_id) {
        return Err("active CLI conversation ID is invalid".into());
    }
    let (host_id, mut url) = host_config(paths)?;
    let now = now_unix()?;
    let grant = PhoneGrant {
        schema_version: 1,
        handoff_id: uuid::Uuid::new_v4().simple().to_string(),
        host_id: host_id.clone(),
        conversation_id: conversation_id.to_string(),
        created_at_unix: now,
        expires_at_unix: now + GRANT_TTL_SECS,
        revoked_at_unix: None,
    };
    let handoffs = root(paths).join("handoffs");
    ensure_private_dir(&root(paths))?;
    ensure_private_dir(&handoffs)?;
    ensure_private_dir(&root(paths).join("inbox"))?;
    crate::store::write_json_private_atomic(
        &handoffs.join(format!("{}.json", grant.handoff_id)),
        &grant,
    ).map_err(|error| format!("save phone grant: {error}"))?;
    url.query_pairs_mut()
        .append_pair("host", &host_id)
        .append_pair("handoff", &grant.handoff_id);
    append_status(paths, &grant.handoff_id, "started", None)
        .map_err(|error| format!("record phone grant: {error}"))?;
    Ok((grant, url.to_string()))
}

pub fn revoke_grant(paths: &AppPaths, handoff_id: &str) -> Result<(), String> {
    let mut grant = load_grant(paths, handoff_id)?;
    if grant.revoked_at_unix.is_none() {
        grant.revoked_at_unix = Some(now_unix()?);
        crate::store::write_json_private_atomic(&grant_path(paths, handoff_id)?, &grant)?;
        append_status(paths, handoff_id, "revoked", None)?;
    }
    Ok(())
}

fn append_line(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("phone inbox path has no parent")?;
    ensure_private_dir(parent)?;
    let mut options = OpenOptions::new();
    options.create(true).read(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    fs2::FileExt::lock_exclusive(&file).map_err(|error| format!("lock phone journal: {error}"))?;
    if file.metadata().map_err(|error| error.to_string())?.len() > MAX_INBOX_BYTES {
        return Err("phone handoff inbox reached its size limit".into());
    }
    serde_json::to_writer(&mut file, value).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    file.sync_data().map_err(|error| format!("sync phone journal: {error}"))?;
    let _ = fs2::FileExt::unlock(&file);
    Ok(())
}

fn read_lines(path: &Path) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    if fs::metadata(path).map_err(|error| error.to_string())?.len() > MAX_INBOX_BYTES {
        return Err("phone handoff queue exceeds its size limit".into());
    }
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    fs2::FileExt::lock_shared(&file).map_err(|error| error.to_string())?;
    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|error| error.to_string())?;
    let values = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(|error| error.to_string()))
        .collect::<Result<Vec<Value>, _>>()?;
    let _ = fs2::FileExt::unlock(&file);
    Ok(values)
}

fn read_lines_after(path: &Path, cursor: u64, max_bytes: u64) -> Result<(Vec<Value>, u64), String> {
    if !path.exists() {
        return Ok((Vec::new(), cursor));
    }
    let file = File::open(path).map_err(|error| error.to_string())?;
    fs2::FileExt::lock_shared(&file).map_err(|error| error.to_string())?;
    let len = file.metadata().map_err(|error| error.to_string())?.len();
    let mut reader = BufReader::new(file);
    reader
        .seek(SeekFrom::Start(cursor.min(len)))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    (&mut reader)
        .take(max_bytes)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let mut consumed = 0_u64;
    let mut values = Vec::new();
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        if !line.ends_with(b"\n") {
            break;
        }
        consumed += line.len() as u64;
        if !line.iter().all(u8::is_ascii_whitespace) {
            values.push(serde_json::from_slice(line).map_err(|error| error.to_string())?);
        }
    }
    let _ = fs2::FileExt::unlock(reader.get_ref());
    Ok((values, cursor.min(len) + consumed))
}

fn append_status(
    paths: &AppPaths,
    handoff_id: &str,
    status: &str,
    request_id: Option<&str>,
) -> Result<(), String> {
    append_line(
        &statuses_path(paths, handoff_id)?,
        &json!({
            "status": status,
            "requestId": request_id,
            "createdAtUnix": now_unix()?
        }),
    )
}

pub fn receive(
    paths: &AppPaths,
    handoff_id: &str,
    host_id: &str,
    request_id: &str,
    kind: &str,
    text: Option<&str>,
) -> Result<(), String> {
    let grant = active_grant(paths, handoff_id, host_id)?;
    if !valid_id(request_id) {
        return Err("invalid phone request ID".into());
    }
    let (target, payload_text) = match kind {
        "input" => {
            let prompt = text.unwrap_or("").trim();
            if prompt.is_empty() || prompt.len() > MAX_PHONE_TEXT_BYTES {
                return Err("phone input must be 1 to 8000 UTF-8 bytes".into());
            }
            (input_path(paths, handoff_id)?, Some(prompt.to_string()))
        }
        "cancel" if text.is_none_or(str::is_empty) => (cancel_path(paths, handoff_id)?, None),
        "cancel" => return Err("phone cancel must not include text".into()),
        _ => return Err("unsupported phone request".into()),
    };
    if read_lines(&target)?
        .iter()
        .any(|entry| entry.get("requestId").and_then(Value::as_str) == Some(request_id))
    {
        return Ok(());
    }
    let request = PhoneRequest {
        request_id: request_id.into(),
        handoff_id: grant.handoff_id,
        kind: kind.into(),
        text: payload_text,
        created_at_unix: now_unix()?,
    };
    append_line(
        &target,
        &serde_json::to_value(request).map_err(|error| error.to_string())?,
    )
}

fn read_cursor(path: &Path) -> u64 {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0)
}

fn write_cursor(path: &Path, cursor: u64) -> Result<(), String> {
    crate::store::write_private_atomic(path, format!("{cursor}\n").as_bytes())
}

fn append_status_once(
    paths: &AppPaths,
    handoff_id: &str,
    status: &str,
    request_id: &str,
) -> Result<(), String> {
    let path = statuses_path(paths, handoff_id)?;
    if read_lines(&path)?.iter().any(|entry| {
        entry.get("requestId").and_then(Value::as_str) == Some(request_id)
            && entry.get("status").and_then(Value::as_str) == Some(status)
    }) {
        return Ok(());
    }
    append_status(paths, handoff_id, status, Some(request_id))
}

pub struct PhoneListener {
    handoff_id: String,
    host_id: String,
    pending_input_cursor: Mutex<u64>,
    cancel_thread_active: Arc<AtomicBool>,
    _cancel_thread: thread::JoinHandle<()>,
}

impl Drop for PhoneListener {
    fn drop(&mut self) {
        self.cancel_thread_active.store(false, Ordering::Release);
    }
}

/// Convert local listener errors to safe, stable journal reason codes.
pub fn detach_reason(error: &str) -> &'static str {
    if error.contains("expired") {
        "expired"
    } else if error.contains("revoked") {
        "revoked"
    } else if error.contains("different account host") {
        "host_mismatch"
    } else if error.contains("different CLI conversation") {
        "conversation_mismatch"
    } else if error.contains("unavailable") {
        "unavailable"
    } else {
        "listener_error"
    }
}

pub struct ActiveCancelGuard(Arc<Mutex<Option<Cancel>>>);

impl ActiveCancelGuard {
    pub fn start(slot: Arc<Mutex<Option<Cancel>>>, cancel: Cancel) -> Self {
        if let Ok(mut current) = slot.lock() {
            *current = Some(cancel);
        }
        Self(slot)
    }
}

impl Drop for ActiveCancelGuard {
    fn drop(&mut self) {
        if let Ok(mut current) = self.0.lock() {
            *current = None;
        }
    }
}

impl PhoneListener {
    pub fn start(
        paths: &AppPaths,
        handoff_id: &str,
        host_id: &str,
        cancel: Arc<Mutex<Option<Cancel>>>,
    ) -> Result<Self, String> {
        let grant = active_grant(paths, handoff_id, host_id)?;
        let thread_paths = paths.clone();
        let thread_handoff_id = handoff_id.to_string();
        let thread_host_id = host_id.to_string();
        let cancel_path = cancel_path(paths, handoff_id)?;
        let cancel_thread_active = Arc::new(AtomicBool::new(true));
        let thread_active = cancel_thread_active.clone();
        let cancel_thread = thread::Builder::new()
            .name("hii-phone-cancel".into())
            .spawn(move || {
                let cursor_path = root(&thread_paths)
                    .join("inbox")
                    .join(format!("{thread_handoff_id}.cancels.cursor"));
                let mut cursor = read_cursor(&cursor_path);
                while thread_active.load(Ordering::Acquire)
                    && now_unix().is_ok_and(|now| now < grant.expires_at_unix)
                {
                    match active_grant(&thread_paths, &thread_handoff_id, &thread_host_id) {
                        Ok(_) => {}
                        Err(_) => break,
                    }
                    if let Ok((entries, next_cursor)) =
                        read_lines_after(&cancel_path, cursor, 64 * 1024)
                    {
                        for value in &entries {
                            let Ok(request) = serde_json::from_value::<PhoneRequest>(value.clone())
                            else {
                                continue;
                            };
                            let Some(active) = cancel.lock().ok().and_then(|guard| guard.clone())
                            else {
                                let _ = append_status_once(
                                    &thread_paths,
                                    &thread_handoff_id,
                                    "no_active_run",
                                    &request.request_id,
                                );
                                continue;
                            };
                            active.cancel(CancelReason::Client);
                            let outcome = if active.is_cancelled() {
                                "cancelled"
                            } else {
                                "no_active_run"
                            };
                            let _ = append_status_once(
                                &thread_paths,
                                &thread_handoff_id,
                                outcome,
                                &request.request_id,
                            );
                        }
                        cursor = next_cursor;
                        let _ = write_cursor(&cursor_path, cursor);
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            })
            .map_err(|error| error.to_string())?;
        let input_cursor_path = root(paths)
            .join("inbox")
            .join(format!("{handoff_id}.inputs.cursor"));
        let pending_input_cursor = read_cursor(&input_cursor_path);
        Ok(Self {
            handoff_id: handoff_id.to_string(),
            host_id: host_id.to_string(),
            pending_input_cursor: Mutex::new(pending_input_cursor),
            cancel_thread_active,
            _cancel_thread: cancel_thread,
        })
    }

    pub fn drain_inputs(
        &self,
        paths: &AppPaths,
        conversation_id: &str,
    ) -> Result<Vec<PhoneInput>, String> {
        let grant = active_grant(paths, &self.handoff_id, &self.host_id)?;
        if grant.conversation_id != conversation_id {
            return Err("phone handoff belongs to a different CLI conversation".into());
        }
        let path = input_path(paths, &self.handoff_id)?;
        let cursor_path = root(paths)
            .join("inbox")
            .join(format!("{}.inputs.cursor", self.handoff_id));
        let cursor = read_cursor(&cursor_path);
        let (values, next_cursor) = read_lines_after(&path, cursor, 64 * 1024)?;
        let mut inputs = Vec::new();
        for value in &values {
            let request: PhoneRequest =
                serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
            if request.handoff_id == self.handoff_id && request.kind == "input" {
                if let Some(text) = request
                    .text
                    .filter(|text| !text.trim().is_empty() && text.len() <= MAX_PHONE_TEXT_BYTES)
                {
                    inputs.push(PhoneInput {
                        request_id: request.request_id,
                        text,
                    });
                }
            }
        }
        if !inputs.is_empty() {
            // The caller writes the CLI conversation event before acknowledging these rows.
            if let Ok(mut pending) = self.pending_input_cursor.lock() {
                *pending = next_cursor;
            }
            return Ok(inputs);
        }
        write_cursor(&cursor_path, next_cursor)?;
        Ok(inputs)
    }

    pub fn handoff_id(&self) -> &str {
        &self.handoff_id
    }
    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    pub fn acknowledge_inputs(&self, paths: &AppPaths) -> Result<(), String> {
        let cursor = self
            .pending_input_cursor
            .lock()
            .map_err(|_| "phone input cursor is unavailable")?;
        write_cursor(
            &root(paths)
                .join("inbox")
                .join(format!("{}.inputs.cursor", self.handoff_id)),
            *cursor,
        )
    }

    pub fn record_input_queued(&self, paths: &AppPaths, request_id: &str) -> Result<(), String> {
        append_status_once(
            paths,
            &self.handoff_id,
            "submitted_to_conversation",
            request_id,
        )
    }
}

fn clipped(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let text = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{text}…")
    } else {
        text
    }
}

fn approved_event(
    event: &Value,
    cursor: usize,
    handoff_id: &str,
) -> (Option<Value>, Option<Value>) {
    let kind = event
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let data = event.get("data").unwrap_or(&Value::Null);
    let timestamp = event
        .get("ts_unix_ms")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let id = format!("{handoff_id}-{cursor}");
    let message = match kind {
        "user.message" | "assistant.message" => {
            data.get("content").and_then(Value::as_str).map(|text| {
                json!({
                    "id": id,
                    "role": if kind == "user.message" { "user" } else { "assistant" },
                    "text": clipped(&redact_text(text), 1_800),
                    "ts": timestamp
                })
            })
        }
        _ => None,
    };
    let activity = match kind {
        "run.linked" => Some(
            json!({ "id": id, "kind": "run", "label": "Run started", "status": "running", "runId": data.get("run_id").and_then(Value::as_str), "ts": timestamp }),
        ),
        "batch.started" => Some(
            json!({ "id": id, "kind": "tool", "label": format!("{} tools", data.get("calls").and_then(Value::as_array).map(Vec::len).unwrap_or(0)), "status": "running", "runId": Value::Null, "ts": timestamp }),
        ),
        "tool.result" => Some(
            json!({ "id": id, "kind": "tool", "label": data.get("call_id").or_else(|| data.get("tool")).and_then(Value::as_str).unwrap_or("Tool result"), "status": if data.get("ok").and_then(Value::as_bool).unwrap_or(false) { "completed" } else { "failed" }, "runId": Value::Null, "ts": timestamp }),
        ),
        "tool.action.started" => Some(
            json!({ "id": id, "kind": "tool", "label": data.get("tool").and_then(Value::as_str).unwrap_or("Tool action"), "status": "running", "runId": Value::Null, "ts": timestamp }),
        ),
        "tool.action.result" => Some(
            json!({ "id": id, "kind": "tool", "label": "Tool action", "status": if data.get("ok").and_then(Value::as_bool).unwrap_or(false) { "completed" } else { "failed" }, "runId": Value::Null, "ts": timestamp }),
        ),
        "run.finished" => Some(
            json!({ "id": id, "kind": "run", "label": "Run finished", "status": data.get("status").and_then(Value::as_str).unwrap_or("finished"), "runId": data.get("run_id").and_then(Value::as_str), "ts": timestamp }),
        ),
        "assistant.stream.delta" => Some(json!({
            "id": id, "kind": "stream",
            "label": clipped(&redact_text(data.get("phase").and_then(Value::as_str).unwrap_or("agent")), 80),
            "text": clipped(&redact_text(data.get("content").and_then(Value::as_str).unwrap_or_default()), 400),
            "status": "running", "runId": Value::Null, "ts": timestamp
        })),
        _ => None,
    };
    (message, activity)
}

pub fn project(
    paths: &AppPaths,
    handoff_id: &str,
    host_id: &str,
    after_cursor: usize,
) -> Result<Value, String> {
    let grant = active_grant(paths, handoff_id, host_id)?;
    let path = paths
        .runtime
        .join("conversations/cli")
        .join(format!("{}.jsonl", grant.conversation_id));
    if !path.is_file() {
        return Err("the CLI conversation journal is unavailable".into());
    }
    let mut file = File::open(&path).map_err(|error| error.to_string())?;
    let file_len = file.metadata().map_err(|error| error.to_string())?.len();
    let snapshot = after_cursor == 0;
    let window_start = if snapshot {
        file_len.saturating_sub(512 * 1024)
    } else {
        (after_cursor as u64).min(file_len)
    };
    file.seek(SeekFrom::Start(window_start))
        .map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut aligned_start = window_start;
    if window_start > 0 {
        let mut discarded = Vec::new();
        reader
            .read_until(b'\n', &mut discarded)
            .map_err(|error| error.to_string())?;
        aligned_start += discarded.len() as u64;
    }
    let mut bytes = Vec::new();
    let limit = if snapshot { 512 * 1024 } else { 128 * 1024 };
    reader
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let mut events = Vec::new();
    let mut consumed = 0_u64;
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        if !line.ends_with(b"\n") {
            break;
        }
        consumed += line.len() as u64;
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        if let Ok(event) = serde_json::from_slice::<Value>(line) {
            events.push((aligned_start + consumed as u64, event));
        }
    }
    let cursor = aligned_start + consumed;
    let mut messages = Vec::new();
    let mut activities = Vec::new();
    let mut runtime = Value::Null;
    for (offset, event) in &events {
        let cursor_id = usize::try_from(*offset).unwrap_or(usize::MAX);
        let (message, activity) = approved_event(event, cursor_id, handoff_id);
        if let Some(message) = message {
            messages.push(message);
        }
        if let Some(activity) = activity {
            activities.push(activity);
        }
        if matches!(
            event.get("kind").and_then(Value::as_str),
            Some(
                "assistant.stream.started"
                    | "assistant.stream.delta"
                    | "assistant.stream.completed"
            )
        ) {
            let data = event.get("data").unwrap_or(&Value::Null);
            let phase = if event.get("kind").and_then(Value::as_str)
                == Some("assistant.stream.completed")
            {
                "completed"
            } else {
                data.get("phase")
                    .and_then(Value::as_str)
                    .unwrap_or("running")
            };
            runtime = json!({
                "model": data.get("model").and_then(Value::as_str).map(|model| clipped(&redact_text(model), 120)),
                "phase": clipped(&redact_text(phase), 80)
            });
        }
    }
    if snapshot {
        if messages.len() > 30 {
            messages.drain(..messages.len() - 30);
        }
        if activities.len() > 60 {
            activities.drain(..activities.len() - 60);
        }
    }
    let statuses = read_lines(&statuses_path(paths, handoff_id)?)?;
    Ok(json!({
        "handoffId": handoff_id,
        "conversationId": grant.conversation_id,
        "expiresAtUnix": grant.expires_at_unix,
        "cursor": cursor,
        "runtime": runtime,
        "messages": messages,
        "activities": activities,
        "statuses": statuses.into_iter().rev().take(40).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>()
    }))
}

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
        ensure_private_dir(&paths.runtime.join("remote")).unwrap();
        fs::write(paths.runtime.join("remote/host.json"), format!(r#"{{"relay":"wss://humaninformationinterface.com/api/remote/host","token":"account-host.{}"}}"#, "s".repeat(43))).unwrap();
        (temp, paths)
    }

    #[test]
    fn grant_qr_and_journal_projection_keep_secrets_out_of_url_and_activity() {
        let (_temp, paths) = paths();
        let (grant, url) = create_grant(&paths, "cli-conversation-1").unwrap();
        assert_eq!(grant.expires_at_unix - grant.created_at_unix, 3_600);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(grant_path(&paths, &grant.handoff_id).unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(root(&paths).join("handoffs"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        assert!(url.contains("handoff="));
        assert!(url.contains("host=account-host"));
        assert!(!url.contains("secret"));
        assert!(!url.contains(&"s".repeat(43)));
        assert!(!url.contains("conversation"));
        let qr = render_qr(&url).unwrap();
        assert!(qr.contains('█'));
        assert!(qr.lines().count() > 20);

        let dir = paths.runtime.join("conversations/cli");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("cli-conversation-1.jsonl"), concat!(
            "{\"ts_unix_ms\":1,\"kind\":\"user.message\",\"data\":{\"content\":\"hello\"}}\n",
            "{\"ts_unix_ms\":2,\"kind\":\"model.request\",\"data\":{\"messages\":[{\"content\":\"private reasoning\"}]}}\n",
            "{\"ts_unix_ms\":3,\"kind\":\"tool.result\",\"data\":{\"call_id\":\"read_file\",\"ok\":true,\"output\":\"private file body\"}}\n"
        )).unwrap();
        let projection = project(&paths, &grant.handoff_id, "account-host", 0).unwrap();
        let encoded = projection.to_string();
        assert!(encoded.contains("hello"));
        assert!(encoded.contains("read_file"));
        assert!(!encoded.contains("private reasoning"));
        assert!(!encoded.contains("private file body"));
    }

    #[test]
    fn inbox_checks_grant_host_and_prompt_size_and_deduplicates() {
        let (_temp, paths) = paths();
        let (grant, _) = create_grant(&paths, "cli-conversation-1").unwrap();
        assert!(
            receive(
                &paths,
                &grant.handoff_id,
                "wrong-host",
                "req-1",
                "input",
                Some("hi")
            )
            .is_err()
        );
        assert!(
            receive(
                &paths,
                &grant.handoff_id,
                "account-host",
                "req-1",
                "input",
                Some(&"x".repeat(MAX_PHONE_TEXT_BYTES + 1))
            )
            .is_err()
        );
        receive(
            &paths,
            &grant.handoff_id,
            "account-host",
            "req-1",
            "input",
            Some("continue"),
        )
        .unwrap();
        receive(
            &paths,
            &grant.handoff_id,
            "account-host",
            "req-1",
            "input",
            Some("continue"),
        )
        .unwrap();
        assert_eq!(
            read_lines(&input_path(&paths, &grant.handoff_id).unwrap())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn expired_listener_detaches_with_stable_reason_and_revokes_grant() {
        let (_temp, paths) = paths();
        let (grant, _) = create_grant(&paths, "cli-conversation-1").unwrap();
        let listener = PhoneListener::start(
            &paths,
            &grant.handoff_id,
            &grant.host_id,
            Arc::new(Mutex::new(None)),
        )
        .unwrap();
        let mut expired = grant.clone();
        expired.expires_at_unix = now_unix().unwrap().saturating_sub(1);
        crate::store::write_json_private_atomic(
            &grant_path(&paths, &grant.handoff_id).unwrap(),
            &expired,
        )
        .unwrap();

        let error = listener
            .drain_inputs(&paths, "cli-conversation-1")
            .unwrap_err();
        assert_eq!(detach_reason(&error), "expired");
        assert!(load_grant(&paths, &grant.handoff_id)
            .unwrap()
            .revoked_at_unix
            .is_some());
        assert!(read_lines(&statuses_path(&paths, &grant.handoff_id).unwrap())
            .unwrap()
            .iter()
            .any(|entry| entry.get("status").and_then(Value::as_str) == Some("expired")));
        drop(listener);
        assert_eq!(detach_reason("phone handoff was revoked"), "revoked");
        assert_eq!(detach_reason("arbitrary local detail"), "listener_error");
    }
}
