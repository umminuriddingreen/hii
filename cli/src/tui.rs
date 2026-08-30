//! Terminal presentation for the canonical HII conversation loop.
//!
//! This deliberately stays smaller than a full retained-mode UI: HII keeps the
//! terminal scrollback useful while giving intent, bounded action, and proof a
//! consistent visual hierarchy.

use std::{
    env, fs,
    io::{self, IsTerminal},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU8, AtomicUsize, Ordering},
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
static ACTIVITY_ROWS: AtomicUsize = AtomicUsize::new(0);

const COMMANDS: &[(&str, &str)] = &[
    ("/help", "all controls"),
    ("/overview", "context state map"),
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
    ("/reasoning", "model effort"),
    ("/autonomy", "local action policy"),
    ("/model", "choose local model"),
    ("/files", "ranger-style explorer"),
    ("/explore", "ranger-style explorer"),
    ("/codex", "use Codex model for a task"),
    ("/claude", "use Claude model for a task"),
    ("/models", "list local models"),
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
    ("/copy", "copy response, code, or all"),
    ("/undo", "drop last exchange"),
    ("/fork", "snapshot session"),
    ("/teach", "save as skill"),
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

    fn description(self) -> &'static str {
        match self {
            Theme::Heritage => "HII signature · warm gold, violet, and signal green.",
            Theme::Midnight => "Cool cyan and blue for low-light terminals.",
            Theme::Mono => "High-clarity monochrome for constrained terminals.",
        }
    }
}

const THEMES: [Theme; 3] = [Theme::Heritage, Theme::Midnight, Theme::Mono];

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
    match requested {
        Some(requested) => apply_theme(runtime, Theme::parse(requested)?)?,
        // Bare `/theme` at a terminal is a choice, not a report: paint each row
        // in its own palette so the operator sees the theme before taking it.
        None if crate::picker::is_available() => {
            let current = active_theme();
            if let Some(selected) = crate::picker::select("Select theme", &theme_choices(current))?
            {
                apply_theme(runtime, Theme::parse(&selected)?)?;
            }
        }
        None => {}
    }
    let theme = active_theme();
    Ok(format!(
        "THEME  {}\n{}\nSwitch: /theme heritage | midnight | mono",
        theme.name(),
        theme.description()
    ))
}

fn apply_theme(runtime: &Path, theme: Theme) -> Result<(), String> {
    let file = theme_file(runtime);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&file, format!("{}\n", theme.name())).map_err(|error| error.to_string())?;
    ACTIVE_THEME.store(theme as u8, Ordering::Relaxed);
    Ok(())
}

