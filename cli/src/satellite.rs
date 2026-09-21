// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! HII-owned authority and receipt boundary for the replaceable Satellite transport.

use crate::{
    config::AppPaths,
    contract::{Authority, Decision},
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const BRIDGE_CLIENT: &str = r#"
import os
import socket
import sys

payload = sys.stdin.buffer.read()
socket_path = os.path.expanduser("~/.hii/satellite/bridge.sock")
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.settimeout(float(sys.argv[1]))
client.connect(socket_path)
client.sendall(payload)
client.shutdown(socket.SHUT_WR)
response = bytearray()
while True:
    chunk = client.recv(4096)
    if not chunk:
        break
    response.extend(chunk)
    if b"\n" in response:
        break
sys.stdout.buffer.write(bytes(response))
"#;

const STATUS_CLIENT: &str = r#"
import json
import os
import sqlite3
import stat
import subprocess

home = os.path.expanduser("~")
socket_path = os.path.join(home, ".hii", "satellite", "bridge.sock")
ready_path = os.path.join(home, ".hii", "satellite", "ready.json")
result = {
    "schema_version": 1,
    "transport": "apple-messages-continuity",
    "account": "owner",
    "bridge_running": False,
    "socket_ready": False,
    "socket_owner_only": False,
    "macos_messages_permission": "unknown",
}
try:
    subprocess.run(["pgrep", "-x", "SatelliteBridge"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    result["bridge_running"] = True
except Exception:
    pass
try:
    mode = os.stat(socket_path).st_mode
    result["socket_ready"] = stat.S_ISSOCK(mode)
    result["socket_owner_only"] = (mode & 0o077) == 0
except Exception:
    pass
try:
    with open(ready_path, "r", encoding="utf-8") as handle:
        ready = json.load(handle)
    result["bridge_policy"] = ready.get("policy", "unknown")
except Exception:
    result["bridge_policy"] = "unknown"
try:
    database = os.path.join(home, "Library", "Application Support", "com.apple.TCC", "TCC.db")
    connection = sqlite3.connect("file:" + database + "?mode=ro", uri=True)
    row = connection.execute(
        "SELECT MAX(auth_value) FROM access WHERE client=? AND indirect_object_identifier=?",
        ("com.ummi.hii.satellite", "com.apple.MobileSMS"),
    ).fetchone()
    value = row[0] if row else None
    result["macos_messages_permission"] = {2: "allowed", 0: "denied"}.get(value, "not-requested")
except Exception:
    pass
print(json.dumps(result, separators=(",", ":")))
"#;

const VERIFY_MESSAGE_CLIENT: &str = r#"
import json
import os
import sqlite3
import sys
import time

request = json.load(sys.stdin)
deadline = time.time() + min(float(sys.argv[1]), 20.0)
database = os.path.expanduser("~/Library/Messages/chat.db")
result = {
    "outgoing_recorded": False,
    "sent": False,
    "delivered": False,
    "error": 0,
}
try:
    connection = sqlite3.connect("file:" + database + "?mode=ro", uri=True)
    while time.time() < deadline:
        row = connection.execute(
            """
            SELECT COUNT(*), COALESCE(MAX(is_sent), 0),
                   COALESCE(MAX(is_delivered), 0), COALESCE(MAX(error), 0)
            FROM message
            WHERE is_from_me=1 AND text=?
              AND ((CASE WHEN date > 1000000000000 THEN date/1000000000 ELSE date END) + 978307200) >= ?
            """,
            (request["body"], request["not_before"]),
        ).fetchone()
        if row and row[0] > 0:
            result.update({
                "outgoing_recorded": True,
                "sent": bool(row[1]),
                "delivered": bool(row[2]),
                "error": int(row[3]),
            })
            break
        time.sleep(0.5)
except Exception:
    result["verification_unavailable"] = True
print(json.dumps(result, separators=(",", ":")))
"#;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SatelliteAction {
    SendMessage,
    StartCall,
}

impl SatelliteAction {
    fn wire(self) -> &'static str {
        match self {
            Self::SendMessage => "message.send",
            Self::StartCall => "call.start",
        }
    }

    fn capability(self) -> &'static str {
        match self {
            Self::SendMessage => "hii.satellite.message_send",
            Self::StartCall => "hii.satellite.call_start",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SatelliteReceipt {
    schema_version: u8,
    kind: &'static str,
    id: String,
    request_id: String,
    capability_id: &'static str,
    action: &'static str,
    authority: String,
    transport: &'static str,
    account: &'static str,
    status: String,
    bridge_status: String,
    carrier_delivery: String,
    detail: String,
    created_at: String,
}

/// External communications remain approval-gated even if a caller selected
/// YOLO. This is the same kind of hard floor HII applies to deletion.
pub fn authority_decision(authority: Authority) -> Decision {
    match authority {
        Authority::Yolo => Decision::Prompt,
        other => other.decide(true, true),
    }
}

pub fn default_ssh_config() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or("could not locate the user profile for the SSH config")?;
    Ok(PathBuf::from(home).join(".ssh").join("config"))
}

pub fn status(host: &str, ssh_config: &Path, timeout_seconds: u64) -> Result<Value, String> {
    let output = run_ssh(host, ssh_config, STATUS_CLIENT, &[], timeout_seconds)?;
    let value: Value = serde_json::from_slice(&output)
        .map_err(|error| format!("Satellite status returned invalid JSON: {error}"))?;
    Ok(json!({
        "schema_version": 1,
        "kind": "hii.satellite.permissions",
        "hii": {
            "message_send": {
                "capability_id": "hii.satellite.message_send",
                "required_authority": "external-commit",
                "recipient_scope": "sealed-owner-only"
            },
            "call_start": {
                "capability_id": "hii.satellite.call_start",
                "required_authority": "external-commit",
                "local_confirmation": "required-every-time",
                "live_agent_audio": "unavailable"
            },
            "yolo_override": "denied"
        },
        "executor": value
    }))
}

pub fn dispatch(
    paths: &AppPaths,
    action: SatelliteAction,
    body: Option<&str>,
    authority: Authority,
    host: &str,
    ssh_config: &Path,
    timeout_seconds: u64,
) -> Result<SatelliteReceipt, String> {
    validate(action, body, timeout_seconds)?;
    let started_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs()
        .saturating_sub(2);
    let request_id = Uuid::new_v4().to_string();
    let mut request = json!({
        "schema_version": 1,
        "request_id": request_id,
        "action": action.wire(),
    });
    if let Some(body) = body {
        request["body"] = Value::String(body.to_string());
    }
    let mut payload = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    payload.push(b'\n');

    let result = run_ssh(host, ssh_config, BRIDGE_CLIENT, &payload, timeout_seconds);
    let (mut status, bridge_status, mut detail) = match result {
        Ok(output) => {
            let bridge: Value = serde_json::from_slice(&output)
                .map_err(|error| format!("Satellite bridge returned invalid JSON: {error}"))?;
            let bridge_status = bridge
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let status = match bridge_status.as_str() {
                "accepted" | "handoff_opened" => "completed",
                "rejected" => "blocked",
                _ => "partial",
            }
            .to_string();
            let detail = bridge
                .get("detail")
                .and_then(Value::as_str)
                .unwrap_or("Bridge returned no detail.")
                .to_string();
            (status, bridge_status, detail)
        }
        Err(error) => {
            let receipt = receipt(
                action,
                authority,
                request_id,
                "failed".into(),
                "unavailable".into(),
                "unverified".into(),
                "The authenticated Satellite executor did not return a bridge receipt.".into(),
            )?;
            append_receipt(paths, &receipt)?;
            return Err(error);
        }
    };

    let mut carrier_delivery = "unverified".to_string();
    if action == SatelliteAction::SendMessage
        && matches!(bridge_status.as_str(), "accepted" | "dispatched_unverified")
    {
        match verify_outgoing_message(
            host,
            ssh_config,
            body.unwrap_or_default(),
            started_unix,
            timeout_seconds,
        ) {
            Ok(verification)
                if verification["outgoing_recorded"].as_bool() == Some(true)
                    && verification["error"].as_i64().unwrap_or(0) == 0 =>
            {
                status = "completed".into();
                carrier_delivery = if verification["delivered"].as_bool() == Some(true) {
                    "reported-delivered".into()
                } else {
                    "unverified".into()
                };
                detail = "Messages recorded the owner-only outgoing message; carrier delivery remains separately reported.".into();
            }
            Ok(_) => {
                status = "partial".into();
                detail = "The owner-only event was dispatched, but no matching outgoing Messages record was observed before the verification deadline.".into();
            }
            Err(_) => {
                status = "partial".into();
                detail = "The owner-only event was dispatched, but outgoing-record verification was unavailable.".into();
            }
        }
    }

    let receipt = receipt(
        action,
        authority,
        request_id,
        status,
        bridge_status,
        carrier_delivery,
        detail,
    )?;
    append_receipt(paths, &receipt)?;
    Ok(receipt)
}

fn validate(
    action: SatelliteAction,
    body: Option<&str>,
    timeout_seconds: u64,
) -> Result<(), String> {
    if !(5..=600).contains(&timeout_seconds) {
        return Err("Satellite timeout must be between 5 and 600 seconds.".into());
    }
    match action {
        SatelliteAction::SendMessage => {
            let body = body.ok_or("message.send requires a body from stdin")?;
            if body.is_empty() {
                return Err("message.send requires a non-empty body from stdin".into());
            }
            if body.chars().count() > 2_000 {
                return Err("message body exceeds 2,000 characters".into());
            }
            if body
                .chars()
                .any(|value| value.is_control() && value != '\n' && value != '\t')
            {
                return Err("message body contains unsupported control characters".into());
            }
        }
        SatelliteAction::StartCall if body.is_some() => {
            return Err("call.start cannot carry a message body".into());
        }
        SatelliteAction::StartCall => {}
    }
    Ok(())
}

fn run_ssh(
    host: &str,
    ssh_config: &Path,
    script: &str,
    input: &[u8],
    timeout_seconds: u64,
) -> Result<Vec<u8>, String> {
    if host.trim().is_empty() {
        return Err("Satellite SSH host cannot be empty".into());
    }
    if !ssh_config.is_file() {
        return Err(format!(
            "Satellite SSH config is unavailable: {}",
            ssh_config.display()
        ));
    }
    let encoded = BASE64.encode(script.as_bytes());
    let remote = format!(
        "python3 -c \"import base64;exec(base64.b64decode('{}'))\" {}",
        encoded, timeout_seconds
    );
    let mut child = Command::new("ssh")
        .arg("-F")
        .arg(ssh_config)
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=5",
            "-o",
            "ServerAliveCountMax=1",
        ])
        .arg(host)
        .arg(remote)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!("could not start authenticated Satellite SSH transport: {error}")
        })?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(input)
            .map_err(|error| format!("could not stream the Satellite request: {error}"))?;
    }
    drop(child.stdin.take());
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Satellite SSH transport failed: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr)
            .split_whitespace()
            .take(30)
            .collect::<Vec<_>>()
            .join(" ");
        return Err(if detail.is_empty() {
            format!("Satellite SSH transport exited with {}", output.status)
        } else {
            format!("Satellite SSH transport failed: {detail}")
        });
    }
    Ok(output.stdout)
}

