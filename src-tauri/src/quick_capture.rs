//! The small, trusted entry point that brings content into the active canvas.

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;

const MAX_CAPTURE_CHARS: usize = 100_000;

fn require_capture_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "capture" {
        Ok(())
    } else {
        Err("quick capture is restricted to its own window".into())
    }
}

pub fn open(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("capture")
        .ok_or_else(|| "quick capture window is unavailable".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    app.emit_to("capture", "hii:quick-capture:open", ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn quick_capture_clipboard(window: WebviewWindow, app: AppHandle) -> Result<String, String> {
    require_capture_window(&window)?;
    // Reading is tied to an explicit invocation of the capture window.
    Ok(app.clipboard().read_text().unwrap_or_default())
}

#[tauri::command]
pub fn quick_capture_save(
    window: WebviewWindow,
    app: AppHandle,
    text: String,
    capture_id: String,
) -> Result<(), String> {
    require_capture_window(&window)?;
    let value = text.trim();
    if value.is_empty() || value.chars().count() > MAX_CAPTURE_CHARS {
        return Err("quick capture needs 1 to 100,000 characters".into());
    }
    if capture_id.is_empty() || capture_id.len() > 128 || !capture_id.is_ascii() {
        return Err("invalid quick capture identifier".into());
    }
    app.emit_to(
        "main",
        "hii:quick-capture",
        serde_json::json!({ "text": value, "captureId": capture_id }),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn quick_capture_hide(window: WebviewWindow) -> Result<(), String> {
    require_capture_window(&window)?;
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn quick_capture_open_main(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    require_capture_window(&window)?;
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "HII canvas window is unavailable".to_string())?;
    main.show().map_err(|error| error.to_string())?;
    main.set_focus().map_err(|error| error.to_string())?;
    window.hide().map_err(|error| error.to_string())
}
