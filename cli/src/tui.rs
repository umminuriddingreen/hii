//! Terminal presentation for the canonical HII conversation loop.
//!
//! This deliberately stays smaller than a full retained-mode UI: HII keeps the
//! terminal scrollback useful while giving intent, bounded action, and proof a
//! consistent visual hierarchy.

use std::{
    env, fs,
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
    },
};

static RUNTIME_VERBOSE: AtomicBool = AtomicBool::new(false);

/// Whether unsolicited runtime presentation should use the plain transcript.
/// The durable run journal and explicit command responses are unaffected.
pub fn raw_activity_mode() -> bool {
    !RUNTIME_VERBOSE.load(Ordering::Relaxed)
}

/// Enable the legacy runtime dashboard for an explicitly verbose invocation.
pub fn set_runtime_verbose(verbose: bool) {
    RUNTIME_VERBOSE.store(verbose, Ordering::Relaxed);
}

const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum Theme {
    Dark = 0,
    Light = 1,
}

struct Palette {
    primary: &'static str,
    secondary: &'static str,
    warning: &'static str,
    error: &'static str,
    muted: &'static str,
}

const MONO: Palette = Palette {
    primary: "\x1b[38;5;255m",
    secondary: "\x1b[38;5;252m",
    warning: "\x1b[38;5;250m",
    error: "\x1b[38;5;255m",
    muted: "\x1b[38;5;245m",
};
const LIGHT: Palette = Palette {
    primary: "\x1b[38;5;16m",
    secondary: "\x1b[38;5;238m",
    warning: "\x1b[38;5;238m",
    error: "\x1b[38;5;16m",
    muted: "\x1b[38;5;244m",
};

static ACTIVE_THEME: AtomicU8 = AtomicU8::new(Theme::Dark as u8);
static ACTIVITY_ROWS: AtomicUsize = AtomicUsize::new(0);
static PROMPT_CONTEXT: Mutex<String> = Mutex::new(String::new());
static ACTIVITY_STAGE: AtomicU8 = AtomicU8::new(0);
static ACTIVITY_PROJECTION: AtomicBool = AtomicBool::new(false);

pub fn set_activity_stage(stage: &str) -> bool {
    let state = match stage {
        "waiting" => 0,
        "generating" => 1,
        "tool" => 2,
        "worker" => 3,
        "saving" => 4,
        "ready" => 5,
        "failed" => 6,
        _ => 0,
    };
    ACTIVITY_STAGE.swap(state, Ordering::Relaxed) != state
}

pub fn activity_stage() -> &'static str {
    match ACTIVITY_STAGE.load(Ordering::Relaxed) {
        1 => "generating",
        2 => "tool",
        3 => "worker",
        4 => "saving",
        5 => "ready",
        6 => "failed",
        _ => "waiting",
    }
}

pub fn toggle_activity_projection() -> String {
    let enabled = !ACTIVITY_PROJECTION.fetch_xor(true, Ordering::Relaxed);
    if enabled {
        format!(
            "Activity projection enabled (event states only):\n{}",
            activity_projection(activity_stage())
        )
    } else {
        "Activity projection disabled.".into()
    }
}

pub fn activity_projection_enabled() -> bool {
    ACTIVITY_PROJECTION.load(Ordering::Relaxed)
}

pub fn set_prompt_context(workspace: &Path, model: &str) {
    if let Ok(mut context) = PROMPT_CONTEXT.lock() {
        *context = format!("{} · {}", short_path(workspace), model);
    }
}

impl Theme {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "dark" | "default" | "heritage" | "midnight" | "mono" | "monochrome" | "cyberpunk" => Ok(Theme::Dark),
            "light" => Ok(Theme::Light),
            other => Err(format!(
                "unknown theme '{other}'; use dark | light"
            )),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Theme::Dark => "dark",
            Theme::Light => "light",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Theme::Dark => "White text on black; quiet monochrome terminal palette.",
            Theme::Light => "Dark text for light terminal backgrounds.",
        }
    }
}

const THEMES: [Theme; 2] = [Theme::Dark, Theme::Light];

fn active_theme() -> Theme {
    match ACTIVE_THEME.load(Ordering::Relaxed) {
        1 => Theme::Light,
        _ => Theme::Dark,
    }
}

pub fn theme_name() -> &'static str {
    active_theme().name()
}

fn palette() -> &'static Palette {
    match active_theme() {
        Theme::Dark => &MONO,
        Theme::Light => &LIGHT,
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
        "THEME  {}\n{}\nUse the selector to change themes.",
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
    let background = if active_theme() == Theme::Light {
        "\x1b[48;5;255m\x1b[38;5;16m"
    } else {
        "\x1b[48;5;16m\x1b[38;5;255m"
    };
    format!("{background}{}{text}{RESET}", codes.concat())
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
    real.min(terminal_width()).saturating_sub(5)
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
    let cursor_chars = buf[..cursor.min(buf.len())].chars().count();
    let width_of = |characters: &[char]| {
        crate::codex_ui::display_width(&characters.iter().collect::<String>())
    };
    let cursor_column = width_of(&flattened[..cursor_chars.min(flattened.len())]);
    if width_of(&flattened) <= width {
        return (flattened.into_iter().collect(), cursor_column);
    }
    // Find the first character at or after the horizontal scroll position.
    // Count terminal cells rather than Unicode scalar values so CJK input does
    // not push the cursor past the visible row.
    let target_column = cursor_column.saturating_sub(width.saturating_sub(1));
    let mut start = 0;
    let mut start_column = 0;
    while start < flattened.len()
        && start_column + crate::codex_ui::char_width(flattened[start]) <= target_column
    {
        start_column += crate::codex_ui::char_width(flattened[start]);
        start += 1;
    }
    let mut visible = Vec::new();
    let mut visible_width = 0;
    for character in flattened.iter().skip(start).copied() {
        let character_width = crate::codex_ui::char_width(character);
        if visible_width + character_width > width {
            break;
        }
        visible.push(character);
        visible_width += character_width;
    }
    if start > 0 && !visible.is_empty() {
        visible[0] = '…';
        visible_width = width_of(&visible);
    } else if start > 0 {
        // A one-column viewport cannot fit a wide glyph. Keep a visible
        // marker and a usable cursor position instead of showing a blank row.
        return ("…".to_string(), usize::from(cursor_chars > 0));
    }
    // Only mark hidden trailing text when the cursor is not sitting on that
    // last cell — otherwise the ellipsis would hide the character being edited.
    let visible_end = start + visible.len();
    if visible_end < flattened.len()
        && cursor_column < start_column + visible_width.saturating_sub(1)
    {
        if let Some(last) = visible.last_mut() {
            *last = '…';
        }
    }
    let visible_cursor_chars = cursor_chars.saturating_sub(start).min(visible.len());
    let visible_cursor = width_of(&visible[..visible_cursor_chars]);
    (visible.into_iter().collect(), visible_cursor.min(width))
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
        snapshot if snapshot.starts_with("unavailable:") => "status unavailable".into(),
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
        "  describe intent · ⇧Tab advisor".to_string(),
    ]);
    lines.join("\n")
}

