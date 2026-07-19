use std::{path::Path, process::Command};

pub const LEGACY_COMMANDS: &[&str] = &[
    "now",
    "chat",
    "task",
    "capture",
    "work",
    "schedule",
    "check",
    "ship",
    "health",
    "context",
    "agent-context",
    "probe",
    "caps",
    "sdk",
    "jobs",
    "console",
    "terminal",
    "og",
    "loop",
    "daemon",
    "instances",
    "feed",
    "board",
    "money",
    "links",
    "pack",
    "knowledge",
    "skill",
    "skills",
    "runner",
    "registry",
    "bridge",
    "mcp",
    "codex",
    "dev",
    "build",
    "start",
];

pub fn is_legacy(command: &str) -> bool {
    LEGACY_COMMANDS.contains(&command) && !(cfg!(feature = "preview") && command == "schedule")
}

pub fn run(repo: &Path, args: &[String]) -> Result<i32, String> {
    let script = repo.join("scripts").join("hii-cli.mjs");
    if !script.is_file() {
        return Err(format!(
            "legacy compatibility entrypoint is missing: {}",
            script.display()
        ));
    }
    let status = Command::new("node")
        .arg(script)
        .args(args)
        .current_dir(repo)
        .env("HII_RUST_CLI", "1")
        .status()
        .map_err(|error| format!("failed to start compatibility command: {error}"))?;
    Ok(status.code().unwrap_or(1))
}
