// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Explicitly linked account-workspace synchronization for the native app.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};

const DEFAULT_API: &str = "https://humaninformationinterface.com/api/device";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceConfig {
    version: u8,
    api: String,
    device_id: String,
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSyncStatus {
    linked: bool,
    device_id: Option<String>,
    api: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiEnvelope {
    status: u16,
    body: Value,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountWorkspaceSelection {
    device_id: String,
    workspace_id: Option<String>,
    configured: bool,
}

fn account_config_path(runtime: &Path, directory: Option<PathBuf>) -> PathBuf {
    directory
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| runtime.join("account"))
        .join("device.json")
}

fn config_path() -> Result<PathBuf, String> {
    Ok(account_config_path(
        &hii_core::runtime_root()?,
        env::var_os("HII_ACCOUNT_DIR").map(PathBuf::from),
    ))
}

fn valid_id(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn selection_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let db = Connection::open(path).map_err(|error| error.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    db.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=FULL;
         CREATE TABLE IF NOT EXISTS hii_account_workspace_preferences (
             device_id TEXT PRIMARY KEY NOT NULL,
             workspace_id TEXT,
             updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
             CHECK(length(device_id)=43),
             CHECK(workspace_id IS NULL OR length(workspace_id)=43)
         );",
    )
    .map_err(|error| error.to_string())?;
    Ok(db)
}

fn selection_path() -> Result<PathBuf, String> {
    Ok(env::var_os("HII_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or(hii_core::runtime_root()?.join("hii.db")))
}

fn read_selection(db: &Connection, device_id: &str) -> Result<AccountWorkspaceSelection, String> {
    if !valid_id(device_id) {
        return Err("HII device ID is invalid.".into());
    }
    let saved: Option<Option<String>> = db
        .query_row(
            "SELECT workspace_id FROM hii_account_workspace_preferences WHERE device_id=?1",
            [device_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(AccountWorkspaceSelection {
        device_id: device_id.into(),
        configured: saved.is_some(),
        workspace_id: saved.flatten(),
    })
}

fn write_selection(
    db: &Connection,
    device_id: &str,
    workspace_id: Option<&str>,
) -> Result<AccountWorkspaceSelection, String> {
    if !valid_id(device_id) || workspace_id.is_some_and(|id| !valid_id(id)) {
        return Err("HII workspace selection is invalid.".into());
    }
    db.execute(
        "INSERT INTO hii_account_workspace_preferences (device_id,workspace_id) VALUES (?1,?2)
         ON CONFLICT(device_id) DO UPDATE SET workspace_id=excluded.workspace_id,updated_at=unixepoch()",
        params![device_id, workspace_id],
    ).map_err(|error| error.to_string())?;
    Ok(AccountWorkspaceSelection {
        device_id: device_id.into(),
        workspace_id: workspace_id.map(str::to_owned),
        configured: true,
    })
}

#[tauri::command]
pub fn account_workspace_selection_get() -> Result<AccountWorkspaceSelection, String> {
    let config = read_config()?;
    read_selection(&selection_database(&selection_path()?)?, &config.device_id)
}

/// The surface validates membership against the current account workspace list.
/// This stores only a preference; read/write endpoints still enforce remote access.
#[tauri::command]
pub fn account_workspace_selection_set(
    workspace_id: Option<String>,
) -> Result<AccountWorkspaceSelection, String> {
    let config = read_config()?;
    write_selection(
        &selection_database(&selection_path()?)?,
        &config.device_id,
        workspace_id.as_deref(),
    )
}

fn api_base() -> String {
    env::var("HII_ACCOUNT_API")
        .ok()
        .map(|value| value.trim_end_matches('/').to_string())
        .filter(|value| {
            value.starts_with("https://")
                || value.starts_with("http://127.0.0.1")
                || value.starts_with("http://localhost")
        })
        .unwrap_or_else(|| DEFAULT_API.to_string())
}

fn read_config() -> Result<DeviceConfig, String> {
    let path = config_path()?;
    let bytes = fs::read(&path).map_err(|_| {
        "This HII app is not linked to an account workspace. Create a device code on the HII website first."
            .to_string()
    })?;
    let config: DeviceConfig = serde_json::from_slice(&bytes)
        .map_err(|_| "HII account device configuration is invalid.".to_string())?;
    if config.version != 1 || config.token.len() < 32 || !valid_id(&config.device_id) {
        return Err("HII account device configuration is invalid.".into());
    }
    Ok(config)
}

fn write_config(config: &DeviceConfig) -> Result<(), String> {
    let path = config_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "HII account device path is invalid.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("HII could not create its private account directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("HII could not protect its account directory: {error}"))?;
    }
    let temporary = parent.join(format!(".device-{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec(config)
        .map_err(|error| format!("HII could not encode its account link: {error}"))?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("HII could not store its account link: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("HII could not protect its account link: {error}"))?;
    }
    fs::rename(&temporary, &path)
        .map_err(|error| format!("HII could not finalize its account link: {error}"))
}

fn response_envelope(response: ureq::Response) -> Result<ApiEnvelope, String> {
    let status = response.status();
    let body = response
        .into_json::<Value>()
        .map_err(|error| format!("HII account service returned invalid data: {error}"))?;
    Ok(ApiEnvelope { status, body })
}

fn call(
    method: &str,
    url: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Result<ApiEnvelope, String> {
    let mut request = ureq::request(method, url).timeout(Duration::from_secs(30));
    if let Some(token) = token {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    let result = if let Some(body) = body {
        request
            .set("Content-Type", "application/json")
            .send_json(body)
    } else {
        request.call()
    };
    match result {
        Ok(response) => response_envelope(response),
        Err(ureq::Error::Status(_, response)) => response_envelope(response),
        Err(error) => Err(format!("HII could not reach the account service: {error}")),
    }
}

#[tauri::command]
pub fn account_sync_status() -> Result<AccountSyncStatus, String> {
    let api = api_base();
    match read_config() {
        Ok(config) => Ok(AccountSyncStatus {
            linked: true,
            device_id: Some(config.device_id),
            api: config.api,
        }),
        Err(_) => Ok(AccountSyncStatus {
            linked: false,
            device_id: None,
            api,
        }),
    }
}

#[tauri::command]
pub fn account_sync_link(code: String, device_name: String) -> Result<Value, String> {
    let api = api_base();
    let envelope = call(
        "POST",
        &format!("{api}/link"),
        None,
        Some(json!({ "code": code.trim(), "deviceName": device_name.trim() })),
    )?;
    if envelope.status != 201 {
        return Err(envelope
            .body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("HII could not link this app.")
            .to_string());
    }
    let device_id = envelope
        .body
        .get("deviceId")
        .and_then(Value::as_str)
        .ok_or_else(|| "HII account link omitted the device ID.".to_string())?;
    let token = envelope
        .body
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| "HII account link omitted the device token.".to_string())?;
    write_config(&DeviceConfig {
        version: 1,
        api,
        device_id: device_id.to_string(),
        token: token.to_string(),
    })?;
    Ok(json!({ "linked": true, "deviceId": device_id }))
}

#[tauri::command]
pub fn account_workspace_list() -> Result<ApiEnvelope, String> {
    let config = read_config()?;
    call(
        "GET",
        &format!("{}/workspaces", config.api),
        Some(&config.token),
        None,
    )
}

#[tauri::command]
pub fn account_workspace_read(workspace_id: String) -> Result<ApiEnvelope, String> {
    if !valid_id(&workspace_id) {
        return Err("HII workspace ID is invalid.".into());
    }
    let config = read_config()?;
    call(
        "GET",
        &format!("{}/workspaces/{workspace_id}", config.api),
        Some(&config.token),
        None,
    )
}

#[tauri::command]
pub fn account_workspace_write(
    workspace_id: String,
    expected_revision: i64,
    document: Value,
) -> Result<ApiEnvelope, String> {
    if !valid_id(&workspace_id) || expected_revision < 0 {
        return Err("HII workspace write is invalid.".into());
    }
    let config = read_config()?;
    call(
        "POST",
        &format!("{}/workspaces/{workspace_id}/document", config.api),
        Some(&config.token),
        Some(json!({ "expectedRevision": expected_revision, "document": document })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_path_uses_explicit_account_directory_or_runtime() {
        let runtime = Path::new("isolated-runtime");
        assert_eq!(
            account_config_path(runtime, None),
            runtime.join("account/device.json")
        );
        assert_eq!(
            account_config_path(runtime, Some(PathBuf::new())),
            runtime.join("account/device.json")
        );
        assert_eq!(
            account_config_path(runtime, Some(PathBuf::from("selected-account"))),
            Path::new("selected-account/device.json")
        );
    }

    #[test]
    fn workspace_selection_survives_restart_and_is_scoped_to_device(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("hii.db");
        let first = "a".repeat(43);
        let second = "b".repeat(43);
        let workspace = "w".repeat(43);
        {
            let db = selection_database(&path)?;
            let empty = read_selection(&db, &first)?;
            assert!(!empty.configured);
            assert_eq!(empty.workspace_id, None);
            write_selection(&db, &first, Some(&workspace))?;
            write_selection(&db, &second, None)?;
        }
        let db = selection_database(&path)?;
        assert_eq!(
            read_selection(&db, &first)?,
            AccountWorkspaceSelection {
                device_id: first.clone(),
                workspace_id: Some(workspace),
                configured: true,
            }
        );
        assert_eq!(
            read_selection(&db, &second)?,
            AccountWorkspaceSelection {
                device_id: second,
                workspace_id: None,
                configured: true,
            }
        );
        assert!(!read_selection(&db, &"c".repeat(43))?.configured);
        write_selection(&db, &first, None)?;
        assert_eq!(read_selection(&db, &first)?.workspace_id, None);
        assert!(read_selection(&db, &first)?.configured);
        drop(db);
        Ok(())
    }

    #[test]
    fn preferences_preserve_existing_database_and_reject_invalid_ids(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("hii.db");
        let device = "d".repeat(43);
        {
            let db = Connection::open(&path)?;
            db.execute_batch("PRAGMA user_version=42; CREATE TABLE existing_hii_data (content TEXT); INSERT INTO existing_hii_data VALUES ('preserved');")?;
        }
        let db = selection_database(&path)?;
        for invalid in [
            "short".to_owned(),
            "/".repeat(43),
            "a".repeat(42),
            "a".repeat(44),
        ] {
            assert!(write_selection(&db, &device, Some(&invalid)).is_err());
            assert!(write_selection(&db, &invalid, None).is_err());
        }
        assert!(!read_selection(&db, &device)?.configured);
        write_selection(&db, &device, Some(&format!("{}_-", "w".repeat(41))))?;
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?,
            42
        );
        assert_eq!(
            db.query_row("SELECT content FROM existing_hii_data", [], |row| row
                .get::<_, String>(0))?,
            "preserved"
        );
        drop(db);
        Ok(())
    }

    #[test]
    fn production_account_api_is_https() {
        assert!(DEFAULT_API.starts_with("https://"));
        if std::env::var("HII_ACCOUNT_API").is_err() {
            assert_eq!(api_base(), DEFAULT_API);
        }
    }
}
