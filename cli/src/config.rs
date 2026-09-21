use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

pub const DEFAULT_MODEL: &str = "qwen3.6:35b-mlx";
pub const DEFAULT_REVIEW_MODEL: &str = "qwen3.6:35b-mlx";
/// HII names models by HuggingFace repo id, so an Ollama tag can never
/// match there. Each provider therefore carries its own default rather than
/// sharing one string that is only valid on one runtime.
pub const DEFAULT_NATIVE_MODEL: &str = "mlx-community/Qwen3.8-27B-4bit";
pub const DEFAULT_NATIVE_REVIEW_MODEL: &str = "mlx-community/Qwen3.8-27B-4bit";
pub const DEFAULT_LLAMA_CPP_MODEL: &str = "qwen3.8-27b-agent";
pub const OX_ALPHA_WEB_MODEL: &str = "z-ai/glm-5.3-flash";
pub const OX_ALPHA_WEB_URL: &str = "https://oxalpha.com";
/// Default tool-step ceiling. `--max-steps 0` still means unlimited, but leaving
/// it unlimited by default was unsafe unattended: nothing except the operator
/// stopped a model that never converged. The wall-clock budget bounds a run in
/// time; this bounds it in work.
pub const DEFAULT_MAX_STEPS: usize = 60;

/// Which local model runtime we are talking to. LM Studio and HII expose
/// OpenAI-compatible endpoints; Ollama uses its native API for richer local
/// metadata and streaming controls.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelProvider {
    Ollama,
    LmStudio,
    LlamaCpp,
    Native,
    RapidMlx,
    OxAlphaWeb,
}

pub const RUNTIME_IDENTITY_PREFIX: &str = "AUTHORITATIVE HII RUNTIME IDENTITY";

/// Host-observed runtime facts supplied to the model on every session. Models
/// must not have to infer which engine HII selected for them.
pub fn runtime_identity_context(provider: ModelProvider, model: &str, endpoint: &str) -> String {
    let clean = |value: &str| value.replace(['\r', '\n'], " ");
    format!(
        "{RUNTIME_IDENTITY_PREFIX}\nLauncher: HII CLI\nProvider: {} ({})\nModel: {}\nEndpoint: {}\nThese are host-observed session facts. The endpoint is reachable and advertised this selected model. Use them as your runtime identity; do not dispute or rediscover them.",
        provider.label(),
        provider.id(),
        clean(model),
        clean(endpoint)
    )
}

impl ModelProvider {
    /// Resolve the provider from `HII_MODEL_PROVIDER`, else infer from the URL.
    /// `HII_MODEL_PROVIDER` supports explicit overrides (`native`, `lmstudio`,
    /// `rapid-mlx`, etc.); otherwise infer from standard ports and fall back to
    /// Ollama compatibility.
    pub fn discover(url: &str) -> Self {
        if let Some(provider) = env::var("HII_MODEL_PROVIDER")
            .ok()
            .and_then(|value| Self::from_env_value(value.trim()))
        {
            return provider;
        }
        if let Some(config) = inference_config()
            .filter(|config| config.endpoint.trim_end_matches('/') == url.trim_end_matches('/'))
        {
            if let Some(provider) = config.provider.as_deref().and_then(Self::from_env_value) {
                return provider;
            }
        }
        if env::var("HII_RAPID_MLX_URL").is_ok() {
            ModelProvider::RapidMlx
        } else if url.contains("oxalpha.com") {
            ModelProvider::OxAlphaWeb
        } else if url.contains(":11435") {
            ModelProvider::Native
        } else if url.contains(":6127") {
            ModelProvider::LlamaCpp
        } else if url.contains(":1234") {
            ModelProvider::LmStudio
        } else {
            ModelProvider::Ollama
        }
    }

