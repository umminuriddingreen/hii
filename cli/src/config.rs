use std::{env, path::PathBuf};

pub const DEFAULT_MODEL: &str = "qwen3.6:27b-mlx";
pub const DEFAULT_REVIEW_MODEL: &str = "qwen3.6:35b-mlx";
pub const DEFAULT_MAX_STEPS: usize = 12;

/// Which local model runtime we are talking to. Both expose an OpenAI-compatible
/// `/v1/chat/completions` endpoint that carries native tool-calling; they differ
/// in the model-listing endpoint and default port.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelProvider {
    Ollama,
    LmStudio,
}

impl ModelProvider {
    /// Resolve the provider from `HII_MODEL_PROVIDER`, else infer from the URL
    /// (LM Studio conventionally serves on port 1234), else default to Ollama.
    pub fn discover(url: &str) -> Self {
        match env::var("HII_MODEL_PROVIDER")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("lmstudio") | Some("lm-studio") | Some("lm_studio") => ModelProvider::LmStudio,
            Some("ollama") => ModelProvider::Ollama,
            _ if url.contains(":1234") => ModelProvider::LmStudio,
            _ => ModelProvider::Ollama,
        }
    }
}

#[derive(Clone, Debug)]
pub struct AppPaths {
    pub repo: PathBuf,
    pub runtime: PathBuf,
}

impl AppPaths {
    pub fn discover() -> Result<Self, String> {
        let home = home_dir()?;
        Ok(Self {
            repo: env::var_os("HII_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("hii")),
            runtime: env::var_os("HII_RUNTIME_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".hii")),
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

    /// Backwards-compatible alias retained for existing call sites.
    pub fn ollama_url() -> String {
        Self::model_url()
    }
}

/// Cross-platform home directory. Uses `dirs::home_dir()` so it resolves
/// `USERPROFILE` on Windows and `HOME` on Unix.
pub fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "could not determine the home directory".to_string())
}
