//! Helium — the internal browser pane.
//!
//! The frontend creates a child webview labeled "helium" inside the main
//! window (multiwebview, tauri `unstable` feature) and positions it over the
//! browser view's placeholder. These commands drive navigation since child
//! webviews can only be navigated from the Rust side.
//!
//! TODO(phase-8): "Open PR" / "Open Diff" buttons route their URLs here.

use tauri::{AppHandle, Manager};

const HELIUM_LABEL: &str = "helium";

#[tauri::command]
pub fn browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    match app.webviews().get(HELIUM_LABEL) {
        Some(webview) => webview.navigate(parsed).map_err(|e| e.to_string()),
        None => Err("helium webview is not open".into()),
    }
}

#[tauri::command]
pub fn browser_current_url(app: AppHandle) -> Option<String> {
    app.webviews()
        .get(HELIUM_LABEL)
        .and_then(|w| w.url().ok())
        .map(|u| u.to_string())
}
