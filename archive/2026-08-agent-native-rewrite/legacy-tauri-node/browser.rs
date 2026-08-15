//! Native browser child-webviews embedded inside the canonical HII workspace.
//!
//! The main HII webview owns all controls and state. Remote pages are confined
//! to uniquely labelled child-webviews and can only be navigated to http(s)
//! URLs through this bounded command.

use tauri::{AppHandle, Manager};

const BROWSER_LABEL_PREFIX: &str = "hii-browser-";

#[tauri::command]
pub fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    if !label.starts_with(BROWSER_LABEL_PREFIX) {
        return Err("invalid HII browser label".into());
    }

    let parsed: tauri::Url = url
        .parse()
        .map_err(|error| format!("invalid url: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("HII browser navigation requires an http(s) URL".into());
    }

    match app.webviews().get(&label) {
        Some(webview) => webview.navigate(parsed).map_err(|error| error.to_string()),
        None => Err("embedded HII browser is not open".into()),
    }
}
