use hii_core::{
    context_pack::{self, ContextApproveRequestV1, ContextCompileRequestV1, ContextPackV1},
    default_workspace_root,
    information::{self, CaptureResult, InformationImage, InformationSource, SearchResult},
    new_run_id, read_workspace,
    runtime::RuntimeSpaceApplyV1,
    runtime::RuntimeSpaceSnapshotV1,
    runtime_share_create, runtime_share_list, runtime_share_revoke, runtime_space_apply,
    runtime_space_history, runtime_space_snapshot, write_workspace, AgentActivityV1, AgentEventV1,
    AgentRequestV1, AgentStartResult, CONTRACT_VERSION,
};
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap},
    env, fs,
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

mod account_sync;
mod browser;
mod terminal;
mod ui_channel;

/// Name of the CLI executable staged into the bundle by `scripts/hii-tauri-build.mjs`.
#[cfg(windows)]
const CLI_BINARY_NAME: &str = "hii.exe";
#[cfg(not(windows))]
const CLI_BINARY_NAME: &str = "hii";

#[derive(Default)]
struct AgentProcesses(Mutex<HashMap<String, u32>>);

#[tauri::command]
fn workspace_read() -> Result<Value, String> {
    read_workspace()
}

#[tauri::command]
fn workspace_write(document: Value) -> Result<Value, String> {
    write_workspace(document)
}

#[tauri::command]
fn runtime_space_snapshot_v1(space_id: Option<String>) -> Result<RuntimeSpaceSnapshotV1, String> {
    runtime_space_snapshot(space_id)
}

#[tauri::command]
fn runtime_space_apply_v1(request: RuntimeSpaceApplyV1) -> Result<RuntimeSpaceSnapshotV1, String> {
    runtime_space_apply(request)
}

#[tauri::command]
fn runtime_space_history_v1(
    space_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<hii_core::runtime::RuntimeEventV1>, String> {
    runtime_space_history(space_id, limit)
}

#[tauri::command]
fn runtime_context_compile_v1(request: ContextCompileRequestV1) -> Result<ContextPackV1, String> {
    context_pack::compile(&hii_core::runtime_root()?, &request)
}

#[tauri::command]
fn runtime_context_get_v1(id: String) -> Result<ContextPackV1, String> {
    context_pack::get(&hii_core::runtime_root()?, &id)
}

#[tauri::command]
fn runtime_context_approve_v1(request: ContextApproveRequestV1) -> Result<ContextPackV1, String> {
    context_pack::approve(&hii_core::runtime_root()?, &request)
}

#[tauri::command]
fn runtime_share_create_v1(
    request: hii_core::runtime::RuntimeShareRequestV1,
) -> Result<hii_core::runtime::RuntimeShareBundleV1, String> {
    runtime_share_create(request)
}

#[tauri::command]
fn runtime_share_list_v1(
    space_id: Option<String>,
) -> Result<Vec<hii_core::runtime::RuntimeShareRecordV1>, String> {
    runtime_share_list(space_id)
}

#[tauri::command]
fn runtime_share_revoke_v1(
    request: hii_core::runtime::RuntimeShareRevokeRequestV1,
) -> Result<hii_core::runtime::RuntimeShareRecordV1, String> {
    runtime_share_revoke(request)
}

#[tauri::command]
fn information_capture(
    url: String,
    workspace_root: Option<String>,
) -> Result<CaptureResult, String> {
    let workspace = workspace_root
        .map(PathBuf::from)
        .unwrap_or(default_workspace_root()?);
    information::capture(&hii_core::runtime_root()?, &workspace, &url)
}

#[tauri::command]
fn information_find(
    query: String,
    web: bool,
    limit: Option<usize>,
) -> Result<Vec<SearchResult>, String> {
    let limit = limit.unwrap_or(10);
    if web {
        information::discover_web(&query, limit)
    } else {
        information::search(&hii_core::runtime_root()?, &query, limit)
    }
}

#[tauri::command]
fn information_inspect(id: String) -> Result<(InformationSource, Vec<InformationImage>), String> {
    information::inspect(&hii_core::runtime_root()?, &id)
}

fn safe_asset_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(['.', '_']);
    if cleaned.is_empty() {
        "asset".into()
    } else {
        cleaned.chars().take(160).collect()
    }
}

