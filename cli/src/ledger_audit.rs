use crate::receipt::{Outcome, Receipt};
use hii_core::run_ledger::{self, BlobRef, RECEIPT_MAX_BYTES};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{BufRead, BufReader},
    path::Path,
};

const QUARANTINE_FILE_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditReport {
    pub generated_at_unix_ms: u128,
    pub run_directories: usize,
    pub envelopes: usize,
    pub missing_envelopes: usize,
    pub invalid_envelopes: usize,
    pub receipts: usize,
    pub event_logs: usize,
    pub missing_receipts: usize,
    pub missing_event_logs: usize,
    pub oversized_receipts: usize,
    pub oversized_event_logs: usize,
    pub chained_event_logs: usize,
    pub broken_event_chains: usize,
    pub quarantined_files: usize,
    pub archived_files: usize,
    pub archived_original_bytes: u64,
    pub archived_stored_bytes: u64,
    pub trace_records: usize,
    pub linked_trace_records: usize,
    pub unlinked_trace_records: usize,
    pub invalid_trace_records: usize,
    pub unmatched_trace_run_ids: usize,
    pub surfaces: BTreeMap<String, SurfaceAudit>,
    pub total_bytes: u64,
    pub index_path: String,
    pub records: Vec<AuditRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRecord {
    pub surface: String,
    pub run_id: String,
    pub envelope: String,
    pub receipt_bytes: Option<u64>,
    pub event_bytes: Option<u64>,
    pub status: Option<String>,
    pub goal: Option<String>,
    pub event_chain: String,
    pub quarantined: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceAudit {
    pub runs: usize,
    pub envelopes: usize,
    pub missing_envelopes: usize,
    pub receipts: usize,
    pub event_logs: usize,
    pub missing_receipts: usize,
    pub missing_event_logs: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveManifest {
    #[serde(default = "default_cli_surface")]
    surface: String,
    run_id: String,
    archived_at_unix_ms: u128,
    files: Vec<ArchivedFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchivedFile {
    name: String,
    blob: BlobRef,
}

pub fn audit(runtime: &Path, repair: bool) -> Result<AuditReport, String> {
    let runs_root = runtime.join("runs");
    let mut report = AuditReport {
        generated_at_unix_ms: crate::clock::unix_ms(),
        run_directories: 0,
        envelopes: 0,
        missing_envelopes: 0,
        invalid_envelopes: 0,
        receipts: 0,
        event_logs: 0,
        missing_receipts: 0,
        missing_event_logs: 0,
        oversized_receipts: 0,
        oversized_event_logs: 0,
        chained_event_logs: 0,
        broken_event_chains: 0,
        quarantined_files: 0,
        archived_files: 0,
        archived_original_bytes: 0,
        archived_stored_bytes: 0,
        trace_records: 0,
        linked_trace_records: 0,
        unlinked_trace_records: 0,
        invalid_trace_records: 0,
        unmatched_trace_run_ids: 0,
        surfaces: BTreeMap::new(),
        total_bytes: 0,
        index_path: runs_root.join("index.jsonl").display().to_string(),
        records: Vec::new(),
    };

    let mut namespaces = fs::read_dir(&runs_root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter(|entry| {
            !matches!(
                entry.file_name().to_string_lossy().as_ref(),
                "blobs" | "quarantine" | "archive"
            )
        })
        .collect::<Vec<_>>();
    namespaces.sort_by_key(|entry| entry.file_name());
    let mut known_run_ids = HashSet::new();
    for namespace in namespaces {
        let surface = namespace.file_name().to_string_lossy().to_string();
        let mut directories = fs::read_dir(namespace.path())
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .filter(|entry| entry.file_name() != "by-workspace")
            .collect::<Vec<_>>();
        directories.sort_by_key(|entry| entry.file_name());
        for entry in directories {
            let run_id = entry.file_name().to_string_lossy().to_string();
            if !run_ledger::valid_id(&run_id) {
                continue;
            }
            known_run_ids.insert(run_id.clone());
            let dir = entry.path();
            let surface_report = report.surfaces.entry(surface.clone()).or_default();
            surface_report.runs += 1;
            report.run_directories += 1;
            let receipt = dir.join("receipt.json");
            let events = dir.join("events.jsonl");
            let envelope_path = dir.join("run.json");
            let envelope = match fs::read(&envelope_path) {
                Ok(bytes) => match serde_json::from_slice::<run_ledger::RunEnvelopeV2>(&bytes) {
                    Ok(envelope)
                        if envelope.version == run_ledger::RUN_ENVELOPE_VERSION
                            && envelope.run_id == run_id =>
                    {
                        report.envelopes += 1;
                        surface_report.envelopes += 1;
                        "valid"
                    }
                    Ok(_) | Err(_) => {
                        report.invalid_envelopes += 1;
                        "invalid"
                    }
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    report.missing_envelopes += 1;
                    surface_report.missing_envelopes += 1;
                    "missing"
                }
                Err(error) => return Err(error.to_string()),
            };
            let receipt_bytes = fs::metadata(&receipt).ok().map(|meta| meta.len());
            let event_bytes = fs::metadata(&events).ok().map(|meta| meta.len());
            report.total_bytes += receipt_bytes.unwrap_or(0) + event_bytes.unwrap_or(0);
            if receipt_bytes.is_some() {
                report.receipts += 1;
                surface_report.receipts += 1;
            } else {
                report.missing_receipts += 1;
                surface_report.missing_receipts += 1;
            }
            if event_bytes.is_some() {
                report.event_logs += 1;
                surface_report.event_logs += 1;
            } else {
                report.missing_event_logs += 1;
                surface_report.missing_event_logs += 1;
            }
            if receipt_bytes.is_some_and(|bytes| bytes > RECEIPT_MAX_BYTES as u64) {
                report.oversized_receipts += 1;
            }
            if event_bytes.is_some_and(|bytes| bytes > QUARANTINE_FILE_BYTES) {
                report.oversized_event_logs += 1;
            }
            let receipt_value = receipt_bytes
                .filter(|bytes| *bytes <= RECEIPT_MAX_BYTES as u64)
                .and_then(|_| fs::read(&receipt).ok())
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
            let (mut event_chain, mut broken, chain_root) =
                inspect_chain(&events, event_bytes.unwrap_or(0))?;
            let declared_root = receipt_value
                .as_ref()
                .and_then(|value| {
                    value
                        .get("eventChainRoot")
                        .or_else(|| value.get("event_chain_root"))
                })
                .and_then(Value::as_str);
            if event_chain == "valid"
                && declared_root.is_some()
                && declared_root != chain_root.as_deref()
            {
                event_chain = "receipt-root-mismatch".into();
                broken = true;
            }
            if event_chain == "valid" {
                report.chained_event_logs += 1;
            }
            if broken {
                report.broken_event_chains += 1;
            }
            let mut record = AuditRecord {
                surface: surface.clone(),
                run_id: run_id.clone(),
                envelope: envelope.into(),
                receipt_bytes,
                event_bytes,
                status: receipt_value
                    .as_ref()
                    .and_then(|value| value["status"].as_str())
                    .map(str::to_owned),
                goal: receipt_value
                    .as_ref()
                    .and_then(|value| value["goal"].as_str())
                    .map(|value| clip(value, 512)),
                event_chain,
                quarantined: Vec::new(),
            };
            if repair {
                for (name, path, bytes, media_type) in [
                    (
                        "receipt.json",
                        &receipt,
                        receipt_bytes,
                        "application/vnd.hii.receipt+json",
                    ),
                    (
                        "events.jsonl",
                        &events,
                        event_bytes,
                        "application/vnd.hii.events+jsonl",
                    ),
                ] {
                    let limit = if name == "receipt.json" {
                        RECEIPT_MAX_BYTES as u64
                    } else {
                        QUARANTINE_FILE_BYTES
                    };
                    if bytes.is_some_and(|size| size > limit) {
                        quarantine(runtime, &surface, &run_id, name, path, media_type)?;
                        record.quarantined.push(name.into());
                        report.quarantined_files += 1;
                    }
                }
            }
            report.records.push(record);
        }
    }
    let (archived_files, archived_original_bytes, archived_stored_bytes) =
        inspect_archives(runtime)?;
    report.archived_files = archived_files;
    report.archived_original_bytes = archived_original_bytes;
    report.archived_stored_bytes = archived_stored_bytes;
    inspect_traces(runtime, &known_run_ids, &mut report)?;
    let lines = report
        .records
        .iter()
        .map(|record| serde_json::to_string(record).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?
        .join("\n")
        + "\n";
    crate::store::write_private_atomic(Path::new(&report.index_path), lines.as_bytes())?;
    crate::store::write_json_private_atomic(&runs_root.join("audit.json"), &report)?;
    Ok(report)
}

fn inspect_archives(runtime: &Path) -> Result<(usize, u64, u64), String> {
    let root = runtime.join("runs/quarantine");
    let mut manifests = Vec::new();
    for entry in fs::read_dir(&root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
    {
        let direct = entry.path().join("manifest.json");
        if direct.is_file() {
            manifests.push(direct);
            continue;
        }
        for run in fs::read_dir(entry.path())
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
        {
            let nested = run.path().join("manifest.json");
            if nested.is_file() {
                manifests.push(nested);
            }
        }
    }
    let mut files = 0usize;
    let mut original = 0u64;
    let mut stored = 0u64;
    for path in manifests {
        let manifest = crate::store::read_json::<ArchiveManifest>(&path)
            .ok_or_else(|| format!("invalid quarantine manifest: {}", path.display()))?;
        for file in manifest.files {
            files += 1;
            original = original.saturating_add(file.blob.original_bytes);
            stored = stored.saturating_add(file.blob.stored_bytes);
        }
    }
    Ok((files, original, stored))
}

fn inspect_traces(
    runtime: &Path,
    known_run_ids: &HashSet<String>,
    report: &mut AuditReport,
) -> Result<(), String> {
    let path = runtime.join("traces/llm_requests.jsonl");
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        report.trace_records += 1;
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                report.invalid_trace_records += 1;
                continue;
            }
        };
        match value.get("receipt_id").and_then(Value::as_str) {
            Some(run_id) => {
                report.linked_trace_records += 1;
                if !known_run_ids.contains(run_id) {
                    report.unmatched_trace_run_ids += 1;
                }
            }
            None => report.unlinked_trace_records += 1,
        }
    }
    Ok(())
}

fn inspect_chain(path: &Path, bytes: u64) -> Result<(String, bool, Option<String>), String> {
    if bytes == 0 {
        return Ok(("missing".into(), false, None));
    }
    if bytes > QUARANTINE_FILE_BYTES {
        return Ok(("legacy-oversized".into(), false, None));
    }
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut previous = None::<String>;
    let mut saw_hash = false;
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let mut value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => return Ok(("malformed".into(), true, None)),
        };
        let Some(event_hash) = value
            .get("event_hash")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            if saw_hash {
                return Ok(("mixed".into(), true, None));
            }
            continue;
        };
        saw_hash = true;
        let declared_previous = value.get("previous_hash").and_then(Value::as_str);
        if declared_previous != previous.as_deref() {
            return Ok(("broken".into(), true, None));
        }
        value
            .as_object_mut()
            .map(|object| object.remove("event_hash"));
        let canonical = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
        if run_ledger::sha256_hex(&canonical) != event_hash {
            return Ok(("broken".into(), true, None));
        }
        previous = Some(event_hash);
    }
    Ok((
        if saw_hash {
            "valid"
        } else {
            "legacy-unchained"
        }
        .into(),
        false,
        previous,
    ))
}

fn quarantine(
    runtime: &Path,
    surface: &str,
    run_id: &str,
    name: &str,
    source: &Path,
    media_type: &str,
) -> Result<(), String> {
    let blob = run_ledger::store_file_blob(runtime, source, media_type)?;
    let manifest_path = runtime
        .join("runs/quarantine")
        .join(surface)
        .join(run_id)
        .join("manifest.json");
    let mut manifest =
        crate::store::read_json::<ArchiveManifest>(&manifest_path).unwrap_or(ArchiveManifest {
            surface: surface.into(),
            run_id: run_id.into(),
            archived_at_unix_ms: crate::clock::unix_ms(),
            files: Vec::new(),
        });
    manifest.files.retain(|file| file.name != name);
    manifest.files.push(ArchivedFile {
        name: name.into(),
        blob: blob.clone(),
    });
    crate::store::write_json_private_atomic(&manifest_path, &manifest)?;
    match name {
        "receipt.json" => {
            let receipt = Receipt {
                schema_version: 9,
                id: run_id.into(),
                created_at_unix_ms: 0,
                finished_at_unix_ms: crate::clock::unix_ms(),
                status: Outcome::Aborted.status().into(),
                goal: "Legacy oversized run archived locally.".into(),
                workspace: String::new(),
                model: "legacy".into(),
                review_model: None,
                steps: 0,
                summary: format!("Original receipt is recoverable from {}.", blob.path),
                verification: Vec::new(),
                git_status: "archived".into(),
                next: None,
                review: None,
                risk: "Full legacy receipt remains in a verified local zstd blob.".into(),
                authority: None,
                done_when: None,
                approvals: Vec::new(),
                artifacts: Vec::new(),
                reversible: Some(true),
                context_sources: Vec::new(),
                preexisting_changes: Vec::new(),
                hooks: Vec::new(),
                outcome: "archived".into(),
                exit_code: 2,
                completion: None,
                model_source: None,
                autonomy_level: None,
                learning_candidates: Vec::new(),
                user_corrections: Vec::new(),
                failure_patterns: Vec::new(),
                skill_draft_ref: None,
                token_usage: None,
                engine: None,
            };
            let mut value = serde_json::to_value(receipt).map_err(|error| error.to_string())?;
            value["archivedBlob"] =
                serde_json::to_value(blob).map_err(|error| error.to_string())?;
            crate::store::write_json_private_atomic(source, &value)?;
        }
        "events.jsonl" => {
            let value = json!({
                "ts_unix_ms": crate::clock::unix_ms(),
                "run_id": run_id,
                "kind": "legacy.archived",
                "data": { "contentRef": blob }
            });
            crate::store::write_private_atomic(source, format!("{value}\n").as_bytes())?;
        }
        _ => return Err(format!("unsupported HII archive file: {name}")),
    }
    Ok(())
}

pub fn restore(runtime: &Path, archive_id: &str) -> Result<(), String> {
    let (surface, run_id) = match archive_id.split_once('/') {
        Some((surface, run_id)) => (surface.to_string(), run_id.to_string()),
        None => find_archive_surface(runtime, archive_id)?,
    };
    if !run_ledger::valid_id(&surface) || !run_ledger::valid_id(&run_id) {
        return Err("invalid archive id".into());
    }
    let mut manifest_path = runtime
        .join("runs/quarantine")
        .join(&surface)
        .join(&run_id)
        .join("manifest.json");
    if !manifest_path.is_file() && surface == "cli" {
        let legacy = runtime
            .join("runs/quarantine")
            .join(&run_id)
            .join("manifest.json");
        if legacy.is_file() {
            manifest_path = legacy;
        }
    }
    let manifest = crate::store::read_json::<ArchiveManifest>(&manifest_path)
        .ok_or_else(|| format!("no quarantine manifest for {run_id}"))?;
    let run_dir = runtime.join("runs").join(&surface).join(&run_id);
    for file in &manifest.files {
        run_ledger::restore_blob(runtime, &file.blob, &run_dir.join(&file.name))?;
    }
    Ok(())
}

fn find_archive_surface(runtime: &Path, run_id: &str) -> Result<(String, String), String> {
    if !run_ledger::valid_id(run_id) {
        return Err("invalid archive id".into());
    }
    let root = runtime.join("runs/quarantine");
    if root.join(run_id).join("manifest.json").is_file() {
        return Ok(("cli".into(), run_id.to_string()));
    }
    let matches = fs::read_dir(root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().join(run_id).join("manifest.json").is_file())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [surface] => Ok((surface.clone(), run_id.to_string())),
        [] => Err(format!("no quarantine manifest for {run_id}")),
        _ => Err(format!("archive id is ambiguous; use <surface>/{run_id}")),
    }
}

