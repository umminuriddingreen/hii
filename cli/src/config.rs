use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

pub const DEFAULT_MODEL: &str = "qwen3.6:35b-mlx";
pub const DEFAULT_REVIEW_MODEL: &str = "qwen3.6:35b-mlx";
/// HII Native names models by HuggingFace repo id, so an Ollama tag can never
/// match there. Each provider therefore carries its own default rather than
/// sharing one string that is only valid on one runtime.
pub const DEFAULT_NATIVE_MODEL: &str = "Qwen/Qwen3.6-35B-A3B";
pub const DEFAULT_NATIVE_REVIEW_MODEL: &str = "Qwen/Qwen3.6-35B-A3B";
/// Default tool-step ceiling. `--max-steps 0` still means unlimited, but leaving
/// it unlimited by default was unsafe unattended: nothing except the operator
/// stopped a model that never converged. The wall-clock budget bounds a run in
/// time; this bounds it in work.
pub const DEFAULT_MAX_STEPS: usize = 60;

/// Which local model runtime we are talking to. LM Studio and HII Native expose
/// OpenAI-compatible endpoints; Ollama uses its native API for richer local
/// metadata and streaming controls.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelProvider {
    Ollama,
    LmStudio,
    Native,
}

impl ModelProvider {
    /// Resolve the provider from `HII_MODEL_PROVIDER`, else infer from the URL
    /// (HII Native uses 11435 and LM Studio uses 1234), else default to Ollama.
    pub fn discover(url: &str) -> Self {
        match env::var("HII_MODEL_PROVIDER")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("lmstudio") | Some("lm-studio") | Some("lm_studio") => ModelProvider::LmStudio,
            Some("native") | Some("hii-native") | Some("hii_native") => ModelProvider::Native,
            Some("ollama") => ModelProvider::Ollama,
            _ if url.contains(":11435") => ModelProvider::Native,
            _ if url.contains(":1234") => ModelProvider::LmStudio,
            _ => ModelProvider::Ollama,
        }
    }

    /// The work model to use on this runtime when the operator names none.
    pub fn default_model(self) -> &'static str {
        match self {
            ModelProvider::Native => DEFAULT_NATIVE_MODEL,
            ModelProvider::Ollama | ModelProvider::LmStudio => DEFAULT_MODEL,
        }
    }

    /// The second-pass review model for this runtime.
    pub fn default_review_model(self) -> &'static str {
        match self {
            ModelProvider::Native => DEFAULT_NATIVE_REVIEW_MODEL,
            ModelProvider::Ollama | ModelProvider::LmStudio => DEFAULT_REVIEW_MODEL,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            ModelProvider::Ollama => "ollama",
            ModelProvider::LmStudio => "lmstudio",
            ModelProvider::Native => "native",
        }
    }
}

#[derive(Clone, Debug)]
pub struct AppPaths {
    pub repo: PathBuf,
    pub runtime: PathBuf,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct UserModelPreference {
    pub provider: Option<String>,
    pub model: String,
}

impl AppPaths {
    pub fn discover() -> Result<Self, String> {
        Ok(Self {
            repo: hii_core::default_workspace_root()?,
            runtime: hii_core::runtime_root()?,
        })
    }

    /// Base URL of the local model runtime. Honors `HII_MODEL_URL` first (the
    /// portable, provider-neutral name), then the legacy `HII_OLLAMA_URL`, then
    /// the Ollama default.
    pub fn model_url() -> String {
        env::var("HII_MODEL_URL")
            .or_else(|_| env::var("HII_OLLAMA_URL"))
            .unwrap_or_else(|_| "http://127.0.0.1:11434".to_string())
            .trim_end_matches('/')
            .to_string()
    }

    pub fn user_model_preference(&self) -> Result<Option<UserModelPreference>, String> {
        let path = self.runtime.join("config/model.json");
        if !path.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
        let preference: UserModelPreference =
            serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        if preference.model.trim().is_empty() {
            Ok(None)
        } else {
            Ok(Some(preference))
        }
    }

    pub fn save_user_model_preference(
        &self,
        provider: ModelProvider,
        model: &str,
    ) -> Result<PathBuf, String> {
        let path = self.runtime.join("config/model.json");
        ensure_parent(&path)?;
        let preference = UserModelPreference {
            provider: Some(provider.id().into()),
            model: model.trim().to_string(),
        };
        let raw = serde_json::to_string_pretty(&preference).map_err(|error| error.to_string())?;
        fs::write(&path, format!("{raw}\n")).map_err(|error| error.to_string())?;
        Ok(path)
    }
}

/// Cross-platform home directory. Uses `dirs::home_dir()` so it resolves
/// `USERPROFILE` on Windows and `HOME` on Unix.
pub fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "could not determine the home directory".to_string())
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}
