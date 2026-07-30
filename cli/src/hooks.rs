use crate::receipt::{redact_text, HookRecord};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    env, fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const CONFIG_LIMIT_BYTES: u64 = 64 * 1024;
const OUTPUT_LIMIT_BYTES: usize = 8 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 3_000;
const MAX_TIMEOUT_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookEvent {
    SessionStart,
    UserPrompt,
    PreTool,
    PostTool,
    Stop,
}

impl HookEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionStart => "session_start",
            Self::UserPrompt => "user_prompt",
            Self::PreTool => "pre_tool",
            Self::PostTool => "post_tool",
            Self::Stop => "stop",
        }
    }

    fn can_block(self) -> bool {
        matches!(self, Self::UserPrompt | Self::PreTool)
    }

    fn may_mutate(self) -> bool {
        matches!(self, Self::SessionStart | Self::PostTool)
    }
}

#[derive(Debug, Default)]
pub struct HookBatch {
    pub records: Vec<HookRecord>,
    pub block_reason: Option<String>,
}

impl HookBatch {
    pub fn mutated_workspace(&self) -> bool {
        self.records
            .iter()
            .any(|record| record.status == "passed" && record.mutates_workspace)
    }

    pub fn model_feedback(&self) -> String {
        self.records
            .iter()
            .filter(|record| matches!(record.status.as_str(), "blocked" | "failed" | "timed_out"))
            .map(|record| {
                let detail = if record.output.trim().is_empty() {
                    "no diagnostic output".to_string()
                } else {
                    record.output.trim().to_string()
                };
                format!(
                    "HOOK {} [{}]: {}",
                    record.name,
                    record.status.to_ascii_uppercase(),
                    detail
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[derive(Debug)]
pub struct HookRunner {
    config_path: PathBuf,
    workspace: PathBuf,
    hook_home: PathBuf,
    allowed: bool,
    config: HookFile,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct HookFile {
    schema_version: u8,
    enabled: bool,
    hooks: HookGroups,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct HookGroups {
    session_start: Vec<HookSpec>,
    user_prompt: Vec<HookSpec>,
    pre_tool: Vec<HookSpec>,
    post_tool: Vec<HookSpec>,
    stop: Vec<HookSpec>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HookSpec {
    command: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    matcher: Option<String>,
    #[serde(default)]
    approved: bool,
    #[serde(default = "default_timeout")]
    timeout_ms: u64,
    #[serde(default)]
    mutates_workspace: bool,
}

#[derive(Debug, Deserialize)]
struct HookDecision {
    #[serde(default)]
    decision: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_MS
}

impl HookRunner {
    pub fn load(runtime: &Path, workspace: &Path, allowed: bool) -> Result<Self, String> {
        let workspace = workspace
            .canonicalize()
            .map_err(|error| format!("cannot resolve hook workspace: {error}"))?;
        let config_path = runtime.join("config/hooks.json");
        let hook_home = runtime.join("hook-home");
        let config = if !allowed || !config_path.exists() {
            HookFile::default()
        } else {
            let metadata = fs::symlink_metadata(&config_path).map_err(|error| {
                format!(
                    "cannot inspect hook config {}: {error}",
                    config_path.display()
                )
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!(
                    "hook config must be a regular non-symlink file: {}",
                    config_path.display()
                ));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                if metadata.uid() != unsafe { libc::geteuid() } {
                    return Err(format!(
                        "hook config must be owned by the current operator: {}",
                        config_path.display()
                    ));
                }
                if metadata.permissions().mode() & 0o022 != 0 {
                    return Err(format!(
                        "hook config cannot be group- or world-writable: {}",
                        config_path.display()
                    ));
                }
            }
            if metadata.len() > CONFIG_LIMIT_BYTES {
                return Err(format!(
                    "hook config exceeds {} KiB: {}",
                    CONFIG_LIMIT_BYTES / 1024,
                    config_path.display()
                ));
            }
            let bytes = fs::read(&config_path).map_err(|error| {
                format!("cannot read hook config {}: {error}", config_path.display())
            })?;
            let config: HookFile = serde_json::from_slice(&bytes).map_err(|error| {
                format!("invalid hook config {}: {error}", config_path.display())
            })?;
            if config.schema_version != 1 {
                return Err(format!(
                    "unsupported hook schema {}; expected 1 in {}",
                    config.schema_version,
                    config_path.display()
                ));
            }
            validate_config(&config)?;
            config
        };
        Ok(Self {
            config_path,
            workspace,
            hook_home,
            allowed,
            config,
        })
    }

    pub fn summary(&self) -> String {
        if !self.allowed {
            return "Hooks are disabled by this session boundary.".into();
        }
        if !self.config_path.exists() {
            return format!(
                "No hooks configured.\nConfig: {}",
                self.config_path.display()
            );
        }
        if !self.config.enabled {
            return format!(
                "Hooks are configured but disabled.\nConfig: {}",
                self.config_path.display()
            );
        }
        let specs = self.all_specs().collect::<Vec<_>>();
        let approved = specs.iter().filter(|spec| spec.approved).count();
        let mut summary = format!(
            "{} hook(s) configured · {} approved · {} awaiting approval\nConfig: {}",
            specs.len(),
            approved,
            specs.len().saturating_sub(approved),
            self.config_path.display()
        );
        for (event, event_specs) in [
            (HookEvent::SessionStart, &self.config.hooks.session_start),
            (HookEvent::UserPrompt, &self.config.hooks.user_prompt),
            (HookEvent::PreTool, &self.config.hooks.pre_tool),
            (HookEvent::PostTool, &self.config.hooks.post_tool),
            (HookEvent::Stop, &self.config.hooks.stop),
        ] {
            for spec in event_specs {
                let name = spec.name.as_deref().unwrap_or(&spec.command);
                summary.push_str(&format!(
                    "\n{}  {:<13} {}{}",
                    if spec.approved {
                        "approved"
                    } else {
                        "pending "
                    },
                    event.as_str(),
                    name,
                    spec.matcher
                        .as_deref()
                        .map(|matcher| format!(" · {matcher}"))
                        .unwrap_or_default()
                ));
            }
        }
        summary
    }

    pub fn fire(
        &self,
        event: HookEvent,
        matcher: Option<&str>,
        session_id: &str,
        data: Value,
    ) -> HookBatch {
        if !self.allowed || !self.config.enabled {
            return HookBatch::default();
        }
        let input = json!({
            "schemaVersion": 1,
            "event": event.as_str(),
            "sessionId": session_id,
            "cwd": self.workspace,
            "data": data
        });
        let mut batch = HookBatch::default();
        let mut seen = HashSet::new();
        for spec in self.specs(event) {
            if !matcher_matches(spec.matcher.as_deref(), matcher) {
                continue;
            }
            let key = format!("{}\0{}", spec.command, spec.args.join("\0"));
            if !seen.insert(key) {
                continue;
            }
            let name = spec.name.clone().unwrap_or_else(|| spec.command.clone());
            if !spec.approved {
                batch.records.push(HookRecord {
                    event: event.as_str().into(),
                    name,
                    command: spec.command.clone(),
                    status: "skipped".into(),
                    exit_code: None,
                    duration_ms: 0,
                    output: "approval required in the operator-local hook config".into(),
                    mutates_workspace: spec.mutates_workspace,
                });
                continue;
            }
            let record = self.run_one(event, spec, &name, session_id, &input);
            if record.status == "blocked" && batch.block_reason.is_none() {
                batch.block_reason = Some(if record.output.trim().is_empty() {
                    format!("Hook {name} blocked this {}", event.as_str())
                } else {
                    format!("Hook {name} blocked this action: {}", record.output.trim())
                });
            }
            batch.records.push(record);
        }
        batch
    }

    fn specs(&self, event: HookEvent) -> &[HookSpec] {
        match event {
            HookEvent::SessionStart => &self.config.hooks.session_start,
            HookEvent::UserPrompt => &self.config.hooks.user_prompt,
            HookEvent::PreTool => &self.config.hooks.pre_tool,
            HookEvent::PostTool => &self.config.hooks.post_tool,
            HookEvent::Stop => &self.config.hooks.stop,
        }
    }

    fn all_specs(&self) -> impl Iterator<Item = &HookSpec> {
        [
            self.config.hooks.session_start.as_slice(),
            self.config.hooks.user_prompt.as_slice(),
            self.config.hooks.pre_tool.as_slice(),
            self.config.hooks.post_tool.as_slice(),
            self.config.hooks.stop.as_slice(),
        ]
        .into_iter()
        .flatten()
    }

    fn run_one(
        &self,
        event: HookEvent,
        spec: &HookSpec,
        name: &str,
        session_id: &str,
        input: &Value,
    ) -> HookRecord {
        let started = Instant::now();
        let executable = match resolve_executable(&self.workspace, &spec.command) {
            Ok(executable) => executable,
            Err(error) => {
                return hook_failure_record(event, spec, name, started, "failed", None, error)
            }
        };
        if let Err(error) = fs::create_dir_all(&self.hook_home) {
            return hook_failure_record(
                event,
                spec,
                name,
                started,
                "failed",
                None,
                format!("cannot create isolated hook HOME: {error}"),
            );
        }
        let mut command = Command::new(&executable);
        command
            .args(&spec.args)
            .current_dir(&self.workspace)
            .env_clear()
            .env(
                "PATH",
                env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
            )
            .env("HOME", &self.hook_home)
            .env("HII_WORKSPACE", &self.workspace)
            .env("HII_HOOK_EVENT", event.as_str())
            .env("HII_SESSION_ID", session_id)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        for key in ["LANG", "LC_ALL", "TERM", "TMPDIR"] {
            if let Some(value) = env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return hook_failure_record(
                    event,
                    spec,
                    name,
                    started,
                    "failed",
                    None,
                    format!("cannot start hook: {error}"),
                )
            }
        };
        if let Some(mut stdin) = child.stdin.take() {
            if serde_json::to_writer(&mut stdin, input).is_err() || stdin.write_all(b"\n").is_err()
            {
                terminate_child_tree(&mut child);
                let _ = child.wait();
                return hook_failure_record(
                    event,
                    spec,
                    name,
                    started,
                    "failed",
                    None,
                    "could not send hook event JSON".into(),
                );
            }
        }
        let stdout = child.stdout.take().map(capture_output);
        let stderr = child.stderr.take().map(capture_output);
        let timeout = Duration::from_millis(spec.timeout_ms);
        let (status, timed_out) = loop {
            match child.try_wait() {
                Ok(Some(status)) => break (Some(status), false),
                Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(10)),
                Ok(None) => {
                    terminate_child_tree(&mut child);
                    break (child.wait().ok(), true);
                }
                Err(_) => {
                    terminate_child_tree(&mut child);
                    break (child.wait().ok(), false);
                }
            }
        };
        // A hook is a bounded action, not a daemon launcher. Stop any
        // descendants that kept inherited pipes open after the main process
        // exited so output collection cannot hang the HII session.
        terminate_child_tree(&mut child);
        let stdout = stdout
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default();
        let stderr = stderr
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default();
        let output = combined_output(&stdout, &stderr);
        let exit_code = status.and_then(|status| status.code());
        let structured_deny = exit_code == Some(0)
            && serde_json::from_str::<HookDecision>(stdout.trim())
                .ok()
                .is_some_and(|decision| {
                    decision
                        .decision
                        .as_deref()
                        .is_some_and(|value| value.eq_ignore_ascii_case("deny"))
                });
        let structured_reason = serde_json::from_str::<HookDecision>(stdout.trim())
            .ok()
            .and_then(|decision| decision.reason)
            .unwrap_or_default();
        let should_block = event.can_block()
            && (timed_out || exit_code == Some(2) || structured_deny || exit_code.is_none());
        let state = if should_block {
            "blocked"
        } else if timed_out {
            "timed_out"
        } else if exit_code == Some(0) {
            "passed"
        } else {
            "failed"
        };
        let output = if structured_deny && !structured_reason.trim().is_empty() {
            structured_reason
        } else if timed_out && output.trim().is_empty() {
            format!("hook exceeded its {} ms timeout", spec.timeout_ms)
        } else {
            output
        };
        HookRecord {
            event: event.as_str().into(),
            name: name.into(),
            command: spec.command.clone(),
            status: state.into(),
            exit_code,
            duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            output: redact_text(&output),
            mutates_workspace: spec.mutates_workspace,
        }
    }
}

fn terminate_child_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        let process_group = -(child.id() as i32);
        // SAFETY: this child was placed in its own process group immediately
        // before spawn, so a negative PID targets only that owned group.
        unsafe {
            libc::kill(process_group, libc::SIGKILL);
        }
    }
    let _ = child.kill();
}

fn validate_config(config: &HookFile) -> Result<(), String> {
    for (event, specs) in [
        (HookEvent::SessionStart, &config.hooks.session_start),
        (HookEvent::UserPrompt, &config.hooks.user_prompt),
        (HookEvent::PreTool, &config.hooks.pre_tool),
        (HookEvent::PostTool, &config.hooks.post_tool),
        (HookEvent::Stop, &config.hooks.stop),
    ] {
        for spec in specs {
            if spec.command.trim().is_empty() || spec.command.len() > 512 {
                return Err(format!(
                    "{} hook command is empty or too long",
                    event.as_str()
                ));
            }
            if spec.args.len() > 32
                || spec
                    .args
                    .iter()
                    .any(|arg| arg.len() > 2_048 || arg.contains('\0'))
            {
                return Err(format!("{} hook args exceed safe limits", event.as_str()));
            }
            if !(1..=MAX_TIMEOUT_MS).contains(&spec.timeout_ms) {
                return Err(format!(
                    "{} hook timeout must be between 1 and {MAX_TIMEOUT_MS} ms",
                    event.as_str()
                ));
            }
            if spec.mutates_workspace && !event.may_mutate() {
                return Err(format!(
                    "{} hooks cannot declare mutatesWorkspace",
                    event.as_str()
                ));
            }
            if spec
                .name
                .as_deref()
                .is_some_and(|name| name.trim().is_empty() || name.len() > 80)
            {
                return Err(format!("{} hook name is invalid", event.as_str()));
            }
        }
    }
    Ok(())
}

fn matcher_matches(configured: Option<&str>, actual: Option<&str>) -> bool {
    let Some(configured) = configured.map(str::trim) else {
        return true;
    };
    if configured.is_empty() || configured == "*" {
        return true;
    }
    actual.is_some_and(|actual| {
        configured
            .split('|')
            .map(str::trim)
            .any(|candidate| candidate == actual)
    })
}

fn resolve_executable(workspace: &Path, requested: &str) -> Result<PathBuf, String> {
    let requested = Path::new(requested);
    if requested.is_absolute() {
        return Err("hook executable must be a workspace-relative path".into());
    }
    let mut relative = PathBuf::new();
    for component in requested.components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("hook executable must stay inside the workspace".into())
            }
        }
    }
    if relative.as_os_str().is_empty() {
        return Err("hook executable path is empty".into());
    }
    let candidate = workspace.join(relative);
    let metadata = fs::symlink_metadata(&candidate).map_err(|error| {
        format!(
            "hook executable {} is unavailable: {error}",
            candidate.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "hook executable must be a regular non-symlink file: {}",
            candidate.display()
        ));
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("cannot resolve hook executable: {error}"))?;
    if !canonical.starts_with(workspace) {
        return Err("hook executable resolves outside the workspace".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(format!(
                "hook executable is not executable: {}",
                candidate.display()
            ));
        }
    }
    Ok(canonical)
}

fn capture_output<R: Read + Send + 'static>(mut reader: R) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut output = Vec::new();
        let mut buffer = [0u8; 4_096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let remaining = OUTPUT_LIMIT_BYTES.saturating_sub(output.len());
                    if remaining > 0 {
                        output.extend_from_slice(&buffer[..count.min(remaining)]);
                    }
                }
            }
        }
        String::from_utf8_lossy(&output).into_owned()
    })
}