fn default_cli_surface() -> String {
    "cli".into()
}

pub fn print_report(report: &AuditReport) {
    println!("HII proof audit");
    println!("runs        {}", report.run_directories);
    println!(
        "envelopes   {} ({} missing, {} invalid)",
        report.envelopes, report.missing_envelopes, report.invalid_envelopes
    );
    println!(
        "receipts    {} ({} missing, {} oversized)",
        report.receipts, report.missing_receipts, report.oversized_receipts
    );
    println!(
        "events      {} ({} missing, {} oversized)",
        report.event_logs, report.missing_event_logs, report.oversized_event_logs
    );
    println!(
        "chains      {} valid, {} broken",
        report.chained_event_logs, report.broken_event_chains
    );
    println!(
        "traces      {} linked, {} unlinked, {} invalid, {} unmatched",
        report.linked_trace_records,
        report.unlinked_trace_records,
        report.invalid_trace_records,
        report.unmatched_trace_run_ids
    );
    for (surface, audit) in &report.surfaces {
        println!(
            "surface     {surface}: {} run(s), {} receipt(s), {} event log(s)",
            audit.runs, audit.receipts, audit.event_logs
        );
    }
    println!("quarantined {} file(s)", report.quarantined_files);
    println!(
        "archives    {} file(s), {} original bytes, {} stored bytes",
        report.archived_files, report.archived_original_bytes, report.archived_stored_bytes
    );
    println!("index       {}", report.index_path);
}

