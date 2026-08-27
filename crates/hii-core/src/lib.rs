use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use uuid::Uuid;

pub mod information;
pub mod operational;
pub mod runtime;
pub mod web;

pub const CONTRACT_VERSION: u8 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequestV1 {
    pub version: u8,
    pub intent: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub context_node_ids: Vec<String>,
    #[serde(default)]
    pub context: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventV1 {
    pub version: u8,
    pub run_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartResult {
    pub run_id: String,
}

pub fn runtime_root() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("HII_RUNTIME_DIR") {
        return Ok(PathBuf::from(path));
    }
    dirs::home_dir()
        .map(|home| home.join(".hii"))
        .ok_or_else(|| "HII could not determine the home directory.".to_string())
}

pub fn default_workspace_root() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("HII_WORKSPACE_ROOT") {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = env::var_os("HII_ROOT") {
        return Ok(PathBuf::from(path));
    }
    dirs::home_dir()
        .map(|home| home.join("hii"))
        .ok_or_else(|| "HII could not determine its default workspace.".to_string())
}

fn workspace_directory() -> Result<PathBuf, String> {
    Ok(runtime_root()?.join("workspace"))
}

fn selected_workspace_id() -> String {
    let path = match workspace_directory() {
        Ok(directory) => directory.join("selection.json"),
        Err(_) => return "default".into(),
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.get("workspaceId")?.as_str().map(str::to_owned))
        .filter(|value| {
            value.chars().all(|character| {
                character.is_ascii_alphanumeric() || character == '-' || character == '_'
            })
        })
        .unwrap_or_else(|| "default".into())
}

fn workspace_path() -> Result<PathBuf, String> {
    Ok(workspace_directory()?
        .join("workspaces")
        .join(format!("{}.json", selected_workspace_id())))
}

fn empty_workspace() -> Value {
    json!({
        "version": 1,
        "revision": 0,
        "updatedAt": "",
        "viewport": { "x": 0, "y": 0, "zoom": 1 },
        "nextZ": 1,
        "nodes": [],
        "links": []
    })
}

pub fn read_workspace() -> Result<Value, String> {
    let current = workspace_path()?;
    let legacy = workspace_directory()?.join("workspace.json");
    let source = if current.is_file() { current } else { legacy };
    if !source.is_file() {
        return Ok(empty_workspace());
    }
    let raw = fs::read_to_string(&source)
        .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("Could not parse {}: {error}", source.display()))
}

pub fn write_workspace(mut document: Value) -> Result<Value, String> {
    if document.get("version").and_then(Value::as_u64) != Some(1)
        || !document.get("nodes").is_some_and(Value::is_array)
        || !document.get("viewport").is_some_and(Value::is_object)
    {
        return Err("HII rejected an invalid canvas document.".into());
    }
    let expected_revision = document
        .get("revision")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let path = workspace_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "HII state path has no parent.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let _lock = WorkspaceFileLock::acquire(&path)?;
    let actual_revision = read_workspace()?
        .get("revision")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if actual_revision != expected_revision {
        return Err(format!(
            "workspace revision changed from {expected_revision} to {actual_revision}"
        ));
    }
    document["revision"] = Value::from(actual_revision + 1);
    atomic_json_write(&path, &document)?;
    Ok(document)
}

/// Read the canonical Runtime projection, importing the legacy Workspace JSON
/// once when this Space has not entered Runtime v1 yet.
pub fn runtime_space_snapshot(
    space_id: Option<String>,
) -> Result<runtime::RuntimeSpaceSnapshotV1, String> {
    let space_id = space_id.unwrap_or_else(selected_workspace_id);
    if let Some(snapshot) = runtime::read_space(&runtime_root()?, &space_id)? {
        return Ok(snapshot);
    }
    let legacy = read_workspace()?;
    runtime::initialize_space(&runtime_root()?, &space_id, &legacy)
}

/// Apply a bounded Space mutation through the Runtime and refresh the old JSON
/// file as a compatibility/export snapshot. The JSON file is no longer read as
/// authority after Runtime initialization.
pub fn runtime_space_apply(
    mut request: runtime::RuntimeSpaceApplyV1,
) -> Result<runtime::RuntimeSpaceSnapshotV1, String> {
    let space_id = request
        .space_id
        .clone()
        .unwrap_or_else(selected_workspace_id);
    request.space_id = Some(space_id.clone());
    let _ = runtime_space_snapshot(Some(space_id.clone()))?;
    let snapshot = runtime::apply_space(&runtime_root()?, &space_id, &request)?;
    write_workspace_snapshot(&snapshot.document)?;
    Ok(snapshot)
}

