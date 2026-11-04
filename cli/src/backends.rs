// SPDX-License-Identifier: Apache-2.0
//! Named inference backends, independent of the server engine.
//!
//! The registry is reference-only: header values may be literal non-secret
//! values or `env:NAME` / `file:/path` references. Inspect output redacts all
//! header values, and credentials are resolved only for an outbound request.

use clap::Subcommand;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{collections::BTreeMap, fs, path::PathBuf};

const REGISTRY: &str = "config/openai-backends.json";
const ACTIVE: &str = "config/active-openai-backend";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backend {
    pub name: String,
    pub endpoint: String,
    #[serde(default = "default_protocol")]
    pub protocol: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub review_model: Option<String>,
    /// Named model aliases, for example `{ "fast": "model-id" }`.
    #[serde(default)]
    pub models: BTreeMap<String, String>,
    /// Arbitrary OpenAI-compatible request defaults merged before per-run values.
    #[serde(default)]
    pub defaults: Map<String, Value>,
    /// Header values can be plain strings or credential references.
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

fn default_protocol() -> String {
    "openai".into()
}

impl Default for Backend {
    fn default() -> Self {
        Self {
            name: String::new(),
            endpoint: String::new(),
            protocol: default_protocol(),
            model: None,
            review_model: None,
            models: BTreeMap::new(),
            defaults: Map::new(),
            headers: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct Registry {
    #[serde(default)]
    backends: Vec<Backend>,
}

fn config_path(relative: &str) -> Result<PathBuf, String> {
    Ok(hii_core::runtime_root()?.join(relative))
}

fn registry() -> Result<Registry, String> {
    let path = config_path(REGISTRY)?;
    if !path.exists() {
        return Ok(Registry::default());
    }
    let bytes = fs::read(&path).map_err(|e| format!("cannot read backend registry: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("invalid backend registry: {e}"))
}

fn save_registry(registry: &Registry) -> Result<(), String> {
    let path = config_path(REGISTRY)?;
    crate::store::write_json_private_atomic(&path, registry)
}

pub(crate) fn validate(backend: &Backend) -> Result<(), String> {
    if !matches!(backend.protocol.as_str(), "openai" | "ollama") {
        return Err("backend protocol must be openai or ollama".into());
    }
    if backend.name.trim().is_empty() || backend.name.chars().any(char::is_control) {
        return Err("backend name must be non-empty and contain no control characters".into());
    }
    let url = url::Url::parse(&backend.endpoint)
        .map_err(|_| "backend endpoint must be an http(s) URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("backend endpoint must use http(s) and must not contain credentials".into());
    }
    if backend.endpoint.contains(['\r', '\n']) {
        return Err("backend endpoint contains invalid line breaks".into());
    }
    for key in backend.headers.keys() {
        if key.is_empty() || key.contains(['\r', '\n', ':']) {
            return Err(format!("invalid HTTP header name: {key:?}"));
        }
    }
    for (name, value) in &backend.headers {
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "authorization" | "x-api-key"
        ) && !value.starts_with("env:")
            && !value.starts_with("file:")
        {
            return Err(format!(
                "sensitive header {name} must use an env:NAME or file:/path reference"
            ));
        }
    }
    Ok(())
}

pub fn list() -> Result<Vec<Backend>, String> {
    Ok(registry()?.backends)
}

pub fn get(name: &str) -> Result<Backend, String> {
    registry()?
        .backends
        .into_iter()
        .find(|b| b.name == name)
        .ok_or_else(|| format!("no backend named {name:?}"))
}

pub fn add(backend: Backend) -> Result<(), String> {
    validate(&backend)?;
    let mut value = registry()?;
    if value.backends.iter().any(|b| b.name == backend.name) {
        return Err(format!("backend {:?} already exists", backend.name));
    }
    value.backends.push(backend);
    save_registry(&value)
}

pub fn edit(name: &str, updated: Backend) -> Result<(), String> {
    validate(&updated)?;
    let mut value = registry()?;
    let Some(index) = value.backends.iter().position(|b| b.name == name) else {
        return Err(format!("no backend named {name:?}"));
    };
    if updated.name != name && value.backends.iter().any(|b| b.name == updated.name) {
        return Err(format!("backend {:?} already exists", updated.name));
    }
    value.backends[index] = updated;
    save_registry(&value)
}

pub fn remove(name: &str) -> Result<(), String> {
    let mut value = registry()?;
    let previous_len = value.backends.len();
    value.backends.retain(|b| b.name != name);
    if value.backends.len() == previous_len {
        return Err(format!("no backend named {name:?}"));
    }
    save_registry(&value)?;
    if selected()?.as_deref() == Some(name) {
        let _ = fs::remove_file(config_path(ACTIVE)?);
    }
    Ok(())
}

pub fn selected() -> Result<Option<String>, String> {
    let path = config_path(ACTIVE)?;
    match fs::read_to_string(path) {
        Ok(name) => Ok(Some(name.trim().to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("cannot read selected backend: {error}")),
    }
}

pub fn select(name: &str) -> Result<(), String> {
    let backend = get(name)?;
    validate(&backend)?;
    let path = config_path(ACTIVE)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, format!("{name}\n")).map_err(|e| format!("cannot select backend: {e}"))
}

pub fn active() -> Result<Option<Backend>, String> {
    selected()?.map(|name| get(&name)).transpose()
}

/// Redacted representation suitable for inspect/status output.
pub fn redacted(backend: &Backend) -> Value {
    let mut value = serde_json::to_value(backend).unwrap_or(Value::Null);
    if let Some(headers) = value.get_mut("headers").and_then(Value::as_object_mut) {
        for (key, val) in headers.iter_mut() {
            let text = val.as_str().unwrap_or_default();
            *val = Value::String(if text.starts_with("env:") || text.starts_with("file:") {
                "<credential reference configured>".into()
            } else {
                "<redacted>".into()
            });
            let _ = key;
        }
    }
    value
}

pub fn resolved_headers(backend: &Backend) -> Result<BTreeMap<String, String>, String> {
    backend
        .headers
        .iter()
        .map(|(name, reference)| {
            let value = if let Some(var) = reference.strip_prefix("env:") {
                std::env::var(var).map_err(|_| {
                    format!("backend header {name} references unset environment variable {var}")
                })?
            } else if let Some(path) = reference.strip_prefix("file:") {
                fs::read_to_string(path)
                    .map_err(|e| format!("cannot read credential file for header {name}: {e}"))?
                    .trim()
                    .to_string()
            } else {
                reference.clone()
            };
            if value.contains(['\r', '\n']) {
                return Err(format!(
                    "backend header {name} contains invalid line breaks"
                ));
            }
            Ok((name.clone(), value))
        })
        .collect()
}

/// Apply configured request defaults over protocol defaults. Adapter fields
/// supplied for an individual run (format/tool choice/think) are applied later.
pub fn apply_request_defaults(backend: &Backend, body: &mut Value) {
    if let Some(object) = body.as_object_mut() {
        for (key, value) in &backend.defaults {
            object.insert(key.clone(), value.clone());
        }
    }
}

pub fn resolve_model(backend: &Backend, requested: &str) -> String {
    backend
        .models
        .get(requested)
        .cloned()
        .unwrap_or_else(|| requested.to_string())
}

pub fn model_for_purpose(backend: &Backend, purpose: &str, fallback: &str) -> String {
    if purpose == "review" {
        backend
            .review_model
            .clone()
            .or_else(|| backend.model.clone())
    } else {
        backend.model.clone()
    }
    .unwrap_or_else(|| fallback.to_string())
}

/// Non-generative connection check against the OpenAI-compatible model catalog.
pub fn test(name: &str) -> Result<Vec<String>, String> {
    let backend = get(name)?;
    validate(&backend)?;
    if backend.protocol == "ollama" {
        return crate::ollama::Ollama::for_backend(name)?.models();
    }
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(std::time::Duration::from_secs(2))
        .timeout_read(std::time::Duration::from_secs(4))
        .build();
    let mut request = agent.get(&api_url(&backend.endpoint, "/models"));
    for (key, value) in resolved_headers(&backend)? {
        request = request.set(&key, &value);
    }
    #[derive(Deserialize)]
    struct Models {
        #[serde(default)]
        data: Vec<Model>,
    }
    #[derive(Deserialize)]
    struct Model {
        id: String,
    }
    let response: Models = request
        .call()
        .map_err(|e| format!("backend test failed: {e}"))?
        .into_json()
        .map_err(|e| format!("backend returned invalid model catalog: {e}"))?;
    Ok(response.data.into_iter().map(|m| m.id).collect())
}

pub fn api_url(endpoint: &str, route: &str) -> String {
    let base = endpoint.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}{route}")
    } else {
        format!("{base}/v1{route}")
    }
}

/// Reference-only preset; adding it never selects it or starts its server.
pub fn splash_preset() -> Backend {
    Backend {
        name: "splash".into(),
        endpoint: "http://127.0.0.1:8000".into(),
        protocol: default_protocol(),
        model: None,
        review_model: None,
        models: BTreeMap::new(),
        defaults: Map::new(),
        headers: BTreeMap::new(),
    }
}

#[derive(Subcommand, Debug)]
pub enum BackendCommand {
    /// List configured runtimes and the saved selection (no network requests).
    List,
    /// Register a runtime; this does not start or select it.
    Add {
        name: String,
        #[arg(long, value_name = "URL")]
        url: String,
        #[arg(long, default_value = "openai", value_parser = ["openai", "ollama"])]
        protocol: String,
        #[arg(long = "default-model", value_name = "MODEL")]
        model: Option<String>,
        /// Import defaults, aliases, and credential references from a JSON file.
        #[arg(long, value_name = "JSON_FILE")]
        config: Option<PathBuf>,
    },
    /// Select a saved runtime for subsequent chat and agent sessions.
    Use { name: String },
    /// Print one runtime with redacted credentials.
    Inspect { name: String },
    /// Fetch a model catalog; this does not prove inference works.
    Test { name: String },
    /// Remove a saved reference; leaves its server and models intact.
    Remove { name: String },
}

pub fn execute(command: BackendCommand) -> Result<(), String> {
    let value = match command {
        BackendCommand::List => serde_json::json!({
            "selected": selected()?,
            "backends": list()?.iter().map(redacted).collect::<Vec<_>>()
        }),
        BackendCommand::Add {
            name,
            url,
            protocol,
            model,
            config,
        } => {
            let mut backend: Backend = if let Some(path) = config {
                serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
                    .map_err(|error| format!("invalid backend configuration: {error}"))?
            } else {
                Backend {
                    protocol,
                    ..Backend::default()
                }
            };
            backend.name = name;
            backend.endpoint = url;
            if model.is_some() {
                backend.model = model;
            }
            add(backend.clone())?;
            redacted(&backend)
        }
        BackendCommand::Use { name } => {
            select(&name)?;
            serde_json::json!({"selected": name, "appliesTo": "new sessions", "environmentOverrides": ["HII_MODEL_URL", "HII_MODEL_PROVIDER", "HII_MODEL"]})
        }
        BackendCommand::Inspect { name } => redacted(&get(&name)?),
        BackendCommand::Test { name } => {
            serde_json::json!({"backend": name, "advertisedModels": test(&name)?, "inferenceVerified": false})
        }
        BackendCommand::Remove { name } => {
            remove(&name)?;
            serde_json::json!({"removedReference": name})
        }
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_backend_protocols_preserve_legacy_and_support_ollama() {
        let legacy: Backend =
            serde_json::from_str(r#"{"name":"splash","endpoint":"http://localhost:1111"}"#)
                .unwrap();
        assert_eq!(serde_json::to_value(legacy).unwrap()["protocol"], "openai");
        let ollama: Backend = serde_json::from_str(
            r#"{"name":"ollama","endpoint":"http://localhost:11434","protocol":"ollama"}"#,
        )
        .unwrap();
        assert_eq!(serde_json::to_value(ollama).unwrap()["protocol"], "ollama");
    }

    #[test]
    fn runtime_backend_rejects_unsupported_protocols() {
        let backend: Backend = serde_json::from_str(
            r#"{"name":"bad","endpoint":"http://localhost:8000","protocol":"unsupported"}"#,
        )
        .unwrap();
        assert!(validate(&backend).is_err());
    }

    #[test]
    fn credential_values_are_redacted_and_references_are_not_resolved_for_inspect() {
        let backend = Backend {
            name: "demo".into(),
            endpoint: "http://127.0.0.1:8000/v1".into(),
            headers: BTreeMap::from([
                ("Authorization".into(), "env:DEMO_TOKEN".into()),
                ("X-Trace".into(), "trace-value".into()),
            ]),
            ..Backend::default()
        };
        let value = redacted(&backend);
        assert_eq!(
            value["headers"]["Authorization"],
            "<credential reference configured>"
        );
        assert_eq!(value["headers"]["X-Trace"], "<redacted>");
    }

    #[test]
    fn backend_defaults_apply_and_v1_endpoints_are_not_doubled() {
        let mut defaults = Map::new();
        defaults.insert("temperature".into(), Value::from(0.2));
        let backend = Backend {
            defaults,
            ..Backend::default()
        };
        let mut body = serde_json::json!({"temperature": 0.1, "stream": true});
        apply_request_defaults(&backend, &mut body);
        assert_eq!(body["temperature"], 0.2);
        assert!(body["stream"].as_bool().unwrap());
        assert_eq!(
            api_url("http://localhost:8000/v1", "/models"),
            "http://localhost:8000/v1/models"
        );
        assert_eq!(
            api_url("http://localhost:8000", "/models"),
            "http://localhost:8000/v1/models"
        );
    }
}
