//! Explicitly linked account-workspace synchronization for the native app.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{env, fs, path::PathBuf, time::Duration};

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

fn config_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".hii").join("account").join("device.json"))
        .ok_or_else(|| "HII could not locate the home directory.".to_string())
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
    if config.version != 1 || config.token.len() < 32 || config.device_id.len() != 43 {
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
    if workspace_id.len() != 43 {
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
    if workspace_id.len() != 43 || expected_revision < 0 {
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
    use super::{api_base, DEFAULT_API};

    #[test]
    fn production_account_api_is_https() {
        assert!(DEFAULT_API.starts_with("https://"));
        if std::env::var("HII_ACCOUNT_API").is_err() {
            assert_eq!(api_base(), DEFAULT_API);
        }
    }
}
