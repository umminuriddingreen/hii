//! Raw-terminal keyboard input model for the interactive REPL.
//!
//! The REPL wants richer control keys than a line-based `read_line` can offer:
//! Enter submits steering for the current run, Tab queues a line for the next
//! checkpoint, Esc interrupts, and Ctrl+B / Ctrl+T reach into run control. This
//! module owns that translation and nothing else — it turns raw key presses
//! into a high-level [`InputEvent`] the REPL can act on.
//!
//! Raw mode is RAII-guarded ([`RawModeGuard`]) so a panic mid-read still
//! restores a sane terminal. When stdin/stdout is not a TTY (piped or
//! non-interactive use) the caller should fall back to [`read_line_fallback`],
//! which never touches raw mode.

use std::{
    env,
    io::{self, IsTerminal, Write},
    time::Duration,
};

use crate::keymap::{KeyAction, Keymap};
use crate::paste::PasteStore;
use crossterm::event::{
    self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEvent, KeyModifiers,
};
use crossterm::execute;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};

/// Local result alias: keyboard I/O surfaces plain string errors, matching the
/// rest of the crate.
type Result<T> = std::result::Result<T, String>;

/// A high-level input intent produced by the REPL key loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputEvent {
    /// Enter — submit the current line as steering/intent for the current run.
    Submit(String),
    /// Tab — queue the current line for the next checkpoint (not submitted now).
    Queue(String),
    /// Esc — interrupt the current run.
    Interrupt,
    /// Ctrl+B — start the current composer text as a supervised background task.
    Background(String),
    /// Ctrl+T — show the task/status view.
    TaskView,
    /// Shift+Tab — ask the heavy local advisor for one governed next action.
    AutoAdvisor,
}

/// Whether the interactive raw-mode loop is usable (both stdin and stdout TTY).
///
/// The REPL gates on this and calls [`read_line_fallback`] otherwise, so piped
/// or non-interactive invocations keep working.
pub fn is_interactive() -> bool {
    env::var_os("HII_UI_LINE_MODE").is_none()
        && io::stdin().is_terminal()
        && io::stdout().is_terminal()
}

/// RAII wrapper that enables raw mode on construction and always restores the
/// terminal on drop — including during unwinding — so a panic never leaves the
/// user's shell in raw mode.
struct RawModeGuard;

impl RawModeGuard {
    fn enter() -> Result<Self> {
        enable_raw_mode().map_err(|e| format!("failed to enable raw terminal mode: {e}"))?;
        // Bracketed paste makes the terminal hand us a clipboard payload as one
        // `Event::Paste` instead of replaying it as keystrokes — without it a
        // multi-line paste submits a half-finished intent per line. Terminals
        // that do not support it simply ignore the sequence.
        let _ = execute!(io::stdout(), EnableBracketedPaste);
        Ok(RawModeGuard)
    }
}

/// Non-blocking input used while a model call is active. It deliberately
/// shares the same key grammar as the idle composer.
pub struct LiveInput {
    _guard: RawModeGuard,
    buf: String,
    cursor: usize,
    keymap: Keymap,
    pastes: PasteStore,
    stream_column: usize,
    terminal_width: usize,
    stream_active: bool,
}

impl LiveInput {
    pub fn enter(keymap: Keymap) -> Result<Option<Self>> {
        if !is_interactive() {
            return Ok(None);
        }
        let mut input = Self {
            _guard: RawModeGuard::enter()?,
            buf: String::new(),
            cursor: 0,
            keymap,
            pastes: PasteStore::default(),
            stream_column: 0,
            terminal_width: crossterm::terminal::size()
                .map(|(columns, _)| usize::from(columns))
                .unwrap_or(80)
                .max(1),
            stream_active: true,
        };
        input.begin_stream()?;
        Ok(Some(input))
    }