fn clip(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn audit_recognizes_a_v2_hash_chain() {
        let _guard = ENV_LOCK.lock().unwrap();
        let runtime = tempfile::tempdir().unwrap();
        std::env::set_var("HII_LEDGER_MIN_FREE_BYTES", "0");
        let ledger = run_ledger::RunLedger::create(runtime.path(), "cli", "test").unwrap();
        ledger
            .event("run.started", json!({"goal": "test"}))
            .unwrap();
        ledger
            .event("run.finished", json!({"status": "completed"}))
            .unwrap();
        ledger
            .finish(json!({
                "schema_version": 9,
                "id": ledger.envelope.run_id,
                "created_at_unix_ms": ledger.envelope.created_at_unix_ms,
                "finished_at_unix_ms": ledger.envelope.created_at_unix_ms,
                "status": "completed",
                "goal": "test",
                "workspace": "/tmp",
                "model": "test",
                "review_model": null,
                "steps": 1,
                "summary": "done",
                "verification": [],
                "git_status": "clean",
                "next": null,
                "review": null,
                "risk": "none"
            }))
            .unwrap();
        let report = audit(runtime.path(), false).unwrap();
        assert_eq!(report.run_directories, 1);
        assert_eq!(report.chained_event_logs, 1);
        assert_eq!(report.broken_event_chains, 0);
        std::env::remove_var("HII_LEDGER_MIN_FREE_BYTES");
    }

    #[test]
    fn legacy_manifest_defaults_to_cli_surface() {
        let manifest: ArchiveManifest = serde_json::from_value(json!({
            "runId": "legacy-run",
            "archivedAtUnixMs": 1,
            "files": []
        }))
        .unwrap();
        assert_eq!(manifest.surface, "cli");
    }

    #[test]
    fn audit_joins_traces_and_reports_each_surface() {
        let _guard = ENV_LOCK.lock().unwrap();
        let runtime = tempfile::tempdir().unwrap();
        std::env::set_var("HII_LEDGER_MIN_FREE_BYTES", "0");
        let cli = run_ledger::RunLedger::create(runtime.path(), "cli", "cli").unwrap();
        cli.event("run.started", json!({})).unwrap();
        cli.finish(json!({"status": "completed"})).unwrap();
        let chat = run_ledger::RunLedger::create(runtime.path(), "chat", "chat").unwrap();
        chat.event("run.started", json!({})).unwrap();
        chat.finish(json!({"status": "completed"})).unwrap();
        fs::create_dir_all(runtime.path().join("traces")).unwrap();
        fs::write(
            runtime.path().join("traces/llm_requests.jsonl"),
            format!(
                "{}\n{}\n{}\nnot-json\n",
                json!({"receipt_id": cli.envelope.run_id}),
                json!({"receipt_id": "missing-run"}),
                json!({"model": "legacy-unlinked"})
            ),
        )
        .unwrap();

        let report = audit(runtime.path(), false).unwrap();
        assert_eq!(report.run_directories, 2);
        assert_eq!(report.surfaces["cli"].runs, 1);
        assert_eq!(report.surfaces["chat"].runs, 1);
        assert_eq!(report.trace_records, 4);
        assert_eq!(report.linked_trace_records, 2);
        assert_eq!(report.unlinked_trace_records, 1);
        assert_eq!(report.invalid_trace_records, 1);
        assert_eq!(report.unmatched_trace_run_ids, 1);
        std::env::remove_var("HII_LEDGER_MIN_FREE_BYTES");
    }

    #[test]
    fn archive_and_restore_are_hash_verified_and_reversible() {
        let _guard = ENV_LOCK.lock().unwrap();
        let runtime = tempfile::tempdir().unwrap();
        std::env::set_var("HII_LEDGER_MIN_FREE_BYTES", "0");
        let run_id = "legacy-large";
        let run_dir = runtime.path().join("runs/cli").join(run_id);
        fs::create_dir_all(&run_dir).unwrap();
        let original = vec![b'x'; RECEIPT_MAX_BYTES + 1];
        fs::write(run_dir.join("receipt.json"), &original).unwrap();
        fs::write(run_dir.join("events.jsonl"), b"{}\n").unwrap();

        let report = audit(runtime.path(), true).unwrap();
        assert_eq!(report.quarantined_files, 1);
        assert_eq!(report.archived_files, 1);
        assert_eq!(report.archived_original_bytes, original.len() as u64);
        assert!(runtime
            .path()
            .join("runs/quarantine/cli/legacy-large/manifest.json")
            .is_file());
        assert_ne!(fs::read(run_dir.join("receipt.json")).unwrap(), original);

        restore(runtime.path(), "cli/legacy-large").unwrap();
        assert_eq!(fs::read(run_dir.join("receipt.json")).unwrap(), original);
        std::env::remove_var("HII_LEDGER_MIN_FREE_BYTES");
    }
}
