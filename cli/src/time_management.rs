// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Native, local-first time blocks with deterministic peer reconciliation.

use crate::{config::AppPaths, remote_cli};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};

const MAX_RECORD_BYTES: usize = 12 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimeBlock {
    pub id: String,
    pub title: String,
    pub start: String,
    pub end: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub revision: u64,
    pub updated_at_unix_ms: i64,
    pub updated_by: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeRecord {
    pub schema_version: u32,
    pub record_id: String,
    pub block_id: String,
    pub device_id: String,
    pub revision: u64,
    pub updated_at_unix_ms: i64,
    pub operation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<TimeBlock>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub schema_version: u32,
    pub kind: &'static str,
    pub peer: String,
    pub pulled: usize,
    pub pushed: usize,
    pub local_records: usize,
    pub remote_records: usize,
    pub remote_receipts: Vec<String>,
}

pub struct TimeService {
    runtime: PathBuf,
    journal: PathBuf,
    device_id: String,
}

impl TimeService {
    pub fn new(paths: &AppPaths) -> Self {
        let root = paths.runtime.join("time");
        Self {
            runtime: paths.runtime.clone(),
            journal: root.join("records.jsonl"),
            device_id: device_id(),
        }
    }

    pub fn add(
        &self,
        start: &str,
        end: &str,
        title: &str,
        task_id: Option<String>,
    ) -> Result<TimeBlock, String> {
        let start = parse_time(start)?;
        let end = parse_time(end)?;
        if end <= start {
            return Err("time block end must be after its start".into());
        }
        let title = clean_text(title, 240, "title")?;
        let now = chrono::Utc::now().timestamp_millis();
        let block = TimeBlock {
            id: format!("time-{}", uuid::Uuid::new_v4().simple()),
            title,
            start: start.to_rfc3339(),
            end: end.to_rfc3339(),
            status: "planned".into(),
            task_id: task_id
                .map(|value| clean_text(&value, 128, "task id"))
                .transpose()?,
            revision: 1,
            updated_at_unix_ms: now,
            updated_by: self.device_id.clone(),
        };
        self.append(&record_for(&block, "upsert"))?;
        Ok(block)
    }

    pub fn set_status(&self, id: &str, status: &str) -> Result<TimeBlock, String> {
        if !matches!(status, "planned" | "completed" | "cancelled") {
            return Err("time block status must be planned, completed, or cancelled".into());
        }
        let mut block = self.find(id)?;
        block.status = status.into();
        block.revision += 1;
        block.updated_at_unix_ms = chrono::Utc::now().timestamp_millis();
        block.updated_by = self.device_id.clone();
        self.append(&record_for(&block, "upsert"))?;
        Ok(block)
    }

    pub fn remove(&self, id: &str) -> Result<TimeRecord, String> {
        let block = self.find(id)?;
        let record = TimeRecord {
            schema_version: 1,
            record_id: uuid::Uuid::new_v4().to_string(),
            block_id: block.id,
            device_id: self.device_id.clone(),
            revision: block.revision + 1,
            updated_at_unix_ms: chrono::Utc::now().timestamp_millis(),
            operation: "delete".into(),
            block: None,
        };
        self.append(&record)?;
        Ok(record)
    }

    pub fn range(&self, from: DateTime<Local>, days: i64) -> Result<Vec<TimeBlock>, String> {
        let until = from + Duration::days(days.clamp(1, 366));
        let mut blocks = self
            .current()?
            .into_values()
            .filter_map(|record| record.block)
            .filter(|block| {
                parse_time(&block.start).is_ok_and(|start| start >= from && start < until)
            })
            .collect::<Vec<_>>();
        blocks.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| a.id.cmp(&b.id)));
        Ok(blocks)
    }

    pub fn today(&self) -> Result<Vec<TimeBlock>, String> {
        let now = Local::now();
        let start = Local
            .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
            .single()
            .ok_or("today has an ambiguous local midnight")?;
        self.range(start, 1)
    }

    pub fn range_from(&self, from: Option<&str>, days: i64) -> Result<Vec<TimeBlock>, String> {
        self.range(
            from.map(parse_time).transpose()?.unwrap_or_else(Local::now),
            days,
        )
    }

    pub fn week(&self) -> Result<Vec<TimeBlock>, String> {
        let now = Local::now();
        let today = Local
            .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
            .single()
            .ok_or("today has an ambiguous local midnight")?;
        let start = today - Duration::days(now.weekday().num_days_from_monday() as i64);
        self.range(start, 7)
    }

    pub fn conflicts(&self) -> Result<Vec<(TimeBlock, TimeBlock)>, String> {
        let mut blocks = self
            .current()?
            .into_values()
            .filter_map(|record| record.block)
            .filter(|block| block.status == "planned")
            .collect::<Vec<_>>();
        blocks.sort_by(|a, b| a.start.cmp(&b.start));
        let mut conflicts = Vec::new();
        for (index, left) in blocks.iter().enumerate() {
            let left_end = parse_time(&left.end)?;
            for right in blocks.iter().skip(index + 1) {
                let right_start = parse_time(&right.start)?;
                if right_start >= left_end {
                    break;
                }
                if parse_time(&right.end)? > parse_time(&left.start)? {
                    conflicts.push((left.clone(), right.clone()));
                }
            }
        }
        Ok(conflicts)
    }

    pub fn export(&self) -> Result<Value, String> {
        let records = self.records()?;
        Ok(json!({
            "schemaVersion": 1,
            "kind": "hii.time.export",
            "deviceId": self.device_id,
            "records": records
        }))
    }

    pub fn merge_record_base64(&self, encoded: &str) -> Result<bool, String> {
        if encoded.len() > MAX_RECORD_BYTES * 2 {
            return Err("encoded time record exceeds the bounded merge limit".into());
        }
        let raw = STANDARD
            .decode(encoded)
            .map_err(|_| "time record is not valid base64".to_string())?;
        if raw.len() > MAX_RECORD_BYTES {
            return Err("time record exceeds the 12 KiB merge limit".into());
        }
        let record: TimeRecord = serde_json::from_slice(&raw)
            .map_err(|error| format!("invalid time record: {error}"))?;
        self.merge(&[record]).map(|count| count == 1)
    }

    pub fn sync(&self, peer: &str, host: &str, os: &str) -> Result<SyncReport, String> {
        let pull = remote_cli::run(
            &self.runtime,
            host,
            os,
            &["time".into(), "export".into(), "--json".into()],
            false,
            60,
        )?;
        if pull["status"] != "completed" {
            return Err(format!(
                "peer export did not complete; receipt {}",
                pull["receipt"].as_str().unwrap_or("unknown")
            ));
        }
        let remote: Value = serde_json::from_str(pull["stdout"].as_str().unwrap_or_default())
            .map_err(|error| format!("peer returned invalid time export: {error}"))?;
        let remote_records: Vec<TimeRecord> = serde_json::from_value(
            remote
                .get("records")
                .cloned()
                .ok_or("peer time export omitted records")?,
        )
        .map_err(|error| format!("peer time records are invalid: {error}"))?;
        let remote_ids = remote_records
            .iter()
            .map(|record| record.record_id.as_str())
            .collect::<HashSet<_>>();
        let pulled = self.merge(&remote_records)?;
        let local_records = self.records()?;
        let pending = local_records
            .iter()
            .filter(|record| !remote_ids.contains(record.record_id.as_str()))
            .collect::<Vec<_>>();
        let mut receipts = vec![pull["receipt"].as_str().unwrap_or_default().to_string()];
        let mut pushed = 0usize;
        for record in pending {
            let raw = serde_json::to_vec(record).map_err(|error| error.to_string())?;
            if raw.len() > MAX_RECORD_BYTES {
                return Err(format!(
                    "time record {} is too large to sync",
                    record.record_id
                ));
            }
            let result = remote_cli::run(
                &self.runtime,
                host,
                os,
                &[
                    "time".into(),
                    "merge".into(),
                    "--record".into(),
                    STANDARD.encode(raw),
                    "--json".into(),
                ],
                true,
                60,
            )?;
            receipts.push(result["receipt"].as_str().unwrap_or_default().to_string());
            if result["status"] != "completed" {
                return Err(format!(
                    "peer merge did not complete; receipt {}",
                    result["receipt"].as_str().unwrap_or("unknown")
                ));
            }
            pushed += 1;
        }
        Ok(SyncReport {
            schema_version: 1,
            kind: "hii.time.sync",
            peer: peer.into(),
            pulled,
            pushed,
            local_records: self.records()?.len(),
            remote_records: remote_records.len(),
            remote_receipts: receipts,
        })
    }

    fn find(&self, prefix: &str) -> Result<TimeBlock, String> {
        let matches = self
            .current()?
            .into_values()
            .filter_map(|record| record.block)
            .filter(|block| block.id.starts_with(prefix))
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [block] => Ok(block.clone()),
            [] => Err(format!("time block not found: {prefix}")),
            _ => Err(format!("time block id is ambiguous: {prefix}")),
        }
    }

    fn current(&self) -> Result<BTreeMap<String, TimeRecord>, String> {
        let mut current = BTreeMap::<String, TimeRecord>::new();
        for record in self.records()? {
            let replace = current.get(&record.block_id).is_none_or(|previous| {
                record.revision > previous.revision
                    || (record.revision == previous.revision
                        && (
                            record.updated_at_unix_ms,
                            &record.device_id,
                            &record.record_id,
                        ) > (
                            previous.updated_at_unix_ms,
                            &previous.device_id,
                            &previous.record_id,
                        ))
            });
            if replace {
                current.insert(record.block_id.clone(), record);
            }
        }
        Ok(current)
    }

    fn records(&self) -> Result<Vec<TimeRecord>, String> {
        if !self.journal.is_file() {
            return Ok(Vec::new());
        }
        fs::read_to_string(&self.journal)
            .map_err(|error| error.to_string())?
            .lines()
            .enumerate()
            .filter(|(_, line)| !line.trim().is_empty())
            .map(|(index, line)| {
                serde_json::from_str(line)
                    .map_err(|error| format!("invalid time journal line {}: {error}", index + 1))
            })
            .collect()
    }

    fn merge(&self, records: &[TimeRecord]) -> Result<usize, String> {
        let known = self
            .records()?
            .into_iter()
            .map(|record| record.record_id)
            .collect::<HashSet<_>>();
        let mut merged = 0usize;
        for record in records {
            validate_record(record)?;
            if !known.contains(&record.record_id) {
                self.append(record)?;
                merged += 1;
            }
        }
        Ok(merged)
    }

    fn append(&self, record: &TimeRecord) -> Result<(), String> {
        validate_record(record)?;
        let raw = serde_json::to_vec(record).map_err(|error| error.to_string())?;
        if raw.len() > MAX_RECORD_BYTES {
            return Err("time record exceeds the 12 KiB journal limit".into());
        }
        let parent = self.journal.parent().ok_or("time journal has no parent")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.journal)
            .map_err(|error| error.to_string())?;
        file.write_all(&raw).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.sync_data().map_err(|error| error.to_string())
    }
}