    pub fn poll(&mut self) -> Result<Option<InputEvent>> {
        if !event::poll(Duration::ZERO)
            .map_err(|e| format!("failed to poll active-run input: {e}"))?
        {
            return Ok(None);
        }
        let event = event::read().map_err(|e| format!("failed to read active-run input: {e}"))?;
        if let Event::Paste(raw) = event {
            insert_paste(&mut self.pastes, &raw, &mut self.buf, &mut self.cursor);
            self.redraw_composer()?;
            return Ok(None);
        }
        let Event::Key(key) = event else {
            return Ok(None);
        };
        if key.kind != event::KeyEventKind::Press {
            return Ok(None);
        }
        let outcome = match apply_key(key, &mut self.buf, &mut self.cursor, &self.keymap) {
            KeyOutcome::Emit(event) => Some(expand_pastes(event, &mut self.pastes)),
            KeyOutcome::Continue => {
                self.redraw_composer()?;
                None
            }
        };
        Ok(outcome)
    }

    fn begin_stream(&mut self) -> Result<()> {
        let mut out = io::stdout();
        write!(
            out,
            "{}\r\n{}\x1b[1A\r\x1b[L",
            crate::tui::prompt_frame(0),
            crate::tui::prompt_footer()
        )
        .map_err(|e| format!("failed to draw active composer: {e}"))?;
        out.flush()
            .map_err(|e| format!("failed to flush active composer: {e}"))
    }

    pub fn write_stream(&mut self, delta: &str) -> Result<()> {
        let mut out = io::stdout();
        for ch in delta.chars() {
            if ch == '\n' {
                write!(out, "\r\n\x1b[L")
                    .map_err(|e| format!("failed to advance model stream: {e}"))?;
                self.stream_column = 0;
                continue;
            }
            if self.stream_column >= self.terminal_width {
                write!(out, "\r\n\x1b[L")
                    .map_err(|e| format!("failed to wrap model stream: {e}"))?;
                self.stream_column = 0;
            }
            write!(out, "{ch}").map_err(|e| format!("failed to write model stream: {e}"))?;
            self.stream_column += 1;
        }
        out.flush()
            .map_err(|e| format!("failed to flush model stream: {e}"))
    }

    /// Replace the single transient activity row above the live composer.
    /// Keeping this to one row lets the final response erase it cleanly.
    pub fn replace_stream_line(&mut self, line: &str) -> Result<()> {
        let mut out = io::stdout();
        write!(out, "\r\x1b[2K{line}")
            .map_err(|e| format!("failed to update model activity: {e}"))?;
        out.flush()
            .map_err(|e| format!("failed to flush model activity: {e}"))
    }

    fn redraw_composer(&self) -> Result<()> {
        let mut out = io::stdout();
        let (visible, column) =
            crate::tui::composer_window(&self.buf, self.cursor, crate::tui::composer_width());
        write!(
            out,
            "\x1b[s\x1b[2B\r\x1b[2K{}{visible}",
            crate::tui::prompt_frame(0)
                .rsplit_once("\r\n")
                .map_or(crate::tui::prompt_frame(0), |(_, row)| row.to_string()),
        )
        .map_err(|e| format!("failed to redraw active composer: {e}"))?;
        let tail = visible.chars().count().saturating_sub(column);
        if tail > 0 {
            write!(out, "\x1b[{tail}D")
                .map_err(|e| format!("failed to restore active composer cursor: {e}"))?;
        }
        write!(out, "\x1b[u").map_err(|e| format!("failed to restore model cursor: {e}"))?;
        out.flush()
            .map_err(|e| format!("failed to flush active composer: {e}"))
    }

    pub fn finish_stream(&mut self) {
        if !self.stream_active {
            return;
        }
        let mut out = io::stdout();
        let _ = write!(
            out,
            "\r\n\x1b[2K\x1b[2B\r\x1b[2K\x1b[1A\r\x1b[2K\x1b[1A\r\x1b[2K"
        );
        let _ = out.flush();
        self.stream_active = false;
    }
}

