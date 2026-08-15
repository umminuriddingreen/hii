use hii_core::{
    default_workspace_root, new_run_id, read_workspace, write_workspace, AgentEventV1,
    AgentRequestV1, AgentStartResult, CONTRACT_VERSION,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    env,
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{Emitter, Manager};

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
    if cleaned.is_empty() { "asset".into() } else { cleaned.chars().take(160).collect() }
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

fn hii_binary() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("HII_CLI_BIN") {
        return Ok(PathBuf::from(path));
    }
    let mut candidates = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("bin/hii"));
        candidates.push(home.join("hii/target/release/hii"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/hii"));
    candidates.into_iter().find(|path| path.is_file()).ok_or_else(|| "HII could not locate its Rust CLI.".into())
}

fn emit_agent(app: &tauri::AppHandle, run_id: &str, status: &str, text: Option<String>, receipt_path: Option<String>) {
    let _ = app.emit("hii://agent-event", AgentEventV1 {
        version: CONTRACT_VERSION,
        run_id: run_id.into(),
        status: status.into(),
        text,
        receipt_path,
    });
}

fn jsonl_receipt_path(value: &Value) -> Option<String> {
    value
        .get("data")
        .and_then(|data| data.get("proof"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn jsonl_user_message(value: &Value) -> Option<String> {
    let event = value.get("event")?.as_str()?;
    let data = value.get("data").unwrap_or(&Value::Null);
    let string = |key: &str| data.get(key).and_then(Value::as_str);
    match event {
        "model.delta" if string("channel") == Some("content") => {
            string("text").filter(|text| !text.trim().is_empty()).map(str::to_owned)
        }
        "tool.started" => {
            let tool = string("tool").unwrap_or("tool");
            let target = string("target").unwrap_or("working");
            Some(format!("{tool} · {target}"))
        }
        "tool.result" if data.get("ok").and_then(Value::as_bool) == Some(false) => string("output")
            .filter(|text| !text.trim().is_empty())
            .map(|text| format!("Tool error · {text}")),
        "run.blocked" | "run.interrupted" | "budget.exceeded" => string("message")
            .or_else(|| string("reason"))
            .map(str::to_owned),
        "run.finished" => string("summary").map(str::to_owned),
        _ => None,
    }
}

#[tauri::command]
fn agent_start(app: tauri::AppHandle, state: tauri::State<AgentProcesses>, request: AgentRequestV1) -> Result<AgentStartResult, String> {
    if request.version != CONTRACT_VERSION {
        return Err(format!("Unsupported HII agent contract version {}.", request.version));
    }
    let intent = request.intent.trim();
    if intent.is_empty() || intent.len() > 16_000 {
        return Err("HII needs an intent between 1 and 16000 characters.".into());
    }
    let root = request.workspace_root.map(PathBuf::from).unwrap_or(default_workspace_root()?);
    if !root.is_dir() {
        return Err(format!("HII workspace does not exist: {}", root.display()));
    }
    let run_id = new_run_id();
    let context = serde_json::to_string(&request.context).unwrap_or_else(|_| "null".into());
    let selected = request.context_node_ids.join(", ");
    let goal = if !request.context.is_null() || !selected.is_empty() {
        format!(
            "{intent}\n\nHII interface context (human-selected, version {}):\nselected object ids: [{}]\ncontext: {}",
            request.version, selected, context
        )
    } else {
        intent.to_owned()
    };
    let mut command = Command::new(hii_binary()?);
    command
        .args(["run", "--cwd"])
        .arg(&root)
        .args(["--jsonl", "--stream", "--autonomy", "local-full"])
        .arg(goal)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| format!("HII could not start the agent: {error}"))?;
    let pid = child.id();
    state.0.lock().map_err(|error| error.to_string())?.insert(run_id.clone(), pid);
    emit_agent(&app, &run_id, "started", Some(format!("Working in {}", root.display())), None);

    let receipt = Arc::new(Mutex::new(None::<String>));
    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        let run = run_id.clone();
        let receipt = receipt.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if let Some(path) = jsonl_receipt_path(&value) {
                        if let Ok(mut target) = receipt.lock() { *target = Some(path.into()); }
                    }
                    if let Some(message) = jsonl_user_message(&value) {
                        emit_agent(&app, &run, "progress", Some(message), None);
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
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if let Some(message) = jsonl_user_message(&value) {
                        emit_agent(&app, &run, "progress", Some(message), None);
                    }
                } else if !line.trim().is_empty() {
                    emit_agent(&app, &run, "progress", Some(line), None);
                }
            }
        });
    }
    let app_for_wait = app.clone();
    let run_for_wait = run_id.clone();
    thread::spawn(move || {
        let status = child.wait();
        if let Some(processes) = app_for_wait.try_state::<AgentProcesses>() {
            if let Ok(mut processes) = processes.0.lock() { processes.remove(&run_for_wait); }
        }
        let receipt_path = receipt.lock().ok().and_then(|value| value.clone());
        match status {
            Ok(value) if value.success() => emit_agent(&app_for_wait, &run_for_wait, "completed", Some("Agent work completed.".into()), receipt_path),
            Ok(value) => emit_agent(&app_for_wait, &run_for_wait, "failed", Some(format!("Agent stopped with exit {}.", value.code().unwrap_or(1))), receipt_path),
            Err(error) => emit_agent(&app_for_wait, &run_for_wait, "failed", Some(error.to_string()), receipt_path),
        }
    });
    Ok(AgentStartResult { run_id })
}

#[tauri::command]
fn agent_cancel(app: tauri::AppHandle, state: tauri::State<AgentProcesses>, run_id: String) -> Result<(), String> {
    let pid = state.0.lock().map_err(|error| error.to_string())?.get(&run_id).copied().ok_or_else(|| "HII agent run is not active.".to_string())?;
    #[cfg(unix)]
    let status = Command::new("/bin/kill").args(["-TERM", &pid.to_string()]).status();
    #[cfg(windows)]
    let status = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T"]).status();
    if status.is_ok_and(|value| value.success()) {
        emit_agent(&app, &run_id, "cancelled", Some("Agent run cancelled.".into()), None);
        Ok(())
    } else {
        Err("HII could not cancel the agent run.".into())
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(AgentProcesses::default())
        .invoke_handler(tauri::generate_handler![
            workspace_read,
            workspace_write,
            workspace_asset_store,
            agent_start,
            agent_cancel
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
        assert_eq!(jsonl_user_message(&event).as_deref(), Some("Imported the images."));
        assert_eq!(jsonl_receipt_path(&event).as_deref(), Some("/tmp/receipt.json"));
    }

    #[test]
    fn asset_names_cannot_escape_the_asset_directory() {
        assert_eq!(safe_asset_name("../../client brief.pdf"), "client_brief.pdf");
    }
}