#[tauri::command]
fn workspace_asset_store(name: String, mime: String, bytes: Vec<u8>) -> Result<Value, String> {
    const MAX_ASSET_BYTES: usize = 250 * 1024 * 1024;
    if bytes.is_empty() || bytes.len() > MAX_ASSET_BYTES {
        return Err("HII accepts files between 1 byte and 250 MB.".into());
    }
    let directory = hii_core::runtime_root()?.join("workspace/assets");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let stored_name = format!("{}-{}", new_run_id(), safe_asset_name(&name));
    let path = directory.join(stored_name);
    fs::write(&path, &bytes).map_err(|error| format!("Could not store HII asset: {error}"))?;
    Ok(serde_json::json!({
        "name": name,
        "mime": mime,
        "size": bytes.len(),
        "path": path
    }))
}

/// Locate the `hii` CLI the packaged app drives.
///
/// The bundled copy inside `Contents/Resources` comes first: a downloaded
/// HII.app has to work on a machine that has never built this repository. The
/// developer-machine paths below it are a convenience for running `tauri dev`
/// against a local `cargo build`, not a distribution mechanism — when they were
/// the only candidates, the app launched fine for anyone and then failed at the
/// first agent run with "could not locate its Rust CLI".
pub(crate) fn hii_binary(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("HII_CLI_BIN") {
        return Ok(PathBuf::from(path));
    }
    let mut candidates = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join(CLI_BINARY_NAME));
        // Tauri nests declared resources under their staged directory name.
        candidates.push(resources.join("resources").join(CLI_BINARY_NAME));
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("bin").join(CLI_BINARY_NAME));
        candidates.push(home.join("hii/target/release").join(CLI_BINARY_NAME));
    }
    #[cfg(target_os = "macos")]
    candidates.push(PathBuf::from("/opt/homebrew/bin").join(CLI_BINARY_NAME));
    // The NSIS installer places HII per-user under %LOCALAPPDATA%\Programs\HII
    // and creates no npm global shim, so the resource dir above is the only
    // copy a Windows install has. This covers a developer who installed the app
    // and is running `tauri dev` beside it.
    #[cfg(target_os = "windows")]
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local)
                .join("Programs")
                .join("HII")
                .join(CLI_BINARY_NAME),
        );
    }
    // Last resort on any platform: whatever `hii` the user's PATH resolves to.
    // A machine that can run `hii` in a shell should not be told the app cannot
    // find it.
    if let Some(path) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&path).map(|dir| dir.join(CLI_BINARY_NAME)));
    }
    let current_executable = env::current_exe()
        .ok()
        .and_then(|path| path.canonicalize().ok());
    candidates.into_iter().find(|path| {
        if !path.is_file() {
            return false;
        }
        let candidate = path.canonicalize().ok();
        candidate.is_none() || candidate != current_executable
    }).ok_or_else(|| {
        "HII could not locate its Rust CLI. Reinstall HII, or set HII_CLI_BIN to a `hii` binary."
            .into()
    })
}

fn emit_agent(
    app: &tauri::AppHandle,
    run_id: &str,
    status: &str,
    kind: Option<&str>,
    text: Option<String>,
    receipt_path: Option<String>,
) {
    emit_agent_with_activity(app, run_id, status, kind, text, receipt_path, None);
}

fn emit_agent_with_activity(
    app: &tauri::AppHandle,
    run_id: &str,
    status: &str,
    kind: Option<&str>,
    text: Option<String>,
    receipt_path: Option<String>,
    activity: Option<AgentActivityV1>,
) {
    let _ = app.emit(
        "hii://agent-event",
        AgentEventV1 {
            version: CONTRACT_VERSION,
            run_id: run_id.into(),
            status: status.into(),
            kind: kind.map(str::to_owned),
            text,
            receipt_path,
            activity,
        },
    );
}