impl Drop for LiveInput {
    fn drop(&mut self) {
        self.finish_stream();
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        // Best-effort: nothing useful to do if restoring fails.
        let _ = execute!(io::stdout(), DisableBracketedPaste);
        let _ = disable_raw_mode();
    }
}

/// Insert a clipboard payload at the cursor, staging it if it is too large to
/// show literally in the one-line composer.
fn insert_paste(store: &mut PasteStore, raw: &str, buf: &mut String, cursor: &mut usize) {
    let inserted = store.stage(raw);
    if inserted.is_empty() {
        return;
    }
    buf.insert_str(*cursor, &inserted);
    *cursor += inserted.len();
}

/// Substitute staged pastes back into an event that carries composer text, and
/// reset the store — the line it belonged to is on its way out.
fn expand_pastes(event: InputEvent, store: &mut PasteStore) -> InputEvent {
    let expanded = match event {
        InputEvent::Submit(line) => InputEvent::Submit(store.expand(&line)),
        InputEvent::Queue(line) => InputEvent::Queue(store.expand(&line)),
        InputEvent::Background(line) => InputEvent::Background(store.expand(&line)),
        other => return other,
    };
    store.clear();
    expanded
}

/// Outcome of feeding a single key into the line buffer.
///
/// Factored out as a pure function ([`apply_key`]) so the submit/queue/control
/// decision logic is unit-testable without a live terminal.
enum KeyOutcome {
    /// A complete high-level event; the read loop returns it.
    Emit(InputEvent),
    /// The buffer was edited (or the key ignored); keep reading.
    Continue,
}

/// Pure translation of one key press into a [`KeyOutcome`], mutating `buf` for
/// plain typing and line editing. No terminal I/O happens here.
fn previous_boundary(buf: &str, cursor: usize) -> usize {
    buf[..cursor]
        .char_indices()
        .last()
        .map(|(index, _)| index)
        .unwrap_or(0)
}

fn next_boundary(buf: &str, cursor: usize) -> usize {
    buf[cursor..]
        .chars()
        .next()
        .map(|character| cursor + character.len_utf8())
        .unwrap_or(cursor)
}

