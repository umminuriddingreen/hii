//! Durable operational-session state layered beside the existing conversation
//! event log. Transcript text remains owned by `ConversationStore`.
use crate::contract::DeclaredEffect;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

const STATE_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionStatus {
    Prepared,
    Running,
    Completed,
    Failed,
    Interrupted,
    Uncertain,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationalAction {
    pub id: String,
    pub effect: DeclaredEffect,
    pub target: String,
    pub command: String,
    pub status: ActionStatus,
    pub pid: Option<u32>,
    #[serde(default)]
    pub process_start_identity: Option<String>,
    pub evidence_refs: Vec<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub objective_generation: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    version: u32,
    revision: u64,
    #[serde(default)]
    objective_generation: u64,
    conversation_id: String,
    workspace: String,
    original_objective: Option<String>,
    active_objective: Option<String>,
    paused: bool,
    finished: bool,
    actions: Vec<OperationalAction>,
    waiting_for_access: Option<String>,
    queued_steering: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecoveryKind {
    InspectBeforeRetry,
    RetryReadOnly,
    UncertainExternalWrite,
    RunningOwnedProcess,
    Completed,
}

#[derive(Clone, Debug)]
pub struct RecoveryItem {
    pub action_id: String,
    pub effect: DeclaredEffect,
    pub status: ActionStatus,
    pub kind: RecoveryKind,
    pub target: String,
    pub detail: String,
}

/// A workspace has one active terminal owner. The advisory lock is released by
/// the OS after a crash, avoiding PID-reuse and stale-lock deletion races.
pub struct OperationalSession {
    state_path: PathBuf,
    state: State,
    writer_lock: Arc<Mutex<()>>,
    _lease: File,
}

impl OperationalSession {
    /// Start a distinct conversation for explicit New Session actions.
    pub fn new_session(runtime: &Path, workspace: &Path) -> Result<Self, String> {
        let workspace = workspace
            .canonicalize()
            .map_err(|e| format!("resolve workspace: {e}"))?;
        let dir = runtime.join("conversations").join("cli");
        fs::create_dir_all(&dir).map_err(|e| format!("create conversation directory: {e}"))?;
        let id = format!("{}-{}", new_conversation_id(), uuid::Uuid::new_v4());
        let state_path = dir.join(format!("{id}.operational.json"));
        let lease_path = dir.join(format!("{id}.lease"));
        let lease = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(lease_path)
            .map_err(|e| format!("open operational session lease: {e}"))?;
        set_owner_private(&lease)?;
        lease
            .try_lock_exclusive()
            .map_err(|_| "could not claim new conversation session".to_string())?;
        let state = State {
            version: STATE_VERSION,
            revision: 0,
            objective_generation: 0,
            conversation_id: id,
            workspace: workspace.to_string_lossy().into_owned(),
            original_objective: None,
            active_objective: None,
            paused: false,
            finished: false,
            actions: Vec::new(),
            waiting_for_access: None,
            queued_steering: Vec::new(),
        };
        let mut session = Self {
            state_path,
            state,
            writer_lock: Arc::new(Mutex::new(())),
            _lease: lease,
        };
        session.persist()?;
        Ok(session)
    }

    pub fn load_or_create(runtime: &Path, workspace: &Path) -> Result<Self, String> {
        let workspace = workspace
            .canonicalize()
            .map_err(|e| format!("resolve workspace: {e}"))?;
        let key = hex_sha256(workspace.to_string_lossy().as_bytes());
        let dir = runtime.join("conversations").join("cli");
        fs::create_dir_all(&dir).map_err(|e| format!("create conversation directory: {e}"))?;
        let state_path = dir.join(format!("workspace-{key}.operational.json"));
        let lease_path = dir.join(format!("workspace-{key}.lease"));
        let lease = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(lease_path)
            .map_err(|e| format!("open operational session lease: {e}"))?;
        set_owner_private(&lease)?;
        lease
            .try_lock_exclusive()
            .map_err(|_| "this workspace already has an active HII terminal session".to_string())?;
        let state = if state_path.exists() {
            let bytes =
                fs::read(&state_path).map_err(|e| format!("read operational session: {e}"))?;
            let mut state: State = serde_json::from_slice(&bytes)
                .map_err(|e| format!("parse operational session: {e}"))?;
            if state.version != STATE_VERSION {
                return Err(format!(
                    "unsupported operational session version {}",
                    state.version
                ));
            }
            if state.workspace != workspace.to_string_lossy() {
                return Err("workspace identity mismatch in operational session".into());
            }
            // A write interrupted after dispatch is never replayed. A local or
            // read-only action remains an inspection/retry decision for HII.
            for action in &mut state.actions {
                if matches!(
                    action.status,
                    ActionStatus::Prepared | ActionStatus::Running
                ) && action.effect == DeclaredEffect::ExternalWrite
                {
                    action.status = ActionStatus::Uncertain;
                    action.error = Some("process ended after external write dispatch; reconcile remote state before retry".into());
                }
            }
            state.revision += 1;
            state
        } else {
            State {
                version: STATE_VERSION,
                revision: 0,
                objective_generation: 0,
                conversation_id: new_conversation_id(),
                workspace: workspace.to_string_lossy().into_owned(),
                original_objective: None,
                active_objective: None,
                paused: false,
                finished: false,
                actions: Vec::new(),
                waiting_for_access: None,
                queued_steering: Vec::new(),
            }
        };
        let mut session = Self {
            state_path,
            state,
            writer_lock: Arc::new(Mutex::new(())),
            _lease: lease,
        };
        session.persist()?;
        Ok(session)
    }

    pub fn conversation_id(&self) -> &str {
        &self.state.conversation_id
    }
    pub fn restored_objective(&self) -> Option<&str> {
        self.state.active_objective.as_deref()
    }
    pub fn original_objective(&self) -> Option<&str> {
        self.state.original_objective.as_deref()
    }
    pub fn queued_steering(&self) -> &[String] {
        &self.state.queued_steering
    }
    pub fn waiting_for_access(&self) -> Option<&str> {
        self.state.waiting_for_access.as_deref()
    }
    pub fn actions(&self) -> &[OperationalAction] {
        &self.state.actions
    }

    pub fn refresh_from_disk(&mut self) -> Result<(), String> {
        let _guard = self
            .writer_lock
            .lock()
            .map_err(|_| "operational writer lock poisoned")?;
        let bytes = fs::read(&self.state_path).map_err(|e| e.to_string())?;
        self.state = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn begin_objective(&mut self, objective: &str) -> Result<(), String> {
        let objective = nonempty(objective, "objective")?;
        if self.state.original_objective.is_none() || self.state.finished {
            self.state.objective_generation += 1;
            self.state.original_objective = Some(objective.clone());
        }
        self.state.active_objective = Some(objective);
        self.state.paused = false;
        self.state.finished = false;
        self.persist()
    }

    pub fn queue_input(&mut self, input: &str) -> Result<(), String> {
        let input = nonempty(input, "queued input")?;
        self.state.queued_steering.push(input);
        self.persist()
    }

    pub fn acknowledge_queued_input(&mut self, input: &str) -> Result<(), String> {
        if let Some(index) = self
            .state
            .queued_steering
            .iter()
            .position(|queued| queued == input.trim())
        {
            self.state.queued_steering.remove(index);
            self.persist()?;
        }
        Ok(())
    }

    pub fn acknowledge_applied_steering(&mut self, input: &str) -> Result<(), String> {
        // The composer combines successive messages with a newline. Remove
        // exactly that acknowledged prefix, preserving later queued input.
        let mut combined = String::new();
        for (index, queued) in self.state.queued_steering.iter().enumerate() {
            if index > 0 {
                combined.push('\n');
            }
            combined.push_str(queued);
            if combined == input.trim() {
                self.state.queued_steering.drain(..=index);
                return self.persist();
            }
        }
        self.acknowledge_queued_input(input)
    }

    pub fn has_queued_input(&self, input: &str) -> bool {
        self.state
            .queued_steering
            .iter()
            .any(|queued| queued == input.trim())
    }

    pub fn set_waiting_for_access(&mut self, request: Option<&str>) -> Result<(), String> {
        self.state.waiting_for_access = request
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        self.persist()
    }

    pub fn action_prepared(
        &mut self,
        id: &str,
        effect: DeclaredEffect,
        target: &str,
        command: &str,
    ) -> Result<(), String> {
        let id = nonempty(id, "action id")?;
        let target_key = if effect == DeclaredEffect::ExternalWrite {
            external_target_key(target, command)
        } else {
            target.to_string()
        };
        if effect == DeclaredEffect::ExternalWrite
            && self.state.actions.iter().any(|action| {
                action.effect == DeclaredEffect::ExternalWrite
                    && action.status == ActionStatus::Completed
                    && action.objective_generation == self.state.objective_generation
                    && external_target_key(&action.target, &action.command) == target_key
                    && action.command == command
            })
        {
            return Err("matching external action already completed for this objective; use its recorded evidence instead of replaying it".into());
        }
        if effect == DeclaredEffect::ExternalWrite
            && self.state.actions.iter().any(|action| {
                action.effect == DeclaredEffect::ExternalWrite
                    && action.status == ActionStatus::Uncertain
                    && external_target_key(&action.target, &action.command) == target_key
            })
        {
            return Err(
                "matching external action is uncertain; reconcile its outcome before any retry"
                    .into(),
            );
        }
        if self.state.actions.iter().any(|action| {
            matches!(
                action.status,
                ActionStatus::Prepared | ActionStatus::Running
            ) && ((effect == DeclaredEffect::LocalMutate
                && action.effect == DeclaredEffect::LocalMutate)
                || (effect == DeclaredEffect::ExternalWrite
                    && action.effect == DeclaredEffect::ExternalWrite
                    && external_target_key(&action.target, &action.command) == target_key)
                || (effect == DeclaredEffect::ReadOnly
                    && action.target == target_key
                    && action
                        .pid
                        .zip(action.process_start_identity.as_deref())
                        .is_some_and(|(pid, identity)| process_instance_alive(pid, identity))))
        }) {
            return Err(
                "matching action is still running or requires local-state inspection before retry"
                    .into(),
            );
        }
        if let Some(existing) = self.state.actions.iter().find(|action| action.id == id) {
            if existing.status == ActionStatus::Completed {
                return Err(format!(
                    "action '{id}' is already completed and cannot be rerun"
                ));
            }
            if existing.status == ActionStatus::Uncertain
                && existing.effect == DeclaredEffect::ExternalWrite
            {
                return Err(format!("external action '{id}' is uncertain and cannot be replayed before reconciliation"));
            }
            return Err(format!("action id '{id}' already exists"));
        }
        self.state.actions.push(OperationalAction {
            id,
            effect,
            target: target_key,
            command: command.into(),
            status: ActionStatus::Prepared,
            pid: None,
            process_start_identity: None,
            evidence_refs: vec![],
            error: None,
            objective_generation: self.state.objective_generation,
        });
        self.persist()
    }

    pub fn action_running(&mut self, id: &str, owned_pid: Option<u32>) -> Result<(), String> {
        let action = self.action_mut(id)?;
        if action.status != ActionStatus::Prepared {
            return Err(format!("action '{id}' is not prepared"));
        }
        action.status = ActionStatus::Running;
        action.pid = owned_pid;
        action.process_start_identity = owned_pid.and_then(process_start_identity);
        self.persist()
    }

    pub fn action_completed(&mut self, id: &str, evidence_refs: &[String]) -> Result<(), String> {
        let action = self.action_mut(id)?;
        if action.status == ActionStatus::Completed {
            return Ok(());
        }
        action.status = ActionStatus::Completed;
        action.evidence_refs = evidence_refs.to_vec();
        action.pid = None;
        action.process_start_identity = None;
        action.error = None;
        self.persist()
    }

    pub fn action_failed(&mut self, id: &str, error: &str) -> Result<(), String> {
        let action = self.action_mut(id)?;
        action.status = if error.starts_with("CANCELLED:") {
            ActionStatus::Interrupted
        } else {
            ActionStatus::Failed
        };
        action.error = Some(error.into());
        action.pid = None;
        action.process_start_identity = None;
        self.persist()
    }

    pub fn action_uncertain(&mut self, id: &str, reason: &str) -> Result<(), String> {
        let action = self.action_mut(id)?;
        action.status = ActionStatus::Uncertain;
        action.error = Some(reason.into());
        self.persist()
    }

    /// Record verified reconciliation of uncertain external or interrupted
    /// local work. `happened` closes it as completed; verified absence permits retry.
    pub fn action_reconciled(
        &mut self,
        id: &str,
        happened: bool,
        evidence_refs: &[String],
    ) -> Result<(), String> {
        if evidence_refs.is_empty()
            || evidence_refs
                .iter()
                .any(|reference| reference.trim().is_empty())
        {
            return Err(
                "reconciling an uncertain external action requires verified target evidence".into(),
            );
        }
        let action = self.action_mut(id)?;
        let can_reconcile = action.status == ActionStatus::Uncertain
            || (action.effect == DeclaredEffect::LocalMutate
                && matches!(
                    action.status,
                    ActionStatus::Prepared | ActionStatus::Running
                ));
        if !can_reconcile {
            return Err(format!("action '{id}' is not awaiting reconciliation"));
        }
        action.status = if happened {
            ActionStatus::Completed
        } else {
            ActionStatus::Failed
        };
        action.evidence_refs = evidence_refs.to_vec();
        action.error = None;
        action.pid = None;
        action.process_start_identity = None;
        self.persist()
    }

    /// Only actual successful file observations unlock local retries. External
    /// writes require their separate verified reconciliation path.
    pub fn record_local_inspection(&mut self, target: &str, evidence: &str) -> Result<(), String> {
        let workspace = Path::new(&self.state.workspace);
        let normalize = |value: &str| {
            let path = Path::new(value);
            let path = if path.is_absolute() {
                path.to_path_buf()
            } else {
                workspace.join(path)
            };
            path.canonicalize().unwrap_or(path)
        };
        let observed = normalize(target);
        let mut changed = false;
        for action in &mut self.state.actions {
            if action.effect == DeclaredEffect::LocalMutate
                && matches!(
                    action.status,
                    ActionStatus::Prepared | ActionStatus::Running | ActionStatus::Uncertain
                )
                && normalize(&action.target) == observed
                && !action
                    .pid
                    .zip(action.process_start_identity.as_deref())
                    .is_some_and(|(pid, identity)| process_instance_alive(pid, identity))
            {
                action.evidence_refs.push(format!("inspection:{evidence}"));
                action.status = ActionStatus::Interrupted;
                action.error = Some("Prior local action outcome inspected; retry may be planned from observed state".into());
                changed = true;
            }
        }
        if changed {
            self.persist()?;
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<(), String> {
        if self.state.actions.iter().any(|action| {
            action.status == ActionStatus::Uncertain
                && action.effect == DeclaredEffect::ExternalWrite
        }) {
            self.state.finished = false;
            self.state.paused = true;
        } else {
            self.state.finished = true;
            self.state.paused = false;
            self.state.active_objective = None;
            self.state.waiting_for_access = None;
        }
        self.persist()
    }
    pub fn pause(&mut self) -> Result<(), String> {
        self.state.paused = true;
        self.persist()
    }

    pub fn recovery_context(&self) -> Vec<RecoveryItem> {
        self.state.actions.iter().map(|action| {
            let kind = match action.status {
                ActionStatus::Completed => RecoveryKind::Completed,
                ActionStatus::Uncertain if action.effect == DeclaredEffect::ExternalWrite => RecoveryKind::UncertainExternalWrite,
                ActionStatus::Running if action.pid.zip(action.process_start_identity.as_deref()).is_some_and(|(pid, identity)| process_instance_alive(pid, identity)) => RecoveryKind::RunningOwnedProcess,
                ActionStatus::Prepared | ActionStatus::Running if action.effect == DeclaredEffect::ReadOnly => RecoveryKind::RetryReadOnly,
                ActionStatus::Prepared | ActionStatus::Running => RecoveryKind::InspectBeforeRetry,
                ActionStatus::Failed | ActionStatus::Interrupted => RecoveryKind::InspectBeforeRetry,
                ActionStatus::Uncertain => RecoveryKind::InspectBeforeRetry,
            };
            let detail = match kind {
                RecoveryKind::Completed => "completed; do not rerun".into(),
                RecoveryKind::RetryReadOnly => "interrupted read-only action may be retried".into(),
                RecoveryKind::UncertainExternalWrite => "external write may have happened; inspect/reconcile and never auto-replay".into(),
                RecoveryKind::RunningOwnedProcess => "recorded process belongs to this live terminal; inspect it, do not duplicate".into(),
                RecoveryKind::InspectBeforeRetry => "inspect local state/evidence before deciding whether to retry".into(),
            };
            RecoveryItem { action_id: action.id.clone(), effect: action.effect, status: action.status.clone(), kind, target: action.target.clone(), detail }
        }).collect()
    }

    pub fn next_resume(&self) -> Option<String> {
        if self.state.finished && self.state.queued_steering.is_empty() {
            return None;
        }
        if let Some(access) = &self.state.waiting_for_access {
            return Some(format!(
                "Resume by addressing the pending access request: {access}"
            ));
        }
        if let Some(item) = self
            .recovery_context()
            .into_iter()
            .find(|item| item.kind != RecoveryKind::Completed)
        {
            return Some(format!("Resume action {}: {}", item.action_id, item.detail));
        }
        if let Some(input) = self.state.queued_steering.first() {
            return Some(format!("Apply queued user steering: {input}"));
        }
        if let Some(objective) = &self.state.active_objective {
            return Some(format!("Continue active objective: {objective}"));
        }
        None
    }

    fn action_mut(&mut self, id: &str) -> Result<&mut OperationalAction, String> {
        self.state
            .actions
            .iter_mut()
            .find(|action| action.id == id)
            .ok_or_else(|| format!("unknown action id '{id}'"))
    }

    /// Cloneable callback for child-process Started events. It atomically patches
    /// the on-disk action while the foreground thread is blocked waiting on it.
    pub fn process_start_recorder(
        &self,
        action_id: &str,
    ) -> impl Fn(u32) -> Result<(), String> + Send + Sync + 'static {
        let path = self.state_path.clone();
        let action_id = action_id.to_string();
        let writer_lock = self.writer_lock.clone();
        move |pid| {
            let _guard = writer_lock
                .lock()
                .map_err(|_| "operational writer lock poisoned")?;
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            let mut state: State = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let action = state
                .actions
                .iter_mut()
                .find(|action| action.id == action_id)
                .ok_or_else(|| format!("unknown action id '{action_id}'"))?;
            if action.status != ActionStatus::Running {
                return Err(format!("action '{action_id}' is not running"));
            }
            action.pid = Some(pid);
            action.process_start_identity = process_start_identity(pid);
            state.revision += 1;
            write_state_file(&path, &state)
        }
    }

    pub fn queue_input_recorder(
        &self,
    ) -> impl Fn(&str) -> Result<(), String> + Send + Sync + 'static {
        let path = self.state_path.clone();
        let writer_lock = self.writer_lock.clone();
        move |input| {
            let input = nonempty(input, "queued input")?;
            let _guard = writer_lock
                .lock()
                .map_err(|_| "operational writer lock poisoned")?;
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            let mut state: State = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            state.queued_steering.push(input);
            state.revision += 1;
            write_state_file(&path, &state)
        }
    }

    fn persist(&mut self) -> Result<(), String> {
        self.state.revision += 1;
        let _guard = self
            .writer_lock
            .lock()
            .map_err(|_| "operational writer lock poisoned")?;
        write_state_file(&self.state_path, &self.state)
    }
}

fn nonempty(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{label} must not be empty"))
    } else {
        Ok(value.to_string())
    }
}
fn external_target_key(target: &str, command: &str) -> String {
    if target != command && !target.trim().is_empty() {
        return target.trim().to_ascii_lowercase();
    }
    let lower = command.trim().to_ascii_lowercase();
    if let Some(token) = lower
        .split_whitespace()
        .find(|part| part.starts_with("http://") || part.starts_with("https://"))
    {
        if let Ok(url) = url::Url::parse(token.trim_matches(['\'', '"', ';'])) {
            return format!("{}:{}", url.host_str().unwrap_or_default(), url.path());
        }
    }
    lower
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ")
}

fn write_state_file(path: &Path, state: &State) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("tmp-{}-{}", process::id(), unix_ms()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    set_owner_private(&file)?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    // Unix supports syncing a directory handle to persist the rename. Windows
    // does not expose this operation through `File::open`/`sync_all`; the file
    // itself is still synced before the atomic replacement on every platform.
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn new_conversation_id() -> String {
    format!("cli-{}-{}", unix_ms(), process::id())
}

fn process_start_identity(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // comm is parenthesized and may itself contain spaces; parse after its final close paren.
        let fields = stat
            .rsplit_once(") ")?
            .1
            .split_whitespace()
            .collect::<Vec<_>>();
        return fields
            .get(19)
            .map(|start_ticks| format!("linux:{start_ticks}"));
    }
    #[cfg(target_os = "macos")]
    {
        let output = process::Command::new("ps")
            .args(["-o", "lstart=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return (!value.is_empty()).then(|| format!("macos:{value}"));
    }
    #[cfg(target_os = "windows")]
    {
        let _ = pid;
        None
    }
}

fn process_instance_alive(pid: u32, identity: &str) -> bool {
    process_start_identity(pid).is_some_and(|current| current == identity)
}

#[cfg(unix)]
fn set_owner_private(file: &File) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("protect operational state: {e}"))
}

#[cfg(not(unix))]
fn set_owner_private(_file: &File) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(tmp: &tempfile::TempDir) -> PathBuf {
        let path = tmp.path().join("workspace");
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn local_retry_requires_actual_target_inspection() {
        let tmp = tempfile::tempdir().unwrap();
        let root = workspace(&tmp);
        fs::write(root.join("note.txt"), "partial").unwrap();
        let mut session = OperationalSession::load_or_create(tmp.path(), &root).unwrap();
        session
            .action_prepared("old", DeclaredEffect::LocalMutate, "note.txt", "write")
            .unwrap();
        session.action_running("old", None).unwrap();
        assert!(session
            .action_prepared(
                "before",
                DeclaredEffect::LocalMutate,
                root.join("note.txt").to_str().unwrap(),
                "write"
            )
            .is_err());
        session
            .record_local_inspection("note.txt", "verified-read-event")
            .unwrap();
        assert!(session
            .action_prepared("after", DeclaredEffect::LocalMutate, "note.txt", "write")
            .is_ok());
    }

    #[test]
    fn interrupted_external_dispatch_is_uncertain_and_never_replayed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = workspace(&tmp);
        let mut session = OperationalSession::load_or_create(tmp.path(), &root).unwrap();
        session
            .action_prepared(
                "deploy-1",
                DeclaredEffect::ExternalWrite,
                "production",
                "deploy",
            )
            .unwrap();
        session.action_running("deploy-1", None).unwrap();
        drop(session);
        let mut reopened = OperationalSession::load_or_create(tmp.path(), &root).unwrap();
        assert_eq!(
            reopened.recovery_context()[0].kind,
            RecoveryKind::UncertainExternalWrite
        );
        assert!(reopened
            .action_prepared(
                "deploy-1",
                DeclaredEffect::ExternalWrite,
                "production",
                "deploy"
            )
            .is_err());
        assert!(reopened
            .action_prepared(
                "deploy-2",
                DeclaredEffect::ExternalWrite,
                "production",
                "wrangler deploy --force"
            )
            .is_err());
    }

    #[test]
    fn completed_external_write_cannot_be_replayed_under_new_id_on_resume() {
        let tmp = tempfile::tempdir().unwrap();
        let root = workspace(&tmp);
        let mut session = OperationalSession::load_or_create(tmp.path(), &root).unwrap();
        session.begin_objective("create task").unwrap();
        session
            .action_prepared(
                "first",
                DeclaredEffect::ExternalWrite,
                "notion.create",
                "task one",
            )
            .unwrap();
        session.action_running("first", None).unwrap();
        session
            .action_completed("first", &["verified-write-result".into()])
            .unwrap();
        drop(session);
        let mut reopened = OperationalSession::load_or_create(tmp.path(), &root).unwrap();
        reopened.begin_objective("create task").unwrap();
        assert!(reopened
            .action_prepared(
                "retry-new-id",
                DeclaredEffect::ExternalWrite,
                "notion.create",
                "task one"
            )
            .is_err());
        assert!(reopened
            .action_prepared(
                "different-task",
                DeclaredEffect::ExternalWrite,
                "notion.create",
                "task two"
            )
            .is_ok());
        reopened
            .action_failed("different-task", "not dispatched")
            .unwrap();
        reopened.finish().unwrap();
        reopened.begin_objective("create task again").unwrap();
        assert!(reopened
            .action_prepared(
                "new-authorized-objective",
                DeclaredEffect::ExternalWrite,
                "notion.create",
                "task one"
            )
            .is_ok());
    }

    #[test]
    fn completed_action_survives_lost_response_and_cannot_run_again() {
        let tmp = tempfile::tempdir().unwrap();
        let root = workspace(&tmp);
        let mut session = OperationalSession::load_or_create(tmp.path(), &root).unwrap();
        session
            .action_prepared("a1", DeclaredEffect::LocalMutate, "file", "write")
            .unwrap();
        session.action_running("a1", None).unwrap();
        session
            .action_completed("a1", &["receipt://r1".into()])
            .unwrap();
        drop(session);
        let mut reopened = OperationalSession::load_or_create(tmp.path(), &root).unwrap();
        assert_eq!(reopened.actions()[0].status, ActionStatus::Completed);
        assert_eq!(reopened.actions()[0].evidence_refs, vec!["receipt://r1"]);
        assert!(reopened
            .action_prepared("a1", DeclaredEffect::LocalMutate, "file", "write")
            .is_err());
    }

    #[test]
    fn combined_steering_acknowledges_only_applied_messages() {
        let tmp = tempfile::tempdir().unwrap();
        let root = workspace(&tmp);
        let mut session = OperationalSession::load_or_create(tmp.path(), &root).unwrap();
        session.queue_input("first\nmultiline").unwrap();
        session.queue_input("second").unwrap();
        session.queue_input("later").unwrap();
        session
            .acknowledge_applied_steering("first\nmultiline\nsecond")
            .unwrap();
        drop(session);
        let reopened = OperationalSession::load_or_create(tmp.path(), &root).unwrap();
        assert_eq!(reopened.queued_steering(), &["later"]);
    }

    #[test]
    fn active_terminal_lease_and_queued_input_are_durable() {
        let tmp = tempfile::tempdir().unwrap();
        let root = workspace(&tmp);
        let mut session = OperationalSession::load_or_create(tmp.path(), &root).unwrap();
        assert!(OperationalSession::load_or_create(tmp.path(), &root).is_err());
        session.queue_input("keep going").unwrap();
        drop(session);
        let reopened = OperationalSession::load_or_create(tmp.path(), &root).unwrap();
        assert_eq!(reopened.queued_steering(), &["keep going"]);
    }
}