fn jsonl_agent_activity(value: &Value) -> Option<AgentActivityV1> {
    let event = value.get("event")?.as_str()?;
    let data = value.get("data")?;
    let name = data
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    match event {
        "tool.started" => Some(AgentActivityV1 {
            kind: "tool-request".into(),
            name,
            detail: data
                .get("target")
                .and_then(Value::as_str)
                .map(str::to_owned),
            ok: None,
        }),
        "tool.result" => Some(AgentActivityV1 {
            kind: "tool-observation".into(),
            name,
            detail: data.get("output").and_then(Value::as_str).map(|output| {
                let visible = output
                    .lines()
                    .find(|line| !line.trim().is_empty())
                    .unwrap_or("observation");
                visible.chars().take(160).collect()
            }),
            ok: data.get("ok").and_then(Value::as_bool),
        }),
        _ => None,
    }
}

fn jsonl_user_kind(value: &Value) -> Option<&'static str> {
    match value.get("event")?.as_str()? {
        "assistant.stream.delta" => Some("delta"),
        "run.finished" => Some("summary"),
        "run.blocked" | "run.interrupted" | "budget.exceeded" => Some("status"),
        "tool.started" | "tool.result" => Some("activity"),
        _ => None,
    }
}

fn jsonl_receipt_path(value: &Value) -> Option<String> {
    value
        .get("data")
        .and_then(|data| data.get("proof"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn visible_external_output(tool: &str, output: &str) -> String {
    let limit = if tool == "web_fetch" { 500 } else { 8_000 };
    if output.chars().count() <= limit {
        return output.to_owned();
    }
    format!(
        "{}\n…source context continues inside the agent",
        output.chars().take(limit).collect::<String>()
    )
}

fn jsonl_user_message(value: &Value) -> Option<String> {
    let event = value.get("event")?.as_str()?;
    let data = value.get("data").unwrap_or(&Value::Null);
    let string = |key: &str| data.get(key).and_then(Value::as_str);
    match event {
        "assistant.stream.delta" => string("content").map(str::to_owned),
        "tool.started" => {
            let tool = string("tool").unwrap_or("tool");
            let target = string("target").unwrap_or("working");
            Some(match tool {
                "web_search" => format!("Searching external context · {target}"),
                "web_fetch" => format!("Loading external source · {target}"),
                _ => format!("{tool} · {target}"),
            })
        }
        "tool.result"
            if data.get("ok").and_then(Value::as_bool) == Some(true)
                && matches!(string("tool"), Some("web_search" | "web_fetch")) =>
        {
            string("output")
                .filter(|text| !text.trim().is_empty())
                .map(|text| {
                    let tool = string("tool").unwrap_or("web_search");
                    format!(
                        "External context loaded\n{}",
                        visible_external_output(tool, text)
                    )
                })
        }
        "tool.result" if data.get("ok").and_then(Value::as_bool) == Some(false) => string("output")
            .filter(|text| !text.trim().is_empty())
            .map(|text| format!("Revising after tool error · {text}")),
        "run.blocked" | "run.interrupted" | "budget.exceeded" => string("message")
            .or_else(|| string("reason"))
            .map(str::to_owned),
        "run.finished" => string("summary").map(str::to_owned),
        _ => None,
    }
}

#[tauri::command]
fn agent_start(
    app: tauri::AppHandle,
    state: tauri::State<AgentProcesses>,
    request: AgentRequestV1,
) -> Result<AgentStartResult, String> {
    if request.version != CONTRACT_VERSION {
        return Err(format!(
            "Unsupported HII agent contract version {}.",
            request.version
        ));
    }
    let intent = request.intent.trim();
    if intent.is_empty() || intent.len() > 16_000 {
        return Err("HII needs an intent between 1 and 16000 characters.".into());
    }
    let root = request
        .workspace_root
        .map(PathBuf::from)
        .unwrap_or(default_workspace_root()?);
    if !root.is_dir() {
        return Err(format!("HII workspace does not exist: {}", root.display()));
    }
    let mode = request.mode.as_deref().unwrap_or("build");
    if !matches!(mode, "build" | "plan" | "browse" | "see" | "show") {
        return Err(format!("Unsupported HII canvas mode: {mode}"));
    }
    let read_only = matches!(mode, "plan" | "browse" | "see");
    let pack = context_pack::require_approved(
        &hii_core::runtime_root()?,
        &request.context_pack_id,
        &request.context_fingerprint,
    )?;
    if pack.workspace_root != root.display().to_string() {
        return Err("The approved ContextPack belongs to a different workspace.".into());
    }
    if pack.space_id != request.space_id.as_deref().unwrap_or("default") {
        return Err("The approved ContextPack belongs to a different Space.".into());
    }
    if pack.intent != intent || pack.mode != mode {
        return Err("The approved ContextPack does not match this intent or mode.".into());
    }
    let requested_ids = request
        .context_node_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let approved_ids = pack
        .items
        .iter()
        .filter(|item| item.selected)
        .map(|item| {
            item.context_ref
                .id
                .rsplit(':')
                .next()
                .unwrap_or(&item.context_ref.id)
                .to_string()
        })
        .collect::<BTreeSet<_>>();
    if requested_ids != approved_ids {
        return Err("The approved ContextPack does not match the selected canvas objects.".into());
    }
    let run_id = new_run_id();
    let goal = format!("{intent}\n\n{}", context_pack::render_for_model(&pack));
    let mut command = Command::new(hii_binary(&app)?);
    command
        .args(["run", "--cwd"])
        .arg(&root)
        .args(["--no-context", "--context-source"])
        .arg(format!("hii-context-pack:{}@{}", pack.id, pack.fingerprint))
        .args([
            "--jsonl",
            "--stream",
            "--autonomy",
            "local-full",
            "--authority",
        ])
        .arg(if read_only { "read-only" } else { "workspace" });
    // Do not declare an informational outcome here: declared outcomes require a
    // predeclared verification check. Read-only canvas research instead rests on
    // source-tool evidence, which remains incidental and cannot unlock high trust.
    command
        .arg(goal)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("HII could not start the agent: {error}"))?;
    let pid = child.id();
    state
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .insert(run_id.clone(), pid);
    emit_agent(
        &app,
        &run_id,
        "started",
        Some("status"),
        Some(format!("Working in {}", root.display())),
        None,
    );

    let receipt = Arc::new(Mutex::new(None::<String>));
    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        let run = run_id.clone();
        let receipt = receipt.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if let Some(path) = jsonl_receipt_path(&value) {
                        if let Ok(mut target) = receipt.lock() {
                            *target = Some(path);
                        }
                    }
                    if let Some(message) = jsonl_user_message(&value) {
                        emit_agent_with_activity(
                            &app,
                            &run,
                            "progress",
                            jsonl_user_kind(&value),
                            Some(message),
                            None,
                            jsonl_agent_activity(&value),
                        );
                    }
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        let run = run_id.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if serde_json::from_str::<Value>(&line).is_err() && !line.trim().is_empty() {
                    emit_agent(&app, &run, "progress", Some("status"), Some(line), None);
                }
            }
        });
    }
    let app_for_wait = app.clone();
    let run_for_wait = run_id.clone();
    thread::spawn(move || {
        let status = child.wait();
        if let Some(processes) = app_for_wait.try_state::<AgentProcesses>() {
            if let Ok(mut processes) = processes.0.lock() {
                processes.remove(&run_for_wait);
            }
        }
        let receipt_path = receipt.lock().ok().and_then(|value| value.clone());
        match status {
            Ok(value) if value.success() => emit_agent(
                &app_for_wait,
                &run_for_wait,
                "completed",
                Some("status"),
                Some("Agent work completed.".into()),
                receipt_path,
            ),
            Ok(value) => emit_agent(
                &app_for_wait,
                &run_for_wait,
                "failed",
                Some("status"),
                Some(format!(
                    "Agent stopped with exit {}.",
                    value.code().unwrap_or(1)
                )),
                receipt_path,
            ),
            Err(error) => emit_agent(
                &app_for_wait,
                &run_for_wait,
                "failed",
                Some("status"),
                Some(error.to_string()),
                receipt_path,
            ),
        }
    });
    Ok(AgentStartResult { run_id })
}