/// A quiet first frame for the human-facing terminal surface. It establishes
/// place and possibility without turning startup into a dashboard.
pub fn welcome(workspace: &Path, provider: &str, model: &str, greeting: &str, public_test: bool) {
    if raw_activity_mode() {
        if crate::keyboard::is_interactive() {
            println!("{}", composer_hints());
        }
        return;
    }
    println!(
        "{}",
        welcome_frame(workspace, provider, model, greeting, public_test)
    );
    if crate::keyboard::is_interactive() {
        println!("\n{}", composer_hints());
    }
    println!();
}

fn composer_hints() -> String {
    format!(
        "{}\n{}",
        paint(
            "Idle  Type naturally · / commands",
            &[DIM, palette().muted]
        ),
        paint(
            "Enter runs · Tab selects · ← workspace on empty input\nWorking  Enter steers · Tab queues · Esc stops",
            &[DIM, palette().muted]
        ),
    )
}

pub(crate) fn welcome_frame(
    workspace: &Path,
    provider: &str,
    model: &str,
    greeting: &str,
    _public_test: bool,
) -> String {
    let width = terminal_width();
    let brand = if width < 64 {
        paint("HII  /  HUMAN INFORMATION INTERFACE", &[BOLD, palette().primary])
    } else {
        format!(
            "{}  {}",
            paint("HII", &[BOLD, palette().primary]),
            paint("HUMAN INFORMATION INTERFACE", &[DIM, palette().muted])
        )
    };
    let mark = paint(" [HII]---< intent / context / action / proof >", &[DIM, palette().muted]);
    let location = paint(
        &format!(
            "{}  ·  started with {}  ·  {}",
            short_path(workspace),
            provider,
            model
        ),
        &[DIM, palette().muted],
    );
    let greeting = paint(greeting, &[palette().secondary]);
    format!("{brand}\n{mark}\n{location}\n\n{greeting}")
}

pub fn prompt_frame(_frame: usize) -> String {
    "  > ".to_string()
}

pub fn live_prompt_frame(frame: usize) -> String {
    if env::var_os("HII_REDUCED_MOTION").is_some() {
        return "  > ".to_string();
    }
    format!(" [{}] ", [".  ", ".. ", "...", " ..", "  .", "   "][frame % 6])
}

pub fn prompt_footer() -> String {
    let context = PROMPT_CONTEXT
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    let stage = activity_stage();
    let footer = if context.is_empty() {
        format!("{stage} · Enter run · Tab queue · Esc stop")
    } else {
        format!(
            "{context} · {stage} · Enter run · Tab queue · Esc stop"
        )
    };
    let width = crossterm::terminal::size()
        .map(|(columns, _)| usize::from(columns))
        .unwrap_or(80);
    crate::text::clip_line(&footer, width.saturating_sub(1).max(1))
}

