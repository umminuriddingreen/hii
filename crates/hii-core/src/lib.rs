use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub mod information;
pub mod operational;

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
    let revision = document
        .get("revision")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        + 1;
    document["revision"] = Value::from(revision);
    let path = workspace_path()?;
    atomic_json_write(&path, &document)?;
    Ok(document)
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
}
