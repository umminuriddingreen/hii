use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliSettings {
    #[serde(default = "default_view")]
    pub conversation_view: String,
    #[serde(default = "default_inline_images")]
    pub inline_images: String,
}

impl Default for CliSettings {
    fn default() -> Self {
        Self {
            conversation_view: default_view(),
            inline_images: default_inline_images(),
        }
    }
}

fn default_view() -> String {
    "stream".into()
}
fn default_inline_images() -> String {
    "auto".into()
}

fn path(runtime: &Path) -> PathBuf {
    runtime.join("config").join("cli.json")
}

pub fn load(runtime: &Path) -> CliSettings {
    fs::read_to_string(path(runtime))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn describe(runtime: &Path) -> String {
    let value = load(runtime);
    format!(
        "CLI SETTINGS\noutput              continuous stream (legacy view: {})\ninline-images       {}\n\nChange: /settings inline-images auto|on|off\nLegacy conversation-view values all use the continuous stream.",
        value.conversation_view, value.inline_images
    )
}

pub fn set(runtime: &Path, key: &str, value: &str) -> Result<CliSettings, String> {
    let mut settings = load(runtime);
    match key.trim().to_ascii_lowercase().replace('_', "-").as_str() {
        "conversation-view" | "view" => {
            let value = value.trim().to_ascii_lowercase();
            if !matches!(
                value.as_str(),
                "conversation" | "stream" | "flow" | "activity" | "diagnostics"
            ) {
                return Err("conversation-view must be conversation, stream, flow, activity, or diagnostics".into());
            }
            settings.conversation_view = value;
        }
        "inline-images" | "images" => {
            let value = value.trim().to_ascii_lowercase();
            if !matches!(value.as_str(), "auto" | "on" | "off") {
                return Err("inline-images must be auto, on, or off".into());
            }
            settings.inline_images = value;
        }
        _ => return Err("unknown setting; use conversation-view or inline-images".into()),
    }
    let file = path(runtime);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(file, format!("{raw}\n")).map_err(|e| e.to_string())?;
    Ok(settings)
}
