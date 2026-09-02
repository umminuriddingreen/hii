// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! HII account linking for the CLI.
//!
//! This deliberately redeems the same short-lived device code as the Tauri
//! app. The resulting credential is stored at the same private path, so the
//! terminal and installed app project one account instead of inventing a
//! second CLI identity.

use crate::{config::AppPaths, store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::Duration,
};

const DEFAULT_API: &str = "https://humaninformationinterface.com/api/device";
const DEFAULT_WEB: &str = "https://humaninformationinterface.com/?link=cli";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceConfig {
    version: u8,
    api: String,
    device_id: String,
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkResponse {
    device_id: String,
    token: String,
}

#[derive(Debug, Deserialize)]
struct AccountView {
    handle: String,
}

#[derive(Debug, Deserialize)]
struct WorkspaceList {
    account: AccountView,
    workspaces: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkedAccount {
    pub device_id: String,
    pub handle: Option<String>,
    pub workspace_count: Option<usize>,
}

fn config_path(paths: &AppPaths) -> PathBuf {
    paths.runtime.join("account/device.json")
}

fn allowed_origin(value: String, fallback: &str) -> String {
    let value = value.trim().trim_end_matches('/').to_string();
    if value.starts_with("https://")
        || value.starts_with("http://127.0.0.1")
        || value.starts_with("http://localhost")
    {
        value
    } else {
        fallback.to_string()
    }
}

fn api_base() -> String {
    allowed_origin(
        env::var("HII_ACCOUNT_API").unwrap_or_else(|_| DEFAULT_API.into()),
        DEFAULT_API,
    )
}

pub fn login_url() -> String {
    let configured = env::var("HII_ACCOUNT_WEB").unwrap_or_else(|_| DEFAULT_WEB.into());
    let value = allowed_origin(configured, DEFAULT_WEB);
    if value.contains("?link=cli") {
        value
    } else {
        format!("{value}/?link=cli")
    }
}

fn read_config(path: &Path) -> Result<DeviceConfig, String> {
    let raw = fs::read(path).map_err(|_| "not linked".to_string())?;
    let config: DeviceConfig = serde_json::from_slice(&raw)
        .map_err(|_| "HII account device configuration is invalid.".to_string())?;
    if config.version != 1 || config.device_id.len() != 43 || config.token.len() < 32 {
        return Err("HII account device configuration is invalid.".into());
    }
    Ok(config)
}

fn profile(config: &DeviceConfig) -> Result<WorkspaceList, String> {
    let response = ureq::get(&format!("{}/workspaces", config.api))
        .set("Authorization", &format!("Bearer {}", config.token))
        .timeout(Duration::from_secs(20))
        .call();
    match response {
        Ok(response) => response
            .into_json::<WorkspaceList>()
            .map_err(|error| format!("HII account service returned invalid data: {error}")),
        Err(ureq::Error::Status(401, _)) => {
            Err("This HII account link was revoked. Run `hii login` to reconnect.".into())
        }
        Err(error) => Err(format!("HII could not reach the account service: {error}")),
    }
}

pub fn link(paths: &AppPaths, code: &str, device_name: &str) -> Result<LinkedAccount, String> {
    let code = code.trim();
    if !code.starts_with("hii_device_") || code.len() > 128 {
        return Err("That computer code is invalid, expired, or incomplete.".into());
    }
    let device_name = device_name.split_whitespace().collect::<Vec<_>>().join(" ");
    if device_name.is_empty() || device_name.chars().count() > 64 {
        return Err("The computer name must contain 1 to 64 characters.".into());
    }
    let api = api_base();
    let response = ureq::post(&format!("{api}/link"))
        .timeout(Duration::from_secs(30))
        .send_json(json!({ "code": code, "deviceName": device_name }));
    let linked = match response {
        Ok(response) if response.status() == 201 => response
            .into_json::<LinkResponse>()
            .map_err(|error| format!("HII account service returned invalid data: {error}"))?,
        Ok(_) => return Err("HII did not accept that computer code.".into()),
        Err(ureq::Error::Status(_, response)) => {
            let error = response
                .into_json::<Value>()
                .ok()
                .and_then(|value| {
                    value
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| "computer_code_unavailable".into());
            return Err(error.replace('_', " "));
        }
        Err(error) => return Err(format!("HII could not reach the account service: {error}")),
    };
    let config = DeviceConfig {
        version: 1,
        api,
        device_id: linked.device_id.clone(),
        token: linked.token,
    };
    store::write_json_private_atomic(&config_path(paths), &config)?;
    let remote = profile(&config).ok();
    Ok(LinkedAccount {
        device_id: linked.device_id,
        handle: remote.as_ref().map(|value| value.account.handle.clone()),
        workspace_count: remote.map(|value| value.workspaces.len()),
    })
}

pub fn status(paths: &AppPaths) -> Result<String, String> {
    let config = match read_config(&config_path(paths)) {
        Ok(config) => config,
        Err(error) if error == "not linked" => {
            return Ok("HII account\nstate: not connected\nrun: hii login".into())
        }
        Err(error) => return Err(error),
    };
    match profile(&config) {
        Ok(remote) => Ok(format!(
            "HII account\nstate: connected\nuser: {}\ncomputer: {}\nworkspaces: {}",
            remote.account.handle,
            config.device_id,
            remote.workspaces.len()
        )),
        Err(error) => Ok(format!(
            "HII account\nstate: linked locally; remote status unavailable\ncomputer: {}\ndetail: {}",
            config.device_id, error
        )),
    }
}

pub fn logout(paths: &AppPaths) -> Result<bool, String> {
    let path = config_path(paths);
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(path)
        .map_err(|error| format!("HII could not clear the local account link: {error}"))?;
    Ok(true)
}

pub fn default_device_name() -> String {
    env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("HII CLI on {}", env::consts::OS))
}

pub fn login_mark_frame(phase: usize) -> Vec<String> {
    let width = 42usize;
    let height = 10usize;
    let mut rows = vec![vec![' '; width]; height];
    for x in 2..width - 2 {
        let wave = (((x + phase) as f32 * 0.42).sin() * 1.35).round() as isize;
        let top = (1isize + wave).clamp(0, 3) as usize;
        let bottom =
            (height as isize - 2 + wave).clamp(height as isize - 4, height as isize - 1) as usize;
        rows[top][x] = ['.', '~', '-', '='][(x + phase) % 4];
        rows[bottom][x] = ['=', '-', '~', '.'][(x + phase) % 4];
    }
    for y in 2..height - 2 {
        let shift = (((y + phase) as f32 * 0.76).sin() * 1.2).round() as isize;
        rows[y][(2isize + shift).clamp(0, 4) as usize] = '/';
        rows[y]
            [(width as isize - 3 + shift).clamp(width as isize - 5, width as isize - 1) as usize] =
            '\\';
    }
    let label = " HII / YOUR INFORMATION ";
    let start = (width - label.len()) / 2;
    for (offset, character) in label.chars().enumerate() {
        rows[height / 2][start + offset] = character;
    }
    rows.into_iter()
        .map(|row| row.into_iter().collect::<String>().trim_end().to_string())
        .collect()
}

pub fn animate_login_mark() -> Result<(), String> {
    if !io::stdin().is_terminal()
        || !io::stdout().is_terminal()
        || env::var_os("HII_UI_LINE_MODE").is_some()
    {
        return Ok(());
    }
    let mut out = io::stdout();
    let mut rendered = 0usize;
    for phase in 0..10 {
        let frame = login_mark_frame(phase);
        if rendered > 0 {
            write!(out, "\x1b[{rendered}A").map_err(|error| error.to_string())?;
        }
        for line in &frame {
            write!(out, "\r\x1b[2K{line}\r\n").map_err(|error| error.to_string())?;
        }
        out.flush().map_err(|error| error.to_string())?;
        rendered = frame.len();
        thread::sleep(Duration::from_millis(55));
    }
    Ok(())
}

pub fn open_login_page(url: &str) -> bool {
    if env::var_os("NO_OPEN_BROWSER").is_some() || env::var_os("HII_NO_OPEN_BROWSER").is_some() {
        return false;
    }
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(url).status();
    #[cfg(target_os = "linux")]
    let status = Command::new("xdg-open").arg(url).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("cmd").args(["/C", "start", "", url]).status();
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let status: Result<std::process::ExitStatus, io::Error> = Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "browser opening is unavailable",
    ));
    status.is_ok_and(|status| status.success())
}

