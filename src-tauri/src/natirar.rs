use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env, fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const DEFAULT_PROJECT: &str = "/Users/ummi/Documents/Natirar-Shell-Study/hii/natirar.project.json";

fn project_path() -> PathBuf {
    env::var_os("HII_NATIRAR_PROJECT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_PROJECT))
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn read_project() -> Result<Value, String> {
    let path = project_path();
    let bytes = fs::read(&path).map_err(|e| format!("natirar_project_unavailable: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("natirar_project_invalid: {e}"))
}

fn write_receipt(kind: &str, payload: &Value) -> Result<PathBuf, String> {
    let project = project_path();
    let root = project.parent().ok_or("natirar_project_parent_missing")?;
    let receipts = root.join("receipts");
    fs::create_dir_all(&receipts).map_err(|e| e.to_string())?;
    let path = receipts.join(format!("{}-{}.json", now_millis(), kind));
    fs::write(
        &path,
        serde_json::to_vec_pretty(payload).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub fn natirar_project_read() -> Result<Value, String> {
    read_project()
}

#[tauri::command]
pub fn natirar_project_select(
    candidate_id: String,
    artist_family_id: String,
    photo_id: String,
) -> Result<Value, String> {
    let mut project = read_project()?;
    let candidates = project["candidates"]
        .as_array()
        .ok_or("natirar_candidates_missing")?;
    let families = project["artistFamilies"]
        .as_array()
        .ok_or("natirar_artist_families_missing")?;
    let photos = project["photos"]
        .as_array()
        .ok_or("natirar_photos_missing")?;
    if !candidates.iter().any(|v| v["id"] == candidate_id) {
        return Err("natirar_candidate_unknown".into());
    }
    if !families.iter().any(|v| v["id"] == artist_family_id) {
        return Err("natirar_artist_family_unknown".into());
    }
    if !photos.iter().any(|v| v["id"] == photo_id) {
        return Err("natirar_photo_unknown".into());
    }
    project["selection"] = json!({"candidateId": candidate_id, "artistFamilyId": artist_family_id, "photoId": photo_id});
    project["parameters"]["HII_CANDIDATE"] = json!(candidate_id);
    project["parameters"]["HII_ARTIST_FAMILY"] = json!(artist_family_id);
    project["parameters"]["HII_PHOTO"] = json!(photo_id);
    let path = project_path();
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&project).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
    let receipt = json!({"schema":"hii.receipt/1", "kind":"natirar.selection", "atMs":now_millis(), "selection":project["selection"]});
    let receipt_path = write_receipt("selection", &receipt)?;
    Ok(json!({"project":project, "receiptPath":receipt_path}))
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NatirarRhinoAction {
    Ping,
    BuildStudy,
    Undo,
    OpenGrasshopper,
    SolveGrasshopper,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NatirarRhinoResult {
    success: bool,
    message: String,
    response: Value,
    receipt_path: PathBuf,
}

#[tauri::command]
pub fn natirar_rhino_action(action: NatirarRhinoAction) -> Result<NatirarRhinoResult, String> {
    let project = read_project()?;
    let build_script = project["files"]["rhinoBuildScript"]
        .as_str()
        .unwrap_or("/Users/ummi/Documents/Natirar-Shell-Study/site_data/build_parametric_rhino.py");
    let grasshopper = project["files"]["grasshopperMaster"]
        .as_str()
        .ok_or("natirar_grasshopper_master_missing")?;
    let (tool, permission, args): (&str, &str, Vec<String>) = match action {
        NatirarRhinoAction::Ping => ("hii.rhino.status", "READ_ONLY", vec!["status".into()]),
        NatirarRhinoAction::BuildStudy => (
            "hii.rhino.script",
            "EDIT_SAFE",
            vec!["script".into(), build_script.into()],
        ),
        NatirarRhinoAction::Undo => (
            "hii.rhino.command",
            "EDIT_SAFE",
            vec!["command".into(), "_Undo".into()],
        ),
        NatirarRhinoAction::OpenGrasshopper => (
            "hii.rhino.grasshopper",
            "EDIT_SAFE",
            vec!["grasshopper".into(), grasshopper.into()],
        ),
        NatirarRhinoAction::SolveGrasshopper => (
            "hii.rhino.command",
            "EDIT_SAFE",
            vec!["command".into(), "_-Grasshopper _Solver _Recompute _Enter".into()],
        ),
    };
    let request = json!({"version":"1", "request_id":format!("hii-natirar-{}",now_millis()), "tool":tool, "permission_level":permission, "args":args});
    let hii = env::var_os("HII_CLI_BIN").unwrap_or_else(|| "hii".into());
    let output = Command::new(hii)
        .arg("rhino")
        .args(&args)
        .output()
        .map_err(|e| format!("hii_rhino_executor_unavailable: {e}"))?;
    let success = output.status.success();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let response = json!({
        "success": success,
        "exitCode": output.status.code(),
        "stdout": stdout,
        "stderr": stderr,
    });
    let receipt = json!({"schema":"hii.receipt/1", "kind":"natirar.rhino", "atMs":now_millis(), "request":request, "response":response});
    let receipt_path = write_receipt("rhino", &receipt)?;
    Ok(NatirarRhinoResult {
        success,
        message: if success { "HII Rhino action completed".into() } else { stderr },
        response,
        receipt_path,
    })
}
