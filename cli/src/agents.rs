use crate::config::AppPaths;
use serde_json::Value;
use std::process::{Command, Stdio};

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

    /// Show only safe, user-facing provider state. Authentication files and
    /// account identifiers are intentionally never read by HII.
    pub fn providers(&self) -> Result<String, String> {
        let codex = provider_status("codex")?;
        let claude = provider_status("claude")?;
        Ok(format!(
            "local   HII · hardware-optimized private runtime\ncodex   {codex}\nclaude  {claude}\n\n/login codex  ·  /login claude\nCompatibility providers remain opt-in through explicit configuration."
        ))
    }

    /// Return the hosted model routes HII can invoke without claiming a full
    /// vendor catalog that the installed CLIs do not expose.
    pub fn model_routes(&self) -> Vec<(String, String, String)> {
        let codex = provider_status("codex").unwrap_or_else(|_| "unavailable".into());
        let claude = provider_status("claude").unwrap_or_else(|_| "unavailable".into());
        Self::hosted_model_routes()
            .into_iter()
            .map(|(provider, model)| {
                let status = if provider == "Codex" {
                    codex.as_str()
                } else {
                    claude.as_str()
                };
                (provider.into(), model.into(), status.into())
            })
            .collect()
    }

    pub fn hosted_model_choices() -> Vec<(String, String)> {
        Self::hosted_model_routes()
            .into_iter()
            .map(|(provider, model)| (provider.into(), model.into()))
            .collect()
    }

    /// Fast, no-auth-probe route list for keystroke-driven picker rendering.
    fn hosted_model_routes() -> Vec<(&'static str, &'static str)> {
        [
            ("Claude", "default"),
            ("Claude", "fable"),
            ("Claude", "opus"),
            ("Claude", "sonnet"),
            ("Codex", "default"),
        ]
        .into_iter()
        .collect()
    }

    /// Hand the terminal directly to the provider's official login flow. HII
    /// never accepts, proxies, logs, or stores the resulting credential.
    pub fn login(&self, provider: &str) -> Result<String, String> {
        let (program, args, label): (&str, &[&str], &str) = match provider.trim() {
            "codex" | "openai" => ("codex", &["login"], "Codex"),
            "claude" | "anthropic" => ("claude", &["auth", "login"], "Claude"),
            _ => return Err("login provider must be codex or claude".into()),
        };
        let status = Command::new(program)
            .args(args)
            .current_dir(&self.repo)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(|error| format!("could not open {label} login: {error}"))?;
        if !status.success() {
            return Err(format!("{label} login did not complete."));
        }
        Ok(format!(
            "{label} login complete. HII will use the authenticated CLI session."
        ))
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

fn provider_status(provider: &str) -> Result<String, String> {
    match provider {
        "codex" => {
            let output = match Command::new("codex").args(["login", "status"]).output() {
                Ok(output) => output,
                Err(_) => return Ok("not installed".into()),
            };
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            if !output.status.success() {
                return Ok("signed out · /login codex".into());
            }
            let method = if text.to_ascii_lowercase().contains("chatgpt") {
                "ChatGPT plan"
            } else {
                "authenticated"
            };
            Ok(format!("ready · {method}"))
        }
        "claude" => {
            let output = match Command::new("claude").args(["auth", "status"]).output() {
                Ok(output) => output,
                Err(_) => return Ok("not installed".into()),
            };
            if !output.status.success() {
                return Ok("signed out · /login claude".into());
            }
            let value: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
            if !value["loggedIn"].as_bool().unwrap_or(false) {
                return Ok("signed out · /login claude".into());
            }
            let plan = value["subscriptionType"]
                .as_str()
                .filter(|value| !value.is_empty())
                .map(|value| format!("{value} plan"))
                .unwrap_or_else(|| "authenticated".into());
            Ok(format!("ready · {plan}"))
        }
        _ => Err("unknown provider".into()),
    }
}