fn apply_key(key: KeyEvent, buf: &mut String, cursor: &mut usize, keymap: &Keymap) -> KeyOutcome {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    if key.code == KeyCode::BackTab
        || (key.code == KeyCode::Tab && key.modifiers.contains(KeyModifiers::SHIFT))
    {
        return KeyOutcome::Emit(InputEvent::AutoAdvisor);
    }
    if matches!(key.code, KeyCode::Esc)
        || matches!(key.code, KeyCode::Char('c')) && ctrl
        || keymap.matches(KeyAction::Interrupt, key)
    {
        return KeyOutcome::Emit(InputEvent::Interrupt);
    }
    if keymap.matches(KeyAction::Queue, key) {
        *cursor = 0;
        return KeyOutcome::Emit(InputEvent::Queue(std::mem::take(buf)));
    }
    if keymap.matches(KeyAction::Background, key) {
        *cursor = 0;
        return KeyOutcome::Emit(InputEvent::Background(std::mem::take(buf)));
    }
    if keymap.matches(KeyAction::Tasks, key) {
        return KeyOutcome::Emit(InputEvent::TaskView);
    }
    match key.code {
        KeyCode::Enter => {
            *cursor = 0;
            KeyOutcome::Emit(InputEvent::Submit(std::mem::take(buf)))
        }
        KeyCode::Char('a') if ctrl => {
            *cursor = 0;
            KeyOutcome::Continue
        }
        KeyCode::Home => {
            *cursor = 0;
            KeyOutcome::Continue
        }
        KeyCode::Char('e') if ctrl => {
            *cursor = buf.len();
            KeyOutcome::Continue
        }
        KeyCode::End => {
            *cursor = buf.len();
            KeyOutcome::Continue
        }
        KeyCode::Left if !alt => {
            *cursor = previous_boundary(buf, *cursor);
            KeyOutcome::Continue
        }
        KeyCode::Right if !alt => {
            *cursor = next_boundary(buf, *cursor);
            KeyOutcome::Continue
        }
        KeyCode::Left if alt => {
            while *cursor > 0
                && buf[..*cursor]
                    .chars()
                    .last()
                    .is_some_and(char::is_whitespace)
            {
                *cursor = previous_boundary(buf, *cursor);
            }
            while *cursor > 0
                && buf[..*cursor]
                    .chars()
                    .last()
                    .is_some_and(|character| !character.is_whitespace())
            {
                *cursor = previous_boundary(buf, *cursor);
            }
            KeyOutcome::Continue
        }
        KeyCode::Char('b') if alt => {
            while *cursor > 0
                && buf[..*cursor]
                    .chars()
                    .last()
                    .is_some_and(char::is_whitespace)
            {
                *cursor = previous_boundary(buf, *cursor);
            }
            while *cursor > 0
                && buf[..*cursor]
                    .chars()
                    .last()
                    .is_some_and(|character| !character.is_whitespace())
            {
                *cursor = previous_boundary(buf, *cursor);
            }
            KeyOutcome::Continue
        }
        KeyCode::Right if alt => {
            while *cursor < buf.len()
                && buf[*cursor..]
                    .chars()
                    .next()
                    .is_some_and(char::is_whitespace)
            {
                *cursor = next_boundary(buf, *cursor);
            }
            while *cursor < buf.len()
                && buf[*cursor..]
                    .chars()
                    .next()
                    .is_some_and(|character| !character.is_whitespace())
            {
                *cursor = next_boundary(buf, *cursor);
            }
            KeyOutcome::Continue
        }
        KeyCode::Char('f') if alt => {
            while *cursor < buf.len()
                && buf[*cursor..]
                    .chars()
                    .next()
                    .is_some_and(char::is_whitespace)
            {
                *cursor = next_boundary(buf, *cursor);
            }
            while *cursor < buf.len()
                && buf[*cursor..]
                    .chars()
                    .next()
                    .is_some_and(|character| !character.is_whitespace())
            {
                *cursor = next_boundary(buf, *cursor);
            }
            KeyOutcome::Continue
        }
        KeyCode::Char('u') if ctrl => {
            buf.drain(..*cursor);
            *cursor = 0;
            KeyOutcome::Continue
        }
        KeyCode::Char('k') if ctrl => {
            buf.truncate(*cursor);
            KeyOutcome::Continue
        }
        KeyCode::Char('w') if ctrl => {
            let end = *cursor;
            while *cursor > 0
                && buf[..*cursor]
                    .chars()
                    .last()
                    .is_some_and(char::is_whitespace)
            {
                *cursor = previous_boundary(buf, *cursor);
            }
            while *cursor > 0
                && buf[..*cursor]
                    .chars()
                    .last()
                    .is_some_and(|character| !character.is_whitespace())
            {
                *cursor = previous_boundary(buf, *cursor);
            }
            buf.drain(*cursor..end);
            KeyOutcome::Continue
        }
        KeyCode::Backspace if *cursor > 0 => {
            let previous = previous_boundary(buf, *cursor);
            buf.drain(previous..*cursor);
            *cursor = previous;
            KeyOutcome::Continue
        }
        KeyCode::Delete if *cursor < buf.len() => {
            let next = next_boundary(buf, *cursor);
            buf.drain(*cursor..next);
            KeyOutcome::Continue
        }
        // Ignore other control chords; only insert real characters.
        KeyCode::Char(c) if !ctrl && !alt => {
            buf.insert(*cursor, c);
            *cursor += c.len_utf8();
            KeyOutcome::Continue
        }
        _ => KeyOutcome::Continue,
    }
}

