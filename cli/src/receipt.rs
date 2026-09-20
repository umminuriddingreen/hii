use crate::completion::CompletionAssessment;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
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
pub struct TokenUsageRecord {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// Zero means the operator did not set a cumulative token ceiling.
    pub budget: u64,
}

/// Provenance for a replaceable agent engine used beneath HII's authority
/// boundary. The engine may reason and orchestrate, but the surrounding
/// [`Receipt`] remains HII's canonical proof record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EngineRecord {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub events: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub termination_reason: Option<String>,
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
    // --- schema v5: why the run ended, and what the shell saw ---
    /// Fine-grained reason the run ended. `status` stays coarse because external
    /// consumers (cli/scripts/local-model-eval.sh) match on its three values.
    #[serde(default)]
    pub outcome: String,
    #[serde(default)]
    pub exit_code: u8,
    // --- schema v6: one canonical completion assessment ---
    /// Absent on every receipt written before this existed. A reader that finds
    /// `None` is looking at legacy proof semantics and must not treat the
    /// receipt as stronger evidence than it carries.
    #[serde(default)]
    pub completion: Option<CompletionAssessment>,
    // --- schema v7: user-owned model policy, autonomy, and learning ---
    #[serde(default)]
    pub model_source: Option<String>,
    #[serde(default)]
    pub autonomy_level: Option<String>,
    #[serde(default)]
    pub learning_candidates: Vec<String>,
    #[serde(default)]
    pub user_corrections: Vec<String>,
    #[serde(default)]
    pub failure_patterns: Vec<String>,
    #[serde(default)]
    pub skill_draft_ref: Option<String>,
    // --- schema v8: objective-bound inference usage ---
    #[serde(default)]
    pub token_usage: Option<TokenUsageRecord>,
    // --- schema v9: replaceable engine provenance ---
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<EngineRecord>,
}

/// Why a run ended, at the granularity the exit code reports.
///
/// `status` collapses these into completed/interrupted/incomplete for existing
/// consumers; `outcome` keeps the distinction that makes a failed run
/// actionable — a missing dependency and a genuine test failure used to be
/// indistinguishable from the outside.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Running,
    Completed,
    VerifyFailed,
    StepCeiling,
    TokenBudget,
    Deadline,
    LoopAbort,
    Interrupted,
    EnvironmentBlocked,
    ProviderError,
    InfraError,
    Aborted,
}

impl Outcome {
    pub fn label(self) -> &'static str {
        match self {
            Outcome::Running => "running",
            Outcome::Completed => "completed",
            Outcome::VerifyFailed => "verify-failed",
            Outcome::StepCeiling => "step-ceiling",
            Outcome::TokenBudget => "token-budget",
            Outcome::Deadline => "deadline",
            Outcome::LoopAbort => "loop-abort",
            Outcome::Interrupted => "interrupted",
            Outcome::EnvironmentBlocked => "environment-blocked",
            Outcome::ProviderError => "provider-error",
            Outcome::InfraError => "infra-error",
            Outcome::Aborted => "aborted",
        }
    }

    /// Process exit code. 0 still means success and 2 still means "incomplete",
    /// so every existing `&&`-chained consumer keeps working; 3-7 refine what
    /// used to be an undifferentiated 2.
    pub fn exit_code(self) -> u8 {
        match self {
            Outcome::Completed => 0,
            Outcome::ProviderError | Outcome::InfraError | Outcome::Aborted => 1,
            Outcome::Running | Outcome::EnvironmentBlocked => 2,
            Outcome::VerifyFailed => 3,
            Outcome::StepCeiling => 4,
            Outcome::TokenBudget => 8,
            Outcome::Deadline => 5,
            Outcome::LoopAbort => 6,
            Outcome::Interrupted => 7,
        }
    }

    /// The coarse status kept for backward compatibility.
    pub fn status(self) -> &'static str {
        match self {
            Outcome::Completed => "completed",
            Outcome::Interrupted => "interrupted",
            _ => "incomplete",
        }
    }
}