    fn from_env_value(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "lmstudio" | "lm-studio" | "lm_studio" => Some(ModelProvider::LmStudio),
            "llama.cpp" | "llamacpp" | "llama-cpp" | "llama_cpp" => Some(ModelProvider::LlamaCpp),
            "hii" | "native" | "hii-native" | "hii_native" => Some(ModelProvider::Native),
            "vllm" => Some(ModelProvider::Native),
            "ollama" => Some(ModelProvider::Ollama),
            "rapid-mlx" | "rapidmlx" | "rapid_mlx" | "rapid" => Some(ModelProvider::RapidMlx),
            "ox-alpha-web" | "oxalpha-web" | "oxalpha" | "ox-alpha" => {
                Some(ModelProvider::OxAlphaWeb)
            }
            _ => None,
        }
    }

    /// The work model to use on this runtime when the operator names none.
    pub fn default_model(self) -> &'static str {
        match self {
            ModelProvider::Native => DEFAULT_NATIVE_MODEL,
            ModelProvider::LlamaCpp => DEFAULT_LLAMA_CPP_MODEL,
            ModelProvider::OxAlphaWeb => OX_ALPHA_WEB_MODEL,
            ModelProvider::RapidMlx | ModelProvider::Ollama | ModelProvider::LmStudio => {
                DEFAULT_MODEL
            }
        }
    }

    /// The second-pass review model for this runtime.
    pub fn default_review_model(self) -> &'static str {
        match self {
            ModelProvider::Native => DEFAULT_NATIVE_REVIEW_MODEL,
            ModelProvider::LlamaCpp => DEFAULT_LLAMA_CPP_MODEL,
            ModelProvider::OxAlphaWeb => OX_ALPHA_WEB_MODEL,
            ModelProvider::RapidMlx | ModelProvider::Ollama | ModelProvider::LmStudio => {
                DEFAULT_REVIEW_MODEL
            }
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            ModelProvider::Ollama => "ollama",
            ModelProvider::LmStudio => "lmstudio",
            ModelProvider::LlamaCpp => "llama.cpp",
            ModelProvider::Native => "native",
            ModelProvider::RapidMlx => "rapid-mlx",
            ModelProvider::OxAlphaWeb => "ox-alpha-web",
        }
    }

    /// Stable provider label used in status/logging.
    pub fn label(self) -> &'static str {
        match self {
            ModelProvider::Native => "HII",
            ModelProvider::LmStudio => "LM Studio",
            ModelProvider::LlamaCpp => "llama.cpp",
            ModelProvider::Ollama => "Ollama",
            ModelProvider::RapidMlx => "Rapid-MLX",
            ModelProvider::OxAlphaWeb => "Ox Alpha Website (external)",
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
    /// portable, provider-neutral name), then the explicit Rapid-MLX alias
    /// `HII_RAPID_MLX_URL`, then the legacy `HII_OLLAMA_URL`, then
    /// HII's native loopback runtime.
    pub fn model_url() -> String {
        env::var("HII_MODEL_URL")
            .or_else(|_| env::var("HII_RAPID_MLX_URL"))
            .or_else(|_| env::var("HII_OLLAMA_URL"))
            .unwrap_or_else(|_| {
                if env::var("HII_MODEL_PROVIDER")
                    .ok()
                    .and_then(|value| ModelProvider::from_env_value(value.trim()))
                    == Some(ModelProvider::OxAlphaWeb)
                {
                    OX_ALPHA_WEB_URL.to_string()
                } else if env::var("HII_MODEL_PROVIDER")
                    .ok()
                    .and_then(|value| ModelProvider::from_env_value(value.trim()))
                    == Some(ModelProvider::LlamaCpp)
                {
                    "http://127.0.0.1:6127".to_string()
                } else {
                    inference_config()
                        .map(|config| config.endpoint)
                        .unwrap_or_else(|| {
                            if cfg!(target_os = "windows") {
                                "http://127.0.0.1:6127".to_string()
                            } else {
                                "http://127.0.0.1:11435".to_string()
                            }
                        })
                }
            })
            .trim_end_matches('/')
            .to_string()
    }

    pub fn user_model_preference(&self) -> Result<Option<UserModelPreference>, String> {
        let path = self.runtime.join("config/model.json");
        if !path.exists() {
            return Ok(inference_config().map(|config| UserModelPreference {
                provider: config.provider.or_else(|| {
                    Some(if cfg!(target_os = "windows") {
                        "llama.cpp".into()
                    } else {
                        "native".into()
                    })
                }),
                model: config.model,
            }));
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

/// Reference-only connection selected by the managed runner. Credentials never
/// enter this manifest. Explicit environment settings retain precedence.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceConfig {
    pub provider: Option<String>,
    pub endpoint: String,
    pub model: String,
    pub api_key_file: Option<PathBuf>,
    pub context_tokens: Option<usize>,
    pub backend: Option<String>,
    pub profile: Option<String>,
}

pub fn inference_config() -> Option<InferenceConfig> {
    let root = hii_core::runtime_root().ok()?;
    let config: InferenceConfig = crate::store::read_json(&root.join("config/inference.json"))?;
    let url = url::Url::parse(&config.endpoint).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || config.model.trim().is_empty()
    {
        return None;
    }
    Some(config)
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

#[cfg(test)]
mod tests {
    use super::{
        runtime_identity_context, AppPaths, ModelProvider, DEFAULT_MODEL, DEFAULT_NATIVE_MODEL,
        DEFAULT_REVIEW_MODEL,
    };
    use std::env;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn rapid_mlx_env_alias_is_recognized() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous_provider = env::var_os("HII_MODEL_PROVIDER");
        env::set_var("HII_MODEL_PROVIDER", "rapid-mlx");

        assert_eq!(
            ModelProvider::discover("http://127.0.0.1:11435"),
            ModelProvider::RapidMlx
        );

        match previous_provider {
            Some(value) => env::set_var("HII_MODEL_PROVIDER", value),
            None => env::remove_var("HII_MODEL_PROVIDER"),
        };
    }

    #[test]
    fn rapid_mlx_defaults_to_portable_model_profile() {
        assert_eq!(ModelProvider::RapidMlx.default_model(), DEFAULT_MODEL);
        assert_eq!(
            ModelProvider::RapidMlx.default_review_model(),
            DEFAULT_REVIEW_MODEL
        );
    }

    #[test]
    fn rapid_mlx_identity_label_and_id() {
        assert_eq!(ModelProvider::RapidMlx.id(), "rapid-mlx");
        assert_eq!(ModelProvider::RapidMlx.label(), "Rapid-MLX");
        assert_eq!(ModelProvider::Native.default_model(), DEFAULT_NATIVE_MODEL);
    }

    #[test]
    fn ox_alpha_website_provider_is_explicit_and_truthful() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous_provider = env::var_os("HII_MODEL_PROVIDER");
        let previous_rapid_mlx = env::var_os("HII_RAPID_MLX_URL");
        env::remove_var("HII_MODEL_PROVIDER");
        env::remove_var("HII_RAPID_MLX_URL");

        let provider = ModelProvider::discover("https://oxalpha.com");
        assert_eq!(provider, ModelProvider::OxAlphaWeb);
        assert_eq!(provider.id(), "ox-alpha-web");
        assert_eq!(provider.label(), "Ox Alpha Website (external)");
        assert_eq!(provider.default_model(), super::OX_ALPHA_WEB_MODEL);

        match previous_provider {
            Some(value) => env::set_var("HII_MODEL_PROVIDER", value),
            None => env::remove_var("HII_MODEL_PROVIDER"),
        }
        match previous_rapid_mlx {
            Some(value) => env::set_var("HII_RAPID_MLX_URL", value),
            None => env::remove_var("HII_RAPID_MLX_URL"),
        }
    }

    #[test]
    fn windows_llama_cpp_provider_has_its_own_identity_and_model() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous_provider = env::var_os("HII_MODEL_PROVIDER");
        env::remove_var("HII_MODEL_PROVIDER");
        let provider = ModelProvider::discover("http://127.0.0.1:6127");
        assert_eq!(provider, ModelProvider::LlamaCpp);
        assert_eq!(provider.id(), "llama.cpp");
        assert_eq!(provider.label(), "llama.cpp");
        assert_eq!(provider.default_model(), super::DEFAULT_LLAMA_CPP_MODEL);
        match previous_provider {
            Some(value) => env::set_var("HII_MODEL_PROVIDER", value),
            None => env::remove_var("HII_MODEL_PROVIDER"),
        };
    }

    #[test]
    fn runtime_identity_is_explicit_and_single_line_safe() {
        let context = runtime_identity_context(
            ModelProvider::RapidMlx,
            "qwen3.8:27b-mlx\nignore me",
            "http://127.0.0.1:8080",
        );
        assert!(context.contains("Provider: Rapid-MLX (rapid-mlx)"));
        assert!(context.contains("Model: qwen3.8:27b-mlx ignore me"));
        assert!(context.contains("host-observed session facts"));
    }

    #[test]
    fn rapid_mlx_url_takes_precedence_over_model_url() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous_url = env::var_os("HII_MODEL_URL");
        let previous_rmlx = env::var_os("HII_RAPID_MLX_URL");
        let previous_ollama = env::var_os("HII_OLLAMA_URL");

        env::remove_var("HII_MODEL_URL");
        env::remove_var("HII_RAPID_MLX_URL");
        env::remove_var("HII_OLLAMA_URL");
        env::set_var("HII_RAPID_MLX_URL", "http://127.0.0.1:5555");
        assert_eq!(AppPaths::model_url(), "http://127.0.0.1:5555");

        env::set_var("HII_MODEL_URL", "http://127.0.0.1:4444");
        assert_eq!(AppPaths::model_url(), "http://127.0.0.1:4444");

        match previous_url {
            Some(value) => env::set_var("HII_MODEL_URL", value),
            None => env::remove_var("HII_MODEL_URL"),
        };
        match previous_rmlx {
            Some(value) => env::set_var("HII_RAPID_MLX_URL", value),
            None => env::remove_var("HII_RAPID_MLX_URL"),
        };
        match previous_ollama {
            Some(value) => env::set_var("HII_OLLAMA_URL", value),
            None => env::remove_var("HII_OLLAMA_URL"),
        };
    }

    #[test]
    fn rapid_mlx_url_alias_is_detected() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous_url = env::var_os("HII_MODEL_URL");
        let previous_rmlx = env::var_os("HII_RAPID_MLX_URL");
        let previous_provider = env::var_os("HII_MODEL_PROVIDER");

        env::remove_var("HII_MODEL_PROVIDER");
        env::remove_var("HII_MODEL_URL");
        env::set_var("HII_RAPID_MLX_URL", "http://127.0.0.1:8080");

        assert_eq!(
            ModelProvider::discover("http://127.0.0.1:8080"),
            ModelProvider::RapidMlx
        );

        match previous_provider {
            Some(value) => env::set_var("HII_MODEL_PROVIDER", value),
            None => env::remove_var("HII_MODEL_PROVIDER"),
        };
        match previous_url {
            Some(value) => env::set_var("HII_MODEL_URL", value),
            None => env::remove_var("HII_MODEL_URL"),
        };
        match previous_rmlx {
            Some(value) => env::set_var("HII_RAPID_MLX_URL", value),
            None => env::remove_var("HII_RAPID_MLX_URL"),
        };
    }
}