/// Redraw the prompt and current buffer on one line (carriage-return refresh).
fn clear_menu(out: &mut impl Write, rows: usize) {
    if rows == 0 {
        return;
    }
    // The cursor rests on the composer's editable middle row. Move to the
    // frame's top, erase the complete frame plus any command-menu rows, and
    // return to that top coordinate for a clean redraw.
    let _ = write!(out, "\x1b[1A\r");
    for index in 0..rows {
        let _ = write!(out, "\x1b[2K");
        if index + 1 < rows {
            let _ = write!(out, "\r\n");
        }
    }
    let _ = write!(out, "\x1b[{}A\r", rows.saturating_sub(1));
}

fn redraw(
    prompt: &str,
    buf: &str,
    cursor: usize,
    selected: usize,
    previous_rows: &mut usize,
    public_test: bool,
) -> Result<()> {
    let mut out = io::stdout();
    clear_menu(&mut out, *previous_rows);
    // The buffer is windowed to one row: a wrapped line would desynchronise
    // every relative cursor move below and tear the frame apart.
    let (visible, column) = crate::tui::composer_window(buf, cursor, crate::tui::composer_width());
    write!(
        out,
        "\r\x1b[2K{prompt}{visible}\r\n\x1b[2K{}",
        crate::tui::prompt_footer()
    )
    .map_err(|e| format!("failed to write prompt: {e}"))?;
    let menu = crate::tui::command_menu(buf, selected, public_test);
    if !menu.is_empty() {
        for line in &menu {
            write!(out, "\r\n\x1b[2K{line}")
                .map_err(|e| format!("failed to draw command menu: {e}"))?;
        }
    }
    // Return from the last painted row to the editable row, then restore the
    // in-buffer cursor. Use relative movement instead of save/restore: saved
    // terminal coordinates become unreliable if drawing the menu scrolls at the
    // bottom of the viewport.
    let rows_below_input = 1 + menu.len();
    write!(out, "\x1b[{rows_below_input}A\r")
        .map_err(|e| format!("failed to restore composer row: {e}"))?;
    // ANSI paint sequences in `prompt` occupy bytes but no terminal columns.
    // The visible input prefix is always "  │ ", which is four columns.
    let column = 4 + column;
    if column > 0 {
        write!(out, "\x1b[{column}C")
            .map_err(|e| format!("failed to restore input cursor: {e}"))?;
    }
    *previous_rows = 3 + menu.len();
    out.flush()
        .map_err(|e| format!("failed to flush stdout: {e}"))?;
    Ok(())
}

/// Run the raw-mode key loop until a high-level [`InputEvent`] is produced.
///
/// `prompt` is redrawn as the user edits. Raw mode is entered for the duration
/// and restored on return (or panic) via [`RawModeGuard`].
fn move_selection(selected: usize, length: usize, direction: i8) -> usize {
    if length == 0 {
        return 0;
    }
    if direction < 0 {
        selected
            .checked_sub(1)
            .unwrap_or_else(|| length.saturating_sub(1))
    } else {
        (selected + 1) % length
    }
}

fn selected_command(buf: &str, matches: &[(String, String)], selected: usize) -> String {
    matches
        .iter()
        .find(|(command, _)| command == buf)
        .or_else(|| matches.get(selected))
        .map(|(command, _)| command.clone())
        .unwrap_or_else(|| buf.to_string())
}

fn complete_selected_command(
    buf: &mut String,
    cursor: &mut usize,
    matches: &[(String, String)],
    selected: usize,
) {
    let command = selected_command(buf, matches, selected);
    *buf = format!("{command} ");
    *cursor = buf.len();
}

