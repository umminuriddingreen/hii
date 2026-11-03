//! Explicit, user-owned inference endpoint registry for `/engine`.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Engine {
    pub name: String,
    #[serde(default)]
    pub device: String,
    pub endpoint: String,
    pub protocol: String,
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub models: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelLoadState {
    Loaded,
    NotLoaded,
    Unknown,
    Unavailable(String),
}

pub fn model_load_state(
    selected: &str,
    running: Result<Option<Vec<String>>, String>,
) -> ModelLoadState {
    match running {
        Ok(Some(models)) if models.iter().any(|model| model == selected) => ModelLoadState::Loaded,
        Ok(Some(_)) => ModelLoadState::NotLoaded,
        Ok(None) => ModelLoadState::Unknown,
        Err(error) => ModelLoadState::Unavailable(error),
    }
}
#[derive(Default, Serialize, Deserialize)]
struct Registry {
    #[serde(default)]
    engines: Vec<Engine>,
}
pub fn defaults() -> Vec<Engine> {
    [
        ("mlx", "http://127.0.0.1:11435", "openai"),
        ("native", "http://127.0.0.1:11435", "openai"),
        ("lmstudio", "http://127.0.0.1:1234", "openai"),
        ("ollama", "http://127.0.0.1:11434", "ollama"),
        ("llamacpp", "http://127.0.0.1:6127", "openai"),
    ]
    .into_iter()
    .map(|(name, endpoint, protocol)| Engine {
        name: name.into(),
        device: "This device".into(),
        endpoint: endpoint.into(),
        protocol: protocol.into(),
        online: false,
        models: vec![],
    })
    .collect()
}
fn path(root: &Path) -> PathBuf {
    root.join("config/engines.json")
}
pub fn list(root: &Path) -> Result<Vec<Engine>, String> {
    let mut all = defaults();
    let p = path(root);
    if p.exists() {
        let raw = fs::read_to_string(p).map_err(|e| e.to_string())?;
        let saved: Registry =
            serde_json::from_str(&raw).map_err(|e| format!("invalid engine registry: {e}"))?;
        for e in saved.engines {
            all.retain(|x| x.name != e.name);
            all.push(e)
        }
    }
    Ok(all)
}
pub fn add(root: &Path, name: &str, endpoint: &str, protocol: &str) -> Result<Engine, String> {
    let name = name.trim();
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("engine name must use letters, numbers, _ or -".into());
    }
    let u = url::Url::parse(endpoint).map_err(|e| format!("invalid endpoint: {e}"))?;
    if !matches!(u.scheme(), "http" | "https")
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err(
            "endpoint must be an http(s) base URL without credentials, query, or fragment".into(),
        );
    }
    if !matches!(protocol, "openai" | "ollama") {
        return Err("protocol must be openai or ollama".into());
    }
    let mut engines = list(root)?;
    let item = Engine {
        name: name.into(),
        device: if name.starts_with("pc-") { "PC / hii-pc".into() } else { "Configured endpoint · executor unverified".into() },
        endpoint: endpoint.trim_end_matches('/').strip_suffix("/v1").unwrap_or(endpoint.trim_end_matches('/')).into(),
        protocol: protocol.into(),
        online: false,
        models: vec![],
    };
    engines.retain(|e| e.name != name);
    engines.push(item.clone());
    save(root, &engines)?;
    Ok(item)
}
pub fn save(root: &Path, engines: &[Engine]) -> Result<(), String> {
    let p = path(root);
    let parent = p.parent().unwrap();
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let raw = serde_json::to_vec_pretty(&Registry {
        engines: engines.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    fs::rename(tmp, p).map_err(|e| e.to_string())
}
pub fn probe(e: &Engine) -> Result<Vec<String>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(3))
        .timeout_write(Duration::from_secs(3))
        .build();
    let suffix = if e.protocol == "ollama" {
        "/api/tags"
    } else {
        "/v1/models"
    };
    let response = agent
        .get(&format!("{}{}", e.endpoint, suffix))
        .call()
        .map_err(|error| format!("{}: {error}", e.name))?;
    let value: serde_json::Value = response
        .into_json()
        .map_err(|error| format!("invalid model listing: {error}"))?;
    let models = if e.protocol == "ollama" {
        value["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m["name"].as_str())
            .map(str::to_owned)
            .collect()
    } else {
        value["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m["id"].as_str())
            .map(str::to_owned)
            .collect()
    };
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configured_endpoint_is_persisted_without_credentials() {
        let root = tempfile::tempdir().unwrap();
        let e = add(root.path(), "pc", "http://192.168.1.8:1234/v1", "openai").unwrap();
        assert_eq!(e.endpoint, "http://192.168.1.8:1234");
        assert!(list(root.path()).unwrap().iter().any(|x| x.name == "pc"));
        assert!(add(
            root.path(),
            "bad",
            "http://user:secret@example.test",
            "openai"
        )
        .is_err());
    }
    #[test]
    fn built_in_local_endpoints_are_visible_offline() {
        let root = tempfile::tempdir().unwrap();
        let all = list(root.path()).unwrap();
        assert_eq!(all.len(), 5);
        assert!(all.iter().all(|e| e.device == "This device"));
        for name in ["mlx", "native"] {
            assert!(all.iter().any(|e| {
                e.name == name
                    && e.endpoint == "http://127.0.0.1:11435"
                    && e.protocol == "openai"
            }));
        }
    }

    #[test]
    fn loaded_state_mapping_never_promotes_catalog_to_loaded() {
        assert_eq!(model_load_state("m", Ok(Some(vec!["m".into()]))), ModelLoadState::Loaded);
        assert_eq!(model_load_state("m", Ok(Some(vec![]))), ModelLoadState::NotLoaded);
        assert_eq!(model_load_state("m", Ok(None)), ModelLoadState::Unknown);
        assert_eq!(model_load_state("m", Err("timeout".into())), ModelLoadState::Unavailable("timeout".into()));
    }
}