/// Classify a run-ending error string into an outcome.
///
/// The provider layer reports failures as plain strings, so this is a match on
/// what those strings actually say rather than on a typed error.
pub fn classify_error(error: &str) -> Outcome {
    let lower = error.to_ascii_lowercase();
    if lower.contains("model loop detected") {
        Outcome::LoopAbort
    } else if lower.contains("ollama")
        || lower.contains("ox alpha")
        || lower.contains("model provider")
        || lower.contains("model stream")
        || lower.contains("lm studio")
        || lower.contains("connection")
    {
        Outcome::ProviderError
    } else {
        Outcome::InfraError
    }
}

pub struct RunStore {
    pub id: String,
    pub dir: PathBuf,
    pub started_at_unix_ms: u128,
    ledger: hii_core::run_ledger::RunLedger,
}

pub struct ConversationStore {
    pub id: String,
    events: PathBuf,
}

impl ConversationStore {
    pub fn create(runtime: &Path) -> Result<Self, String> {
        let now = crate::clock::unix_ms();
        let id = new_store_id(now);
        let dir = runtime.join("conversations").join("cli");
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        crate::run_context::set_conversation_id(&id);
        Ok(Self {
            id: id.clone(),
            events: dir.join(format!("{id}.jsonl")),
        })
    }