pub fn read_event(public_test: bool, history: &[String], keymap: &Keymap) -> Result<InputEvent> {
    let _guard = RawModeGuard::enter()?;
    let mut buf = String::new();
    let mut cursor = 0usize;
    let mut pastes = PasteStore::default();
    let frame = 0usize;
    let mut selected = 0usize;
    let mut menu_rows = 0usize;
    let mut history_index = history.len();
    let mut draft = String::new();
    redraw(
        &crate::tui::prompt_frame(frame),
        &buf,
        cursor,
        selected,
        &mut menu_rows,
        public_test,
    )?;
    loop {
        if !event::poll(Duration::from_millis(140))
            .map_err(|e| format!("failed to poll terminal event: {e}"))?
        {
            continue;
        }
        let event = event::read().map_err(|e| format!("failed to read key: {e}"))?;
        if let Event::Paste(raw) = &event {
            insert_paste(&mut pastes, raw, &mut buf, &mut cursor);
            selected = 0;
            redraw(
                &crate::tui::prompt_frame(frame),
                &buf,
                cursor,
                selected,
                &mut menu_rows,
                public_test,
            )?;
            continue;
        }
        if let Event::Key(key) = event {
            // crossterm may deliver key-release events on some platforms; only
            // act on presses (the default `Press` kind).
            if key.kind != event::KeyEventKind::Press {
                continue;
            }
            // A buffer holding a staged paste is prose, not a command — even
            // when the pasted text happens to start with `/`.
            let matches = if crate::paste::holds_placeholder(&buf) {
                Vec::new()
            } else {
                crate::tui::command_matches(&buf, public_test)
            };
            if !matches.is_empty()
                && (key.code == KeyCode::Up || keymap.matches(KeyAction::MenuUp, key))
            {
                selected = move_selection(selected, matches.len(), -1);
                redraw(
                    &crate::tui::prompt_frame(frame),
                    &buf,
                    cursor,
                    selected,
                    &mut menu_rows,
                    public_test,
                )?;
                continue;
            }
            if !matches.is_empty()
                && (key.code == KeyCode::Down || keymap.matches(KeyAction::MenuDown, key))
            {
                selected = move_selection(selected, matches.len(), 1);
                redraw(
                    &crate::tui::prompt_frame(frame),
                    &buf,
                    cursor,
                    selected,
                    &mut menu_rows,
                    public_test,
                )?;
                continue;
            }
            if matches.is_empty()
                && !history.is_empty()
                && (key.code == KeyCode::Up || keymap.matches(KeyAction::HistoryUp, key))
            {
                if history_index == history.len() {
                    draft = buf.clone();
                }
                history_index = history_index.saturating_sub(1);
                buf.clone_from(&history[history_index]);
                cursor = buf.len();
                selected = 0;
                redraw(
                    &crate::tui::prompt_frame(frame),
                    &buf,
                    cursor,
                    selected,
                    &mut menu_rows,
                    public_test,
                )?;
                continue;
            }
            if matches.is_empty()
                && history_index < history.len()
                && (key.code == KeyCode::Down || keymap.matches(KeyAction::HistoryDown, key))
            {
                history_index += 1;
                if history_index == history.len() {
                    buf.clone_from(&draft);
                } else {
                    buf.clone_from(&history[history_index]);
                }
                cursor = buf.len();
                selected = 0;
                redraw(
                    &crate::tui::prompt_frame(frame),
                    &buf,
                    cursor,
                    selected,
                    &mut menu_rows,
                    public_test,
                )?;
                continue;
            }
            match key.code {
                KeyCode::Tab | KeyCode::Right if !matches.is_empty() => {
                    complete_selected_command(&mut buf, &mut cursor, &matches, selected);
                    selected = 0;
                    redraw(
                        &crate::tui::prompt_frame(frame),
                        &buf,
                        cursor,
                        selected,
                        &mut menu_rows,
                        public_test,
                    )?;
                    continue;
                }
                KeyCode::Enter if !matches.is_empty() => {
                    let choice = selected_command(&buf, &matches, selected);
                    let mut out = io::stdout();
                    clear_menu(&mut out, menu_rows);
                    let _ = write!(out, "\r\n");
                    let _ = out.flush();
                    return Ok(InputEvent::Submit(choice));
                }
                KeyCode::Esc if !matches.is_empty() => {
                    buf.clear();
                    cursor = 0;
                    selected = 0;
                    redraw(
                        &crate::tui::prompt_frame(frame),
                        &buf,
                        cursor,
                        selected,
                        &mut menu_rows,
                        public_test,
                    )?;
                    continue;
                }
                _ => {}
            }
            match apply_key(key, &mut buf, &mut cursor, keymap) {
                KeyOutcome::Emit(ev) => {
                    // Move to a fresh line so subsequent output is not clobbered.
                    let mut out = io::stdout();
                    clear_menu(&mut out, menu_rows);
                    let _ = write!(out, "\r\n");
                    let _ = out.flush();
                    return Ok(expand_pastes(ev, &mut pastes));
                }
                KeyOutcome::Continue => {
                    selected = 0;
                    redraw(
                        &crate::tui::prompt_frame(frame),
                        &buf,
                        cursor,
                        selected,
                        &mut menu_rows,
                        public_test,
                    )?;
                }
            }
        }
    }
}

