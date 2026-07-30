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
    ("/model", "choose available model"),
    ("/models", "list available models"),
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
    ("/agent", "manage one worker"),
    #[cfg(feature = "preview")]
    ("/resources", "machine resources"),
    #[cfg(feature = "preview")]
    ("/top", "resource monitor"),
    #[cfg(feature = "preview")]
    ("/schedule", "create recurring task"),
    #[cfg(feature = "preview")]
    ("/schedules", "recurring tasks"),
    #[cfg(feature = "preview")]
    ("/calendar", "calendar view"),
    #[cfg(feature = "preview")]
    ("/sync", "sync calendar"),
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

pub fn welcome(workspace: &Path, model: &str, max_steps: usize, git: &str, public_test: bool) {
    let width = terminal_width();
    let rule = "━".repeat(width.saturating_sub(4));
    let workspace = if public_test {
        "shared workspace".to_string()
    } else {
        short_path(workspace)
    };
    let model = model.strip_suffix("-mlx").unwrap_or(model);
    let git = workspace_state(git);
    let workspace = if public_test || git == "clean" || git == "not a Git workspace" {
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
            &format!(
                "{model} · workspace · {} · live model stream · receipts",
                if max_steps == 0 {
                    "unlimited".to_string()
                } else {
                    format!("{max_steps} steps")
                }
            ),
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

fn public_command(command: &str) -> bool {
    matches!(
        command,
        "/help"
            | "/compact"
            | "/clear"
            | "/status"
            | "/usage"
            | "/thinking"
            | "/model"
            | "/models"
            | "/proof"
            | "/undo"
            | "/exit"
    )
}

pub fn command_matches(input: &str, public_test: bool) -> Vec<(&'static str, &'static str)> {
    if !input.starts_with('/') || input.chars().any(char::is_whitespace) {
        return Vec::new();
    }
    let query = input.trim_start_matches('/').to_ascii_lowercase();
    let mut matches = COMMANDS
        .iter()
        .copied()
        .filter(|(command, _)| !public_test || public_command(command))
        .filter(|(command, _)| command[1..].contains(&query))
        .collect::<Vec<_>>();
    matches.sort_by_key(|(command, _)| !command[1..].starts_with(&query));
    matches
}

pub fn command_menu(input: &str, selected: usize, public_test: bool) -> Vec<String> {
    const VISIBLE_ROWS: usize = 6;
    let matches = command_matches(input, public_test);
    let selected = selected.min(matches.len().saturating_sub(1));
    let start = if matches.len() <= VISIBLE_ROWS {
        0
    } else {
        selected
            .saturating_sub(VISIBLE_ROWS - 1)
            .min(matches.len() - VISIBLE_ROWS)
    };
    let total = matches.len();
    let mut rows = matches
        .into_iter()
        .enumerate()
        .skip(start)
        .take(VISIBLE_ROWS)
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
        .collect::<Vec<_>>();
    if total > 0 {
        rows.push(format!(
            "    {}",
            paint(
                &format!(
                    "↑↓ navigate  Enter select  Esc close  ·  {}/{}",
                    selected + 1,
                    total
                ),
                &[DIM, SLATE]
            )
        ));
    }
    rows
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

pub fn stage(label: &str, message: &str) {
    println!(
        "  {}  {}",
        paint(label, &[BOLD, CYAN]),
        paint(
            &truncate(message, terminal_width().saturating_sub(label.len() + 6)),
            &[SLATE]
        )
    );
}

pub fn model_text(message: &str) {
    println!("  {} {}", paint("│", &[BLUE]), paint(message, &[SLATE]));
}

pub fn tool_start(step: usize, tool: &str, target: &str) {
    let stage = if matches!(tool, "verify" | "http") {
        "VERIFYING"
    } else if tool == "web_search" {
        "RESEARCHING"
    } else if matches!(tool, "write" | "edit" | "shell") {
        "BUILDING"
    } else {
        "CHECKING"
    };
    println!(
        "  {}  {:02} {}  {}",
        paint(stage, &[BOLD, BLUE]),
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

pub fn tool_failure_detail(output: &str) {
    let mut shown = Vec::new();
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let line = truncate(line, terminal_width().saturating_sub(10));
        if !shown.contains(&line) {
            shown.push(line);
        }
        if shown.len() == 3 {
            break;
        }
    }
    for line in shown {
        println!("  {} {}", paint("│", &[DIM, RED]), paint(&line, &[RED]));
    }
}

pub fn recovery(message: &str) {
    println!(
        "  {}  {}",
        paint("REPAIR STALLED", &[BOLD, AMBER]),
        paint(
            &truncate(message, terminal_width().saturating_sub(20)),
            &[AMBER]
        )
    );
}

pub fn reply(message: &str, activity: Option<&str>) {
    println!();
    println!("  {}", paint("DONE", &[BOLD, GREEN]));
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

pub fn cue(message: &str) {
    println!("  {}", paint(message, &[BOLD]));
    println!();
}

pub fn error(message: &str) {
    println!();
    let label = if message.starts_with("Response interrupted") {
        "! INTERRUPTED"
    } else {
        "! LOCAL PROBLEM"
    };
    println!("  {}  {}", paint(label, &[BOLD, RED]), message);
    println!();
}

#[cfg(test)]
mod tests {
    use super::{
        command_matches, command_menu, prompt_frame, short_path, truncate, workspace_state,
    };
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
        let matches = command_matches("/sta", false);
        assert_eq!(matches.first().map(|item| item.0), Some("/status"));
        assert!(command_matches("status", false).is_empty());
        assert!(command_matches("/model qwen", false).is_empty());
    }

    #[test]
    fn slash_palette_keeps_every_command_navigable_in_a_scrolling_window() {
        let matches = command_matches("/", false);
        assert!(matches.len() > 6);
        let last = matches.len() - 1;
        let menu = command_menu("/", last, false);
        assert_eq!(menu.len(), 7);
        assert!(menu.iter().any(|line| line.contains(matches[last].0)));
        assert!(menu.last().unwrap().contains("Enter select"));
    }

    #[test]
    fn public_palette_only_lists_controls_that_can_run() {
        let matches = command_matches("/", true);
        assert!(matches.iter().any(|(command, _)| *command == "/model"));
        assert!(!matches.iter().any(|(command, _)| *command == "/providers"));
    }
}
