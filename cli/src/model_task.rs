// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Task-boundary coordination for HII-owned adaptive NVIDIA runtimes.
use crate::config::AppPaths;
use serde_json::Value;
use std::process::{Command, Stdio};

pub struct ModelTask {
    paths: AppPaths,
    id: String,
    pub report: Value,
}

impl ModelTask {
    pub fn acquire(paths: &AppPaths, pinned: bool, deep: bool) -> Result<Option<Self>, String> {
        let Some(config) = crate::config::inference_config() else {
            return Ok(None);
        };
        if pinned
            || std::env::var_os("HII_MODEL").is_some()
            || config.profile.as_deref() != Some("adaptive")
            || !matches!(
                config.backend.as_deref(),
                Some("native-cuda" | "wsl-cuda" | "wsl-vllm")
            )
            || std::env::var("HII_MODEL_URL").ok().is_some_and(|url| {
                url.trim_end_matches('/') != config.endpoint.trim_end_matches('/')
            })
        {
            return Ok(None);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mut task = Self {
            paths: paths.clone(),
            id,
            report: Value::Null,
        };
        let output = task
            .command("prepare-task")
            .args(["--task-class", if deep { "deep" } else { "interactive" }])
            .output()
            .map_err(|error| format!("cannot prepare model task: {error}"))?;
        let report: Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| "model task supervisor returned an invalid response; run `hii runner model doctor --json`".to_string())?;
        task.report = report;
        if !output.status.success()
            || task.report["acquired"] != true
            || task.report["state"] != "ready"
        {
            return Err(format!(
                "Model task is waiting: {}",
                task.report["reason"]
                    .as_str()
                    .or(task.report["message"].as_str())
                    .unwrap_or("runtime unavailable; retry after the active task finishes")
            ));
        }
        Ok(Some(task))
    }

    fn command(&self, action: &str) -> Command {
        let mut command = Command::new("node");
        command
            .arg(self.paths.repo.join("aii/daemon/hiid.mjs"))
            .args([
                "model-runtime",
                action,
                "--task-id",
                &self.id,
                "--owner-pid",
                &std::process::id().to_string(),
            ])
            .env("HII_ROOT", &self.paths.repo)
            .env("HII_RUNTIME_DIR", &self.paths.runtime)
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
    }
}

impl Drop for ModelTask {
    fn drop(&mut self) {
        let _ = self.command("finish-task").stdout(Stdio::null()).status();
    }
}
