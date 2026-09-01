use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter, State, Webview};

const MAX_REPLAY_BYTES: usize = 512 * 1024;
const TRUSTED_TERMINAL_WEBVIEW: &str = "main";

fn require_trusted_terminal_webview(label: &str) -> Result<(), String> {
    if label == TRUSTED_TERMINAL_WEBVIEW {
        Ok(())
    } else {
        Err("terminal commands are restricted to the trusted HII webview".into())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputV1 {
    version: u8,
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitV1 {
    version: u8,
    session_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartResultV1 {
    version: u8,
    session_id: String,
    cwd: String,
    replay: String,
    created: bool,
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    replay: Arc<Mutex<String>>,
}

#[derive(Default)]
pub struct TerminalSessions(Mutex<HashMap<String, TerminalSession>>);

impl TerminalSessions {
    fn remove_and_kill(&self, session_id: &str) -> Result<bool, String> {
        let mut session = self
            .0
            .lock()
            .map_err(|_| "terminal session lock is unavailable".to_string())?
            .remove(session_id);
        if let Some(session) = session.as_mut() {
            session
                .child
                .kill()
                .map_err(|error| format!("could not stop terminal session: {error}"))?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

impl Drop for TerminalSessions {
    fn drop(&mut self) {
        if let Ok(sessions) = self.0.get_mut() {
            for session in sessions.values_mut() {
                let _ = session.child.kill();
            }
        }
    }
}

fn resolve_cwd(value: &str) -> Result<PathBuf, String> {
    let expanded = if value == "~" {
        dirs::home_dir().ok_or_else(|| "could not resolve the home directory".to_string())?
    } else if let Some(relative) = value.strip_prefix("~/") {
        dirs::home_dir()
            .ok_or_else(|| "could not resolve the home directory".to_string())?
            .join(relative)
    } else {
        PathBuf::from(value)
    };
    let canonical = expanded.canonicalize().map_err(|_| {
        format!(
            "terminal working directory does not exist: {}",
            expanded.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "terminal working directory is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

#[cfg(windows)]
fn shell_command(cwd: &Path) -> CommandBuilder {
    let shell = env::var_os("COMSPEC").unwrap_or_else(|| "powershell.exe".into());
    let mut command = CommandBuilder::new(shell);
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command
}

fn hii_command(app: &AppHandle, cwd: &Path) -> Result<CommandBuilder, String> {
    let mut command = CommandBuilder::new(crate::hii_binary(app)?);
    command.arg("--cwd");
    command.arg(cwd);
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    Ok(command)
}

#[cfg(not(windows))]
fn shell_command(cwd: &Path) -> CommandBuilder {
    let shell = env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
    let mut command = CommandBuilder::new(shell);
    command.arg("-l");
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command
}

fn append_replay(replay: &Arc<Mutex<String>>, data: &str) {
    let Ok(mut value) = replay.lock() else { return };
    value.push_str(data);
    if value.len() <= MAX_REPLAY_BYTES {
        return;
    }
    let mut start = value.len() - MAX_REPLAY_BYTES;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value.drain(..start);
}

#[tauri::command]
pub fn terminal_start(
    webview: Webview,
    app: AppHandle,
    sessions: State<'_, TerminalSessions>,
    session_id: String,
    cwd: String,
    cols: Option<u16>,
    rows: Option<u16>,
    entry: Option<String>,
) -> Result<TerminalStartResultV1, String> {
    require_trusted_terminal_webview(webview.label())?;
    if session_id.trim().is_empty() || session_id.len() > 128 {
        return Err("terminal session id is invalid".into());
    }
    let cwd = resolve_cwd(&cwd)?;
    let mut sessions_guard = sessions
        .0
        .lock()
        .map_err(|_| "terminal session lock is unavailable".to_string())?;
    if let Some(existing) = sessions_guard.get_mut(&session_id) {
        if existing
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            let replay = existing
                .replay
                .lock()
                .map(|value| value.clone())
                .unwrap_or_default();
            return Ok(TerminalStartResultV1 {
                version: 1,
                session_id,
                cwd: cwd.display().to_string(),
                replay,
                created: false,
            });
        }
        sessions_guard.remove(&session_id);
    }

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.unwrap_or(28).clamp(4, 300),
            cols: cols.unwrap_or(100).clamp(20, 500),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("could not create terminal: {error}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("could not read terminal: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("could not write terminal: {error}"))?;
    let command = match entry.as_deref().unwrap_or("hii") {
        "hii" => hii_command(&app, &cwd)?,
        "shell" => shell_command(&cwd),
        _ => return Err("terminal entry must be hii or shell".into()),
    };
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("could not start terminal: {error}"))?;
    drop(pair.slave);

    let replay = Arc::new(Mutex::new(String::new()));
    let reader_replay = Arc::clone(&replay);
    let reader_session_id = session_id.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(length) => {
                    let data = String::from_utf8_lossy(&buffer[..length]).into_owned();
                    append_replay(&reader_replay, &data);
                    let _ = app.emit(
                        "hii://terminal-output",
                        TerminalOutputV1 {
                            version: 1,
                            session_id: reader_session_id.clone(),
                            data,
                        },
                    );
                }
            }
        }
        let _ = app.emit(
            "hii://terminal-exit",
            TerminalExitV1 {
                version: 1,
                session_id: reader_session_id,
            },
        );
    });

    sessions_guard.insert(
        session_id.clone(),
        TerminalSession {
            master: pair.master,
            writer,
            child,
            replay,
        },
    );
    Ok(TerminalStartResultV1 {
        version: 1,
        session_id,
        cwd: cwd.display().to_string(),
        replay: String::new(),
        created: true,
    })
}

#[tauri::command]
pub fn terminal_write(
    webview: Webview,
    sessions: State<'_, TerminalSessions>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    require_trusted_terminal_webview(webview.label())?;
    if data.len() > 1024 * 1024 {
        return Err("terminal input is too large".into());
    }
    let mut guard = sessions
        .0
        .lock()
        .map_err(|_| "terminal session lock is unavailable".to_string())?;
    let session = guard
        .get_mut(&session_id)
        .ok_or_else(|| "terminal session is not running".to_string())?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|error| error.to_string())?;
    session.writer.flush().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn terminal_resize(
    webview: Webview,
    sessions: State<'_, TerminalSessions>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    require_trusted_terminal_webview(webview.label())?;
    let guard = sessions
        .0
        .lock()
        .map_err(|_| "terminal session lock is unavailable".to_string())?;
    let session = guard
        .get(&session_id)
        .ok_or_else(|| "terminal session is not running".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: rows.clamp(4, 300),
            cols: cols.clamp(20, 500),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn terminal_stop(
    webview: Webview,
    sessions: State<'_, TerminalSessions>,
    session_id: String,
) -> Result<bool, String> {
    require_trusted_terminal_webview(webview.label())?;
    sessions.remove_and_kill(&session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cwd_expands_home_and_rejects_missing_directories() {
        assert!(resolve_cwd("~").is_ok());
        assert!(resolve_cwd("/hii/this-directory-should-not-exist").is_err());
    }

    #[test]
    fn replay_is_bounded_on_utf8_boundaries() {
        let replay = Arc::new(Mutex::new(String::new()));
        append_replay(&replay, &"界".repeat(MAX_REPLAY_BYTES));
        let value = replay.lock().expect("replay");
        assert!(value.len() <= MAX_REPLAY_BYTES);
        assert!(value.is_char_boundary(0));
    }

    #[test]
    fn terminal_commands_only_trust_the_main_webview() {
        assert!(require_trusted_terminal_webview("main").is_ok());
        assert!(require_trusted_terminal_webview("hii-browser-preview").is_err());
        assert!(require_trusted_terminal_webview("main-child").is_err());
    }
}