/// Render the optional terminal-local activity projection from a real HII
/// phase label. The projection deliberately reports no token or device metrics.
pub fn activity_projection(stage: &str) -> String {
    let stage = match stage {
        "waiting" | "generating" | "tool" | "worker" | "saving" | "ready" | "failed" => stage,
        _ => "waiting",
    };
    format!("  +----+\n /    /|\n+----+ |  {stage}\n|    | +\n|    |/\n+----+")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlashCommandEntry {
    /// Prefix used to find the command while typing.
    pub trigger: String,
    /// Exact text inserted by Tab or dispatched by Enter.
    pub completion: String,
    pub description: String,
    pub requires_arguments: bool,
}

/// Composer controls are loaded once when an idle composer opens. This keeps
/// runtime and skill discovery out of the per-keystroke path.
pub struct SlashCommandCatalog {
    entries: Vec<SlashCommandEntry>,
    prefix_entries: Vec<SlashCommandEntry>,
}

impl SlashCommandCatalog {
    pub fn load(public_test: bool) -> Self {
        // Keep this inventory aligned with `parse_slash_command` and the
        // command handlers in main.rs. The public-test surface is intentionally
        // narrower than the owner harness.
        let mut entries = [
            ("/preview", "/preview ", "Preview an image, PDF, or text file", true, true),
            ("/permissions", "/permissions", "Inspect execution permissions", false, false),
            ("/help", "/help", "Show command help", false, true),
            ("/workspace", "/workspace", "Open live work, files, and proof", false, false),
            ("/tips", "/tips", "Show quick interaction tips", false, true),
            (
                "/install",
                "/install",
                "Install a model, skill, or tool",
                false,
                false,
            ),
            (
                "/compact",
                "/compact",
                "Summarize this conversation",
                false,
                true,
            ),
            ("/clear", "/clear", "Start with fresh context", false, true),
            ("/new", "/new", "Start with fresh context", false, true),
            (
                "/overview",
                "/overview",
                "Show current context and proof",
                false,
                false,
            ),
            (
                "/status",
                "/status",
                "Show session, workspace, model, and usage",
                false,
                true,
            ),
            (
                "/attach",
                "/attach",
                "Attach a workspace file or image",
                true,
                true,
            ),
            (
                "/attachments",
                "/attachments",
                "List pending attachments",
                false,
                true,
            ),
            (
                "/detach",
                "/detach",
                "Remove a pending attachment",
                false,
                true,
            ),
            (
                "/goal",
                "/goal",
                "Inspect or change the session goal",
                false,
                false,
            ),
            (
                "/plan",
                "/plan",
                "Inspect or change plan mode",
                false,
                false,
            ),
            (
                "/usage",
                "/usage",
                "Show token and context usage",
                false,
                true,
            ),
            (
                "/thinking",
                "/thinking",
                "Set conversation display mode",
                false,
                true,
            ),
            (
                "/reasoning",
                "/reasoning",
                "Set model reasoning effort",
                false,
                true,
            ),
            (
                "/mode",
                "/mode",
                "Choose coding behavior or provider routing",
                false,
                false,
            ),
            (
                "/autonomy",
                "/autonomy",
                "Choose local autonomy policy",
                false,
                false,
            ),
            ("/learn", "/learn", "Inspect learned memory", false, false),
            (
                "/theme",
                "/theme",
                "Inspect or change terminal theme",
                false,
                true,
            ),
            (
                "/settings",
                "/settings",
                "Inspect or change conversation settings",
                false,
                false,
            ),
            (
                "/keymap",
                "/keymap",
                "Inspect or change keyboard bindings",
                false,
                true,
            ),
            ("/raw", "/raw", "Toggle direct output mode", false, true),
            (
                "/activity",
                "/activity",
                "Toggle event-state ASCII activity view",
                false,
                false,
            ),
            (
                "/model",
                "/model",
                "List or switch models; /model refresh rescans the inventory",
                false,
                true,
            ),
            (
                "/engine",
                "/engine",
                "Choose an inference engine or configure a connection",
                false,
                true,
            ),
            ("/models", "/models", "List available models", false, false),
            ("/files", "/files", "Browse workspace files", false, false),
            (
                "/explore",
                "/explore",
                "Browse workspace files",
                false,
                false,
            ),
            ("/proof", "/proof", "Inspect execution proof", false, true),
            (
                "/runs",
                "/runs",
                "Browse this conversation's run tree and artifacts",
                false,
                true,
            ),
            ("/diff", "/diff", "Inspect workspace changes", false, false),
            (
                "/review",
                "/review",
                "Review workspace changes",
                false,
                false,
            ),
            ("/side", "/side", "Ask a side question", true, false),
            (
                "/resume",
                "/resume",
                "List or restore a session",
                false,
                false,
            ),
            (
                "/skills",
                "/skills",
                "Show learned skill drafts",
                false,
                false,
            ),
            ("/hooks", "/hooks", "Inspect lifecycle policy", false, false),
            ("/mcp", "/mcp", "Inspect governed MCP clients", false, false),
            (
                "/background",
                "/background",
                "Start a supervised background task",
                true,
                false,
            ),
            (
                "/bg",
                "/bg",
                "Start a supervised background task",
                true,
                false,
            ),
            ("/jobs", "/jobs", "List background jobs", false, false),
            ("/tasks", "/tasks", "List background jobs", false, false),
            (
                "/job",
                "/job",
                "Inspect or manage a background job",
                true,
                false,
            ),
            (
                "/agents",
                "/agents",
                "List managed and observed agents",
                false,
                false,
            ),
            (
                "/ps",
                "/ps",
                "List managed and observed agents",
                false,
                false,
            ),
            (
                "/providers",
                "/providers",
                "Show available provider access",
                false,
                false,
            ),
            (
                "/login",
                "/login",
                "Connect an existing provider plan",
                true,
                false,
            ),
            (
                "/phone",
                "/phone",
                "Continue this CLI conversation on an account-authenticated phone",
                false,
                false,
            ),
            (
                "/codex",
                "/codex",
                "Run an authenticated Codex task",
                true,
                false,
            ),
            (
                "/claude",
                "/claude",
                "Run an authenticated Claude task",
                true,
                false,
            ),
            (
                "/copy",
                "/copy",
                "Copy the latest response or transcript",
                false,
                false,
            ),
            (
                "/export",
                "/export",
                "Save this conversation to a private local file",
                false,
                false,
            ),
            (
                "/rename",
                "/rename",
                "Rename this saved session",
                true,
                false,
            ),
            ("/undo", "/undo", "Remove the last exchange", false, true),
            ("/fork", "/fork", "Snapshot this session", false, false),
            (
                "/teach",
                "/teach",
                "Save this session as a skill",
                true,
                false,
            ),
            (
                "/agent",
                "/agent",
                "Inspect or manage an agent",
                true,
                false,
            ),
            ("/stop", "/stop", "Stop a managed agent", true, false),
            (
                "/schedule",
                "/schedule",
                "Create a recurring task",
                true,
                false,
            ),
            (
                "/schedules",
                "/schedules",
                "List recurring tasks",
                false,
                false,
            ),
            (
                "/calendar",
                "/calendar",
                "Show upcoming calendar events",
                false,
                false,
            ),
            (
                "/sync",
                "/sync calendar",
                "Sync HII runs to Apple Calendar",
                false,
                false,
            ),
            ("/exit", "/exit", "Leave HII", false, true),
            ("/quit", "/quit", "Leave HII", false, true),
            ("/q", "/q", "Leave HII", false, true),
        ]
        .into_iter()
        .filter(|(_, _, _, _, in_public)| !public_test || *in_public)
        .map(
            |(trigger, completion, description, requires_arguments, _)| SlashCommandEntry {
                trigger: trigger.into(),
                completion: completion.into(),
                description: description.into(),
                requires_arguments,
            },
        )
        .collect::<Vec<_>>();
        if !public_test {
            // Dynamic controls resolve through the same hot-reloaded registry
            // as the CLI dispatcher. Native command handlers take precedence.
            for control in crate::slash_registry::controls() {
                let name = control.name.trim();
                if name.is_empty()
                    || !name.chars().all(|character| {
                        character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                    })
                {
                    continue;
                }
                let trigger = format!("/{name}");
                if entries.iter().any(|entry| entry.trigger == trigger) {
                    continue;
                }
                entries.push(SlashCommandEntry {
                    trigger: trigger.clone(),
                    completion: trigger,
                    description: control.description,
                    requires_arguments: false,
                });
            }
        }
        let prefix_entries = prefix_menu_entries();
        Self {
            entries,
            prefix_entries,
        }
    }

    pub fn matches(&self, input: &str) -> Vec<SlashCommandEntry> {
        let input = input.trim_start();
        if input
            .chars()
            .next()
            .is_some_and(|c| matches!(c, '@' | '!' | '$' | '#'))
        {
            if input.chars().any(char::is_whitespace) {
                return Vec::new();
            }
            let mut matches = self
                .prefix_entries
                .iter()
                .filter(|entry| {
                    entry.trigger.starts_with(input)
                })
                .cloned()
                .collect::<Vec<_>>();
            matches.sort_by(|left, right| left.trigger.cmp(&right.trigger));
            return matches;
        }
        if !input.starts_with('/') || input.chars().any(char::is_whitespace) {
            return Vec::new();
        }
        let mut matches = self
            .entries
            .iter()
            .filter(|entry| {
                entry.trigger.starts_with(input)
                    && !(input == "/" && is_slash_alias(&entry.trigger))
            })
            .cloned()
            .collect::<Vec<_>>();
        matches.sort_by_key(|entry| {
            let priority = match entry.trigger.as_str() {
                "/help" => 0,
                "/status" => 1,
                "/model" => 2,
                "/resume" => 3,
                "/jobs" => 4,
                "/permissions" => 5,
                _ => 6,
            };
            (priority, entry.trigger.clone())
        });
        matches
    }

    /// Return local command suggestions for slash prefixes and ordinary query
    /// text. This reads only the catalog loaded at composer start, so callers
    /// can reuse it on every keystroke or expose it through a local API.
    pub fn suggest(&self, input: &str) -> Vec<SlashCommandEntry> {
        let trimmed = input.trim();
        if matches!(trimmed.chars().next(), Some('@' | '!' | '$' | '#')) {
            return self.matches(trimmed).into_iter().take(8).collect();
        }
        if trimmed.starts_with('/') {
            return self.matches(trimmed).into_iter().take(6).collect();
        }
        let query = trimmed.strip_prefix('?').unwrap_or(trimmed).trim();
        if query.is_empty() {
            return Vec::new();
        }
        let query_terms = suggestion_terms(query);
        let mut ranked = self
            .entries
            .iter()
            .filter_map(|entry| {
                let haystack = format!(
                    "{} {}",
                    entry.trigger.trim_start_matches('/'),
                    entry.description
                );
                let (matched, score) =
                    fuzzy_command_score(&query_terms, &suggestion_terms(&haystack));
                (matched > 0).then(|| (entry.clone(), matched, score))
            })
            .collect::<Vec<_>>();
        ranked.sort_by(|left, right| {
            right
                .1
                .cmp(&left.1)
                .then_with(|| left.2.cmp(&right.2))
                .then_with(|| left.0.trigger.cmp(&right.0.trigger))
        });
        let command_limit = if trimmed.starts_with('?') { 0 } else { 5 };
        let mut suggestions = ranked
            .into_iter()
            .take(command_limit)
            .map(|(entry, _, _)| entry)
            .collect::<Vec<_>>();
        let search_completion = if trimmed.starts_with('?') {
            trimmed.to_string()
        } else {
            format!("? {trimmed}")
        };
        let search = SlashCommandEntry {
            trigger: "?".into(),
            completion: search_completion,
            description: "Search local HII information and capabilities".into(),
            requires_arguments: false,
        };
        if trimmed.starts_with('?') {
            suggestions.insert(0, search);
        } else {
            suggestions.push(search);
        }
        suggestions
    }
}

/// Composer prefixes that open a dedicated local menu instead of free text.
pub fn is_command_prefix(input: &str) -> bool {
    matches!(input.trim_start().chars().next(), Some('/' | '@' | '!' | '$' | '#'))
}

fn prefix_menu_entries() -> Vec<SlashCommandEntry> {
    let mut entries = [
        ("@read", "@read ", "Read a file or selected source", true),
        ("@list", "@list", "List available sources", false),
        ("@search", "@search ", "Search local files and information", true),
        (
            "@system-search",
            "@system-search ",
            "Search current system sources",
            true,
        ),
        ("@open", "@open ", "Open a file, app, or resource", true),
        ("@web-search", "@web-search ", "Search the web", true),
        ("!pwd", "!pwd", "Print the current directory", false),
        ("!ls", "!ls", "List files in the current directory", false),
        ("!git status", "!git status", "Show workspace changes", false),
        ("!rg", "!rg ", "Search workspace text", true),
        ("#note", "#note ", "Save a note", true),
        ("#idea", "#idea ", "Save an idea", true),
    ]
    .into_iter()
    .map(|(trigger, completion, description, requires_arguments)| SlashCommandEntry {
        trigger: trigger.into(),
        completion: completion.into(),
        description: description.into(),
        requires_arguments,
    })
    .collect::<Vec<_>>();

    if let Ok(paths) = crate::config::AppPaths::discover() {
        let skills_home = crate::storage::skills_root(&paths.runtime);
        let roots = crate::skill_catalog::roots(&paths.repo, Some(&paths.repo), &skills_home);
        for skill in crate::skill_catalog::search(&roots, "", 128) {
            let slug = skill
                .name
                .chars()
                .map(|character| {
                    if character.is_ascii_alphanumeric() {
                        character.to_ascii_lowercase()
                    } else {
                        '-'
                    }
                })
                .collect::<String>()
                .split('-')
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("-");
            if slug.is_empty() {
                continue;
            }
            entries.push(SlashCommandEntry {
                trigger: format!("${slug}"),
                completion: format!("${slug} "),
                description: if skill.description.is_empty() {
                    format!("Run the {} skill", skill.name)
                } else {
                    skill.description
                },
                requires_arguments: true,
            });
        }
    }
    entries.sort_by(|left, right| left.trigger.cmp(&right.trigger));
    entries.dedup_by(|left, right| left.trigger == right.trigger);
    entries
}

fn suggestion_terms(value: &str) -> Vec<String> {
    value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| term.chars().count() > 1)
        .map(str::to_lowercase)
        .filter(|term| {
            !matches!(
                term.as_str(),
                "the"
                    | "and"
                    | "for"
                    | "with"
                    | "that"
                    | "this"
                    | "from"
                    | "into"
                    | "your"
                    | "you"
                    | "please"
                    | "can"
                    | "could"
                    | "would"
                    | "what"
                    | "where"
                    | "when"
                    | "how"
                    | "why"
                    | "find"
                    | "search"
                    | "look"
                    | "show"
                    | "tell"
                    | "about"
            )
        })
        .collect()
}

