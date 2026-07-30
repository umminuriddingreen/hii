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

const COMMANDS: &[(&str, &str)] = &[
    ("/help", "all controls"),
    ("/status", "session state"),
    ("/usage", "tokens and speed"),
    ("/thinking", "thought stream"),
    ("/model", "choose local model"),
    ("/providers", "accounts and plans"),
    ("/login", "connect an account"),
    ("/proof", "latest receipt"),
    ("/agents", "managed workers"),
    ("/skills", "learned workflows"),
    ("/compact", "shrink context"),
    ("/clear", "fresh conversation"),
    ("/undo", "drop last exchange"),
    ("/fork", "snapshot session"),
    ("/teach", "save as skill"),
    ("/codex", "start Codex task"),
    ("/claude", "start Claude task"),
    ("/exit", "leave HII"),
];

fn color_enabled() -> bool {
    io::stdout().is_terminal()
        && env::var_os("NO_COLOR").is_none()
        && env::var("TERM").map_or(true, |term| term != "dumb")
}

pub fn motion_enabled() -> bool {
    color_enabled()
        && env::var("HII_MOTION").map_or(true, |value| value != "off")
        && env::var("HII_REDUCED_MOTION").map_or(true, |value| value != "1")
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
    let workspace = if git == "clean" || git == "not a Git workspace" {
        workspace
    } else {
        format!("{workspace} · {git}")
    };

    println!();
    println!(
        "  {} {}  {}",
        paint("◈", &[BOLD, CYAN]),
        paint("hii", &[BOLD]),
        paint(&workspace, &[DIM, SLATE])
    );
    println!("  {}", paint(&rule, &[DIM, BLUE]));
    println!(
        "  {}  {}",
        paint("ready", &[GREEN]),
        paint(
            &format!("{model} · workspace · {max_steps} steps · receipts"),
            &[DIM, SLATE]
        )
    );
    println!(
        "  {}",
        paint(
            "state the outcome  ·  Enter steer  Tab queue  Esc stop  ·  / commands",
            &[DIM, SLATE]
        )
    );
    println!();
}

pub fn prompt_frame(frame: usize) -> String {
    let glyphs = ["◇", "◈", "◆", "◈"];
    let glyph = if motion_enabled() {
        glyphs[frame % glyphs.len()]
    } else {
        "◈"
    };
    format!("  {} ", paint(glyph, &[BOLD, CYAN]))
}

pub fn command_matches(input: &str) -> Vec<(&'static str, &'static str)> {
    if !input.starts_with('/') || input.chars().any(char::is_whitespace) {
        return Vec::new();
    }
    let query = input.trim_start_matches('/').to_ascii_lowercase();
    let mut matches = COMMANDS
        .iter()
        .copied()
        .filter(|(command, _)| command[1..].contains(&query))
        .collect::<Vec<_>>();
    matches.sort_by_key(|(command, _)| !command[1..].starts_with(&query));
    matches.truncate(6);
    matches
}

pub fn command_menu(input: &str, selected: usize) -> Vec<String> {
    command_matches(input)
        .into_iter()
        .enumerate()
        .map(|(index, (command, description))| {
            let active = index == selected;
            let marker = if active { "›" } else { " " };
            let command = if active {
                paint(command, &[BOLD, CYAN])
            } else {
                paint(command, &[SLATE])
            };
            format!(
                "    {} {:<12} {}",
                paint(marker, &[CYAN]),
                command,
                paint(description, &[DIM, SLATE])
            )
        })
        .collect()
}

pub fn queued() {
    println!(
        "  {} {}",
        paint("◇ QUEUED", &[AMBER]),
        paint("carried into the next intent", &[DIM, SLATE])
    );
}

pub fn steered() {
    println!(
        "\n  {} {}",
        paint("↳ STEER", &[CYAN]),
        paint("applies before the next action", &[DIM, SLATE])
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
    use super::{command_matches, prompt_frame, short_path, truncate, workspace_state};
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

    #[test]
    fn prompt_frame_is_always_present() {
        assert!(!prompt_frame(0).trim().is_empty());
    }

    #[test]
    fn slash_palette_filters_commands() {
        let matches = command_matches("/sta");
        assert_eq!(matches.first().map(|item| item.0), Some("/status"));
        assert!(command_matches("status").is_empty());
        assert!(command_matches("/model qwen").is_empty());
    }
}
