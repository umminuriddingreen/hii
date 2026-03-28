use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use colored::*;
use std::env;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// HII — the self-healing persistence engine
#[derive(Parser)]
#[command(name = "hii", version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Start the HII dashboard server
    Serve,

    /// Daemon management
    Daemon {
        #[command(subcommand)]
        action: DaemonAction,
    },

    /// Skill registry operations
    Skill {
        #[command(subcommand)]
        action: SkillAction,
    },

    /// Task queue operations
    Task {
        #[command(subcommand)]
        action: TaskAction,
    },

    /// Bridge messaging
    Bridge {
        #[command(subcommand)]
        action: BridgeAction,
    },

    /// Add an observation to the psyche model
    Observe {
        /// The observation text
        text: Vec<String>,
    },

    /// Show version info
    Version,
}

#[derive(Subcommand)]
enum DaemonAction {
    Start,
    Stop,
    Status,
}

#[derive(Subcommand)]
enum SkillAction {
    /// List all registered skills
    List,
    /// Search skills by query
    Search {
        query: String,
    },
    /// Run a skill by name
    Run {
        name: String,
        /// Arguments to pass to the skill
        args: Vec<String>,
    },
}

#[derive(Subcommand)]
enum TaskAction {
    /// Add a new task
    Add {
        /// Task description
        description: Vec<String>,
    },
    /// List all tasks
    List,
}

#[derive(Subcommand)]
enum BridgeAction {
    /// Send a message through the bridge
    Send {
        /// Message text
        message: Vec<String>,
    },
    /// Read bridge messages
    Read,
}

fn hii_root() -> PathBuf {
    env::var("HII_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let exe = env::current_exe().unwrap_or_default();
            // cli/target/release/hii -> cli -> hii root
            exe.ancestors().nth(3).unwrap_or(exe.parent().unwrap_or(&exe)).to_path_buf()
        })
}

const API_BASE: &str = "http://localhost:8888";

fn server_up() -> bool {
    reqwest::blocking::Client::new()
        .get(format!("{API_BASE}/api/bridge"))
        .timeout(std::time::Duration::from_millis(500))
        .send()
        .is_ok()
}

fn py(root: &PathBuf, args: &[&str]) -> Result<()> {
    let status = Command::new("python3")
        .args(args)
        .env("HII_ROOT", root)
        .current_dir(root)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .context("failed to run python3")?;
    if !status.success() {
        anyhow::bail!("python3 exited with {}", status);
    }
    Ok(())
}