fn fuzzy_command_score(query: &[String], words: &[String]) -> (usize, usize) {
    let mut matched = 0;
    let mut score = 0;
    for term in query {
        let best = words
            .iter()
            .filter_map(|word| {
                if word == term {
                    Some(0)
                } else if word.starts_with(term) {
                    Some(1)
                } else if fuzzy_subsequence(term, word) {
                    Some(3)
                } else {
                    None
                }
            })
            .min();
        if let Some(best) = best {
            matched += 1;
            score += best;
        }
    }
    (matched, score)
}

fn fuzzy_subsequence(needle: &str, haystack: &str) -> bool {
    let mut chars = needle.chars();
    let Some(mut next) = chars.next() else {
        return false;
    };
    for character in haystack.chars() {
        if character == next {
            match chars.next() {
                Some(character) => next = character,
                None => return true,
            }
        }
    }
    false
}

fn is_slash_alias(command: &str) -> bool {
    matches!(
        command,
        "/new" | "/models" | "/explore" | "/bg" | "/tasks" | "/ps" | "/quit" | "/q"
    )
}

pub fn command_menu(input: &str, selected: usize, public_test: bool) -> Vec<String> {
    let matches = SlashCommandCatalog::load(public_test).matches(input);
    let start = selected
        .saturating_sub(5)
        .min(matches.len().saturating_sub(6));
    matches
        .iter()
        .enumerate()
        .skip(start)
        .take(6)
        .map(|(index, entry)| {
            format!(
                "{}{}  {}",
                if index == selected { "› " } else { "  " },
                entry.completion,
                one_line_terminal_text(&entry.description)
            )
        })
        .collect()
}