#[tauri::command]
fn agent_cancel(
    app: tauri::AppHandle,
    state: tauri::State<AgentProcesses>,
    run_id: String,
) -> Result<(), String> {
    let pid = state
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&run_id)
        .copied()
        .ok_or_else(|| "HII agent run is not active.".to_string())?;
    #[cfg(unix)]
    let status = Command::new("/bin/kill")
        .args(["-TERM", &pid.to_string()])
        .status();
    // /T takes the process tree, /F forces it. Without /F an agent that has
    // stopped servicing its message loop -- the usual reason a run needs
    // cancelling -- survives, and the run stays "active" forever.
    #[cfg(windows)]
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
    if status.is_ok_and(|value| value.success()) {
        emit_agent(
            &app,
            &run_id,
            "cancelled",
            Some("status"),
            Some("Agent run cancelled.".into()),
            None,
        );
        Ok(())
    } else {
        Err("HII could not cancel the agent run.".into())
    }
}

#[tauri::command]
fn notification_list(app: tauri::AppHandle) -> Result<Value, String> {
    let output = Command::new(hii_binary(&app)?)
        .args(["notify", "list", "--limit", "80", "--json"])
        .output()
        .map_err(|error| format!("HII could not read notifications: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

#[tauri::command]
fn notification_read(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let output = Command::new(hii_binary(&app)?)
        .args(["notify", "read", &id])
        .output()
        .map_err(|error| format!("HII could not update the notification: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn hii_json(app: &tauri::AppHandle, arguments: &[&str]) -> Result<Value, String> {
    let output = Command::new(hii_binary(app)?)
        .args(arguments)
        .output()
        .map_err(|error| format!("HII could not run its application registry: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

#[tauri::command]
fn applications_list(app: tauri::AppHandle) -> Result<Value, String> {
    hii_json(&app, &["apps", "list", "--json"])
}

#[tauri::command]
fn agent_home(app: tauri::AppHandle) -> Result<Value, String> {
    hii_json(&app, &["home", "--json"])
}

const ECOSYSTEM_CATALOG_MAX_BYTES: u64 = 256 * 1024;
const ECOSYSTEM_CATALOG_TIMEOUT: Duration = Duration::from_secs(5);

fn ecosystem_catalog_process_error() -> String {
    "HII could not read its ecosystem catalog (catalog_process_failed)".to_string()
}

fn spawn_catalog_reader<R: Read + Send + 'static>(
    is_stdout: bool,
    stream: R,
    sender: mpsc::Sender<(bool, Result<Vec<u8>, std::io::Error>)>,
) {
    thread::spawn(move || {
        let mut output = Vec::new();
        let result = stream
            .take(ECOSYSTEM_CATALOG_MAX_BYTES + 1)
            .read_to_end(&mut output)
            .map(|_| output);
        let _ = sender.send((is_stdout, result));
    });
}

#[tauri::command]
fn ecosystem_catalog(app: tauri::AppHandle) -> Result<Value, String> {
    let mut child = Command::new(hii_binary(&app)?)
        .args(["ecosystem", "catalog", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("HII could not read its ecosystem catalog: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("HII catalog stdout was unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("HII catalog stderr was unavailable")?;
    let (sender, receiver) = mpsc::channel();
    spawn_catalog_reader(true, stdout, sender.clone());
    spawn_catalog_reader(false, stderr, sender.clone());
    drop(sender);
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            for _ in 0..2 {
                let (is_stdout, result) = receiver
                    .recv_timeout(Duration::from_secs(1))
                    .map_err(|_| "HII catalog output was incomplete".to_string())?;
                let value = result.map_err(|error| error.to_string())?;
                if value.len() as u64 > ECOSYSTEM_CATALOG_MAX_BYTES {
                    return Err("HII catalog exceeded its output limit".to_string());
                }
                if is_stdout {
                    stdout = value
                } else {
                    stderr = value
                }
            }
            if !status.success() {
                // stderr is deliberately drained above for process safety, but
                // never crosses the Tauri boundary: future CLI diagnostics may
                // contain private runtime paths or secret-bearing context.
                let _ = stderr;
                return Err(ecosystem_catalog_process_error());
            }
            return serde_json::from_slice(&stdout)
                .map_err(|_| "HII returned an invalid ecosystem catalog".to_string());
        }
        if started.elapsed() >= ECOSYSTEM_CATALOG_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("HII ecosystem catalog timed out".to_string());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[tauri::command]
fn application_requests(app: tauri::AppHandle) -> Result<Value, String> {
    hii_json(&app, &["apps", "requests", "--json"])
}

#[tauri::command]
fn application_acknowledge(app: tauri::AppHandle, id: String) -> Result<Value, String> {
    hii_json(&app, &["apps", "acknowledge", &id, "--json"])
}

#[tauri::command]
fn link_contact_card(app: tauri::AppHandle) -> Result<Value, String> {
    hii_json(&app, &["link", "card", "--json"])
}

#[tauri::command]
fn link_vpn_status(app: tauri::AppHandle) -> Result<Value, String> {
    hii_json(&app, &["link", "status", "--json"])
}

#[cfg(target_os = "macos")]
fn url_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[tauri::command]
fn link_open_handoff(kind: String, recipient: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = match kind.as_str() {
            "messages" => format!(
                "sms:{}&body={}",
                url_component(recipient.trim()),
                url_component(body.trim())
            ),
            "facetime" => format!("facetime:{}", url_component(recipient.trim())),
            _ => return Err("HII Link handoff must be messages or facetime".into()),
        };
        let status = Command::new("open")
            .arg(&url)
            .status()
            .map_err(|error| format!("could not open the {kind} handoff: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("macOS did not accept the {kind} handoff"))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (kind, recipient, body);
        Err("HII Link's Messages and FaceTime handoff is available on macOS".into())
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AgentProcesses::default())
        .manage(terminal::TerminalSessions::default())
        .manage(ui_channel::ActiveBundle::default())
        // Serves an installed interface bundle out of ~/.hii/ui/bundles/<version>.
        .register_uri_scheme_protocol("hiiui", |ctx, request| {
            let active = ctx.app_handle().state::<ui_channel::ActiveBundle>().get();
            let path = request.uri().path().to_string();
            let resolved = active
                .as_deref()
                .and_then(|root| ui_channel::resolve_asset(root, &path));
            match resolved.and_then(|file| fs::read(&file).ok().map(|body| (file, body))) {
                Some((file, body)) => tauri::http::Response::builder()
                    .header("content-type", ui_channel::content_type(&file))
                    .header("cache-control", "no-store")
                    .body(body)
                    .unwrap_or_else(|_| {
                        tauri::http::Response::builder()
                            .status(500)
                            .body(Vec::new())
                            .expect("static error response")
                    }),
                None => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .expect("static error response"),
            }
        })
        .setup(|app| {
            ui_channel::apply_startup(&app.handle().clone());
            ui_channel::spawn_poller(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_space_snapshot_v1,
            runtime_space_apply_v1,
            runtime_space_history_v1,
            runtime_context_compile_v1,
            runtime_context_get_v1,
            runtime_context_approve_v1,
            runtime_share_create_v1,
            runtime_share_list_v1,
            runtime_share_revoke_v1,
            workspace_read,
            workspace_write,
            account_sync::account_sync_status,
            account_sync::account_sync_link,
            account_sync::account_workspace_list,
            account_sync::account_workspace_read,
            account_sync::account_workspace_write,
            workspace_asset_store,
            information_capture,
            information_find,
            information_inspect,
            agent_start,
            agent_cancel,
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_stop,
            notification_list,
            notification_read,
            applications_list,
            agent_home,
            ecosystem_catalog,
            application_requests,
            application_acknowledge,
            link_contact_card,
            link_vpn_status,
            link_open_handoff,
            browser::browser_navigate,
            browser::browser_action,
            ui_channel::ui_channel_status,
            ui_channel::ui_channel_set_live,
            ui_channel::ui_channel_configure,
            ui_channel::ui_channel_check,
            ui_channel::ui_channel_apply,
            ui_channel::ui_channel_versions
        ])
        .build(tauri::generate_context!())
        .expect("error while building HII desktop interface");

    app.run(|_, _| {});
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ecosystem_catalog_process_errors_do_not_expose_child_stderr() {
        let private_diagnostic = "/Users/owner/.hii/private token=do-not-leak";
        let error = ecosystem_catalog_process_error();
        assert!(error.contains("catalog_process_failed"));
        assert!(!error.contains(private_diagnostic));
        assert!(!error.contains("/Users/"));
        assert!(!error.contains("token="));
    }

    #[test]
    fn internal_protocol_events_are_not_user_output() {
        let event = json!({
            "event": "model.reasoning_policy",
            "data": { "bounded": false, "mode": "auto", "step": 1 }
        });
        assert_eq!(jsonl_user_message(&event), None);
    }

    #[test]
    fn completed_runs_surface_summary_and_receipt() {
        let event = json!({
            "event": "run.finished",
            "data": { "summary": "Imported the images.", "proof": "/tmp/receipt.json" }
        });
        assert_eq!(
            jsonl_user_message(&event).as_deref(),
            Some("Imported the images.")
        );
        assert_eq!(
            jsonl_receipt_path(&event).as_deref(),
            Some("/tmp/receipt.json")
        );
    }

    #[test]
    fn assistant_content_streams_as_exact_visible_deltas() {
        let event = json!({
            "event": "assistant.stream.delta",
            "data": { "content": " next token", "offset": 11 }
        });
        assert_eq!(jsonl_user_kind(&event), Some("delta"));
        assert_eq!(jsonl_user_message(&event).as_deref(), Some(" next token"));
    }

    #[test]
    fn web_tools_surface_external_context_progress_and_links() {
        let started = json!({
            "event": "tool.started",
            "data": { "tool": "web_fetch", "target": "https://example.com/source" }
        });
        let completed = json!({
            "event": "tool.result",
            "data": { "tool": "web_fetch", "ok": true, "output": "Source\nhttps://example.com/source" }
        });
        assert_eq!(
            jsonl_user_message(&started).as_deref(),
            Some("Loading external source · https://example.com/source")
        );
        assert_eq!(
            jsonl_user_message(&completed).as_deref(),
            Some("External context loaded\nSource\nhttps://example.com/source")
        );
        let request = jsonl_agent_activity(&started).expect("tool request activity");
        assert_eq!(request.kind, "tool-request");
        assert_eq!(request.name, "web_fetch");
        assert_eq!(
            request.detail.as_deref(),
            Some("https://example.com/source")
        );
        let observation = jsonl_agent_activity(&completed).expect("tool observation activity");
        assert_eq!(observation.kind, "tool-observation");
        assert_eq!(observation.ok, Some(true));
    }

    #[test]
    fn tool_errors_explain_that_hii_is_revising() {
        let event = json!({
            "event": "tool.result",
            "data": { "tool": "http", "ok": false, "output": "public URLs are not allowed" }
        });
        assert_eq!(
            jsonl_user_message(&event).as_deref(),
            Some("Revising after tool error · public URLs are not allowed")
        );
    }

    #[test]
    fn asset_names_cannot_escape_the_asset_directory() {
        assert_eq!(
            safe_asset_name("../../client brief.pdf"),
            "client_brief.pdf"
        );
    }
}
