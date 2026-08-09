use std::{env, path::PathBuf};

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
}

/// Cross-platform home directory. Uses `dirs::home_dir()` so it resolves
/// `USERPROFILE` on Windows and `HOME` on Unix.
pub fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "could not determine the home directory".to_string())
}
