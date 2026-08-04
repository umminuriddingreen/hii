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
    "home",
    "agents",
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
    "space",
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

/// Additional HII commands, grouped for `--help`.
///
/// These are routed through the compatibility surface while the Rust migration
/// continues. That implementation detail should not leak into user-facing help.
pub const LEGACY_GROUPS: &[(&str, &[&str])] = &[
    (
        "work",
        &[
            "now", "chat", "task", "capture", "work", "check", "ship", "loop",
        ],
    ),
    (
        "context",
        &[
            "home",
            "agents",
            "context",
            "agent-context",
            "og",
            "knowledge",
            "links",
            "feed",
            "pack",
        ],
    ),
    (
        "infra",
        &[
            "health",
            "probe",
            "caps",
            "jobs",
            "daemon",
            "instances",
            "runner",
            "registry",
            "space",
            "money",
        ],
    ),
    (
        "tools",
        &[
            "sdk", "console", "terminal", "bridge", "mcp", "codex", "skill", "skills",
        ],
    ),
    ("build", &["dev", "build", "start", "schedule"]),
];

/// The `--help` footer naming every additional command.
pub fn help_footer() -> String {
    let mut lines = vec!["More HII commands:".to_string()];
    for (group, commands) in LEGACY_GROUPS {
        lines.push(format!("  {group:<9} {}", commands.join(" ")));
    }
    lines.push(String::new());
    lines.push("  Every command supports `hii <command> --help`.".into());
    lines.join("\n")
}

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

#[cfg(test)]
mod help_tests {
    use super::*;

    /// Every delegated command must appear in the help footer, or it stays as
    /// invisible as `hii context` was.
    #[test]
    fn help_footer_names_every_delegated_command() {
        let footer = help_footer();
        for command in LEGACY_COMMANDS {
            assert!(
                footer.contains(command),
                "{command} is delegated but missing from --help"
            );
        }
    }

    #[test]
    fn help_groups_do_not_invent_commands() {
        for (_, commands) in LEGACY_GROUPS {
            for command in *commands {
                assert!(
                    LEGACY_COMMANDS.contains(command),
                    "{command} is listed in help but is not delegated"
                );
            }
        }
    }
}