pub fn one_line_terminal_text(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

pub fn command_matches(input: &str, public_test: bool) -> Vec<(String, String)> {
    SlashCommandCatalog::load(public_test)
        .matches(input)
        .into_iter()
        .map(|entry| (entry.completion, entry.description))
        .collect()
}

/// Render plain numbered session tabs with the active session marked by `*`.
/// `active` is zero-based; out-of-range active indices leave every tab inactive.
pub fn session_tabs(count: usize, active: usize) -> String {
    let mut tabs = (0..count)
        .map(|index| {
            if index == active {
                format!("[*{}]", index + 1)
            } else {
                format!("[{}]", index + 1)
            }
        })
        .collect::<Vec<_>>();
    tabs.push("[+]".to_string());
    tabs.join(" ")
}

pub fn queued() {
    if raw_activity_mode() {
        return;
    }
    println!(
        "  {} {}",
        paint("◇ QUEUED", &[palette().warning]),
        paint("carried into the next intent", &[DIM, palette().muted])
    );
}

pub fn idle_background() {
    if raw_activity_mode() {
        return;
    }
    println!(
        "  {} {}",
        paint("◇ BACKGROUND", &[palette().primary]),
        paint("type a task, then press Ctrl+B", &[DIM, palette().muted])
    );
}

pub fn tool_start(step: usize, tool: &str, target: &str) {
    let raw = raw_activity_mode();
    let rendered = tool_start_text(step, tool, target, raw);
    if raw {
        println!("{rendered}");
    } else {
        activity_line(&rendered);
    }
}

fn tool_start_text(step: usize, tool: &str, target: &str, raw: bool) -> String {
    if raw {
        if matches!(tool, "shell" | "verify") {
            target.to_string()
        } else {
            format!("{tool}({target})")
        }
    } else {
        tool_start_frame(step, tool, target)
    }
}

/// Print a tool call as durable stream history instead of transient activity.
/// Raw/stream mode is an append-only transcript: later model activity must not
/// erase the call or any output printed after it.
pub fn stream_tool_start(step: usize, tool: &str, target: &str) {
    println!("{}", tool_start_frame(step, tool, target));
}

fn tool_start_frame(step: usize, tool: &str, target: &str) -> String {
    format!(
        "{}  {}  {}",
        paint("◇", &[palette().secondary]),
        paint(&format!("{step:02} {tool}"), &[BOLD]),
        paint(
            &crate::text::clip_line(target, terminal_width().saturating_sub(30)),
            &[DIM, palette().muted]
        )
    )
}

pub fn tool_result(ok: bool, verification: bool) {
    if raw_activity_mode() {
        return;
    }
    activity_line(&tool_result_frame(ok, verification));
}

/// Keep a raw-mode result in terminal scrollback alongside its tool call.
pub fn stream_tool_result(ok: bool, verification: bool) {
    println!("{}", tool_result_frame(ok, verification));
}

fn tool_result_frame(ok: bool, verification: bool) -> String {
    let (mark, label, color) = if !ok {
        ("×", "tool failed", palette().error)
    } else if verification {
        ("✓", "verified", palette().primary)
    } else {
        ("✓", "complete", palette().primary)
    };
    format!(
        "{}  {}",
        paint(mark, &[BOLD, color]),
        paint(label, &[DIM, palette().muted])
    )
}

pub fn tool_output(output: &str) {
    if output.trim().is_empty() {
        return;
    }
    println!("{output}");
}

fn activity_line(line: &str) {
    println!("{line}");
    ACTIVITY_ROWS.fetch_add(1, Ordering::Relaxed);
}

pub fn user_turn(message: &str) {
    // Enter clears the idle composer before the model run begins. Keep the
    // submitted intent in the transcript even when transient activity is
    // hidden, so the run never appears to start with the user's text erased.
    if !raw_activity_mode() {
        finish_activity();
    }
    println!("{}", user_turn_frame(message));
}

fn user_turn_frame(message: &str) -> String {
    message.to_string()
}

pub struct ActiveRunView<'a> {
    pub title: &'a str,
    pub goal: &'a str,
    pub current: &'a str,
    pub direction: &'a [&'a str],
    pub next: &'a str,
}

