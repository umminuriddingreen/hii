//! Terminal presentation for the canonical HII conversation loop.
//!
//! This deliberately stays smaller than a full retained-mode UI: HII keeps the
//! terminal scrollback useful while giving intent, bounded action, and proof a
//! consistent visual hierarchy.

use std::{
    env, fs,
    io::{self, IsTerminal},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU8, Ordering},
};

const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum Theme {
    Heritage = 0,
    Midnight = 1,
    Mono = 2,
}

struct Palette {
    primary: &'static str,
    secondary: &'static str,
    warning: &'static str,
    error: &'static str,
    muted: &'static str,
}

const HERITAGE: Palette = Palette {
    primary: "\x1b[38;5;220m",
    secondary: "\x1b[38;5;141m",
    warning: "\x1b[38;5;215m",
    error: "\x1b[38;5;203m",
    muted: "\x1b[38;5;250m",
};
const MIDNIGHT: Palette = Palette {
    primary: "\x1b[38;5;44m",
    secondary: "\x1b[38;5;75m",
    warning: "\x1b[38;5;215m",
    error: "\x1b[38;5;203m",
    muted: "\x1b[38;5;245m",
};
const MONO: Palette = Palette {
    primary: "\x1b[38;5;255m",
    secondary: "\x1b[38;5;252m",
    warning: "\x1b[38;5;250m",
    error: "\x1b[38;5;255m",
    muted: "\x1b[38;5;245m",
};

static ACTIVE_THEME: AtomicU8 = AtomicU8::new(Theme::Heritage as u8);

const COMMANDS: &[(&str, &str)] = &[
    ("/help", "all controls"),
    ("/status", "session state"),
    ("/attach", "add file or image"),
    ("/attachments", "pending context"),
    ("/detach", "remove pending context"),
    ("/goal", "persistent objective"),
    ("/plan", "inspect before acting"),
    ("/side", "ask without derailing"),
    ("/theme", "visual signature"),
    ("/keymap", "keyboard profile"),
    ("/usage", "tokens and speed"),
    ("/thinking", "thought stream"),
    ("/reasoning", "model effort"),
    ("/autonomy", "local action policy"),
    ("/raw", "raw model stream"),
    ("/model", "choose available model"),
    ("/models", "list available models"),
    ("/providers", "accounts and plans"),
    ("/login", "connect an account"),
    ("/proof", "latest receipt"),
    ("/diff", "workspace changes"),
    ("/review", "review current diff"),
    ("/permissions", "authority boundary"),
    ("/resume", "restore a session"),
    ("/agents", "managed workers"),
    ("/ps", "managed workers"),
    ("/stop", "stop one worker"),
    ("/skills", "learned workflows"),
    ("/learn", "learning memory"),
    ("/hooks", "lifecycle policy"),
    ("/mcp", "governed tool servers"),
    ("/background", "supervised local task"),
    ("/jobs", "background work"),
    ("/job", "inspect or cancel job"),
    ("/compact", "shrink context"),
    ("/clear", "fresh conversation"),
    ("/new", "fresh conversation"),
    ("/rename", "name this session"),
    ("/copy", "copy latest response"),
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

impl Theme {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "heritage" | "default" => Ok(Theme::Heritage),
            "midnight" => Ok(Theme::Midnight),
            "mono" | "monochrome" => Ok(Theme::Mono),
            other => Err(format!(
                "unknown theme '{other}'; use heritage | midnight | mono"
            )),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Theme::Heritage => "heritage",
            Theme::Midnight => "midnight",
            Theme::Mono => "mono",
        }
    }
}

fn active_theme() -> Theme {
    match ACTIVE_THEME.load(Ordering::Relaxed) {
        1 => Theme::Midnight,
        2 => Theme::Mono,
        _ => Theme::Heritage,
    }
}

pub fn theme_name() -> &'static str {
    active_theme().name()
}

fn palette() -> &'static Palette {
    match active_theme() {
        Theme::Heritage => &HERITAGE,
        Theme::Midnight => &MIDNIGHT,
        Theme::Mono => &MONO,
    }
}

fn theme_file(runtime: &Path) -> PathBuf {
    runtime.join("config").join("tui-theme")
}

pub fn load_theme(runtime: &Path) {
    let requested = env::var("HII_THEME")
        .ok()
        .or_else(|| fs::read_to_string(theme_file(runtime)).ok());
    if let Some(theme) = requested
        .as_deref()
        .and_then(|value| Theme::parse(value).ok())
    {
        ACTIVE_THEME.store(theme as u8, Ordering::Relaxed);
    }
}

pub fn set_theme(runtime: &Path, requested: Option<&str>) -> Result<String, String> {
    if let Some(requested) = requested {
        let theme = Theme::parse(requested)?;
        let file = theme_file(runtime);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&file, format!("{}\n", theme.name())).map_err(|error| error.to_string())?;
        ACTIVE_THEME.store(theme as u8, Ordering::Relaxed);
    }
    let theme = active_theme();
    let description = match theme {
        Theme::Heritage => "HII signature · warm gold, violet, and signal green.",
        Theme::Midnight => "Cool cyan and blue for low-light terminals.",
        Theme::Mono => "High-clarity monochrome for constrained terminals.",
    };
    Ok(format!(
        "THEME  {}\n{}\nSwitch: /theme heritage | midnight | mono",
        theme.name(),
        description
    ))
}

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

