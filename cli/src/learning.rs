use crate::receipt::Receipt;
use serde::Serialize;
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Serialize)]
struct LearningRecord<'a> {
    schema_version: u8,
    kind: &'static str,
    id: String,
    scope: &'static str,
    source: LearningSource<'a>,
    category: &'static str,
    summary: String,
    evidence: serde_json::Value,
    approved: bool,
    created_at_unix_ms: u128,
}

#[derive(Serialize)]
struct LearningSource<'a> {
    receipt_id: &'a str,
    conversation_id: Option<&'a str>,
    workspace: &'a str,
}

pub fn record_from_receipt(
    runtime: &Path,
    receipt: &Receipt,
    conversation_id: Option<&str>,
    skill_draft: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    if receipt.status != "completed" || receipt.verification.iter().all(|check| !check.ok) {
        return Ok(None);
    }
    let dir = runtime.join("learning");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join("records.jsonl");
    let checks = receipt
        .verification
        .iter()
        .filter(|check| check.ok)
        .map(|check| check.command.clone())
        .collect::<Vec<_>>();
    let files = if receipt.artifacts.is_empty() {
        receipt
            .git_status
            .lines()
            .take(24)
            .map(str::to_string)
            .collect::<Vec<_>>()
    } else {
        receipt.artifacts.clone()
    };
    let record = LearningRecord {
        schema_version: 1,
        kind: "hii.learning.candidate",
        id: format!("{}-verified-workflow", receipt.id),
        scope: "workspace",
        source: LearningSource {
            receipt_id: &receipt.id,
            conversation_id,
            workspace: &receipt.workspace,
        },
        category: if skill_draft.is_some() {
            "reusable-skill"
        } else {
            "verified-workflow"
        },
        summary: receipt.summary.clone(),
        evidence: json!({
            "goal": receipt.goal,
            "checks": checks,
            "files": files,
            "skillDraft": skill_draft,
            "model": receipt.model,
            "authority": receipt.authority,
        }),
        approved: false,
        created_at_unix_ms: crate::clock::unix_ms(),
    };
    crate::store::append_jsonl(&path, &record)?;
    write_verified_lessons(runtime)?;
    Ok(Some(path))
}

pub fn write_verified_lessons(runtime: &Path) -> Result<Option<PathBuf>, String> {
    let records = runtime.join("learning/records.jsonl");
    if !records.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&records).map_err(|error| error.to_string())?;
    let mut lines = Vec::new();
    for line in raw.lines().rev().take(8) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let summary = value["summary"].as_str().unwrap_or("").trim();
        if summary.is_empty() {
            continue;
        }
        let receipt = value["source"]["receipt_id"].as_str().unwrap_or("unknown");
        lines.push(format!("- {summary} (source: hii proof {receipt})"));
    }
    if lines.is_empty() {
        return Ok(None);
    }
    lines.reverse();
    let path = runtime.join("learning/verified-lessons.md");
    fs::write(
        &path,
        format!(
            "HII LEARNED LOCAL WORKFLOWS\nUse these only as source-linked hints; current instructions and live state outrank them.\n{}\n",
            lines.join("\n")
        ),
    )
    .map_err(|error| error.to_string())?;
    Ok(Some(path))
}

pub fn status(runtime: &Path) -> Result<String, String> {
    let records = runtime.join("learning/records.jsonl");
    if !records.exists() {
        return Ok("No learning records yet.".into());
    }
    let raw = fs::read_to_string(records).map_err(|error| error.to_string())?;
    let count = raw.lines().filter(|line| !line.trim().is_empty()).count();
    let lessons = runtime.join("learning/verified-lessons.md");
    Ok(format!(
        "{count} learning candidate(s)\n{}",
        lessons.display()
    ))
}