fn combined_output(stdout: &str, stderr: &str) -> String {
    match (stdout.trim(), stderr.trim()) {
        ("", "") => String::new(),
        (stdout, "") => stdout.to_string(),
        ("", stderr) => stderr.to_string(),
        (stdout, stderr) => format!("{stdout}\n{stderr}"),
    }
}

fn hook_failure_record(
    event: HookEvent,
    spec: &HookSpec,
    name: &str,
    started: Instant,
    status: &str,
    exit_code: Option<i32>,
    output: String,
) -> HookRecord {
    let status = if event.can_block() { "blocked" } else { status };
    HookRecord {
        event: event.as_str().into(),
        name: name.into(),
        command: spec.command.clone(),
        status: status.into(),
        exit_code,
        duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        output: redact_text(&output),
        mutates_workspace: spec.mutates_workspace,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let serial = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let path = env::temp_dir().join(format!(
                "hii-hooks-{label}-{}-{nonce}-{serial}",
                process::id()
            ));
            fs::create_dir_all(&path).expect("create temp directory");
            Self(path.canonicalize().expect("canonicalize temp directory"))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn executable(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        fs::write(path, format!("#!/bin/sh\n{body}\n")).expect("write hook");
        let mut permissions = fs::metadata(path).expect("hook metadata").permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions).expect("make hook executable");
    }

    fn write_config(runtime: &Path, json: &str) {
        fs::create_dir_all(runtime.join("config")).expect("create config directory");
        fs::write(runtime.join("config/hooks.json"), json).expect("write config");
    }

    #[test]
    fn matchers_are_exact_or_pipe_separated() {
        assert!(matcher_matches(None, Some("write")));
        assert!(matcher_matches(Some("*"), Some("write")));
        assert!(matcher_matches(Some("write|edit"), Some("edit")));
        assert!(!matcher_matches(Some("write|edit"), Some("shell")));
    }

    #[test]
    fn public_boundary_ignores_even_enabled_hooks() {
        let runtime = TempDir::new("runtime");
        let workspace = TempDir::new("workspace");
        write_config(
            &runtime.0,
            r#"{"schemaVersion":1,"enabled":true,"hooks":{"preTool":[{"command":"hook.sh","approved":true}]}}"#,
        );
        let runner = HookRunner::load(&runtime.0, &workspace.0, false).expect("load disabled");
        assert!(runner
            .summary()
            .contains("disabled by this session boundary"));
        assert!(runner
            .fire(HookEvent::PreTool, Some("write"), "session", json!({}))
            .records
            .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn approved_pre_tool_hook_can_block_with_sanitized_environment() {
        let runtime = TempDir::new("runtime");
        let workspace = TempDir::new("workspace");
        executable(
            &workspace.0.join("block.sh"),
            r#"test -z "$API_KEY" || exit 1
test "$HOME" != "/Users/real" || exit 1
echo "protected path" >&2
exit 2"#,
        );
        write_config(
            &runtime.0,
            r#"{"schemaVersion":1,"enabled":true,"hooks":{"preTool":[{"name":"protect","command":"block.sh","matcher":"write|edit","approved":true,"timeoutMs":1000}]}}"#,
        );
        let runner = HookRunner::load(&runtime.0, &workspace.0, true).expect("load hooks");
        let batch = runner.fire(
            HookEvent::PreTool,
            Some("write"),
            "session",
            json!({"tool":"write"}),
        );
        assert_eq!(batch.records.len(), 1);
        assert_eq!(batch.records[0].status, "blocked");
        assert!(batch.records[0].output.contains("protected path"));
        assert!(batch.block_reason.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn structured_user_prompt_deny_blocks_with_a_model_facing_reason() {
        let runtime = TempDir::new("runtime");
        let workspace = TempDir::new("workspace");
        executable(
            &workspace.0.join("policy.sh"),
            r#"printf '%s\n' '{"decision":"deny","reason":"run the formatter first"}'"#,
        );
        write_config(
            &runtime.0,
            r#"{"schemaVersion":1,"enabled":true,"hooks":{"userPrompt":[{"name":"prompt-policy","command":"policy.sh","approved":true}]}}"#,
        );
        let runner = HookRunner::load(&runtime.0, &workspace.0, true).expect("load hooks");
        let batch = runner.fire(HookEvent::UserPrompt, None, "session", json!({}));
        assert_eq!(batch.records[0].status, "blocked");
        assert_eq!(batch.records[0].output, "run the formatter first");
        assert!(batch
            .block_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("run the formatter first")));
    }

    #[cfg(unix)]
    #[test]
    fn pre_tool_timeout_fails_closed() {
        let runtime = TempDir::new("runtime");
        let workspace = TempDir::new("workspace");
        executable(&workspace.0.join("slow.sh"), "sleep 1");
        write_config(
            &runtime.0,
            r#"{"schemaVersion":1,"enabled":true,"hooks":{"preTool":[{"name":"slow-policy","command":"slow.sh","approved":true,"timeoutMs":20}]}}"#,
        );
        let runner = HookRunner::load(&runtime.0, &workspace.0, true).expect("load hooks");
        let batch = runner.fire(HookEvent::PreTool, Some("shell"), "session", json!({}));
        assert_eq!(batch.records[0].status, "blocked");
        assert!(batch.records[0].output.contains("20 ms timeout"));
        assert!(batch.block_reason.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn approved_post_tool_mutation_invalidates_prior_proof() {
        let runtime = TempDir::new("runtime");
        let workspace = TempDir::new("workspace");
        executable(
            &workspace.0.join("format.sh"),
            "printf 'formatted\\n' > formatted.txt",
        );
        write_config(
            &runtime.0,
            r#"{"schemaVersion":1,"enabled":true,"hooks":{"postTool":[{"name":"formatter","command":"format.sh","matcher":"write","approved":true,"mutatesWorkspace":true}]}}"#,
        );
        let runner = HookRunner::load(&runtime.0, &workspace.0, true).expect("load hooks");
        let batch = runner.fire(HookEvent::PostTool, Some("write"), "session", json!({}));
        assert_eq!(batch.records[0].status, "passed");
        assert!(batch.mutated_workspace());
        assert_eq!(
            fs::read_to_string(workspace.0.join("formatted.txt")).expect("formatted output"),
            "formatted\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unapproved_hook_is_visible_but_never_executed() {
        let runtime = TempDir::new("runtime");
        let workspace = TempDir::new("workspace");
        executable(&workspace.0.join("touch.sh"), "touch should-not-exist.txt");
        write_config(
            &runtime.0,
            r#"{"schemaVersion":1,"enabled":true,"hooks":{"postTool":[{"command":"touch.sh"}]}}"#,
        );
        let runner = HookRunner::load(&runtime.0, &workspace.0, true).expect("load hooks");
        let batch = runner.fire(HookEvent::PostTool, Some("write"), "session", json!({}));
        assert_eq!(batch.records[0].status, "skipped");
        assert!(!workspace.0.join("should-not-exist.txt").exists());
    }

    #[test]
    fn invalid_mutating_policy_hook_is_rejected() {
        let runtime = TempDir::new("runtime");
        let workspace = TempDir::new("workspace");
        write_config(
            &runtime.0,
            r#"{"schemaVersion":1,"enabled":true,"hooks":{"preTool":[{"command":"hook.sh","mutatesWorkspace":true}]}}"#,
        );
        assert!(HookRunner::load(&runtime.0, &workspace.0, true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_or_writable_operator_config_is_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let runtime = TempDir::new("runtime");
        let workspace = TempDir::new("workspace");
        fs::create_dir_all(runtime.0.join("config")).expect("create config directory");
        let source = runtime.0.join("hooks-source.json");
        fs::write(&source, r#"{"schemaVersion":1,"enabled":false,"hooks":{}}"#)
            .expect("write source config");
        symlink(&source, runtime.0.join("config/hooks.json")).expect("symlink config");
        assert!(HookRunner::load(&runtime.0, &workspace.0, true)
            .expect_err("symlinked config must fail")
            .contains("non-symlink"));

        fs::remove_file(runtime.0.join("config/hooks.json")).expect("remove symlink");
        fs::copy(&source, runtime.0.join("config/hooks.json")).expect("copy config");
        let config = runtime.0.join("config/hooks.json");
        let mut permissions = fs::metadata(&config)
            .expect("config metadata")
            .permissions();
        permissions.set_mode(0o666);
        fs::set_permissions(&config, permissions).expect("make config writable");
        assert!(HookRunner::load(&runtime.0, &workspace.0, true)
            .expect_err("writable config must fail")
            .contains("world-writable"));
    }

    #[test]
    fn traversal_never_resolves_as_a_hook_executable() {
        let workspace = TempDir::new("workspace");
        assert!(resolve_executable(&workspace.0, "../outside.sh").is_err());
        assert!(resolve_executable(&workspace.0, "/bin/sh").is_err());
    }
}