pub fn welcome(workspace: &Path, model: &str, max_steps: usize, git: &str, public_test: bool) {
    let _ = (model, max_steps);
    let workspace = if public_test {
        "shared workspace".to_string()
    } else {
        short_path(workspace)
    };
    let git = workspace_state(git);
    let workspace = if public_test || git == "clean" || git == "not a Git workspace" {
        workspace
    } else {
        format!("{workspace} · {git}")
    };

    println!("{}", paint(&workspace, &[DIM, palette().muted]));
}

pub fn prompt_frame(_frame: usize) -> String {
    let width = terminal_width().saturating_sub(4);
    let rule = "─".repeat(width.saturating_sub(2));
    format!(
        "  {}\r\n  {} ",
        paint(&format!("╭─{rule}╮"), &[DIM, palette().primary]),
        paint("│", &[BOLD, palette().primary])
    )
}

pub fn prompt_footer() -> String {
    let width = terminal_width().saturating_sub(4);
    let rule = "─".repeat(width.saturating_sub(2));
    format!(
        "  {}",
        paint(&format!("╰─{rule}╯"), &[DIM, palette().muted])
    )
}

fn public_command(command: &str) -> bool {
    matches!(
        command,
        "/help"
            | "/compact"
            | "/clear"
            | "/status"
            | "/attach"
            | "/attachments"
            | "/detach"
            | "/usage"
            | "/thinking"
            | "/reasoning"
            | "/raw"
            | "/theme"
            | "/keymap"
            | "/model"
            | "/models"
            | "/proof"
            | "/permissions"
            | "/undo"
            | "/new"
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
                paint(command, &[BOLD, palette().primary])
            } else {
                paint(command, &[palette().muted])
            };
            format!(
                "    {} {:<12} {}",
                paint(marker, &[palette().primary]),
                command,
                paint(description, &[DIM, palette().muted])
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
                &[DIM, palette().muted]
            )
        ));
    }
    rows
}

pub fn queued() {
    println!(
        "  {} {}",
        paint("◇ QUEUED", &[palette().warning]),
        paint("carried into the next intent", &[DIM, palette().muted])
    );
}

pub fn steered() {
    println!(
        "\n  {} {}",
        paint("↳ STEER", &[palette().primary]),
        paint("applies before the next action", &[DIM, palette().muted])
    );
}

pub fn idle_background() {
    println!(
        "  {} {}",
        paint("◇ BACKGROUND", &[palette().primary]),
        paint("type a task, then press Ctrl+B", &[DIM, palette().muted])
    );
}

pub fn stage(label: &str, message: &str) {
    let _ = (label, message);
}

pub fn model_text(message: &str) {
    println!("{message}");
}

pub fn tool_start(step: usize, tool: &str, target: &str) {
    let _ = (step, tool, target);
}

pub fn tool_result(ok: bool, verification: bool) {
    let _ = (ok, verification);
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
        println!(
            "  {} {}",
            paint("│", &[DIM, palette().error]),
            paint(&line, &[palette().error])
        );
    }
}

pub fn recovery(message: &str) {
    println!(
        "  {}  {}",
        paint("REPAIR STALLED", &[BOLD, palette().warning]),
        paint(
            &truncate(message, terminal_width().saturating_sub(20)),
            &[palette().warning]
        )
    );
}

pub fn reply(message: &str, activity: Option<&str>) {
    let _ = activity;
    println!("{message}");
}

pub fn system(message: &str) {
    println!();
    println!("  {}", paint("SYSTEM", &[BOLD, palette().secondary]));
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
    println!("  {}  {}", paint(label, &[BOLD, palette().error]), message);
    println!();
}

#[cfg(test)]
mod tests {
    use super::{
        command_matches, command_menu, prompt_frame, short_path, truncate, workspace_state, Theme,
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
        assert_eq!(prompt_frame(0), prompt_frame(99));
        assert!(!prompt_frame(0).contains("STEER MODEL"));
        assert!(!super::prompt_footer().contains("Enter steer"));
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
        assert!(matches.iter().any(|(command, _)| *command == "/new"));
        assert!(matches.iter().any(|(command, _)| *command == "/raw"));
        assert!(matches.iter().any(|(command, _)| *command == "/theme"));
        assert!(matches.iter().any(|(command, _)| *command == "/keymap"));
        assert!(matches.iter().any(|(command, _)| *command == "/attach"));
        assert!(matches
            .iter()
            .any(|(command, _)| *command == "/attachments"));
        assert!(!matches.iter().any(|(command, _)| *command == "/providers"));
        assert!(!matches.iter().any(|(command, _)| *command == "/copy"));
        assert!(!matches.iter().any(|(command, _)| *command == "/rename"));
        assert!(!matches.iter().any(|(command, _)| *command == "/background"));
        assert!(!matches.iter().any(|(command, _)| *command == "/jobs"));
        assert!(!matches.iter().any(|(command, _)| *command == "/mcp"));
    }

    #[test]
    fn theme_names_are_stable_and_reject_unknown_values() {
        assert_eq!(Theme::parse("default").unwrap(), Theme::Heritage);
        assert_eq!(Theme::parse("midnight").unwrap().name(), "midnight");
        assert_eq!(Theme::parse("monochrome").unwrap(), Theme::Mono);
        assert!(Theme::parse("neon-chaos").is_err());
    }
}