fn theme_choices(current: Theme) -> Vec<crate::picker::Choice> {
    THEMES
        .iter()
        .map(|theme| {
            let detail = if *theme == current {
                format!("{} · current", theme.description())
            } else {
                theme.description().to_string()
            };
            crate::picker::Choice::new(theme.name(), detail).current(*theme == current)
        })
        .collect()
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

pub(crate) fn style_bold(text: &str) -> String {
    paint(text, &[BOLD])
}

pub(crate) fn style_active(text: &str) -> String {
    paint(text, &[BOLD, palette().primary])
}

pub(crate) fn style_accent(text: &str) -> String {
    paint(text, &[palette().primary])
}

pub(crate) fn style_muted(text: &str) -> String {
    paint(text, &[palette().muted])
}

pub(crate) fn style_dim(text: &str) -> String {
    paint(text, &[DIM, palette().muted])
}

pub(crate) fn terminal_width() -> usize {
    crossterm::terminal::size()
        .map(|(columns, _)| usize::from(columns))
        .unwrap_or(80)
        .clamp(48, 104)
}

/// Columns the composer may paint on its single editable row.
///
/// The prompt gutter `"  │ "` takes four columns, and one trailing column is
/// left unused so a cursor resting after the last character cannot trigger the
/// terminal's auto-wrap. The frame is clamped to 104 columns but the real
/// terminal may be narrower, so honour whichever is smaller.
pub(crate) fn composer_width() -> usize {
    let real = crossterm::terminal::size()
        .map(|(columns, _)| usize::from(columns))
        .unwrap_or(80);
    real.min(terminal_width()).saturating_sub(5).max(8)
}

/// Render the slice of the composer buffer that fits on one row, plus the
/// column the cursor lands on within that slice.
///
/// The composer's redraw uses relative cursor movement and assumes the input
/// occupies exactly one terminal row. A buffer wider than the row would wrap,
/// shifting every subsequent move and tearing the frame apart — so long lines
/// scroll horizontally instead, and newlines (recalled from a multi-line
/// history entry) are shown as a glyph rather than breaking the row.
pub(crate) fn composer_window(buf: &str, cursor: usize, width: usize) -> (String, usize) {
    if width == 0 {
        return (String::new(), 0);
    }
    let flattened: Vec<char> = buf
        .chars()
        .map(|character| match character {
            '\n' => '⏎',
            '\t' => ' ',
            other => other,
        })
        .collect();
    let cursor_column = buf[..cursor.min(buf.len())].chars().count();
    if flattened.len() <= width {
        return (flattened.into_iter().collect(), cursor_column);
    }
    // Scrolled windows keep the cursor on the right edge, which is where it sits
    // while typing or pasting past the end of the row.
    let start = cursor_column.saturating_sub(width.saturating_sub(1));
    let end = (start + width).min(flattened.len());
    let mut visible: Vec<char> = flattened[start..end].to_vec();
    if start > 0 {
        visible[0] = '…';
    }
    // Only mark hidden trailing text when the cursor is not sitting on that
    // last cell — otherwise the ellipsis would hide the character being edited.
    if end < flattened.len() && cursor_column < end.saturating_sub(1) {
        if let Some(last) = visible.last_mut() {
            *last = '…';
        }
    }
    (visible.into_iter().collect(), cursor_column - start)
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

pub fn overview(
    workspace: &Path,
    model: &str,
    git: &str,
    context_sources: usize,
    tasks: &[(String, String, String)],
    latest_proof: Option<(&str, &str, usize)>,
) -> String {
    let workspace = short_path(workspace);
    let git = workspace_state(git);
    let mut lanes = std::collections::BTreeMap::new();
    for (lane, _, _) in tasks {
        *lanes.entry(lane.as_str()).or_insert(0usize) += 1;
    }
    let work = ["doing", "next", "blocked", "backlog"]
        .into_iter()
        .filter_map(|lane| lanes.get(lane).map(|count| format!("{lane}:{count}")))
        .collect::<Vec<_>>()
        .join("  ");
    let proof = latest_proof.map_or_else(
        || "none recorded for this workspace".to_string(),
        |(status, id, checks)| format!("{status} · {checks} checks · {id}"),
    );
    let mut lines = vec![
        "HII // CONTEXT MAP v1".to_string(),
        "┌─ NOW ─────────────────────────────────────────────────────────┐".to_string(),
        format!("│ workspace  {workspace}"),
        format!("│ state      {git}"),
        format!("│ model      {model}"),
        "├─ CONTEXT ─────────────────────────────────────────────────────┤".to_string(),
        format!("│ sources    {context_sources} local, source-labelled"),
        "├─ WORK ────────────────────────────────────────────────────────┤".to_string(),
        format!(
            "│ lanes      {}",
            if work.is_empty() { "none" } else { &work }
        ),
    ];
    for (lane, title, coordinate) in tasks.iter().take(3) {
        lines.push(format!(
            "│ {:<9} {}  @ {}",
            lane,
            crate::text::clip_line(title, 34),
            crate::text::clip_line(coordinate, 28)
        ));
    }
    lines.extend([
        "├─ PROOF ───────────────────────────────────────────────────────┤".to_string(),
        format!("│ latest     {proof}"),
        "└─ CONTROL ─────────────────────────────────────────────────────┘".to_string(),
        "  describe intent · ⇧Tab advisor · /overview refresh · /proof inspect".to_string(),
    ]);
    lines.join("\n")
}

/// A quiet first frame for the human-facing terminal surface. It establishes
/// place and possibility without turning startup into a dashboard.
pub fn welcome(workspace: &Path, provider: &str, model: &str, greeting: &str, public_test: bool) {
    println!(
        "{}",
        welcome_frame(workspace, provider, model, greeting, public_test)
    );
    println!();
}

pub(crate) fn welcome_frame(
    workspace: &Path,
    provider: &str,
    model: &str,
    greeting: &str,
    _public_test: bool,
) -> String {
    let brand = format!(
        "{}  {}",
        paint("HII", &[BOLD, palette().primary]),
        paint("HUMAN INFORMATION INTERFACE", &[DIM, palette().muted])
    );
    let location = paint(
        &format!("{}  ·  {}  ·  {}", short_path(workspace), provider, model),
        &[DIM, palette().muted],
    );
    let greeting = paint(greeting, &[palette().secondary]);
    format!("{brand}\n{location}\n\n{greeting}")
}

pub fn prompt_frame(_frame: usize) -> String {
    format!("\r\n  {} ", paint("›", &[BOLD, palette().primary]))
}

pub fn prompt_footer() -> String {
    String::new()
}

fn public_command(command: &str) -> bool {
    matches!(
        command,
        "/help"
            | "/overview"
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

pub fn command_matches(input: &str, public_test: bool) -> Vec<(String, String)> {
    if let Some(query) = model_query(input) {
        return model_matches(query, public_test);
    }
    if !input.starts_with('/') || input.chars().any(char::is_whitespace) {
        return Vec::new();
    }
    let query = input.trim_start_matches('/').to_ascii_lowercase();
    let mut matches = COMMANDS
        .iter()
        .copied()
        .filter(|(command, _)| !public_test || public_command(command))
        .filter(|(command, _)| command[1..].contains(&query))
        .map(|(command, description)| (command.to_string(), description.to_string()))
        .collect::<Vec<_>>();
    matches.sort_by_key(|(command, _)| !command[1..].starts_with(&query));
    matches
}

fn model_query(input: &str) -> Option<&str> {
    input
        .strip_prefix("/model")
        .and_then(|tail| (tail.is_empty() || tail.starts_with(char::is_whitespace)).then_some(tail))
        .map(str::trim)
}

fn model_matches(query: &str, public_test: bool) -> Vec<(String, String)> {
    let query = query.to_ascii_lowercase();
    let mut rows = crate::ollama::Ollama::discover()
        .models()
        .unwrap_or_default()
        .into_iter()
        .filter(|model| query.is_empty() || model.to_ascii_lowercase().contains(&query))
        .map(|model| (format!("/model {model}"), "Local".to_string()))
        .collect::<Vec<_>>();
    if !public_test {
        rows.extend(
            crate::agents::AgentManager::hosted_model_choices()
                .into_iter()
                .filter(|(provider, model)| {
                    query.is_empty()
                        || provider.to_ascii_lowercase().contains(&query)
                        || model.to_ascii_lowercase().contains(&query)
                })
                .map(|(provider, model)| {
                    let command = match provider.as_str() {
                        "Claude" => "/claude ".to_string(),
                        "Codex" => "/codex ".to_string(),
                        _ => format!("/model {model}"),
                    };
                    (command, format!("{provider} · {model}"))
                }),
        );
    }
    rows.sort_by(|left, right| {
        left.1
            .to_ascii_lowercase()
            .cmp(&right.1.to_ascii_lowercase())
            .then_with(|| left.0.cmp(&right.0))
    });
    rows
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
                paint(&command, &[BOLD, palette().primary])
            } else {
                paint(&command, &[palette().muted])
            };
            format!(
                "    {} {:<12} {}",
                paint(marker, &[palette().primary]),
                command,
                paint(&description, &[DIM, palette().muted])
            )
        })
        .collect::<Vec<_>>();
    if total > 0 {
        rows.push(format!(
            "    {}",
            paint(
                &format!(
                    "↑↓ navigate  Tab/→ complete  Enter run  Esc close  ·  {}/{}",
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
    activity_line(&format!(
        "{}  {}",
        paint("◐", &[palette().primary]),
        paint(
            &format!(
                "{}  {}",
                label.to_ascii_lowercase(),
                crate::text::clip_line(message, terminal_width().saturating_sub(22))
            ),
            &[DIM, palette().muted]
        )
    ));
}

pub fn tool_start(step: usize, tool: &str, target: &str) {
    activity_line(&format!(
        "{}  {}  {}",
        paint("◇", &[palette().secondary]),
        paint(&format!("{step:02} {tool}"), &[BOLD]),
        paint(
            &crate::text::clip_line(target, terminal_width().saturating_sub(30)),
            &[DIM, palette().muted]
        )
    ));
}

pub fn tool_result(ok: bool, verification: bool) {
    let (mark, label, color) = if !ok {
        ("×", "tool failed", palette().error)
    } else if verification {
        ("✓", "verified", palette().primary)
    } else {
        ("✓", "complete", palette().primary)
    };
    activity_line(&format!(
        "{}  {}",
        paint(mark, &[BOLD, color]),
        paint(label, &[DIM, palette().muted])
    ));
}

pub fn tool_output(output: &str) {
    if output.trim().is_empty() {
        return;
    }
    println!("{}", paint("  TOOL OUTPUT", &[BOLD, palette().secondary]));
    println!("{output}");
}

pub fn model_activity(frame: usize, phase: &str, detail: Option<&str>) -> String {
    const FRAMES: [&str; 4] = ["◐", "◓", "◑", "◒"];
    let phase = match phase {
        "thinking" => "Thinking",
        "reviewing" => "Reviewing",
        "side chat" => "Considering",
        "compacting" => "Compacting",
        "learning" => "Learning",
        other => other,
    };
    let detail = detail
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            format!(
                "  {}",
                crate::text::clip_line(value, terminal_width().saturating_sub(24))
            )
        })
        .unwrap_or_default();
    format!(
        "  {}  {}{}",
        paint(FRAMES[frame % FRAMES.len()], &[BOLD, palette().primary]),
        paint(phase, &[BOLD]),
        paint(&detail, &[DIM, palette().muted])
    )
}

fn activity_line(line: &str) {
    println!("{line}");
    ACTIVITY_ROWS.fetch_add(1, Ordering::Relaxed);
}

pub fn finish_activity() {
    let rows = ACTIVITY_ROWS.swap(0, Ordering::Relaxed);
    if rows == 0 || !io::stdout().is_terminal() {
        return;
    }
    print!("{}", clear_activity_sequence(rows));
    let _ = std::io::Write::flush(&mut io::stdout());
}

fn clear_activity_sequence(rows: usize) -> String {
    "\x1b[1A\r\x1b[2K".repeat(rows)
}

pub fn tool_failure_detail(output: &str) {
    let mut shown = Vec::new();
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let line = crate::text::clip_line(line, terminal_width().saturating_sub(10));
        if !shown.contains(&line) {
            shown.push(line);
        }
        if shown.len() == 3 {
            break;
        }
    }
    for line in shown {
        activity_line(&format!(
            "  {} {}",
            paint("│", &[DIM, palette().error]),
            paint(&line, &[palette().error])
        ));
    }
}

pub fn recovery(message: &str) {
    activity_line(&format!(
        "  {}  {}",
        paint("REPAIR STALLED", &[BOLD, palette().warning]),
        paint(
            &crate::text::clip_line(message, terminal_width().saturating_sub(20)),
            &[palette().warning]
        )
    ));
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

pub fn error(message: &str) {
    finish_activity();
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
        clear_activity_sequence, command_matches, command_menu, composer_window, model_activity,
        overview, prompt_frame, short_path, terminal_width, theme_choices, welcome_frame,
        workspace_state, Theme,
    };
    use std::path::Path;

    #[test]
    fn theme_choices_offer_every_theme_and_mark_the_active_one() {
        let choices = theme_choices(Theme::Midnight);
        let names: Vec<_> = choices.iter().map(|choice| choice.value.as_str()).collect();
        assert_eq!(names, vec!["heritage", "midnight", "mono"]);
        let current: Vec<_> = choices
            .iter()
            .filter(|choice| choice.current)
            .map(|choice| choice.value.as_str())
            .collect();
        assert_eq!(current, vec!["midnight"]);
        assert!(choices[1].detail.ends_with("· current"));
        assert!(choices[0].detail.contains("warm gold"));
    }

    #[test]
    fn truncates_long_activity_targets() {
        assert_eq!(
            crate::text::clip_line("one two three four", 12),
            "one two thr…"
        );
        assert_eq!(crate::text::clip_line("short", 12), "short");
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
    fn overview_is_a_stable_agent_readable_context_map() {
        let rendered = overview(
            Path::new("/tmp/work"),
            "local-model",
            " M src/main.rs",
            4,
            &[("doing".into(), "Build state map".into(), "cli/src".into())],
            Some(("completed", "run-123", 2)),
        );
        assert!(rendered.contains("HII // CONTEXT MAP v1"));
        assert!(rendered.contains("│ sources    4 local, source-labelled"));
        assert!(rendered.contains("doing:1"));
        assert!(rendered.contains("completed · 2 checks · run-123"));
        assert!(rendered.contains("/overview refresh"));
    }

    #[test]
    fn composer_window_keeps_a_long_line_on_one_row() {
        let long = "x".repeat(300);
        let (visible, column) = composer_window(&long, long.len(), 40);
        // One row, never more; the cursor rests just past the last character.
        assert!(visible.chars().count() <= 40);
        assert!(visible.starts_with('…'));
        assert_eq!(column, visible.chars().count());
    }

    #[test]
    fn composer_window_shows_short_lines_whole() {
        let (visible, column) = composer_window("deploy", 3, 40);
        assert_eq!(visible, "deploy");
        assert_eq!(column, 3);
    }

    #[test]
    fn composer_window_marks_text_hidden_to_the_right() {
        let line = "abcdefghij";
        let (visible, column) = composer_window(line, 0, 5);
        assert_eq!(visible, "abcd…");
        assert_eq!(column, 0);
    }

    #[test]
    fn composer_window_flattens_newlines_from_history() {
        let (visible, _) = composer_window("one\ntwo", 7, 40);
        assert_eq!(visible, "one⏎two");
    }

    #[test]
    fn composer_window_counts_columns_not_bytes() {
        let line = "héllo wörld";
        let (visible, column) = composer_window(line, line.len(), 40);
        assert_eq!(visible, line);
        assert_eq!(column, 11);
    }

    #[test]
    fn prompt_is_a_minimal_codex_style_input_line() {
        assert!(!prompt_frame(0).trim().is_empty());
        assert_eq!(prompt_frame(0), prompt_frame(99));
        assert!(prompt_frame(0).contains('›'));
        assert!(!prompt_frame(0).contains("INTENT"));
        assert!(!prompt_frame(0).contains('╭'));
        assert!(super::prompt_footer().is_empty());
    }

    #[test]
    fn welcome_is_compact_and_leaves_instruction_to_the_composer() {
        let rendered = welcome_frame(
            Path::new("/tmp/studio"),
            "HII Native",
            "local-model",
            "Welcome back — 2 context sources loaded.",
            false,
        );
        assert!(rendered.contains("HUMAN INFORMATION INTERFACE"));
        assert!(rendered.contains("HII Native"));
        assert!(rendered.contains("Welcome back"));
        assert!(!rendered.contains("What do you want"));
        assert!(!rendered.contains("Type naturally"));
        assert_eq!(rendered.lines().count(), 4);
    }

    #[test]
    fn model_activity_has_motion_phase_and_bounded_detail() {
        let first = model_activity(0, "thinking", Some(&"detail ".repeat(80)));
        let second = model_activity(1, "thinking", None);
        assert!(first.contains("Thinking"));
        assert!(first.contains("detail"));
        assert_ne!(first, second);
        assert!(first.chars().count() <= terminal_width() + 10);
    }

    #[test]
    fn collapsed_activity_clears_exactly_the_rows_it_owned() {
        assert_eq!(clear_activity_sequence(0), "");
        assert_eq!(clear_activity_sequence(2).matches("\x1b[1A").count(), 2);
        assert_eq!(clear_activity_sequence(2).matches("\x1b[2K").count(), 2);
    }

    #[test]
    fn slash_palette_filters_commands() {
        let matches = command_matches("/sta", false);
        assert_eq!(matches.first().map(|item| item.0.as_str()), Some("/status"));
        assert!(command_matches("status", false).is_empty());
        let model_matches = command_matches("/model claude", false);
        assert!(model_matches
            .iter()
            .any(|(command, description)| command == "/claude " && description.contains("Claude")));
    }

    #[test]
    fn slash_palette_keeps_every_command_navigable_in_a_scrolling_window() {
        let matches = command_matches("/", false);
        assert!(matches.len() > 6);
        let last = matches.len() - 1;
        let menu = command_menu("/", last, false);
        assert_eq!(menu.len(), 7);
        assert!(menu.iter().any(|line| line.contains(&matches[last].0)));
        assert!(menu.last().unwrap().contains("Tab/→ complete"));
        assert!(menu.last().unwrap().contains("Enter run"));
    }

    #[test]
    fn public_palette_only_lists_controls_that_can_run() {
        let matches = command_matches("/", true);
        assert!(matches.iter().any(|(command, _)| command == "/model"));
        assert!(matches.iter().any(|(command, _)| command == "/new"));
        assert!(!matches.iter().any(|(command, _)| command == "/raw"));
        assert!(!matches.iter().any(|(command, _)| command == "/thinking"));
        assert!(matches.iter().any(|(command, _)| command == "/theme"));
        assert!(matches.iter().any(|(command, _)| command == "/keymap"));
        assert!(matches.iter().any(|(command, _)| command == "/attach"));
        assert!(matches.iter().any(|(command, _)| command == "/attachments"));
        assert!(!matches.iter().any(|(command, _)| command == "/providers"));
        assert!(!matches.iter().any(|(command, _)| command == "/copy"));
        assert!(!matches.iter().any(|(command, _)| command == "/rename"));
        assert!(!matches.iter().any(|(command, _)| command == "/background"));
        assert!(!matches.iter().any(|(command, _)| command == "/jobs"));
        assert!(!matches.iter().any(|(command, _)| command == "/mcp"));
    }

    #[test]
    fn theme_names_are_stable_and_reject_unknown_values() {
        assert_eq!(Theme::parse("default").unwrap(), Theme::Heritage);
        assert_eq!(Theme::parse("midnight").unwrap().name(), "midnight");
        assert_eq!(Theme::parse("monochrome").unwrap(), Theme::Mono);
        assert!(Theme::parse("neon-chaos").is_err());
    }
}
