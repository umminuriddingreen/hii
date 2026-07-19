use std::{env, path::PathBuf};

pub const DEFAULT_MODEL: &str = "qwen3.6:27b-mlx";
pub const DEFAULT_REVIEW_MODEL: &str = "qwen3.6:35b-mlx";
pub const DEFAULT_MAX_STEPS: usize = 12;

#[derive(Clone, Debug)]
pub struct AppPaths {
    pub repo: PathBuf,
    pub runtime: PathBuf,
}

impl AppPaths {
    pub fn discover() -> Result<Self, String> {
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "HOME is not available".to_string())?;
        Ok(Self {
            repo: env::var_os("HII_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("hii")),
            runtime: env::var_os("HII_RUNTIME_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".hii")),
        })
    }

    pub fn ollama_url() -> String {
        std::env::var("HII_OLLAMA_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:11434".to_string())
            .trim_end_matches('/')
            .to_string()
    }
}