    pub fn event(&self, kind: &str, data: Value) -> Result<(), String> {
        let entry = serde_json::json!({
            "ts_unix_ms": crate::clock::unix_ms(),
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
        let conversation_id = crate::run_context::conversation_id();
        let mut ledger = hii_core::run_ledger::RunLedger::create_linked(
            runtime,
            "cli",
            "cli",
            conversation_id.as_deref(),
            None,
        )?;
        if let Some(route) = crate::run_context::model_route() {
            ledger.set_model_route(
                route.requested.as_deref(),
                &route.routed,
                &route.routed,
                &route.reason,
            )?;
        }
        let id = ledger.envelope.run_id.clone();
        let dir = ledger.dir.clone();
        let started_at_unix_ms = ledger.envelope.created_at_unix_ms;
        Ok(Self {
            id,
            started_at_unix_ms,
            dir,
            ledger,
        })
    }

    pub fn envelope(&self) -> &hii_core::run_ledger::RunEnvelopeV2 {
        &self.ledger.envelope
    }

    pub fn set_model_route(
        &mut self,
        requested: Option<&str>,
        routed: &str,
        served: &str,
        reason: &str,
    ) -> Result<(), String> {
        self.ledger
            .set_model_route(requested, routed, served, reason)
    }

    pub fn set_authority(&mut self, authority: &str) -> Result<(), String> {
        self.ledger.set_authority(authority)
    }

    /// Location of this run's append-only event log.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn events_path(&self) -> &Path {
        self.ledger.events_path()
    }

    pub fn event(&self, kind: &str, data: Value) -> Result<(), String> {
        self.ledger.event(kind, data)
    }

    pub fn finish(&self, runtime: &Path, receipt: &Receipt) -> Result<PathBuf, String> {
        write_receipt(&self.dir, runtime, &self.id, receipt)
    }
}

/// Persist a receipt and both `latest` pointers.
///
/// Shared by [`RunStore::finish`] and [`RunGuard`] so a run written by the
/// durability guard is indistinguishable from one written on the happy path.
fn write_receipt(
    dir: &Path,
    runtime: &Path,
    id: &str,
    receipt: &Receipt,
) -> Result<PathBuf, String> {
    let receipt_path = dir.join("receipt.json");
    let value = bounded_receipt_value(runtime, dir, receipt)?;
    crate::store::write_json_private_atomic(&receipt_path, &value)?;
    // The global pointer stays: cli/scripts/local-model-eval.sh and
    // scripts/hii-activation-smoke.mjs both read it.
    let latest = runtime.join("runs").join("cli").join("latest");
    crate::store::write_private_atomic(&latest, format!("{id}\n").as_bytes())?;
    // The per-workspace pointer is what `hii proof` resolves against, so a run
    // in one workspace can no longer answer for another.
    if !receipt.workspace.is_empty() {
        let scoped = workspace_pointer_dir(runtime, Path::new(&receipt.workspace));
        fs::create_dir_all(&scoped).map_err(|error| error.to_string())?;
        crate::store::write_private_atomic(&scoped.join("latest"), format!("{id}\n").as_bytes())?;
    }
    Ok(receipt_path)
}

fn bounded_receipt_value(runtime: &Path, dir: &Path, receipt: &Receipt) -> Result<Value, String> {
    let mut complete = serde_json::to_value(receipt).map_err(|error| error.to_string())?;
    attach_ledger_metadata(dir, &mut complete)?;
    let original = serde_json::to_vec(&complete).map_err(|error| error.to_string())?;
    if original.len() <= hii_core::run_ledger::RECEIPT_MAX_BYTES {
        return Ok(complete);
    }
    let blob =
        hii_core::run_ledger::store_blob(runtime, "application/vnd.hii.receipt+json", &original)?;
    let mut compact = receipt.clone();
    compact.goal = clipped(&compact.goal, 16_384);
    compact.summary = clipped(&compact.summary, 16_384);
    compact.git_status = clipped(&compact.git_status, 65_536);
    compact.risk = clipped(&compact.risk, 8_192);
    compact.review = compact.review.map(|value| clipped(&value, 8_192));
    compact.next = compact.next.map(|value| clipped(&value, 4_096));
    compact.verification.truncate(128);
    for check in &mut compact.verification {
        check.command = clipped(&check.command, 2_048);
        check.output = clipped(&check.output, 4_096);
    }
    compact.hooks.truncate(128);
    for hook in &mut compact.hooks {
        hook.command = clipped(&hook.command, 2_048);
        hook.output = clipped(&hook.output, 2_048);
    }
    for values in [
        &mut compact.approvals,
        &mut compact.artifacts,
        &mut compact.context_sources,
        &mut compact.preexisting_changes,
        &mut compact.learning_candidates,
        &mut compact.user_corrections,
        &mut compact.failure_patterns,
    ] {
        values.truncate(256);
        for value in values {
            *value = clipped(value, 2_048);
        }
    }
    let mut value = serde_json::to_value(&compact).map_err(|error| error.to_string())?;
    attach_ledger_metadata(dir, &mut value)?;
    value["contentBlobs"] = serde_json::json!([blob]);
    value["receiptCompacted"] = serde_json::json!(true);
    let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    if bytes.len() > hii_core::run_ledger::RECEIPT_MAX_BYTES {
        return Err(format!(
            "compact HII receipt is still {} bytes (limit {})",
            bytes.len(),
            hii_core::run_ledger::RECEIPT_MAX_BYTES
        ));
    }
    Ok(value)
}

fn attach_ledger_metadata(dir: &Path, value: &mut Value) -> Result<(), String> {
    let run_path = dir.join("run.json");
    if let Ok(bytes) = fs::read(&run_path) {
        value["run"] = serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "invalid HII run envelope at {}: {error}",
                run_path.display()
            )
        })?;
    }
    value["eventChainRoot"] = serde_json::to_value(hii_core::run_ledger::event_chain_root(
        &dir.join("events.jsonl"),
    )?)
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn clipped(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes.min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n[truncated; full value stored in contentBlobs]",
        &value[..end]
    )
}