fn verify_outgoing_message(
    host: &str,
    ssh_config: &Path,
    body: &str,
    not_before: u64,
    timeout_seconds: u64,
) -> Result<Value, String> {
    let payload = serde_json::to_vec(&json!({
        "body": body,
        "not_before": not_before,
    }))
    .map_err(|error| error.to_string())?;
    let output = run_ssh(
        host,
        ssh_config,
        VERIFY_MESSAGE_CLIENT,
        &payload,
        timeout_seconds,
    )?;
    serde_json::from_slice(&output)
        .map_err(|error| format!("Satellite verification returned invalid JSON: {error}"))
}

fn receipt(
    action: SatelliteAction,
    authority: Authority,
    request_id: String,
    status: String,
    bridge_status: String,
    carrier_delivery: String,
    detail: String,
) -> Result<SatelliteReceipt, String> {
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis()
        .to_string();
    Ok(SatelliteReceipt {
        schema_version: 1,
        kind: "hii.satellite.receipt",
        id: format!("satellite-{request_id}"),
        request_id,
        capability_id: action.capability(),
        action: action.wire(),
        authority: authority.label().to_string(),
        transport: "apple-messages-continuity",
        account: "owner",
        status,
        bridge_status,
        carrier_delivery,
        detail,
        created_at,
    })
}