pub fn read_link_code() -> Result<String, String> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(format!(
            "HII account login needs an interactive terminal. Open {} and run `hii login` again.",
            login_url()
        ));
    }
    let url = login_url();
    animate_login_mark()?;
    println!("\nConnect this terminal to your HII account");
    println!("{url}");
    if open_login_page(&url) {
        println!("\nOpened HII in your browser.");
    } else {
        println!("\nOpen the address above in your browser.");
    }
    print!("Create a one-time computer code, then paste it here: ");
    io::stdout().flush().map_err(|error| error.to_string())?;
    let mut code = String::new();
    io::stdin()
        .read_line(&mut code)
        .map_err(|error| format!("HII could not read the computer code: {error}"))?;
    if code.trim().is_empty() {
        return Err("No computer code was entered.".into());
    }
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_mark_is_a_stable_moving_box() {
        let first = login_mark_frame(0);
        let next = login_mark_frame(1);
        assert_eq!(first.len(), 10);
        assert!(first.iter().all(|line| line.chars().count() <= 42));
        assert!(first.join("\n").contains("HII / YOUR INFORMATION"));
        assert_ne!(first, next);
    }

    #[test]
    fn production_login_url_is_https() {
        if env::var("HII_ACCOUNT_WEB").is_err() {
            assert!(login_url().starts_with("https://"));
            assert!(login_url().contains("link=cli"));
        }
    }
}