fn py_cmd(root: &PathBuf, code: &str) -> Result<String> {
    let out = Command::new("python3")
        .args(["-c", code])
        .env("HII_ROOT", root)
        .current_dir(root)
        .output()
        .context("failed to run python3")?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!("python3 error: {err}");
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let root = hii_root();

    match cli.command {
        Cmd::Serve => {
            println!("{}", "Starting HII server...".cyan().bold());
            let mut child = Command::new("python3")
                .args(["-m", "engine.serve.server"])
                .env("HII_ROOT", &root)
                .current_dir(&root)
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .context("failed to start server")?;

            // Forward signals by just waiting
            let status = child.wait().context("server process failed")?;
            if !status.success() {
                anyhow::bail!("server exited with {}", status);
            }
        }

        Cmd::Daemon { action } => {
            let subcmd = match action {
                DaemonAction::Start => "start",
                DaemonAction::Stop => "stop",
                DaemonAction::Status => "status",
            };
            let code = format!(
                "import sys; sys.path.insert(0,'.'); from engine.core.daemon import main; main('{subcmd}')"
            );
            py(&root, &["-c", &code])?;
        }

        Cmd::Skill { action } => match action {
            SkillAction::List => {
                let code = "import sys; sys.path.insert(0,'.'); from engine.skills.registry import list_skills; list_skills()";
                py(&root, &["-c", code])?;
            }
            SkillAction::Search { query } => {
                let code = format!(
                    "import sys; sys.path.insert(0,'.'); from engine.skills.registry import search_skills; search_skills('{query}')"
                );
                py(&root, &["-c", &code])?;
            }
            SkillAction::Run { name, args } => {
                let args_str = args.join(" ");
                let code = format!(
                    "import sys; sys.path.insert(0,'.'); from engine.skills.registry import run_skill; run_skill('{name}', '{args_str}')"
                );
                py(&root, &["-c", &code])?;
            }
        },

        Cmd::Task { action } => match action {
            TaskAction::Add { description } => {
                let desc = description.join(" ");
                let code = format!(
                    "import sys; sys.path.insert(0,'.'); from engine.tasks.queue import add_task; add_task('{desc}')"
                );
                py(&root, &["-c", &code])?;
            }
            TaskAction::List => {
                let code = "import sys; sys.path.insert(0,'.'); from engine.tasks.queue import list_tasks; list_tasks()";
                py(&root, &["-c", code])?;
            }
        },

        Cmd::Bridge { action } => match action {
            BridgeAction::Send { message } => {
                let msg = message.join(" ");
                if server_up() {
                    let client = reqwest::blocking::Client::new();
                    let resp = client
                        .post(format!("{API_BASE}/api/bridge"))
                        .json(&serde_json::json!({
                            "from": "ummi",
                            "message": msg
                        }))
                        .send()
                        .context("failed to POST to bridge")?;
                    if resp.status().is_success() {
                        println!("{} message sent", "✓".green().bold());
                    } else {
                        anyhow::bail!("bridge returned {}", resp.status());
                    }
                } else {
                    // Fallback: write directly to bridge/messages/
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)?
                        .as_secs();
                    let dir = root.join("bridge/messages");
                    std::fs::create_dir_all(&dir)?;
                    let payload = serde_json::json!({
                        "from": "ummi",
                        "message": msg,
                        "ts": ts
                    });
                    let path = dir.join(format!("{ts}_ummi.json"));
                    std::fs::write(&path, serde_json::to_string_pretty(&payload)?)?;
                    println!("{} message written to {}", "✓".green().bold(), path.display());
                }
            }
            BridgeAction::Read => {
                if server_up() {
                    let resp = reqwest::blocking::get(format!("{API_BASE}/api/bridge"))
                        .context("failed to GET bridge")?;
                    let body: serde_json::Value = resp.json().context("bad json from bridge")?;
                    if let Some(msgs) = body.as_array().or_else(|| body.get("messages").and_then(|m| m.as_array())) {
                        for m in msgs {
                            let from = m.get("from").and_then(|v| v.as_str()).unwrap_or("?");
                            let text = m.get("message").and_then(|v| v.as_str()).unwrap_or("");
                            let ts = m.get("ts").and_then(|v| v.as_u64()).unwrap_or(0);
                            let label = if from == "ummi" {
                                from.magenta().bold()
                            } else {
                                from.cyan().bold()
                            };
                            println!("[{}] {}: {}", ts.to_string().dimmed(), label, text);
                        }
                    } else {
                        println!("{}", body);
                    }
                } else {
                    // Fallback: read from bridge/messages/
                    let dir = root.join("bridge/messages");
                    if !dir.exists() {
                        println!("{}", "No messages.".dimmed());
                        return Ok(());
                    }
                    let mut entries: Vec<_> = std::fs::read_dir(&dir)?
                        .filter_map(|e| e.ok())
                        .filter(|e| e.path().extension().map_or(false, |x| x == "json"))
                        .collect();
                    entries.sort_by_key(|e| e.file_name());
                    for entry in entries.iter().rev().take(20).rev() {
                        if let Ok(data) = std::fs::read_to_string(entry.path()) {
                            if let Ok(m) = serde_json::from_str::<serde_json::Value>(&data) {
                                let from = m.get("from").and_then(|v| v.as_str()).unwrap_or("?");
                                let text = m.get("message").and_then(|v| v.as_str()).unwrap_or("");
                                let label = if from == "ummi" {
                                    from.magenta().bold()
                                } else {
                                    from.cyan().bold()
                                };
                                println!("{}: {}", label, text);
                            }
                        }
                    }
                }
            }
        },

        Cmd::Observe { text } => {
            let obs = text.join(" ");
            if server_up() {
                let client = reqwest::blocking::Client::new();
                let resp = client
                    .post(format!("{API_BASE}/api/observe"))
                    .json(&serde_json::json!({ "text": obs }))
                    .send()
                    .context("failed to POST observation")?;
                if resp.status().is_success() {
                    println!("{} observation recorded", "✓".green().bold());
                } else {
                    anyhow::bail!("observe returned {}", resp.status());
                }
            } else {
                let code = format!(
                    "import sys; sys.path.insert(0,'.'); from engine.psyche.profile import observe; observe('{obs}')"
                );
                py(&root, &["-c", &code])?;
            }
        }

        Cmd::Version => {
            println!("{} {}", "hii".cyan().bold(), env!("CARGO_PKG_VERSION"));
            // Try to get git info
            if let Ok(out) = Command::new("git")
                .args(["log", "-1", "--format=%h %s", "--"])
                .current_dir(&root)
                .output()
            {
                if out.status.success() {
                    let line = String::from_utf8_lossy(&out.stdout);
                    println!("git: {}", line.trim().dimmed());
                }
            }
            // Try Python version module
            match py_cmd(&root, "import sys; sys.path.insert(0,'.'); from engine.core.version import show; show()") {
                Ok(v) => print!("{}", v),
                Err(_) => println!("engine: {}", "unavailable".yellow()),
            }
            println!("root: {}", root.display().to_string().dimmed());
        }
    }

    Ok(())
}
