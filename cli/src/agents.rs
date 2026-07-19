use crate::config::AppPaths;
use std::process::Command;

pub struct AgentManager {
    hiid: std::path::PathBuf,
    repo: std::path::PathBuf,
}

impl AgentManager {
    pub fn new(paths: &AppPaths) -> Self {
        Self {
            hiid: paths.repo.join("aii/daemon/hiid.mjs"),
            repo: paths.repo.clone(),
        }
    }

    pub fn list(&self) -> Result<String, String> {
        let raw = self.run(&["instances"])?;
        let active = raw
            .lines()
            .filter(|line| {
                line.split_whitespace().nth(1).is_some_and(|status| {
                    matches!(status, "running" | "queued" | "blocked" | "starting")
                })
            })
            .take(30)
            .collect::<Vec<_>>();
        Ok(if active.is_empty() {
            "No active HII agent sessions.".into()
        } else {
            active.join("\n")
        })
    }

    pub fn codex(&self, task: &str) -> Result<String, String> {
        if task.trim().is_empty() {
            return self.run(&["codex", "status"]);
        }
        self.run(&["codex", "run", task])
    }

    pub fn claude(&self, task: &str) -> Result<String, String> {
        if task.trim().is_empty() {
            return self.run(&["claude", "status"]);
        }
        self.run(&["claude", "run", task])
    }

    pub fn operate(&self, id: &str, action: &str) -> Result<String, String> {
        if id.starts_with("codex-") || id.starts_with("codex:") {
            let id = id.strip_prefix("codex:").unwrap_or(id);
            return match action {
                "status" => self.run(&["codex", "status"]),
                "logs" => self.run(&["codex", "logs", id]),
                "stop" => self.run(&["codex", "stop", id]),
                _ => Err("agent action must be status, logs, or stop".into()),
            };
        }
        if id.starts_with("claude") {
            return match action {
                "status" => self.run(&["claude", "status"]),
                "logs" | "stop" => Err(format!(
                    "Claude's installed session backend does not safely expose {action} by HII id yet. Use /claude to inspect sessions."
                )),
                _ => Err("agent action must be status, logs, or stop".into()),
            };
        }
        Err("use a codex-* or claude* agent id from /agents".into())
    }

    fn run(&self, args: &[&str]) -> Result<String, String> {
        let output = Command::new("node")
            .arg(&self.hiid)
            .args(args)
            .current_dir(&self.repo)
            .output()
            .map_err(|error| format!("could not start the HII supervisor: {error}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if output.status.success() {
            Ok(if stdout.is_empty() {
                "Done.".into()
            } else {
                stdout
            })
        } else {
            Err(if stderr.is_empty() { stdout } else { stderr })
        }
    }
}
