use crate::completion::CompletionAssessment;
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
        // Bind the ambient run identity at the moment it exists, so model-call
        // traces and skill attribution can name the receipt they belong to
        // without threading the id through every call site.
        crate::run_context::set_run_id(&id);
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
    let content = serde_json::to_vec_pretty(receipt).map_err(|error| error.to_string())?;
    fs::write(&receipt_path, content).map_err(|error| error.to_string())?;
    // The global pointer stays: cli/scripts/local-model-eval.sh and
    // scripts/hii-activation-smoke.mjs both read it.
    let latest = runtime.join("runs").join("cli").join("latest");
    fs::write(&latest, format!("{id}\n")).map_err(|error| error.to_string())?;
    // The per-workspace pointer is what `hii proof` resolves against, so a run
    // in one workspace can no longer answer for another.
    if !receipt.workspace.is_empty() {
        let scoped = workspace_pointer_dir(runtime, Path::new(&receipt.workspace));
        fs::create_dir_all(&scoped).map_err(|error| error.to_string())?;
        fs::write(scoped.join("latest"), format!("{id}\n")).map_err(|error| error.to_string())?;
    }
    Ok(receipt_path)
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
        self.draft.finished_at_unix_ms = unix_ms();
        self.draft.summary = redact_text(message);
    }

    pub fn finalize(mut self, receipt: &Receipt) -> Result<PathBuf, String> {
        self.finalized = true;
        write_receipt(&self.dir, &self.runtime, &self.id, receipt)
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
            self.draft.finished_at_unix_ms = unix_ms();
        }
        // Best effort: a failure here must not mask the error being unwound.
        let _ = write_receipt(&self.dir, &self.runtime, &self.id, &self.draft);
    }
}

/// Append a verification record unless the same command already passed.
///
/// Records are cleared whenever a new mutation epoch begins, so equality within
/// the current vector is already epoch-scoped. Without this, declaring
/// `--verify "cargo test"` for a check the model also runs itself recorded the
/// result twice and executed the suite twice.
pub fn record_verification(
    records: &mut Vec<VerificationRecord>,
    record: VerificationRecord,
) -> bool {
    if records
        .iter()
        .any(|existing| existing.ok && existing.command == record.command)
    {
        return false;
    }
    records.push(record);
    true
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

/// Every receipt recorded for `workspace`, newest first.
pub fn receipts_for_workspace(runtime: &Path, workspace: &Path) -> Vec<(PathBuf, Receipt)> {
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
    paths
        .into_iter()
        .filter_map(|path| {
            let raw = fs::read_to_string(&path).ok()?;
            let receipt = serde_json::from_str::<Receipt>(&raw).ok()?;
            Some((path, receipt))
        })
        .filter(|(_, receipt)| {
            Path::new(&receipt.workspace)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(&receipt.workspace))
                == canonical
        })
        .collect()
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
            let pointer = workspace_pointer_dir(runtime, workspace).join("latest");
            let scoped = fs::read_to_string(pointer)
                .ok()
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
                .filter(|id| cli_runs.join(id).join("receipt.json").is_file());
            match scoped {
                Some(id) => id,
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
                unix_ms()
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
        }
    }

    fn record_run(runtime: &Path, id: &str, workspace: &Path) {
        let dir = runtime.join("runs").join("cli").join(id);
        fs::create_dir_all(&dir).expect("create run dir");
        write_receipt(&dir, runtime, id, &sample(id, workspace)).expect("write receipt");
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
        assert_eq!(failing.len(), 2);
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
    }

    #[test]
    fn redacts_secret_bearing_lines() {
        let value = redact_text("normal\nAPI_KEY=abc123\nalso normal");
        assert_eq!(value, "normal\n[redacted]\nalso normal");
    }
}