pub fn active_run(view: &ActiveRunView<'_>) {
    if raw_activity_mode() {
        let _ = view;
        return;
    }
    finish_activity();
    println!("{}", active_run_frame(view));
}

/// Is this the same objective as the one already on screen?
///
/// Title, goal and direction are the standing header; `current` and `next` are
/// expected to move every step and do not make it a new objective.
pub fn same_objective(
    previous: &crate::agent::FlowProjection,
    next: &crate::agent::FlowProjection,
) -> bool {
    previous.title == next.title
        && previous.goal == next.goal
        && previous.direction == next.direction
}

/// Advance an objective already on screen.
///
/// Reprinting the header, the direction list and the steer hint on every action
/// is the wall of text the objective view exists to remove, so only the two
/// lines that actually moved are printed.
pub fn active_run_progress(view: &ActiveRunView<'_>) {
    if raw_activity_mode() {
        let _ = view;
        return;
    }
    finish_activity();
    println!("{}", active_run_progress_frame(view));
}

fn active_run_progress_frame(view: &ActiveRunView<'_>) -> String {
    [
        String::new(),
        paint("Currently", &[BOLD]),
        view.current.to_string(),
        String::new(),
        paint("Next", &[BOLD]),
        view.next.to_string(),
        String::new(),
    ]
    .join("\n")
}

fn active_run_frame(view: &ActiveRunView<'_>) -> String {
    let mut rows = vec![
        String::new(),
        paint(view.title, &[BOLD, palette().primary]),
        paint("Creating", &[DIM, palette().muted]),
    ];
    // An empty goal means the title already says it; do not print it twice.
    if !view.goal.is_empty() {
        rows.extend([String::new(), paint("Goal", &[BOLD]), view.goal.to_string()]);
    }
    rows.extend([
        String::new(),
        paint("Currently", &[BOLD]),
        view.current.to_string(),
    ]);
    if !view.direction.is_empty() {
        rows.extend([String::new(), paint("Direction", &[BOLD])]);
        rows.extend(view.direction.iter().map(|item| format!("• {item}")));
    }
    rows.extend([
        String::new(),
        paint("Next", &[BOLD]),
        view.next.to_string(),
        String::new(),
    ]);
    rows.join("\n")
}

pub fn activity_item(step: usize, current: &str) {
    if raw_activity_mode() {
        let _ = (step, current);
        return;
    }
    activity_line(&format!(
        "{}  {}",
        paint(&format!("{step:02} →"), &[BOLD, palette().secondary]),
        current
    ));
}

/// Composer-safe status for an explicitly requested engine switch. The prompt
/// has already submitted its draft before this line is emitted.
pub fn engine_status(state: &str, detail: &str) {
    activity_line(&engine_status_frame(state, detail));
}

fn engine_status_frame(state: &str, detail: &str) -> String {
    let (label, color) = match state {
        "connecting" | "loading" => (state.to_ascii_uppercase(), palette().warning),
        "ready" => ("READY".to_string(), palette().primary),
        _ => ("FAILED".to_string(), palette().error),
    };
    format!("{}  {}", paint(&format!("◇ {label}"), &[BOLD, color]), detail)
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
    if raw_activity_mode() {
        tool_output(output);
        return;
    }
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
    if raw_activity_mode() {
        let _ = message;
        return;
    }
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
    println!("{}", terminal_safe_text(message));
}

/// Write one incremental piece of model-authored text without adding a role,
/// event label, or newline.
pub fn stream_text(message: &str) {
    print!("{}", terminal_safe_text(message));
    let _ = io::stdout().flush();
}

/// Keep model text literal: ANSI/OSC and other control bytes must never become
/// terminal commands. Newlines and tabs remain available for readable prose,
/// tables, and code blocks.
fn terminal_safe_text(message: &str) -> String {
    message
        .chars()
        .filter_map(|character| match character {
            '\n' | '\t' => Some(character),
            '\r' => None,
            character if character.is_control() => Some('�'),
            character => Some(character),
        })
        .collect()
}

pub fn system(message: &str) {
    if raw_activity_mode() {
        tool_output(message);
        return;
    }
    println!();
    println!("  {}", paint("SYSTEM", &[BOLD, palette().secondary]));
    for line in message.lines() {
        println!("  {line}");
    }
    println!();
}

/// Runtime-only notices are omitted from the default transcript. Keep explicit
/// command results on `system`/`reply` so user-requested output remains visible.
pub fn runtime_system(message: &str) {
    if !raw_activity_mode() {
        system(message);
    }
}

pub fn error(message: &str) {
    finish_activity();
    if raw_activity_mode() {
        println!("{}", terminal_safe_text(message));
        return;
    }
    println!();
    println!(
        "  {}  {}",
        paint("! LOCAL PROBLEM", &[BOLD, palette().error]),
        message
    );
    println!();
}

