//! Discover existing local boards without uploading or replacing their contents.
use serde_json::{json, Value};
use std::{fs, path::Path};

fn inventory(root: &Path) -> Result<Value, String> {
    let directory = root.join("workspace");
    let selection = directory.join("selection.json");
    let selected = match fs::read(&selection) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .map_err(|e| e.to_string())?
            .get("workspaceId")
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "default".into(),
        Err(e) => return Err(e.to_string()),
    };
    let mut boards = Vec::new();
    match fs::read_dir(directory.join("workspaces")) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                if path.extension().and_then(|v| v.to_str()) != Some("json") {
                    continue;
                }
                let Some(id) = path.file_stem().and_then(|v| v.to_str()) else {
                    continue;
                };
                let document = fs::read(&path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                boards.push(json!({"id": id, "objects": document.as_ref().and_then(|d| d["nodes"].as_array()).map(Vec::len), "unreadable": document.is_none()}));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    boards.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    Ok(json!({"selectedWorkspaceId":selected,"workspaces":boards}))
}

#[tauri::command]
pub fn local_workspace_list() -> Result<Value, String> {
    inventory(&hii_core::runtime_root()?)
}

#[tauri::command]
pub fn local_workspace_read(workspace_id: String) -> Result<Value, String> {
    let root = hii_core::runtime_root()?;
    let listing = inventory(&root)?;
    if !listing["workspaces"].as_array().is_some_and(|boards| {
        boards.iter().any(|board| board["id"] == workspace_id && board["unreadable"] == false)
    }) {
        return Err("Choose an existing readable local board.".into());
    }
    Ok(hii_core::runtime_space_snapshot(Some(workspace_id))?.document)
}

#[tauri::command]
pub fn local_workspace_select(workspace_id: String) -> Result<(), String> {
    let root = hii_core::runtime_root()?;
    let listing = inventory(&root)?;
    if !listing["workspaces"].as_array().is_some_and(|boards| {
        boards
            .iter()
            .any(|b| b["id"] == workspace_id && b["unreadable"] == false)
    }) {
        return Err("Choose an existing readable local board.".into());
    }
    // The core validates the ID and verifies the authoritative document before
    // changing the CLI and canvas selection. It never substitutes another board.
    hii_core::runtime_space_snapshot(Some(workspace_id.clone()))?;
    let directory = root.join("workspace");
    let temporary = directory.join(format!(".selection-{}.tmp", hii_core::new_run_id()));
    fs::write(
        &temporary,
        serde_json::to_vec(&json!({"workspaceId":workspace_id})).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&temporary, directory.join("selection.json")).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inventory_preserves_and_exposes_unreadable_boards() {
        let root = std::env::temp_dir().join(format!("hii-inventory-{}", hii_core::new_run_id()));
        fs::create_dir_all(root.join("workspace/workspaces")).unwrap();
        fs::write(
            root.join("workspace/workspaces/old.json"),
            r#"{"nodes":[{"id":"kept"}]}"#,
        )
        .unwrap();
        fs::write(root.join("workspace/workspaces/broken.json"), "{").unwrap();
        let result = inventory(&root).unwrap();
        assert_eq!(result["workspaces"][0]["unreadable"], true);
        assert_eq!(result["workspaces"][1]["objects"], 1);
        assert_eq!(
            fs::read_to_string(root.join("workspace/workspaces/broken.json")).unwrap(),
            "{"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