fn append_receipt(paths: &AppPaths, receipt: &SatelliteReceipt) -> Result<(), String> {
    let directory = paths.runtime.join("satellite");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join("hii-receipts.jsonl");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("could not open Satellite receipt ledger: {error}"))?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(receipt).map_err(|error| error.to_string())?
    )
    .map_err(|error| format!("could not append Satellite receipt: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn communications_require_external_authority() {
        assert_eq!(authority_decision(Authority::ReadOnly), Decision::Deny);
        assert_eq!(authority_decision(Authority::Workspace), Decision::Deny);
        assert_eq!(
            authority_decision(Authority::ExternalPreview),
            Decision::Prompt
        );
        assert_eq!(
            authority_decision(Authority::ExternalCommit),
            Decision::Allow
        );
    }

    #[test]
    fn yolo_cannot_bypass_the_communication_gate() {
        assert_eq!(authority_decision(Authority::Yolo), Decision::Prompt);
    }

    #[test]
    fn message_body_is_not_part_of_the_remote_program() {
        let secret = "private message body";
        let encoded = BASE64.encode(BRIDGE_CLIENT.as_bytes());
        let remote = format!(
            "python3 -c \"import base64;exec(base64.b64decode('{}'))\" 120",
            encoded
        );
        assert!(!remote.contains(secret));
        assert!(!BRIDGE_CLIENT.contains(secret));
        assert!(!VERIFY_MESSAGE_CLIENT.contains(secret));
    }

    #[test]
    fn message_validation_is_bounded() {
        assert!(validate(SatelliteAction::SendMessage, Some("wsp"), 120).is_ok());
        assert!(validate(SatelliteAction::SendMessage, Some(""), 120).is_err());
        assert!(validate(SatelliteAction::SendMessage, Some(&"a".repeat(2_001)), 120).is_err());
    }

    #[test]
    fn call_never_accepts_a_hidden_body() {
        assert!(validate(SatelliteAction::StartCall, None, 120).is_ok());
        assert!(validate(SatelliteAction::StartCall, Some("hidden"), 120).is_err());
    }

    #[test]
    fn hii_receipt_excludes_message_and_phone_identity() {
        let value = serde_json::to_value(
            receipt(
                SatelliteAction::SendMessage,
                Authority::ExternalCommit,
                Uuid::new_v4().to_string(),
                "completed".into(),
                "dispatched_unverified".into(),
                "unverified".into(),
                "Outgoing record observed.".into(),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(value.get("body").is_none());
        assert!(value.get("phone").is_none());
        assert!(value.get("recipient").is_none());
    }
}