#[cfg(test)]
mod tests {
    use super::{
        active_run_frame, active_run_progress_frame, clear_activity_sequence, command_matches,
        command_menu, composer_hints, composer_window, overview, prompt_footer, prompt_frame,
        session_tabs, short_path, terminal_safe_text, theme_choices, tool_result_frame,
        tool_start_frame, tool_start_text, user_turn_frame, welcome_frame, workspace_state,
        engine_status_frame,
        ActiveRunView, Theme,
    };
    use std::path::Path;

    #[test]
    fn engine_status_frames_name_each_truthful_phase() {
        for phase in ["connecting", "loading", "ready", "failed"] {
            assert!(engine_status_frame(phase, "PC / hii-pc · endpoint").contains(&phase.to_ascii_uppercase()));
        }
        assert!(engine_status_frame("loading", "waiting for first request").contains("waiting for first request"));
    }

    #[test]
    fn final_replies_preserve_layout_without_executing_terminal_controls() {
        assert_eq!(
            terminal_safe_text("Title\n\n- item\n\tcode\x1b[2J"),
            "Title\n\n- item\n\tcode�[2J"
        );
    }

    #[test]
    fn theme_choices_offer_every_theme_and_mark_the_active_one() {
        let choices = theme_choices(Theme::Light);
        let names: Vec<_> = choices.iter().map(|choice| choice.value.as_str()).collect();
        assert_eq!(names, vec!["dark", "light"]);
        let current: Vec<_> = choices
            .iter()
            .filter(|choice| choice.current)
            .map(|choice| choice.value.as_str())
            .collect();
        assert_eq!(current, vec!["light"]);
        assert!(choices[1].detail.ends_with("· current"));
        assert!(choices[0].detail.contains("monochrome"));
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
        assert_eq!(workspace_state("unavailable: status timed out"), "status unavailable");
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
        assert!(!rendered.contains("/overview"));
        assert!(!rendered.contains("/proof"));
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
    fn composer_window_scrolls_cjk_by_terminal_cells() {
        let line = "界界界abcd";
        let (visible, column) = composer_window(line, line.len(), 6);
        assert!(crate::codex_ui::display_width(&visible) <= 6);
        assert!(visible.starts_with('…'));
        assert_eq!(column, crate::codex_ui::display_width(&visible));

        let line = "e\u{301}界界z";
        let (visible, column) = composer_window(line, line.len(), 4);
        assert!(crate::codex_ui::display_width(&visible) <= 4);
        assert_eq!(column, crate::codex_ui::display_width(&visible));
    }

    #[test]
    fn composer_window_keeps_cursor_inside_a_one_column_cjk_viewport() {
        let (visible, column) = composer_window("界", "界".len(), 1);
        assert_eq!(visible, "…");
        assert_eq!(column, 1);
    }

    #[test]
    fn prompt_is_a_minimal_codex_style_input_line() {
        assert!(!prompt_frame(0).trim().is_empty());
        assert!(prompt_frame(0).starts_with("  "));
        assert_eq!(crate::codex_ui::display_width(&prompt_frame(0)), 4);
        assert!(!prompt_frame(0).contains('\n'));
        assert!(prompt_footer().contains("Enter run"));
    }

    #[test]
    fn activity_cube_is_ascii_and_reports_only_named_runtime_states() {
        for stage in ["waiting", "generating", "tool", "worker", "saving"] {
            let frame = super::activity_projection(stage);
            assert!(frame.is_ascii());
            assert!(frame.contains(stage));
            assert!(!frame.contains('%'));
            assert!(!frame.to_ascii_lowercase().contains("gpu"));
        }
        assert!(super::activity_projection("invented-state").contains("waiting"));
    }

    #[test]
    fn welcome_is_compact_and_leaves_instruction_to_the_composer() {
        let rendered = welcome_frame(
            Path::new("/tmp/studio"),
            "HII",
            "local-model",
            "Welcome back — 2 context sources loaded.",
            false,
        );
        assert!(rendered.contains("HUMAN INFORMATION INTERFACE"));
        assert!(rendered.contains("HII"));
        assert!(rendered.contains("started with HII  ·  local-model"));
        assert!(rendered.contains("Welcome back"));
        assert!(!rendered.contains("What do you want"));
        assert!(!rendered.contains("Type naturally"));
        assert_eq!(rendered.lines().count(), 5);
    }

    #[test]
    fn collapsed_activity_clears_exactly_the_rows_it_owned() {
        assert_eq!(clear_activity_sequence(0), "");
        assert_eq!(clear_activity_sequence(2).matches("\x1b[1A").count(), 2);
        assert_eq!(clear_activity_sequence(2).matches("\x1b[2K").count(), 2);
    }

    #[test]
    fn stream_tool_frames_are_complete_durable_rows() {
        let call = tool_start_frame(3, "list", "workspace");
        let result = tool_result_frame(true, false);
        assert!(call.contains("◇"));
        assert!(call.contains("03 list"));
        assert!(call.contains("workspace"));
        assert!(result.contains("✓"));
        assert!(result.contains("complete"));
        assert!(!call.contains('\n'));
        assert!(!result.contains('\n'));
    }

    #[test]
    fn raw_tool_call_shows_full_action_without_runtime_badges() {
        let rendered = tool_start_text(
            7,
            "shell",
            "python3 create_scene.py --output /tmp/house.blend",
            true,
        );
        assert_eq!(
            rendered,
            "python3 create_scene.py --output /tmp/house.blend"
        );
        assert!(!rendered.contains("07"));
        assert!(!rendered.contains('◇'));
    }

    #[test]
    fn advancing_an_objective_reprints_only_what_moved() {
        // Reprinting the header on every action is the wall of text the
        // objective view exists to remove.
        let view = ActiveRunView {
            title: "Personal Dashboard",
            goal: "See what matters right now.",
            current: "Adding the schedule section.",
            direction: &["HII", "School"],
            next: "Wire the data source.",
        };
        let progress = active_run_progress_frame(&view);
        assert!(progress.contains("Adding the schedule section."));
        assert!(progress.contains("Wire the data source."));
        assert!(!progress.contains("Personal Dashboard"));
        assert!(!progress.contains("• School"));
        assert!(!progress.contains("You can steer at any time."));
    }

    #[test]
    fn an_objective_that_only_advances_is_still_the_same_objective() {
        let projection = |current: &str, title: &str| crate::agent::FlowProjection {
            title: title.into(),
            goal: "See what matters right now.".into(),
            current: current.into(),
            direction: vec!["HII".into()],
            next: "next".into(),
        };
        assert!(super::same_objective(
            &projection("organizing", "Personal Dashboard"),
            &projection("adding schedule", "Personal Dashboard"),
        ));
        assert!(!super::same_objective(
            &projection("organizing", "Personal Dashboard"),
            &projection("organizing", "Course Planner"),
        ));
    }

    #[test]
    fn the_opening_frame_states_the_objective_once() {
        // The request is already echoed above this frame; a title plus an
        // identical goal would print it three times.
        let frame = active_run_frame(&ActiveRunView {
            title: "Create a personal dashboard for us",
            goal: "",
            current: "Understanding what belongs here.",
            direction: &[],
            next: "Choose the first useful change.",
        });
        assert!(frame.contains("Create a personal dashboard for us"));
        assert!(!frame.contains("Goal"));
        assert!(frame.contains("Currently"));
    }

    #[test]
    fn flow_frames_keep_intent_and_direction_out_of_transient_activity() {
        let human = user_turn_frame("Fix this\nand verify it");
        let run = active_run_frame(&ActiveRunView {
            title: "Personal Dashboard",
            goal: "See what matters right now.",
            current: "Organizing active projects.",
            direction: &["HII", "School"],
            next: "Add schedule.",
        });
        // The default raw transcript must retain the submitted text after
        // Enter clears the idle composer and before the run tree is updated.
        assert_eq!(user_turn_frame("Fix this\nand verify it"), human);
        assert_eq!(human, "Fix this\nand verify it");
        assert!(run.contains("Personal Dashboard"));
        assert!(run.contains("Currently"));
        assert!(run.contains("• School"));
        assert!(!run.contains("You can steer at any time."));
        assert!(!human.contains("\x1b[1A"));
        assert!(!run.contains("tool_call"));
        assert!(!run.contains("\x1b[1A"));
    }

    #[test]
    fn slash_palette_filters_harness_and_public_commands() {
        assert!(command_matches("/sta", false)
            .iter()
            .any(|(command, _)| command == "/status"));
        assert!(command_matches("/pho", false)
            .iter()
            .any(|(command, _)| command == "/phone"));
        assert!(command_matches("  /sta", false)
            .iter()
            .any(|(command, _)| command == "/status"));
        assert!(command_matches("/model local", true).is_empty());
        let menu = command_menu("/", 0, false);
        assert_eq!(menu.len(), 6);
        assert!(menu[0].contains("/help"));
        assert!(menu[1].contains("/status"));
        assert!(menu[2].contains("/model"));
        assert!(menu[3].contains("/resume"));
        assert!(menu[4].contains("/jobs"));
        assert!(menu[5].contains("/permissions"));
        assert!(
            !command_matches("/", false)
                .iter()
                .any(|(command, _)| matches!(command.as_str(), "/new" | "/quit" | "/q" | "/ps"))
        );
        assert!(
            command_matches("/q", false)
                .iter()
                .any(|(command, _)| command == "/q")
        );
        assert!(
            command_matches("/q", false)
                .iter()
                .any(|(command, _)| command == "/quit")
        );
        assert!(
            command_matches("/ag", false)
                .iter()
                .any(|(command, _)| command == "/agents")
        );
        assert!(command_matches("/ag", true).is_empty());
        assert!(prompt_footer().contains("Tab queue"));
    }

    #[test]
    fn omni_suggestions_fuzzily_match_commands_and_offer_local_search() {
        let catalog = super::SlashCommandCatalog::load(false);
        let suggestions = catalog.suggest("stts");
        assert!(
            suggestions
                .iter()
                .any(|entry| entry.completion == "/status")
        );
        assert_eq!(suggestions.last().unwrap().completion, "? stts");
        assert!(suggestions.len() <= 6);

        let query_suggestions = catalog.suggest("? where is my model");
        assert_eq!(query_suggestions.len(), 1);
        assert_eq!(query_suggestions[0].completion, "? where is my model");
        assert!(catalog.suggest("").is_empty());
        assert!(catalog.suggest("/").len() <= 6);
    }

    #[test]
    fn startup_hint_distinguishes_idle_submission_from_live_steering() {
        let hints = composer_hints();
        assert!(hints.contains("/ commands"));
        assert!(hints.contains("Type naturally"));
        assert!(hints.contains("Enter runs · Tab selects · ← workspace on empty input"));
        assert!(hints.contains("Working  Enter steers · Tab queues · Esc stops"));
    }

    #[test]
    fn session_tabs_are_plain_and_mark_the_active_session() {
        assert_eq!(session_tabs(2, 0), "[*1] [2] [+]");
        assert_eq!(session_tabs(3, 2), "[1] [2] [*3] [+]");
        assert_eq!(session_tabs(0, 0), "[+]");
        assert_eq!(session_tabs(2, 9), "[1] [2] [+]");
    }

    #[test]
    fn theme_names_are_stable_and_reject_unknown_values() {
        assert_eq!(Theme::parse("default").unwrap(), Theme::Dark);
        assert_eq!(Theme::parse("light").unwrap(), Theme::Light);
        assert_eq!(Theme::parse("monochrome").unwrap(), Theme::Dark);
        assert!(Theme::parse("neon-chaos").is_err());
    }
}
