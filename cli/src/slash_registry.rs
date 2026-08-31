// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Hot-reloaded slash controls backed by HII's delegated CLI surface.

use serde::Deserialize;
use std::{fs, path::PathBuf};

#[derive(Clone, Debug, Deserialize)]
pub struct SlashControl {
    pub name: String,
    pub description: String,
    #[serde(rename = "argvPrefix")]
    pub argv_prefix: Vec<String>,
}

fn registry_path() -> Option<PathBuf> {
    std::env::var_os("HII_RUNTIME_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".hii")))
        .map(|root| root.join("cli").join("slash-commands.json"))
}

pub fn controls() -> Vec<SlashControl> {
    let Some(path) = registry_path() else {
        return Vec::new();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn resolve(command: &str, rest: &str) -> Option<Vec<String>> {
    let name = command.trim_start_matches('/');
    controls()
        .into_iter()
        .find(|entry| entry.name == name)
        .map(|entry| {
            entry
                .argv_prefix
                .into_iter()
                .chain(rest.split_whitespace().map(str::to_string))
                .collect()
        })
}