// Retain the sortable timestamp prefix and add independent identity for runs
// started in the same process during one clock tick.
fn new_store_id(now: u128) -> String {
    format!(
        "{now:x}-{:x}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Where a workspace's `latest` pointer lives. The directory name is a hash so
/// an arbitrary filesystem path becomes one safe path component.
fn workspace_pointer_dir(runtime: &Path, workspace: &Path) -> PathBuf {
    let canonical = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    let digest = ring::digest::digest(
        &ring::digest::SHA256,
        canonical.to_string_lossy().as_bytes(),
    );
    let hex = digest
        .as_ref()
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    runtime
        .join("runs")
        .join("cli")
        .join("by-workspace")
        .join(hex)
}

/// Resolve only the per-workspace latest pointer without scanning historical
/// runs. Status surfaces use this bounded lookup so a large proof archive can
/// never turn a health probe into an unbounded read.
pub fn latest_receipt_pointer(runtime: &Path, workspace: &Path) -> Option<PathBuf> {
    let id = fs::read_to_string(workspace_pointer_dir(runtime, workspace).join("latest"))
        .ok()?
        .trim()
        .to_string();
    if id.is_empty() {
        return None;
    }
    let path = runtime.join("runs/cli").join(id).join("receipt.json");
    path.is_file().then_some(path)
}

/// Keeps a run's receipt durable no matter how the run ends.
///
/// A draft is written the moment the run starts and rewritten on drop if it was
/// never finalized. Before this, any early `return Err` — a provider transport
/// failure, an unrecovered stream loop — left `events.jsonl` with no receipt
/// beside it and the `latest` pointer still naming an older run in a possibly
/// unrelated workspace. That combination is what made `hii proof` confidently
/// display the wrong run.
pub struct RunGuard {
    dir: PathBuf,
    runtime: PathBuf,
    id: String,
    draft: Receipt,
    finalized: bool,
}

impl RunGuard {
    /// Claim the run's identity immediately: the draft receipt and both `latest`
    /// pointers are written before the first model call, so a run that dies at
    /// any later point is still the one `hii proof` reports.
    pub fn start(runtime: &Path, dir: &Path, id: &str, draft: Receipt) -> Result<Self, String> {
        let guard = Self {
            dir: dir.to_path_buf(),
            runtime: runtime.to_path_buf(),
            id: id.to_string(),
            draft,
            finalized: false,
        };
        write_receipt(&guard.dir, &guard.runtime, &guard.id, &guard.draft)?;
        Ok(guard)
    }

    /// Record why the run is ending badly. The receipt is written by `drop`.
    pub fn record_error(&mut self, outcome: Outcome, message: &str) {
        self.draft.status = outcome.status().into();
        self.draft.outcome = outcome.label().into();
        self.draft.exit_code = outcome.exit_code();
        self.draft.finished_at_unix_ms = crate::clock::unix_ms();
        self.draft.summary = redact_text(message);
        self.draft.completion = Some(crate::completion::CompletionAssessment::terminated(
            &self.draft.summary,
        ));
    }

    /// Persist a terminal checkpoint before fallible cleanup and presentation.
    /// A long-lived interactive process may retain the guard after a turn, so
    /// relying on `Drop` alone can leave `hii proof` claiming the run is still
    /// active even after a loop stop was already shown to the operator.
    pub fn checkpoint_error(
        &mut self,
        outcome: Outcome,
        message: &str,
        steps: usize,
    ) -> Result<(), String> {
        self.record_error(outcome, message);
        self.draft.steps = steps;
        write_receipt(&self.dir, &self.runtime, &self.id, &self.draft).map(|_| ())
    }

    pub fn finalize(mut self, receipt: &Receipt) -> Result<PathBuf, String> {
        self.draft = receipt.clone();
        let path = match write_receipt(&self.dir, &self.runtime, &self.id, receipt) {
            Ok(path) => path,
            Err(error) => {
                self.record_error(
                    Outcome::InfraError,
                    &format!("Receipt persistence failed: {error}"),
                );
                return Err(error);
            }
        };
        self.finalized = true;
        Ok(path)
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if self.finalized {
            return;
        }
        if self.draft.outcome == Outcome::Running.label() {
            self.draft.status = Outcome::Aborted.status().into();
            self.draft.outcome = Outcome::Aborted.label().into();
            self.draft.exit_code = Outcome::Aborted.exit_code();
            self.draft.finished_at_unix_ms = crate::clock::unix_ms();
        }
        // Best effort: a failure here must not mask the error being unwound.
        let _ = write_receipt(&self.dir, &self.runtime, &self.id, &self.draft);
    }
}

/// Keep the current verification result for each command in this mutation epoch.
///
/// Records are cleared whenever a new mutation epoch begins, so equality within
/// the current vector is already epoch-scoped. Without this, declaring
/// `--verify "cargo test"` for a check the model also runs itself recorded the
/// result twice and executed the suite twice. A retry replaces an earlier
/// result, including a success followed by a failure; the event journal retains
/// the full attempt history. This keeps every completion consumer consistent.
pub fn record_verification(
    records: &mut Vec<VerificationRecord>,
    record: VerificationRecord,
) -> bool {
    if record.ok
        && records
            .iter()
            .rev()
            .find(|existing| existing.command == record.command)
            .is_some_and(|existing| existing.ok)
    {
        return false;
    }
    records.retain(|existing| existing.command != record.command);
    records.push(record);
    true
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

/// Every receipt recorded for `workspace`, newest first.
pub fn receipts_for_workspace(runtime: &Path, workspace: &Path) -> Vec<(PathBuf, Receipt)> {
    receipts_for_workspace_bounded(runtime, workspace, usize::MAX, u64::MAX)
}

/// Newest receipts for `workspace`, with bounded count and per-file size.
///
/// Startup context only needs a handful of recent receipts. Keeping that path
/// bounded prevents one historical receipt with oversized captured output from
/// delaying every interactive session.
pub fn receipts_for_workspace_bounded(
    runtime: &Path,
    workspace: &Path,
    limit: usize,
    max_bytes: u64,
) -> Vec<(PathBuf, Receipt)> {
    if limit == 0 {
        return Vec::new();
    }
    let runs = runtime.join("runs").join("cli");
    let mut paths = fs::read_dir(runs)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("receipt.json"))
        .filter(|path| path.is_file())
        .collect::<Vec<PathBuf>>();
    paths.sort_by(|left, right| right.cmp(left));

    let canonical = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    let mut receipts = Vec::with_capacity(limit.min(paths.len()));
    for path in paths {
        let Some((path, receipt)) = (|| {
            if fs::metadata(&path).ok()?.len() > max_bytes {
                return None;
            }
            let raw = fs::read_to_string(&path).ok()?;
            let receipt = serde_json::from_str::<Receipt>(&raw).ok()?;
            Some((path, receipt))
        })() else {
            continue;
        };
        if Path::new(&receipt.workspace)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(&receipt.workspace))
            == canonical
        {
            receipts.push((path, receipt));
            if receipts.len() == limit {
                break;
            }
        }
    }
    receipts
}

fn newest_run_id(runtime: &Path) -> Option<String> {
    let latest = runtime.join("runs").join("cli").join("latest");
    let id = fs::read_to_string(latest).ok()?.trim().to_string();
    (!id.is_empty()).then_some(id)
}

/// Resolve a receipt.
///
/// An explicit `id` resolves from anywhere, so `hii proof <id>` still works when
/// run outside the workspace that produced it. Without one the lookup is bound to
/// `workspace`: it previously read a process-global `latest` pointer that any run
/// in any directory could overwrite, so `hii proof` in a workspace with no runs
/// of its own silently displayed a different workspace's receipt.
pub fn find_receipt(runtime: &Path, id: Option<&str>, workspace: &Path) -> Result<PathBuf, String> {
    let cli_runs = runtime.join("runs").join("cli");
    let id = match id {
        Some(id) => id.to_string(),
        None => {
            match latest_receipt_pointer(runtime, workspace) {
                Some(path) => return Ok(path),
                // Fall back to a scan: the pointer only exists for runs recorded
                // since it was introduced.
                None => match receipts_for_workspace(runtime, workspace)
                    .into_iter()
                    .next()
                {
                    Some((path, _)) => return Ok(path),
                    None => return Err(no_receipts_here(runtime, workspace)),
                },
            }
        }
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

/// Explain an empty workspace without pretending another workspace's run is it.
fn no_receipts_here(runtime: &Path, workspace: &Path) -> String {
    let mut message = format!("no HII receipts for {}", workspace.display());
    if let Some(id) = newest_run_id(runtime) {
        let elsewhere = fs::read_to_string(
            runtime
                .join("runs")
                .join("cli")
                .join(&id)
                .join("receipt.json"),
        )
        .ok()
        .and_then(|raw| serde_json::from_str::<Receipt>(&raw).ok());
        if let Some(receipt) = elsewhere {
            message.push_str(&format!(
                "; the most recent run overall is {id} in {} (hii proof {id})",
                receipt.workspace
            ));
        }
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "hii-receipt-{tag}-{}-{}",
                std::process::id(),
                crate::clock::unix_ms()
            ));
            fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sample(id: &str, workspace: &Path) -> Receipt {
        Receipt {
            schema_version: 5,
            id: id.into(),
            created_at_unix_ms: 1,
            finished_at_unix_ms: 2,
            status: "completed".into(),
            goal: "fix".into(),
            workspace: workspace.display().to_string(),
            model: "local".into(),
            review_model: None,
            steps: 1,
            summary: "done".into(),
            verification: Vec::new(),
            git_status: "clean".into(),
            next: None,
            review: None,
            risk: String::new(),
            authority: None,
            done_when: None,
            approvals: Vec::new(),
            artifacts: Vec::new(),
            reversible: None,
            context_sources: Vec::new(),
            preexisting_changes: Vec::new(),
            hooks: Vec::new(),
            outcome: "completed".into(),
            exit_code: 0,
            completion: None,
            model_source: None,
            autonomy_level: None,
            learning_candidates: Vec::new(),
            user_corrections: Vec::new(),
            failure_patterns: Vec::new(),
            skill_draft_ref: None,
            token_usage: None,
            engine: None,
        }
    }

    fn record_run(runtime: &Path, id: &str, workspace: &Path) {
        let dir = runtime.join("runs").join("cli").join(id);
        fs::create_dir_all(&dir).expect("create run dir");
        write_receipt(&dir, runtime, id, &sample(id, workspace)).expect("write receipt");
    }

    #[test]
    fn bounded_workspace_receipts_skip_oversized_history_and_stop_at_limit() {
        let runtime = TempDir::new("bounded-runtime");
        let workspace = TempDir::new("bounded-workspace");
        record_run(&runtime.0, "run-a", &workspace.0);
        record_run(&runtime.0, "run-b", &workspace.0);
        record_run(&runtime.0, "run-c", &workspace.0);
        fs::write(
            runtime.0.join("runs/cli/run-c/receipt.json"),
            vec![b'x'; 4096],
        )
        .expect("write oversized receipt");

        let receipts = receipts_for_workspace_bounded(&runtime.0, &workspace.0, 1, 2048);

        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].1.id, "run-b");
    }

    /// The silent-wrong-answer bug: a run in workspace A must never answer a
    /// lookup made from workspace B.
    #[test]
    fn find_receipt_is_scoped_to_the_workspace() {
        let runtime = TempDir::new("scope-runtime");
        let workspace_a = TempDir::new("scope-a");
        let workspace_b = TempDir::new("scope-b");
        record_run(&runtime.0, "run-a", &workspace_a.0);

        let found = find_receipt(&runtime.0, None, &workspace_a.0).expect("A resolves its own run");
        assert!(found.ends_with("run-a/receipt.json"));

        let error = find_receipt(&runtime.0, None, &workspace_b.0)
            .expect_err("B has no runs and must not inherit A's");
        assert!(error.contains(&workspace_b.0.display().to_string()));
        assert!(
            error.contains("run-a"),
            "error should offer the id: {error}"
        );
    }

    /// An explicit id still resolves from anywhere.
    #[test]
    fn find_receipt_by_id_crosses_workspaces() {
        let runtime = TempDir::new("byid-runtime");
        let workspace_a = TempDir::new("byid-a");
        let workspace_b = TempDir::new("byid-b");
        record_run(&runtime.0, "run-a", &workspace_a.0);

        let found = find_receipt(&runtime.0, Some("run-a"), &workspace_b.0)
            .expect("explicit ids are not workspace-bound");
        assert!(found.ends_with("run-a/receipt.json"));
    }

    /// A run that ends without finalizing still leaves a receipt behind.
    #[test]
    fn drop_guard_finalizes_an_abandoned_run() {
        let runtime = TempDir::new("guard-runtime");
        let workspace = TempDir::new("guard-ws");
        let dir = runtime.0.join("runs").join("cli").join("run-x");
        fs::create_dir_all(&dir).expect("create run dir");

        {
            let mut draft = sample("run-x", &workspace.0);
            draft.status = Outcome::Running.status().into();
            draft.outcome = Outcome::Running.label().into();
            let mut guard = RunGuard::start(&runtime.0, &dir, "run-x", draft).expect("start guard");
            guard.record_error(Outcome::ProviderError, "Ollama returned HTTP 500");
        }

        let raw = fs::read_to_string(dir.join("receipt.json")).expect("receipt exists after drop");
        let receipt: Receipt = serde_json::from_str(&raw).expect("parse receipt");
        assert_eq!(receipt.outcome, "provider-error");
        assert_eq!(receipt.exit_code, 1);
        assert_eq!(receipt.status, "incomplete");
        assert!(receipt.summary.contains("HTTP 500"));
    }

    #[test]
    fn terminal_checkpoint_is_visible_before_guard_drop() {
        let runtime = TempDir::new("checkpoint-runtime");
        let workspace = TempDir::new("checkpoint-ws");
        let dir = runtime.0.join("runs").join("cli").join("run-checkpoint");
        fs::create_dir_all(&dir).expect("create run dir");
        let mut draft = sample("run-checkpoint", &workspace.0);
        draft.status = Outcome::Running.status().into();
        draft.outcome = Outcome::Running.label().into();
        let mut guard =
            RunGuard::start(&runtime.0, &dir, "run-checkpoint", draft).expect("start guard");

        guard
            .checkpoint_error(Outcome::LoopAbort, "repeated HTTP 403", 4)
            .expect("checkpoint terminal state");

        let raw = fs::read_to_string(dir.join("receipt.json")).expect("checkpoint receipt exists");
        let receipt: Receipt = serde_json::from_str(&raw).expect("parse receipt");
        assert_eq!(receipt.outcome, "loop-abort");
        assert_eq!(receipt.exit_code, 6);
        assert_eq!(receipt.steps, 4);
        assert!(receipt.finished_at_unix_ms > 0);
    }

    /// An unfinalized guard with no recorded error still writes something.
    #[test]
    fn drop_guard_marks_an_unexplained_exit_aborted() {
        let runtime = TempDir::new("abort-runtime");
        let workspace = TempDir::new("abort-ws");
        let dir = runtime.0.join("runs").join("cli").join("run-y");
        fs::create_dir_all(&dir).expect("create run dir");
        {
            let mut draft = sample("run-y", &workspace.0);
            draft.status = Outcome::Running.status().into();
            draft.outcome = Outcome::Running.label().into();
            let _guard = RunGuard::start(&runtime.0, &dir, "run-y", draft).expect("start guard");
        }
        let raw = fs::read_to_string(dir.join("receipt.json")).expect("receipt exists");
        let receipt: Receipt = serde_json::from_str(&raw).expect("parse receipt");
        assert_eq!(receipt.outcome, "aborted");
    }

    /// Declaring a check the model also runs must not record or run it twice.
    #[test]
    fn verification_dedup_keeps_one_passing_record() {
        let mut records = Vec::new();
        let check = |ok: bool| VerificationRecord {
            command: "cargo test".into(),
            ok,
            output: "out".into(),
        };
        assert!(record_verification(&mut records, check(true)));
        assert!(!record_verification(&mut records, check(true)));
        assert_eq!(records.len(), 1);
        // A failure is still recorded, since a retry after a fix is real news.
        let mut failing = vec![check(false)];
        assert!(record_verification(&mut failing, check(false)));
        assert_eq!(failing.len(), 1);
    }

    #[test]
    fn store_ids_do_not_collide_within_one_clock_tick() {
        let now = crate::clock::unix_ms();
        let ids = (0..1000)
            .map(|_| new_store_id(now))
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), 1000);
        assert!(ids.iter().all(|id| id.starts_with(&format!("{now:x}-"))));
    }

    #[test]
    fn finalize_failure_recovers_terminal_evidence_instead_of_leaving_a_draft() {
        let runtime = TempDir::new("finalize-failure");
        let workspace = TempDir::new("finalize-failure-workspace");
        let run = RunStore::create(&runtime.0).unwrap();
        let mut draft = sample(&run.id, &workspace.0);
        draft.outcome = Outcome::Running.label().into();
        let guard = RunGuard::start(&runtime.0, &run.dir, &run.id, draft).unwrap();
        let latest = runtime.0.join("runs/cli/latest");
        fs::remove_file(&latest).unwrap();
        fs::create_dir(&latest).unwrap();
        let mut completed = sample(&run.id, &workspace.0);
        completed.steps = 7;
        completed.artifacts = vec!["report.md".into()];
        assert!(guard.finalize(&completed).is_err());
        let recovered: Receipt =
            serde_json::from_slice(&fs::read(run.dir.join("receipt.json")).unwrap()).unwrap();
        assert_eq!(recovered.outcome, "infra-error");
        assert_eq!(recovered.steps, 7);
        assert_eq!(recovered.artifacts, vec!["report.md"]);
        assert!(recovered.summary.contains("Receipt persistence failed"));
        assert!(!recovered.completion.unwrap().satisfied);
    }

    #[test]
    fn retry_results_replace_stale_evidence_without_hiding_a_regression() {
        let mut records = Vec::new();
        for ok in [false, true, false] {
            assert!(record_verification(
                &mut records,
                VerificationRecord {
                    command: "cargo test".into(),
                    ok,
                    output: format!("result {ok}"),
                }
            ));
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].ok, ok);
        }
    }

    #[test]
    fn concurrent_receipt_readers_never_observe_partial_json() {
        let runtime = TempDir::new("atomic-reader");
        let workspace = TempDir::new("atomic-reader-workspace");
        let run = RunStore::create(&runtime.0).unwrap();
        let receipt = sample(&run.id, &workspace.0);
        run.finish(&runtime.0, &receipt).unwrap();
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let reader = scope.spawn(|| {
                barrier.wait();
                for _ in 0..300 {
                    let bytes = fs::read(run.dir.join("receipt.json")).unwrap();
                    let observed: Receipt = serde_json::from_slice(&bytes)
                        .expect("complete receipt during replacement");
                    assert_eq!(observed.id, run.id);
                }
            });
            barrier.wait();
            let mut updated = receipt;
            for index in 0..30 {
                updated.summary = format!("{index}: {}", "evidence ".repeat(1000));
                run.finish(&runtime.0, &updated).unwrap();
            }
            reader.join().unwrap();
        });
    }

    #[test]
    fn outcomes_map_to_distinguishable_exit_codes() {
        assert_eq!(Outcome::Completed.exit_code(), 0);
        assert_eq!(Outcome::VerifyFailed.exit_code(), 3);
        assert_eq!(Outcome::StepCeiling.exit_code(), 4);
        assert_eq!(Outcome::Deadline.exit_code(), 5);
        assert_eq!(Outcome::LoopAbort.exit_code(), 6);
        assert_eq!(Outcome::Interrupted.exit_code(), 7);
        // The coarse status stays limited to the three published values.
        for outcome in [
            Outcome::Completed,
            Outcome::VerifyFailed,
            Outcome::LoopAbort,
            Outcome::Interrupted,
            Outcome::Aborted,
        ] {
            assert!(matches!(
                outcome.status(),
                "completed" | "interrupted" | "incomplete"
            ));
        }
    }

    #[test]
    fn classifies_provider_and_loop_failures() {
        assert_eq!(
            classify_error("Ollama returned HTTP 500"),
            Outcome::ProviderError
        );
        assert_eq!(
            classify_error("MODEL LOOP DETECTED — repeated block"),
            Outcome::LoopAbort
        );
        assert_eq!(classify_error("goal cannot be empty"), Outcome::InfraError);
        assert_eq!(
            classify_error("model provider returned HTTP 500"),
            Outcome::ProviderError
        );
        assert_eq!(
            classify_error("Ox Alpha website returned HTTP 428"),
            Outcome::ProviderError
        );
    }

    #[test]
    fn redacts_secret_bearing_lines() {
        let value = redact_text("normal\nAPI_KEY=abc123\nalso normal");
        assert_eq!(value, "normal\n[redacted]\nalso normal");
    }
}
