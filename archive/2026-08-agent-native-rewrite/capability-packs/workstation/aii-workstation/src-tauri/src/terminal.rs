//! Embedded terminal: a real PTY running the user's login shell, streamed to
//! the xterm.js panel in the bottom dock.
//!
//! Single session for now. TODO(phase-5): one PTY per agent task, attached to
//! the remote tmux/Zellij session (`ssh -t <host> tmux attach -t <sessionId>`).

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState(pub Mutex<Option<PtySession>>);

#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    state: State<'_, PtyState>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(()); // already running — reattach on the frontend
    }

    let pty = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd.env("TERM", "xterm-256color");
    if let Some(home) = dirs_home() {
        cmd.cwd(home);
    }

    let child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;

    // Stream PTY output to the frontend as `terminal:output` events.
    let emitter = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = emitter.emit("terminal:output", chunk);
                }
            }
        }
        let _ = emitter.emit("terminal:exit", ());
    });

    *guard = Some(PtySession {
        master: pty.master,
        writer,
        child,
    });
    Ok(())
}

#[tauri::command]
pub fn terminal_write(state: State<'_, PtyState>, data: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    match guard.as_mut() {
        Some(s) => s
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string()),
        None => Err("no terminal session".into()),
    }
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, PtyState>, cols: u16, rows: u16) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(s) => s
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string()),
        None => Err("no terminal session".into()),
    }
}

#[tauri::command]
pub fn terminal_close(state: State<'_, PtyState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut s) = guard.take() {
        let _ = s.child.kill();
    }
    Ok(())
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}
