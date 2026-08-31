use std::{
    path::{Path, PathBuf},
    process::Command,
};

use crate::route;

/// HII's opening lines, naming only commands this installation can actually run.
///
/// The footer below has always adapted to a standalone binary; this block did not,
/// so a released `hii` opened by telling a brand-new user to run `hii home` — a
/// delegated command that build cannot execute. The first instruction a product
/// gives must not be the first one that fails.
pub fn intro_resolved() -> String {
    intro(delegation_available())
}

/// Split from [`intro_resolved`] so both branches are testable without reaching
/// for the process environment.
pub fn intro(delegating: bool) -> String {
    let mut lines = vec![
        "HII is the local home for human intent, bounded agent work, and inspectable proof."
            .to_string(),
        String::new(),
        "Start here:".to_string(),
        "  hii                          open the interactive workspace".to_string(),
    ];
    if delegating {
        lines.push("  hii home                     show the compact current coordinate".into());
    }
    lines.push("  hii \"fix the failing tests\"  run a bounded goal".into());
    lines.push("  hii proof                    inspect what completed".into());
    lines.join("\n")
}

/// The `--help` footer for the installation actually running.
///
/// Advertising commands the binary cannot run is how a first install turns into
/// an error message: a standalone `hii` listed 39 delegated commands and failed
/// on every one of them.
pub fn help_footer_resolved() -> String {
    if delegation_available() {
        help_footer()
    } else {
        STANDALONE_FOOTER.to_string()
    }
}

const STANDALONE_FOOTER: &str = "\
This build ships HII's native commands only.

  HII's extended surface (home, work, context, knowledge, codex, and others)
  needs a HII checkout beside it. Install from source or set HII_ROOT to one.";

/// The `--help` footer: the rest of the core surface, plus the way to see it all.
///
/// `--help` used to print all 77 commands, which buried the four that carry the
/// product. Extended commands still exist and still work; they are one flag away.
pub fn help_footer() -> String {
    let mut lines = vec!["More core commands:".to_string()];
    for group in route::Group::ORDER {
        let names: Vec<&str> = route::in_group(*group, Some(route::Visibility::Core))
            .filter(|entry| route::is_delegated(entry.name))
            .map(|entry| entry.name)
            .collect();
        if names.is_empty() {
            continue;
        }
        lines.push(format!(
            "  {:<9} {}",
            group.title().to_lowercase(),
            names.join(" ")
        ));
    }
    lines.push(String::new());
    lines.push("  Full command list: hii help --all".into());
    lines.push("  Every command supports `hii <command> --help`.".into());
    lines.join("\n")
}

/// Whether this installation can run delegated commands at all.
///
/// Asks `AppPaths` where the checkout is rather than re-deriving it. A second
/// answer to "where is the workspace" is how `--help` starts describing one
/// installation while the commands run against another.
pub fn delegation_available() -> bool {
    crate::config::AppPaths::discover().is_ok_and(|paths| is_available(&paths.repo))
}

/// Whether the Node compatibility surface owns this command.
///
/// Delegates to the single routing table; `preview` no longer needs a carve-out
/// here because `schedule` is simply a native entry in that table.
pub fn is_legacy(command: &str) -> bool {
    route::is_delegated(command)
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

/// Run a delegated command for an interactive slash command and return the
/// rendered result to the conversation instead of writing around the TUI.
pub fn output(repo: &Path, args: &[String]) -> Result<String, String> {
    let script = entrypoint(repo);
    if !script.is_file() {
        return Err("This HII build does not include the local control surface.".into());
    }
    let result = Command::new("node")
        .arg(script)
        .args(args)
        .current_dir(repo)
        .env("HII_RUST_CLI", "1")
        .output()
        .map_err(|error| format!("failed to start compatibility command: {error}"))?;
    let stdout = String::from_utf8_lossy(&result.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
    if !result.status.success() {
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
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

    /// `hii --help` shows the core surface; `hii help --all` is where the rest
    /// must remain reachable. A delegated command missing from both is as
    /// invisible as `hii context` used to be.
    #[test]
    fn every_delegated_command_is_named_by_the_full_list() {
        let listing = route::full_command_list();
        for entry in route::ROUTES {
            if !is_legacy(entry.name) {
                continue;
            }
            assert!(
                listing.contains(entry.name),
                "{} is delegated but `hii help --all` never names it",
                entry.name
            );
        }
    }

    /// The footer's job changed: it is now a short core list plus the door to
    /// everything else. If it stops naming that door, the extended surface is
    /// undiscoverable.
    #[test]
    fn the_footer_points_at_the_full_list() {
        let footer = help_footer();
        assert!(footer.contains("hii help --all"), "{footer}");
        assert!(
            !footer.contains("knowledge"),
            "the footer is the core surface, not the whole catalog: {footer}"
        );
    }

    /// The broken first impression this change exists to remove: a released
    /// binary opened by telling a new user to run `hii home`, then failed on it.
    #[test]
    fn a_standalone_install_does_not_open_by_naming_a_command_it_cannot_run() {
        let standalone = intro(false);
        assert!(
            !standalone.contains("hii home"),
            "a build without the Node surface must not advertise `hii home`: {standalone}"
        );
        assert!(
            standalone.contains("hii proof"),
            "the standalone intro still needs somewhere to send the user: {standalone}"
        );
        assert!(
            intro(true).contains("hii home"),
            "a checkout must still get the full opening"
        );
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
        assert!(route::full_command_list().contains("knowledge"));
    }
}