/// Line-based fallback for non-TTY stdin: reads one line and always submits it.
///
/// Returns `Ok(None)` on EOF so the caller can end the loop cleanly.
pub fn read_line_fallback() -> Result<Option<InputEvent>> {
    let mut line = String::new();
    let n = io::stdin()
        .read_line(&mut line)
        .map_err(|e| format!("failed to read line: {e}"))?;
    if n == 0 {
        return Ok(None);
    }
    let trimmed = line.trim_end_matches(['\r', '\n']).to_string();
    Ok(Some(InputEvent::Submit(trimmed)))
}

pub fn confirm_suggestion() -> Result<bool> {
    let _guard = RawModeGuard::enter()?;
    loop {
        if let Event::Key(key) = event::read().map_err(|error| error.to_string())? {
            if key.kind != event::KeyEventKind::Press {
                continue;
            }
            return Ok(matches!(key.code, KeyCode::Char('y') | KeyCode::Char('Y')));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::CONTROL)
    }

    fn alt(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::ALT)
    }

    fn emit(key: KeyEvent, buf: &mut String, cursor: &mut usize) -> Option<InputEvent> {
        match apply_key(key, buf, cursor, &Keymap::default()) {
            KeyOutcome::Emit(ev) => Some(ev),
            KeyOutcome::Continue => None,
        }
    }

    #[test]
    fn a_multi_line_paste_submits_as_one_intent() {
        let mut store = PasteStore::default();
        let mut buf = String::from("explain ");
        let mut cursor = buf.len();
        insert_paste(
            &mut store,
            "line one\r\nline two\r\n",
            &mut buf,
            &mut cursor,
        );
        // The composer shows a placeholder, not eight hundred columns of text.
        assert!(buf.starts_with("explain ⟦paste #1"));
        assert_eq!(cursor, buf.len());

        // Enter submits once, with the full pasted body restored.
        let event = emit(key(KeyCode::Enter), &mut buf, &mut cursor).unwrap();
        assert_eq!(
            expand_pastes(event, &mut store),
            InputEvent::Submit("explain line one\nline two".to_string())
        );
    }

    #[test]
    fn typing_then_enter_submits_buffer() {
        let mut buf = String::new();
        let mut cursor = 0;
        assert!(emit(key(KeyCode::Char('h')), &mut buf, &mut cursor).is_none());
        assert!(emit(key(KeyCode::Char('i')), &mut buf, &mut cursor).is_none());
        assert_eq!(
            emit(key(KeyCode::Enter), &mut buf, &mut cursor),
            Some(InputEvent::Submit("hi".to_string()))
        );
        // Buffer is drained on submit.
        assert!(buf.is_empty());
    }

    #[test]
    fn completing_a_picker_choice_keeps_the_command_open_for_arguments() {
        let mut buf = String::from("/cl");
        let mut cursor = buf.len();
        let matches = crate::tui::command_matches(&buf, false);
        assert_eq!(matches[0].0, "/claude");

        complete_selected_command(&mut buf, &mut cursor, &matches, 0);

        assert_eq!(buf, "/claude ");
        assert_eq!(cursor, buf.len());
    }

    #[test]
    fn tab_queues_current_line_without_losing_text() {
        let mut buf = String::from("deploy");
        let mut cursor = buf.len();
        assert_eq!(
            emit(key(KeyCode::Tab), &mut buf, &mut cursor),
            Some(InputEvent::Queue("deploy".to_string()))
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn control_keys_map_to_run_controls() {
        let mut buf = String::new();
        let mut cursor = 0;
        assert_eq!(
            emit(key(KeyCode::Esc), &mut buf, &mut cursor),
            Some(InputEvent::Interrupt)
        );
        assert_eq!(
            emit(ctrl(KeyCode::Char('c')), &mut buf, &mut cursor),
            Some(InputEvent::Interrupt)
        );
        buf = "task".into();
        cursor = buf.len();
        assert_eq!(
            emit(ctrl(KeyCode::Char('b')), &mut buf, &mut cursor),
            Some(InputEvent::Background("task".into()))
        );
        assert!(buf.is_empty());
        assert_eq!(
            emit(ctrl(KeyCode::Char('t')), &mut buf, &mut cursor),
            Some(InputEvent::TaskView)
        );
    }

    #[test]
    fn shift_tab_opens_auto_advisor() {
        let mut buf = String::new();
        let mut cursor = 0;
        assert_eq!(
            emit(key(KeyCode::BackTab), &mut buf, &mut cursor),
            Some(InputEvent::AutoAdvisor)
        );
    }

    #[test]
    fn backspace_edits_and_ctrl_chars_are_not_inserted() {
        let mut buf = String::from("ab");
        let mut cursor = buf.len();
        assert!(emit(key(KeyCode::Backspace), &mut buf, &mut cursor).is_none());
        assert_eq!(buf, "a");
        // A ctrl chord that is not a mapped control must not type a character.
        assert!(emit(ctrl(KeyCode::Char('x')), &mut buf, &mut cursor).is_none());
        assert_eq!(buf, "a");
        buf.push_str(" two words");
        cursor = buf.len();
        assert!(emit(ctrl(KeyCode::Char('w')), &mut buf, &mut cursor).is_none());
        assert_eq!(buf, "a two ");
        assert!(emit(ctrl(KeyCode::Char('u')), &mut buf, &mut cursor).is_none());
        assert!(buf.is_empty());
    }

    #[test]
    fn composer_edits_at_the_cursor_and_moves_by_word() {
        let mut buf = String::from("make blue");
        let mut cursor = buf.len();
        assert!(emit(alt(KeyCode::Left), &mut buf, &mut cursor).is_none());
        assert_eq!(&buf[cursor..], "blue");
        assert!(emit(key(KeyCode::Char('i')), &mut buf, &mut cursor).is_none());
        assert!(emit(key(KeyCode::Char('t')), &mut buf, &mut cursor).is_none());
        assert_eq!(buf, "make itblue");
        assert!(emit(key(KeyCode::Right), &mut buf, &mut cursor).is_none());
        assert!(emit(key(KeyCode::Delete), &mut buf, &mut cursor).is_none());
        assert_eq!(buf, "make itbue");
        assert!(emit(ctrl(KeyCode::Char('a')), &mut buf, &mut cursor).is_none());
        assert_eq!(cursor, 0);
        assert!(emit(ctrl(KeyCode::Char('k')), &mut buf, &mut cursor).is_none());
        assert!(buf.is_empty());
    }

    #[test]
    fn arrow_selection_wraps_and_enter_resolves_the_highlighted_command() {
        let matches = crate::tui::command_matches("/", false);
        assert!(matches.len() > 6);
        assert_eq!(move_selection(0, matches.len(), -1), matches.len() - 1);
        assert_eq!(move_selection(matches.len() - 1, matches.len(), 1), 0);
        assert_eq!(
            selected_command("/", &matches, matches.len() - 1),
            matches.last().unwrap().0
        );
    }
}