pub fn runtime_space_history(
    space_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<runtime::RuntimeEventV1>, String> {
    let space_id = space_id.unwrap_or_else(selected_workspace_id);
    let _ = runtime_space_snapshot(Some(space_id.clone()))?;
    runtime::history(&runtime_root()?, &space_id, limit.unwrap_or(100))
}

fn write_workspace_snapshot(document: &Value) -> Result<(), String> {
    let path = workspace_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "HII state path has no parent.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let _lock = WorkspaceFileLock::acquire(&path)?;
    atomic_json_write(&path, document)
}

struct WorkspaceFileLock {
    path: PathBuf,
    file: Option<fs::File>,
}

impl WorkspaceFileLock {
    fn acquire(workspace_path: &Path) -> Result<Self, String> {
        let mut lock_name = workspace_path.as_os_str().to_os_string();
        lock_name.push(".lock");
        let lock_path = PathBuf::from(lock_name);
        for _ in 0..40 {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(file) => {
                    return Ok(Self {
                        path: lock_path,
                        file: Some(file),
                    });
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    let stale = fs::metadata(&lock_path)
                        .and_then(|metadata| metadata.modified())
                        .and_then(|modified| modified.elapsed().map_err(std::io::Error::other))
                        .is_ok_and(|elapsed| elapsed > Duration::from_secs(30));
                    if stale {
                        let _ = fs::remove_file(&lock_path);
                        continue;
                    }
                    thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("workspace save lock timed out".into())
    }
}

impl Drop for WorkspaceFileLock {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(&self.path);
    }
}

pub fn new_run_id() -> String {
    format!("desktop-{}", Uuid::new_v4())
}

fn atomic_json_write(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "HII state path has no parent.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("state"),
        Uuid::new_v4()
    ));
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn contracts_are_versioned() {
        let request = AgentRequestV1 {
            version: CONTRACT_VERSION,
            intent: "shape this information".into(),
            mode: Some("build".into()),
            workspace_root: None,
            context_node_ids: vec![],
            context: Value::Null,
        };
        let encoded = serde_json::to_value(request).unwrap();
        assert_eq!(encoded["version"], 1);
        assert_eq!(encoded["intent"], "shape this information");
        assert_eq!(encoded["mode"], "build");
    }

    #[test]
    fn workspace_lock_child() {
        if env::var_os("HII_WORKSPACE_LOCK_CHILD").is_none() {
            return;
        }
        let error = write_workspace(empty_workspace()).expect_err("stale native write must fail");
        assert!(
            error.contains("workspace revision changed from 0 to 1"),
            "unexpected native conflict: {error}"
        );
    }

    #[test]
    fn native_workspace_write_waits_for_shared_lock_and_refuses_stale_state() {
        let runtime = env::temp_dir().join(format!("hii-core-workspace-lock-{}", Uuid::new_v4()));
        let workspace_dir = runtime.join("workspace");
        let workspaces = workspace_dir.join("workspaces");
        let workspace = workspaces.join("race-space.json");
        let lock = PathBuf::from(format!("{}.lock", workspace.display()));
        fs::create_dir_all(&workspaces).unwrap();
        fs::write(
            workspace_dir.join("selection.json"),
            r#"{"workspaceId":"race-space"}"#,
        )
        .unwrap();
        atomic_json_write(&workspace, &empty_workspace()).unwrap();

        // This is the TypeScript convention exactly: open `<file>.lock` with
        // exclusive creation, update the document, close, then remove it.
        let lock_handle = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
            .unwrap();
        let mut child = Command::new(env::current_exe().unwrap())
            .arg("--exact")
            .arg("tests::workspace_lock_child")
            .arg("--nocapture")
            .env("HII_RUNTIME_DIR", &runtime)
            .env("HII_WORKSPACE_LOCK_CHILD", "1")
            .spawn()
            .unwrap();
        thread::sleep(Duration::from_millis(100));
        assert!(
            child.try_wait().unwrap().is_none(),
            "native writer bypassed the shared lock"
        );

        let mut typescript_winner = empty_workspace();
        typescript_winner["revision"] = Value::from(1);
        typescript_winner["nodes"] = json!([{
            "id": "typescript-winner",
            "type": "canvas-text",
            "x": 0,
            "y": 0,
            "w": 100,
            "h": 100,
            "z": 1,
            "createdAt": "2026-08-20T12:00:00.000Z",
            "updatedAt": "2026-08-20T12:00:00.000Z",
            "payload": { "text": "preserved" }
        }]);
        atomic_json_write(&workspace, &typescript_winner).unwrap();
        drop(lock_handle);
        fs::remove_file(&lock).unwrap();

        let status = child.wait().unwrap();
        assert!(
            status.success(),
            "cross-process native lock assertion failed"
        );
        let preserved: Value =
            serde_json::from_str(&fs::read_to_string(&workspace).unwrap()).unwrap();
        assert_eq!(preserved["revision"], 1);
        assert_eq!(preserved["nodes"][0]["id"], "typescript-winner");
        fs::remove_dir_all(runtime).unwrap();
    }
}