pub fn render_blocks(blocks: &[TimeBlock], json_output: bool) -> Result<String, String> {
    if json_output {
        return serde_json::to_string_pretty(&json!({
            "schemaVersion": 1,
            "kind": "hii.time.blocks",
            "count": blocks.len(),
            "blocks": blocks
        }))
        .map_err(|error| error.to_string());
    }
    if blocks.is_empty() {
        return Ok("No time blocks.".into());
    }
    Ok(blocks
        .iter()
        .map(|block| {
            let start = parse_time(&block.start)
                .map(|value| value.format("%a %b %-d %-I:%M %p").to_string())
                .unwrap_or_else(|_| block.start.clone());
            let end = parse_time(&block.end)
                .map(|value| value.format("%-I:%M %p").to_string())
                .unwrap_or_else(|_| block.end.clone());
            format!(
                "{}  {}-{}  {}  [{}]",
                block.id, start, end, block.title, block.status
            )
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

fn record_for(block: &TimeBlock, operation: &str) -> TimeRecord {
    TimeRecord {
        schema_version: 1,
        record_id: uuid::Uuid::new_v4().to_string(),
        block_id: block.id.clone(),
        device_id: block.updated_by.clone(),
        revision: block.revision,
        updated_at_unix_ms: block.updated_at_unix_ms,
        operation: operation.into(),
        block: Some(block.clone()),
    }
}

fn validate_record(record: &TimeRecord) -> Result<(), String> {
    if record.schema_version != 1
        || !safe_id(&record.record_id)
        || !safe_id(&record.block_id)
        || !safe_id(&record.device_id)
        || record.revision == 0
        || !matches!(record.operation.as_str(), "upsert" | "delete")
    {
        return Err("invalid time record identity or operation".into());
    }
    match (&record.operation[..], &record.block) {
        ("delete", None) => Ok(()),
        ("upsert", Some(block)) => {
            if block.id != record.block_id
                || block.revision != record.revision
                || block.updated_at_unix_ms != record.updated_at_unix_ms
                || block.updated_by != record.device_id
                || !matches!(block.status.as_str(), "planned" | "completed" | "cancelled")
                || block.title.trim().is_empty()
                || block.title.chars().count() > 240
                || parse_time(&block.end)? <= parse_time(&block.start)?
            {
                return Err("invalid time block payload".into());
            }
            Ok(())
        }
        _ => Err("time record operation and payload disagree".into()),
    }
}

fn parse_time(value: &str) -> Result<DateTime<Local>, String> {
    if let Ok(value) = DateTime::parse_from_rfc3339(value) {
        return Ok(value.with_timezone(&Local));
    }
    let naive = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M")
        .map_err(|_| "time must be RFC3339 or local YYYY-MM-DDTHH:MM".to_string())?;
    Local
        .from_local_datetime(&naive)
        .single()
        .ok_or_else(|| "that local time is ambiguous or does not exist".into())
}

fn clean_text(value: &str, max: usize, label: &str) -> Result<String, String> {
    let clean = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() || clean.chars().count() > max || clean.contains('\0') {
        return Err(format!("{label} must contain 1..{max} safe characters"));
    }
    Ok(clean)
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn device_id() -> String {
    std::env::var("HII_DEVICE_ID")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .filter(|value| safe_id(value))
        .unwrap_or_else(|| "local-device".into())
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(label: &str) -> (PathBuf, TimeService) {
        let root = std::env::temp_dir().join(format!(
            "hii-time-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let paths = AppPaths {
            repo: root.join("repo"),
            runtime: root.join("runtime"),
        };
        (root, TimeService::new(&paths))
    }

    #[test]
    fn add_complete_remove_keeps_append_only_history() {
        let (root, service) = service("lifecycle");
        let block = service
            .add(
                "2026-09-21T09:00",
                "2026-09-21T10:30",
                "Design review",
                None,
            )
            .unwrap();
        let completed = service.set_status(&block.id, "completed").unwrap();
        assert_eq!(completed.revision, 2);
        service.remove(&block.id).unwrap();
        assert!(service.find(&block.id).is_err());
        assert_eq!(service.records().unwrap().len(), 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_is_idempotent_and_converges_by_revision() {
        let (left_root, left) = service("left");
        let (right_root, right) = service("right");
        let mut block = left
            .add("2026-09-21T09:00", "2026-09-21T10:00", "Focus", None)
            .unwrap();
        right.merge(&left.records().unwrap()).unwrap();
        block.status = "completed".into();
        block.revision = 2;
        block.updated_at_unix_ms += 1;
        block.updated_by = "peer".into();
        let next = record_for(&block, "upsert");
        assert_eq!(left.merge(std::slice::from_ref(&next)).unwrap(), 1);
        assert_eq!(left.merge(std::slice::from_ref(&next)).unwrap(), 0);
        assert_eq!(left.find(&block.id).unwrap().status, "completed");
        fs::remove_dir_all(left_root).unwrap();
        fs::remove_dir_all(right_root).unwrap();
    }

    #[test]
    fn reports_overlapping_planned_blocks() {
        let (root, service) = service("conflicts");
        service
            .add("2026-09-21T09:00", "2026-09-21T10:00", "One", None)
            .unwrap();
        service
            .add("2026-09-21T09:30", "2026-09-21T11:00", "Two", None)
            .unwrap();
        assert_eq!(service.conflicts().unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
