use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationRecord {
    pub command: String,
    pub ok: bool,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookRecord {
    pub event: String,
    pub name: String,
    pub command: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub output: String,
    pub mutates_workspace: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    pub schema_version: u8,
    pub id: String,
    pub created_at_unix_ms: u128,
    pub finished_at_unix_ms: u128,
    pub status: String,
    pub goal: String,
    pub workspace: String,
    pub model: String,
    pub review_model: Option<String>,
    pub steps: usize,
    pub summary: String,
    pub verification: Vec<VerificationRecord>,
    pub git_status: String,
    pub next: Option<String>,
    pub review: Option<String>,
    pub risk: String,
    // --- schema v2: contract + inventory (plan Phases 1, 5, 7) ---
    #[serde(default)]
    pub authority: Option<String>,
    #[serde(default)]
    pub done_when: Option<String>,
    #[serde(default)]
    pub approvals: Vec<String>,
    #[serde(default)]
    pub artifacts: Vec<String>,
    #[serde(default)]
    pub reversible: Option<bool>,
    #[serde(default)]
    pub context_sources: Vec<String>,
    #[serde(default)]
    pub preexisting_changes: Vec<String>,
    #[serde(default)]
    pub hooks: Vec<HookRecord>,
}

pub struct RunStore {
    pub id: String,
    pub dir: PathBuf,
    pub started_at_unix_ms: u128,
    events: PathBuf,
}

pub struct ConversationStore {
    pub id: String,
    events: PathBuf,
}

impl ConversationStore {
    pub fn create(runtime: &Path) -> Result<Self, String> {
        let now = unix_ms();
        let id = format!("{now:x}-{:x}", std::process::id());
        let dir = runtime.join("conversations").join("cli");
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        Ok(Self {
            id: id.clone(),
            events: dir.join(format!("{id}.jsonl")),
        })
    }

    pub fn event(&self, kind: &str, data: Value) -> Result<(), String> {
        let entry = serde_json::json!({
            "ts_unix_ms": unix_ms(),
            "conversation_id": self.id,
            "kind": kind,
            "data": data
        });
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.events)
            .map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut file, &entry).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())
    }
}

impl RunStore {
    pub fn create(runtime: &Path) -> Result<Self, String> {
        let now = unix_ms();
        let id = format!("{now:x}-{:x}", std::process::id());
        let dir = runtime.join("runs").join("cli").join(&id);
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        Ok(Self {
            id,
            started_at_unix_ms: now,
            events: dir.join("events.jsonl"),
            dir,
        })
    }

    /// Location of this run's append-only event log.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn events_path(&self) -> &Path {
        &self.events
    }

    pub fn event(&self, kind: &str, data: Value) -> Result<(), String> {
        let entry = serde_json::json!({
            "ts_unix_ms": unix_ms(),
            "run_id": self.id,
            "kind": kind,
            "data": data
        });
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.events)
            .map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut file, &entry).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())
    }

    pub fn finish(&self, runtime: &Path, receipt: &Receipt) -> Result<PathBuf, String> {
        let receipt_path = self.dir.join("receipt.json");
        let content = serde_json::to_vec_pretty(receipt).map_err(|error| error.to_string())?;
        fs::write(&receipt_path, content).map_err(|error| error.to_string())?;
        let latest = runtime.join("runs").join("cli").join("latest");
        fs::write(&latest, format!("{}\n", self.id)).map_err(|error| error.to_string())?;
        Ok(receipt_path)
    }
}

pub fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub fn redact_text(value: &str) -> String {
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

pub fn find_receipt(runtime: &Path, id: Option<&str>) -> Result<PathBuf, String> {
    let cli_runs = runtime.join("runs").join("cli");
    let id = match id {
        Some(id) => id.to_string(),
        None => fs::read_to_string(cli_runs.join("latest"))
            .map_err(|_| "no Rust CLI receipts yet".to_string())?
            .trim()
            .to_string(),
    };
    let direct = cli_runs.join(&id).join("receipt.json");
    if direct.is_file() {
        return Ok(direct);
    }
    let matches: Vec<PathBuf> = fs::read_dir(&cli_runs)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&id))
        })
        .collect();
    if matches.len() == 1 {
        Ok(matches[0].join("receipt.json"))
    } else {
        Err(format!("receipt id '{id}' was not found or is ambiguous"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_secret_bearing_lines() {
        let value = redact_text("normal\nAPI_KEY=abc123\nalso normal");
        assert_eq!(value, "normal\n[redacted]\nalso normal");
    }
}
