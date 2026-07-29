//! Terminal presentation for the canonical HII conversation loop.
//!
//! This deliberately stays smaller than a full retained-mode UI: HII keeps the
//! terminal scrollback useful while giving intent, bounded action, and proof a
//! consistent visual hierarchy.

use std::{
    env,
    io::{self, IsTerminal},
    path::Path,
};

const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";
const CYAN: &str = "\x1b[38;5;44m";
const BLUE: &str = "\x1b[38;5;75m";
const GREEN: &str = "\x1b[38;5;78m";
const AMBER: &str = "\x1b[38;5;215m";
const RED: &str = "\x1b[38;5;203m";
const SLATE: &str = "\x1b[38;5;245m";

fn color_enabled() -> bool {
    io::stdout().is_terminal()
        && env::var_os("NO_COLOR").is_none()
        && env::var("TERM").map_or(true, |term| term != "dumb")
}

fn paint(text: &str, codes: &[&str]) -> String {
    if !color_enabled() {
        return text.to_string();
    }
    format!("{}{text}{RESET}", codes.concat())
}

fn terminal_width() -> usize {
    crossterm::terminal::size()
        .map(|(columns, _)| usize::from(columns))
        .unwrap_or(80)
        .clamp(48, 104)
}

fn short_path(path: &Path) -> String {
    let displayed = path.display().to_string();
    let Some(home) = dirs::home_dir() else {
        return displayed;
    };
    let home = home.display().to_string();
    displayed
        .strip_prefix(&home)
        .map(|tail| format!("~{tail}"))
        .unwrap_or(displayed)
}

fn truncate(value: &str, max: usize) -> String {
    let single_line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if single_line.chars().count() <= max {
        return single_line;
    }
    let mut clipped = single_line
        .chars()
        .take(max.saturating_sub(1))
        .collect::<String>();
    clipped.push('…');
    clipped
}

fn workspace_state(git: &str) -> String {
    match git {
        "clean" => "clean".into(),
        "not a git workspace" => "not a Git workspace".into(),
        snapshot => {
            let changes = snapshot
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count();
            format!("{changes} change{}", if changes == 1 { "" } else { "s" })
        }
    }
}

pub fn welcome(workspace: &Path, model: &str, max_steps: usize, git: &str) {
    let width = terminal_width();
    let rule = "━".repeat(width.saturating_sub(4));
    let workspace = short_path(workspace);
    let model = model.strip_suffix("-mlx").unwrap_or(model);
    let git = workspace_state(git);

    println!();
    println!(
        "  {}  {}",
        paint("hii", &[BOLD, CYAN]),
        paint("HUMAN INFORMATION INTERFACE", &[DIM, SLATE])
    );
    println!("  {}", paint(&rule, &[DIM, BLUE]));
    println!(
        "  {}  {}",
        paint("◆ READY", &[BOLD, GREEN]),
        paint("local · bounded · receipts on", &[DIM, SLATE])
    );
    println!(
        "  {} {} · {}",
        paint("┃ workspace", &[BLUE]),
        workspace,
        git
    );
    println!("  {} {}", paint("┃ model    ", &[BLUE]), model);
    println!(
        "  {} {} · {} steps",
        paint("┃ authority", &[BLUE]),
        "workspace-only",
        max_steps
    );
    println!(
        "  {}",
        paint("┗ proof     every action stays inspectable", &[BLUE])
    );
    println!();
    println!("  {}", paint("Tell HII what should be true.", &[BOLD]));
    println!(
        "  {}",
        paint(
            "/help commands  ·  ! shell  ·  Tab queue  ·  Esc exit",
            &[DIM, SLATE]
        )
    );
    println!();
}

pub fn prompt() -> String {
    format!("  {} ", paint("❯", &[BOLD, CYAN]))
}

pub fn queued() {
    println!(
        "  {} {}",
        paint("◇ QUEUED", &[AMBER]),
        paint("carried into the next intent", &[DIM, SLATE])
    );
}

pub fn idle_background() {
    println!(
        "  {} {}",
        paint("○ IDLE", &[SLATE]),
        paint("nothing is running to background", &[DIM, SLATE])
    );
}

pub fn tool_start(step: usize, tool: &str, target: &str) {
    println!(
        "  {}  {}  {}",
        paint(&format!("{step:02}"), &[DIM, SLATE]),
        paint(&tool.to_ascii_uppercase(), &[BOLD, BLUE]),
        paint(
            &truncate(target, terminal_width().saturating_sub(20)),
            &[DIM, SLATE]
        )
    );
}

pub fn tool_result(ok: bool, verification: bool) {
    let (mark, color, label) = if !ok {
        ("╰─", RED, "failed")
    } else if verification {
        ("╰─", GREEN, "verified")
    } else {
        ("╰─", GREEN, "complete")
    };
    println!(
        "  {} {}",
        paint(mark, &[DIM, color]),
        paint(label, &[color])
    );
}

pub fn reply(message: &str, activity: Option<&str>) {
    println!();
    println!("  {}", paint("HII", &[BOLD, CYAN]));
    for line in message.lines() {
        println!("  {line}");
    }
    if let Some(activity) = activity {
        println!("  {}", paint(activity, &[DIM, SLATE]));
    }
    println!();
}

pub fn system(message: &str) {
    println!();
    println!("  {}", paint("SYSTEM", &[BOLD, BLUE]));
    for line in message.lines() {
        println!("  {line}");
    }
    println!();
}

pub fn error(message: &str) {
    println!();
    println!("  {}  {}", paint("! LOCAL PROBLEM", &[BOLD, RED]), message);
    println!(
        "  {}",
        paint("Nothing external was changed.", &[DIM, SLATE])
    );
    println!();
}

#[cfg(test)]
mod tests {
    use super::{short_path, truncate, workspace_state};
    use std::path::Path;

    #[test]
    fn truncates_long_activity_targets() {
        assert_eq!(truncate("one two three four", 12), "one two thr…");
        assert_eq!(truncate("short", 12), "short");
    }

    #[test]
    fn short_path_keeps_non_home_paths_readable() {
        assert!(!short_path(Path::new("/tmp/work")).is_empty());
    }

    #[test]
    fn workspace_state_counts_porcelain_lines() {
        assert_eq!(workspace_state("clean"), "clean");
        assert_eq!(workspace_state(" M one.rs\n?? two.rs"), "2 changes");
    }
}
