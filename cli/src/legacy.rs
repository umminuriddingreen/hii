use std::{
    path::{Path, PathBuf},
    process::Command,
};

pub const LEGACY_COMMANDS: &[&str] = &[
    "now",
    "chat",
    "task",
    "capture",
    "work",
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
    ("build", &["dev", "build", "start"]),
];

/// The `--help` footer for the installation actually running.
///
/// Advertising commands the binary cannot run is how a first install turns into
/// an error message: a standalone `hii` listed 39 delegated commands and failed
/// on every one of them.
pub fn help_footer_resolved() -> String {
    let repo = std::env::var_os("HII_ROOT")
        .map(PathBuf::from)
        .or_else(|| crate::config::home_dir().ok().map(|home| home.join("hii")));
    match repo {
        Some(repo) if is_available(&repo) => help_footer(),
        _ => STANDALONE_FOOTER.to_string(),
    }
}

const STANDALONE_FOOTER: &str = "\
This build ships HII's native commands only.

  HII's extended surface (home, work, context, knowledge, codex, and others)
  needs a HII checkout beside it. Install from source or set HII_ROOT to one.";

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

/// The Node compatibility surface these commands are delegated to.
pub fn entrypoint(repo: &Path) -> PathBuf {
    repo.join("scripts").join("hii-cli.mjs")
}

/// Whether this installation can run delegated commands at all.
///
/// A binary installed on its own — the shape a released `hii` takes — has no
/// repository beside it, so every delegated command is unavailable. That is a
/// legitimate way to run HII, not a broken one, and the CLI has to say so
/// rather than printing a path nobody outside this repo can act on.
pub fn is_available(repo: &Path) -> bool {
    entrypoint(repo).is_file()
}

pub fn run(repo: &Path, args: &[String]) -> Result<i32, String> {
    let script = entrypoint(repo);
    if !script.is_file() {
        let command = first_word(args);
        return Err(format!(
            "`hii {command}` needs HII's Node compatibility surface, which this build does not \
             ship.\nThis binary provides HII's native commands — run `hii --help` to see them.\n\
             To get the full command set, install from a HII checkout or set HII_ROOT to one."
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

/// The command the user actually typed, for an error that names it.
fn first_word(args: &[String]) -> &str {
    args.iter()
        .find(|arg| !arg.starts_with('-'))
        .map(String::as_str)
        .unwrap_or("that command")
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

    /// The first-run experience for a released binary. A standalone `hii`
    /// advertised 39 delegated commands and failed on every one with a path
    /// from this repository, which is unusable for anyone who does not have it.
    #[test]
    fn a_standalone_install_does_not_advertise_commands_it_cannot_run() {
        let nowhere = Path::new("/nonexistent-hii-checkout");
        assert!(!is_available(nowhere));

        for command in ["home", "work", "knowledge"] {
            assert!(
                !STANDALONE_FOOTER.contains(&format!(" {command} ")),
                "{command} must not be offered as a runnable command in a standalone build"
            );
        }

        let error = run(nowhere, &["home".to_string()]).unwrap_err();
        assert!(
            error.contains("hii home"),
            "the error must name what failed"
        );
        assert!(
            !error.contains("hii-cli.mjs"),
            "a stranger cannot act on an internal path: {error}"
        );
        assert!(
            error.contains("--help"),
            "the error must point somewhere useful: {error}"
        );
    }

    #[test]
    fn a_checkout_still_gets_the_full_command_list() {
        // This repository is a checkout, so the resolved footer must be the full
        // one — the standalone path must not leak into normal development.
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("cli/ has a parent");
        assert!(
            is_available(repo),
            "the repo under test must have the entrypoint"
        );
        assert!(help_footer().contains("knowledge"));
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
