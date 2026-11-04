//! Raw-terminal keyboard input model for the interactive REPL.
//!
//! The REPL wants richer control keys than a line-based `read_line` can offer:
//! Enter submits steering for the current run, Tab queues typed steering while
//! an empty Tab switches sessions, Esc interrupts, and Ctrl+B / Ctrl+T reach into
//! run control. This module owns that translation and nothing else — it turns raw key presses
//! into a high-level [`InputEvent`] the REPL can act on.
//!
//! Raw mode is RAII-guarded ([`RawModeGuard`]) so a panic mid-read still
//! restores a sane terminal. When stdin/stdout is not a TTY (piped or
//! non-interactive use) the caller should fall back to [`read_line_fallback`],
//! which never touches raw mode.

use std::{
    cell::RefCell,
    env,
    io::{self, IsTerminal, Write},
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::Duration,
    time::Instant,
};

thread_local! {
    /// Bytes read past the key that ended one input loop belong to the next
    /// reader on this thread (the idle composer hands off to LiveInput).
    static INPUT_HANDOFF: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

use crate::keymap::{KeyAction, Keymap};
use crate::paste::PasteStore;
use crossterm::event::{
    self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEvent, KeyModifiers,
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use unicode_width::UnicodeWidthChar;

/// Local result alias: keyboard I/O surfaces plain string errors, matching the
/// rest of the crate.
type Result<T> = std::result::Result<T, String>;

/// A high-level input intent produced by the REPL key loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputEvent {
    /// Enter — submit the current line as steering/intent for the current run.
    Submit(String),
    /// Tab with text — queue the current line as steering for the active run.
    Queue(String),
    /// Esc — interrupt the current run.
    Interrupt,
    /// Ctrl+B — start the current composer text as a supervised background task.
    Background(String),
    /// Ctrl+T — show the task/status view.
    TaskView,
    /// Switch between agent sessions in the terminal tab bar.
    SwitchSession(i8, String),
    /// Create a new agent session tab.
    NewSession(String),
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
        let _ = execute!(
            io::stdout(),
            EnableBracketedPaste,
            PushKeyboardEnhancementFlags(
                KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                    | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
            )
        );
        Ok(RawModeGuard)
    }
}

/// Non-blocking input used while a model call is active. It deliberately
/// shares the same key grammar as the idle composer.
pub struct LiveInput {
    guard: Option<RawModeGuard>,
    buf: String,
    cursor: usize,
    keymap: Keymap,
    pastes: PasteStore,
    stream_column: usize,
    terminal_width: usize,
    stream_active: bool,
    has_committed_output: bool,
    composer_visible: bool,
    stream_has_output: bool,
    reader: TerminalReader,
    catalog: crate::tui::SlashCommandCatalog,
    menu_selected: usize,
    menu_rows: usize,
    menu_dismissed: bool,
    menu_selection_explicit: bool,
    animation_at: Instant,
    animation_frame: usize,
}

impl LiveInput {
    pub fn enter(keymap: Keymap) -> Result<Option<Self>> {
        if !is_interactive() {
            return Ok(None);
        }
        let mut input = Self {
            guard: Some(RawModeGuard::enter()?),
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
            has_committed_output: false,
            composer_visible: true,
            stream_has_output: false,
            reader: TerminalReader::default(),
            catalog: crate::tui::SlashCommandCatalog::load(false),
            menu_selected: 0,
            menu_rows: 0,
            menu_dismissed: false,
            menu_selection_explicit: false,
            animation_at: Instant::now(),
            animation_frame: 0,
        };
        input.draw_composer()?;
        Ok(Some(input))
    }

    pub fn poll(&mut self) -> Result<Option<InputEvent>> {
        if self.composer_visible && !self.stream_has_output
            && self.animation_at.elapsed() >= Duration::from_millis(160)
            && std::env::var_os("HII_REDUCED_MOTION").is_none()
        {
            self.animation_frame = self.animation_frame.wrapping_add(1);
            self.animation_at = Instant::now();
            self.draw_composer()?;
        }
        let Some(event) = self.reader.read_event(Duration::ZERO)? else {
            return Ok(None);
        };
        if let Event::Resize(columns, _) = &event {
            self.terminal_width = usize::from(*columns).max(1);
            self.stream_column = 0;
            self.stream_has_output = false;
            self.draw_composer()?;
            return Ok(None);
        }
        if let Event::Paste(raw) = event {
            insert_paste(&mut self.pastes, &raw, &mut self.buf, &mut self.cursor);
            self.menu_selected = 0;
            self.menu_dismissed = false;
            self.menu_selection_explicit = false;
            self.draw_composer()?;
            return Ok(None);
        }
        let Event::Key(key) = event else {
            return Ok(None);
        };
        if key.kind != event::KeyEventKind::Press {
            return Ok(None);
        }
        let entries = if self.menu_dismissed {
            Vec::new()
        } else if menu_trigger(&self.buf) {
            self.catalog.matches(&self.buf)
        } else {
            self.catalog.suggest(&self.buf)
        };
        if let Some(action) = menu_action(
            &entries,
            self.menu_selected,
            key,
            &self.keymap,
            menu_trigger(&self.buf),
            self.menu_selection_explicit,
        ) {
            match action {
                SlashMenuAction::Dismiss => {
                    self.menu_dismissed = true;
                    self.menu_selected = 0;
                    self.menu_selection_explicit = false;
                    self.draw_composer()?;
                    return Ok(None);
                }
                SlashMenuAction::Select(index) => {
                    self.menu_selected = index;
                    self.menu_selection_explicit = true;
                    self.draw_composer()?;
                    return Ok(None);
                }
                SlashMenuAction::Complete(completion, requires_arguments) => {
                    self.buf = completion;
                    if requires_arguments {
                        self.buf.push(' ');
                    }
                    self.cursor = self.buf.len();
                    self.menu_selected = 0;
                    self.menu_selection_explicit = false;
                    self.menu_dismissed = false;
                    self.draw_composer()?;
                    return Ok(None);
                }
                SlashMenuAction::Dispatch(command) => {
                    self.menu_dismissed = true;
                    self.draw_composer()?;
                    return Ok(Some(InputEvent::Submit(command)));
                }
            }
        }
        let outcome = match apply_key(key, &mut self.buf, &mut self.cursor, &self.keymap) {
            KeyOutcome::Emit(event) => Some(expand_pastes(event, &mut self.pastes)),
            KeyOutcome::Continue => None,
        };
        self.menu_selected = 0;
        self.menu_selection_explicit = false;
        self.menu_dismissed = false;
        self.draw_composer()?;
        Ok(outcome)
    }

    pub fn write_stream(&mut self, delta: &str) -> Result<()> {
        if delta.is_empty() {
            return Ok(());
        }
        let mut out = io::stdout();
        if self.composer_visible {
            write_stream_frame(
                &mut out,
                delta,
                &mut self.stream_column,
                self.terminal_width,
                self.stream_has_output,
                &self.buf,
                self.cursor,
            )
            .map_err(|e| format!("failed to write active stream frame: {e}"))?;
            self.stream_has_output = true;
            self.draw_composer()?;
        } else {
            write_stream_delta(
                &mut out,
                delta,
                &mut self.stream_column,
                self.terminal_width,
                !self.has_committed_output,
            )
            .map_err(|e| format!("failed to write model stream: {e}"))?;
        }
        self.has_committed_output |= !delta.is_empty();
        out.flush()
            .map_err(|e| format!("failed to flush model stream: {e}"))
    }

    pub fn finish_stream(&mut self) {
        if !self.stream_active {
            return;
        }
        let mut out = io::stdout();
        if self.composer_visible {
            let _ = write!(out, "\r\x1b[2K\r\n\r\x1b[2K\x1b[1A");
        } else {
            let _ = write!(out, "{}", finish_stream_sequence(self.has_committed_output));
        }
        let _ = out.flush();
        self.stream_active = false;
    }

    /// Temporarily hand the terminal to an inline inspection picker, then
    /// restore raw input and the editable composer before reporting its result.
    pub fn inspect_with(&mut self, inspect: impl FnOnce() -> Result<String>) -> Result<()> {
        let draft = self.take_draft();
        self.finish_stream();
        self.guard.take();

        let result = inspect();

        self.guard = Some(RawModeGuard::enter()?);
        reset_inspection_stream_frame(
            &mut self.stream_column,
            &mut self.stream_has_output,
            &mut self.stream_active,
            &mut self.composer_visible,
        );
        self.restore_draft(&draft.0, draft.1)?;
        match result {
            Ok(details) => {
                self.notify(&details)?;
                reset_inspection_stream_frame(
                    &mut self.stream_column,
                    &mut self.stream_has_output,
                    &mut self.stream_active,
                    &mut self.composer_visible,
                );
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    /// Move the full draft across an input/run boundary, expanding staged pastes.
    pub fn take_draft(&mut self) -> (String, usize) {
        let (expanded, cursor) = expand_draft(&self.buf, self.cursor, &self.pastes);
        self.pastes.clear();
        self.buf.clear();
        self.cursor = 0;
        (expanded, cursor)
    }

    /// Restore a draft at a new input boundary and repaint the visible composer.
    pub fn restore_draft(&mut self, draft: &str, cursor: usize) -> Result<()> {
        self.buf.clear();
        self.buf.push_str(draft);
        self.cursor = floor_char_boundary(&self.buf, cursor.min(self.buf.len()));
        self.pastes.clear();
        self.draw_composer()
    }

    /// Write a status line above the composer while keeping the draft editable.
    pub fn notify(&mut self, message: &str) -> Result<()> {
        let mut out = io::stdout();
        if self.composer_visible {
            write!(out, "\r\x1b[2K")
                .map_err(|e| format!("failed to clear active composer: {e}"))?;
        }
        let safe = message
            .chars()
            .map(|c| if c.is_control() && !matches!(c, '\n' | '\t' | '\r') { '�' } else { c })
            .collect::<String>();
        self.stream_column = 0;
        write_stream_delta(
            &mut out,
            &safe,
            &mut self.stream_column,
            self.terminal_width,
            false,
        )
        .map_err(|e| format!("failed to write notification: {e}"))?;
        if self.stream_column > 0 {
            write!(out, "\r\n").map_err(|e| format!("failed to position notification: {e}"))?;
        }
        self.has_committed_output = true;
        self.stream_has_output = false;
        if self.composer_visible {
            self.draw_composer()?;
        }
        out.flush()
            .map_err(|e| format!("failed to flush notification: {e}"))
    }

    fn draw_composer(&mut self) -> Result<()> {
        let mut out = io::stdout().lock();
        redraw_to(
            &mut out,
            &crate::tui::live_prompt_frame(self.animation_frame),
            &self.buf,
            self.cursor,
            self.menu_selected,
            &mut self.menu_rows,
            &self.catalog,
            self.menu_dismissed,
            self.menu_selection_explicit,
        )
    }
}

fn reset_inspection_stream_frame(
    stream_column: &mut usize,
    stream_has_output: &mut bool,
    stream_active: &mut bool,
    composer_visible: &mut bool,
) {
    *stream_column = 0;
    *stream_has_output = false;
    *stream_active = true;
    *composer_visible = true;
}

fn expand_draft(buf: &str, cursor: usize, pastes: &PasteStore) -> (String, usize) {
    let cursor = floor_char_boundary(buf, cursor.min(buf.len()));
    let prefix = pastes.expand(&buf[..cursor]);
    (pastes.expand(buf), prefix.len())
}

fn floor_char_boundary(value: &str, mut index: usize) -> usize {
    while !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn write_composer(out: &mut impl Write, buf: &str, cursor: usize, width: usize) -> io::Result<()> {
    out.write_all(composer_frame(buf, cursor, width, &crate::tui::prompt_footer()).as_bytes())
}

fn composer_frame(buf: &str, cursor: usize, width: usize, footer: &str) -> String {
    let usable = width.saturating_sub(1).max(1);
    let (visible, column) =
        crate::tui::composer_window(buf, cursor, usable.saturating_sub(2).max(1));
    let mut frame = String::new();
    frame.push_str(&format!("› {visible}"));
    let used = 2 + crate::codex_ui::display_width(&visible);
    for _ in used.min(usable)..usable {
        frame.push(' ');
    }
    frame.push_str(&format!(
        "\r\n{}\r\x1b[1A",
        composer_footer_frame(footer, usable)
    ));
    // Cursor is back on the input row. Relative motion remains valid
    // after terminal scrolling and does not depend on saved absolute positions.
    let column = 2 + column;
    if column > 0 {
        frame.push_str(&format!("\x1b[{column}C"));
    }
    frame
}

fn composer_footer_frame(footer: &str, width: usize) -> String {
    let footer = crate::text::clip_line(footer, width);
    let used = crate::codex_ui::display_width(&footer).min(width);
    let mut frame = String::from("\x1b[2K");
    frame.push_str(&footer);
    for _ in used..width {
        frame.push(' ');
    }
    frame
}

/// Append a stream delta without erasing the prior output row, then repaint
/// the composer directly below it. The composer always occupies one row.
fn write_stream_frame(
    out: &mut impl Write,
    delta: &str,
    stream_column: &mut usize,
    terminal_width: usize,
    prior_output: bool,
    buf: &str,
    cursor: usize,
) -> io::Result<()> {
    write!(out, "\r\x1b[2K")?;
    if prior_output {
        write!(out, "\x1b[1A\r")?;
        if *stream_column > 0 {
            write!(out, "\x1b[{}C", *stream_column)?;
        }
    }
    write_stream_delta(out, delta, stream_column, terminal_width, false)?;
    // Keep a reserved output row immediately above the composer even when a
    // model delta ends with a newline; subsequent deltas always target it.
    write!(out, "\r\n")?;
    write_composer(out, buf, cursor, terminal_width)
}

/// Write model text without ever touching the terminal's final column.
///
/// The final physical column is reserved because printing into it triggers an
/// implicit terminal wrap. The live composer uses relative cursor movement;
/// one implicit wrap is enough to make later status updates overwrite reply
/// text. Model-provided control bytes are rendered harmlessly, and display
/// width (rather than UTF-8 bytes or scalar count) keeps wide characters from
/// producing the same desynchronization.
fn write_stream_delta(
    out: &mut impl Write,
    delta: &str,
    stream_column: &mut usize,
    terminal_width: usize,
    clear_transient: bool,
) -> io::Result<()> {
    if delta.is_empty() {
        return Ok(());
    }
    if clear_transient {
        write!(out, "\r")?;
        *stream_column = 0;
    }
    let usable_width = terminal_width.saturating_sub(1).max(1);
    let advance = |out: &mut dyn Write, column: &mut usize| -> io::Result<()> {
        write!(out, "\r\n")?;
        *column = 0;
        Ok(())
    };
    for character in delta.chars() {
        if character == '\n' {
            advance(out, stream_column)?;
            continue;
        }
        if character == '\r' {
            continue;
        }
        if character == '\t' {
            let spaces = 4 - (*stream_column % 4);
            for _ in 0..spaces {
                if *stream_column + 1 > usable_width {
                    advance(out, stream_column)?;
                }
                write!(out, " ")?;
                *stream_column += 1;
            }
            continue;
        }
        let (safe, width) = if character.is_control() {
            ('�', 1)
        } else {
            (character, UnicodeWidthChar::width(character).unwrap_or(0))
        };
        if width > 0 && *stream_column > 0 && *stream_column + width > usable_width {
            advance(out, stream_column)?;
        }
        write!(out, "{safe}")?;
        *stream_column += width;
    }
    Ok(())
}

fn finish_stream_sequence(has_committed_output: bool) -> &'static str {
    if has_committed_output { "\r\n" } else { "" }
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
        let _ = execute!(io::stdout(), PopKeyboardEnhancementFlags);
        let _ = disable_raw_mode();
    }
}

#[derive(Debug)]
struct TerminalReader {
    pending: Vec<u8>,
    escape_since: Option<Instant>,
    size: Option<(u16, u16)>,
}

impl Default for TerminalReader {
    fn default() -> Self {
        Self {
            pending: INPUT_HANDOFF.with(|handoff| std::mem::take(&mut *handoff.borrow_mut())),
            escape_since: None,
            size: crossterm::terminal::size().ok(),
        }
    }
}

impl Drop for TerminalReader {
    fn drop(&mut self) {
        INPUT_HANDOFF.with(|handoff| {
            let mut handoff = handoff.borrow_mut();
            handoff.clear();
            handoff.extend(self.pending.drain(..));
        });
    }
}

impl TerminalReader {
    fn read_event(&mut self, timeout: Duration) -> Result<Option<Event>> {
        #[cfg(unix)]
        {
            use std::os::fd::RawFd;
            let size = crossterm::terminal::size().ok();
            if size.is_some() && size != self.size {
                self.size = size;
                let (columns, rows) = size.unwrap();
                return Ok(Some(Event::Resize(columns, rows)));
            }
            if let Some(event) = self.decode_pending() {
                return Ok(Some(event));
            }
            let mut input = libc::pollfd {
                fd: 0 as RawFd,
                events: libc::POLLIN,
                revents: 0,
            };
            let millis = timeout.as_millis().min(i32::MAX as u128) as i32;
            let ready = unsafe { libc::poll(&mut input, 1, millis) };
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    return Ok(self.decode_pending());
                }
                return Err(format!("failed to poll terminal input: {error}"));
            }
            if ready > 0 && input.revents & libc::POLLIN != 0 {
                let mut bytes = [0u8; 4096];
                let read = unsafe { libc::read(0, bytes.as_mut_ptr().cast(), bytes.len()) };
                if read < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::Interrupted
                        && error.kind() != io::ErrorKind::WouldBlock
                    {
                        return Err(format!("failed to read terminal input: {error}"));
                    }
                } else if read > 0 {
                    self.pending.extend_from_slice(&bytes[..read as usize]);
                }
            }
            Ok(self.decode_pending())
        }
        #[cfg(not(unix))]
        {
            if !event::poll(timeout).map_err(|e| format!("failed to poll terminal input: {e}"))? {
                return Ok(None);
            }
            event::read()
                .map(Some)
                .map_err(|e| format!("failed to read terminal input: {e}"))
        }
    }

    fn decode_pending(&mut self) -> Option<Event> {
        decode_terminal_input(&mut self.pending, &mut self.escape_since)
    }
}

/// Decode only complete key sequences. Unknown CSI sequences are consumed as
/// control input, never inserted into the user's draft as escape characters.
fn decode_terminal_input(
    pending: &mut Vec<u8>,
    escape_since: &mut Option<Instant>,
) -> Option<Event> {
    if pending.is_empty() {
        *escape_since = None;
        return None;
    }
    if pending[0] == 0x1b {
        if pending.len() == 1 {
            let since = escape_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_millis(40) {
                pending.remove(0);
                *escape_since = None;
                return Some(Event::Key(KeyCode::Esc.into()));
            }
            return None;
        }
        *escape_since = None;
        if pending.starts_with(b"\x1b[200~") {
            let end = pending
                .windows(6)
                .position(|window| window == b"\x1b[201~")?;
            let payload = String::from_utf8_lossy(&pending[6..end]).into_owned();
            pending.drain(..end + 6);
            return Some(Event::Paste(payload));
        }
        if pending.starts_with(b"\x1b[") {
            let end = pending
                .iter()
                .enumerate()
                .skip(2)
                .find_map(|(index, byte)| (0x40..=0x7e).contains(byte).then_some(index));
            let Some(end) = end else {
                return None;
            };
            let sequence = pending[2..=end].to_vec();
            pending.drain(..=end);
            if is_kitty_key_release(&sequence) {
                return None;
            }
            return decode_csi_key(&sequence).or(Some(Event::FocusLost));
        }
        if pending.starts_with(b"\x1bO") {
            // SS3 is the application-cursor spelling used by several terminal
            // modes. Keep the prefix buffered until its final byte arrives so
            // fragmented `ESC O A` never degrades into Alt+O plus A.
            let end = pending
                .iter()
                .enumerate()
                .skip(2)
                .find_map(|(index, byte)| (0x40..=0x7e).contains(byte).then_some(index));
            let Some(end) = end else {
                return None;
            };
            let final_byte = pending[end];
            pending.drain(..=end);
            return decode_ss3_key(final_byte).or(Some(Event::FocusLost));
        }
        let (character, length) = decode_character(&pending[1..])?;
        pending.drain(..1 + length);
        return Some(Event::Key(KeyEvent::new(
            KeyCode::Char(character),
            KeyModifiers::ALT,
        )));
    }

    let first = pending[0];
    if first == b'\r' {
        pending.remove(0);
        return Some(Event::Key(KeyCode::Enter.into()));
    }
    if first == b'\n' {
        pending.remove(0);
        return Some(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::SHIFT,
        )));
    }
    if first == b'\t' {
        pending.remove(0);
        return Some(Event::Key(KeyCode::Tab.into()));
    }
    if first == 0x7f || first == 0x08 {
        pending.remove(0);
        return Some(Event::Key(KeyCode::Backspace.into()));
    }
    if (1..=26).contains(&first) {
        pending.remove(0);
        let character = char::from(b'a' + first - 1);
        return Some(Event::Key(KeyEvent::new(
            KeyCode::Char(character),
            KeyModifiers::CONTROL,
        )));
    }
    let (character, length) = decode_character(pending)?;
    pending.drain(..length);
    Some(Event::Key(KeyCode::Char(character).into()))
}

fn decode_ss3_key(final_byte: u8) -> Option<Event> {
    let code = match final_byte {
        b'A' => KeyCode::Up,
        b'B' => KeyCode::Down,
        b'C' => KeyCode::Right,
        b'D' => KeyCode::Left,
        b'H' => KeyCode::Home,
        b'F' => KeyCode::End,
        _ => return None,
    };
    Some(Event::Key(code.into()))
}

fn decode_character(bytes: &[u8]) -> Option<(char, usize)> {
    let first = *bytes.first()?;
    let length = match first {
        0x00..=0x7f => 1,
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => return Some(('�', 1)),
    };
    let bytes = bytes.get(..length)?;
    let value = std::str::from_utf8(bytes).ok()?.chars().next()?;
    Some((value, length))
}

fn decode_csi_key(sequence: &[u8]) -> Option<Event> {
    let raw = std::str::from_utf8(sequence).ok()?;
    if raw == "27;2;13~" {
        return Some(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::SHIFT,
        )));
    }
    let final_byte = *sequence.last()? as char;
    let body = &raw[..raw.len().saturating_sub(1)];
    let values = body.split(';').collect::<Vec<_>>();
    // Standard arrow/Home/End sequences omit numeric parameters (CSI A).
    let first_value =
        if body.is_empty() && matches!(final_byte, 'A' | 'B' | 'C' | 'D' | 'H' | 'F' | 'Z') {
            1
        } else {
            values.first()?.split(':').next()?.parse::<u32>().ok()?
        };
    let modifier_value = values
        .get(1)
        .and_then(|part| part.split(':').next())
        .and_then(|part| part.parse::<u16>().ok())
        .unwrap_or(1)
        .saturating_sub(1);
    let mut modifiers = KeyModifiers::NONE;
    if modifier_value & 1 != 0 {
        modifiers |= KeyModifiers::SHIFT;
    }
    if modifier_value & 2 != 0 {
        modifiers |= KeyModifiers::ALT;
    }
    if modifier_value & 4 != 0 {
        modifiers |= KeyModifiers::CONTROL;
    }
    let code = match final_byte {
        'A' => KeyCode::Up,
        'B' => KeyCode::Down,
        'C' => KeyCode::Right,
        'D' => KeyCode::Left,
        'H' => KeyCode::Home,
        'F' => KeyCode::End,
        'Z' => KeyCode::BackTab,
        'u' => {
            return decode_kitty_key(first_value, modifiers);
        }
        '~' => match values.first().copied()? {
            "3" => KeyCode::Delete,
            "7" => KeyCode::Home,
            "8" => KeyCode::End,
            "27" if values.get(2) == Some(&"13") && modifiers.contains(KeyModifiers::SHIFT) => {
                KeyCode::Enter
            }
            _ => return None,
        },
        _ => return None,
    };
    Some(Event::Key(KeyEvent::new(code, modifiers)))
}

/// Kitty keyboard protocol functional key codepoints. Only translate defined
/// controls here; unknown private-use values must never become draft text.
fn decode_kitty_key(codepoint: u32, modifiers: KeyModifiers) -> Option<Event> {
    let code = match codepoint {
        9 => KeyCode::Tab,
        13 => KeyCode::Enter,
        27 => KeyCode::Esc,
        127 => KeyCode::Backspace,
        57344..=63743 => return None,
        value => {
            let character = char::from_u32(value)?;
            if character.is_control() || is_private_use(character) {
                return None;
            }
            KeyCode::Char(character)
        }
    };
    Some(Event::Key(KeyEvent::new(code, modifiers)))
}

fn is_private_use(character: char) -> bool {
    matches!(character as u32, 0xe000..=0xf8ff | 0xf0000..=0xffffd | 0x100000..=0x10fffd)
}

fn is_kitty_key_release(sequence: &[u8]) -> bool {
    let Ok(raw) = std::str::from_utf8(sequence) else {
        return false;
    };
    if !raw.ends_with('u') {
        return false;
    }
    raw[..raw.len() - 1]
        .split(';')
        .nth(1)
        .and_then(|field| field.split(':').nth(1))
        .and_then(|event_type| event_type.parse::<u8>().ok())
        == Some(3)
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
        InputEvent::SwitchSession(direction, line) => {
            InputEvent::SwitchSession(direction, store.expand(&line))
        }
        InputEvent::NewSession(line) => InputEvent::NewSession(store.expand(&line)),
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
        *cursor = 0;
        return if buf.is_empty() {
            KeyOutcome::Emit(InputEvent::SwitchSession(-1, String::new()))
        } else {
            KeyOutcome::Emit(InputEvent::Queue(std::mem::take(buf)))
        };
    }
    if matches!(key.code, KeyCode::Esc)
        || matches!(key.code, KeyCode::Char('c')) && ctrl
        || keymap.matches(KeyAction::Interrupt, key)
    {
        return KeyOutcome::Emit(InputEvent::Interrupt);
    }
    if key.code == KeyCode::Tab {
        *cursor = 0;
        return if buf.is_empty() {
            KeyOutcome::Emit(InputEvent::SwitchSession(1, String::new()))
        } else {
            KeyOutcome::Emit(InputEvent::Queue(std::mem::take(buf)))
        };
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
    if key.code == KeyCode::Char('n') && ctrl {
        *cursor = 0;
        return KeyOutcome::Emit(InputEvent::NewSession(std::mem::take(buf)));
    }
    match key.code {
        KeyCode::Enter if key.modifiers.contains(KeyModifiers::SHIFT) => {
            buf.insert(*cursor, '\n');
            *cursor += 1;
            KeyOutcome::Continue
        }
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
        KeyCode::Left if !alt && !ctrl && buf.is_empty() => {
            KeyOutcome::Emit(InputEvent::Submit("/workspace".into()))
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
fn redraw(
    prompt: &str,
    buf: &str,
    cursor: usize,
    selected: usize,
    previous_rows: &mut usize,
    catalog: &crate::tui::SlashCommandCatalog,
    menu_dismissed: bool,
    selection_explicit: bool,
) -> Result<()> {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    redraw_to(
        &mut out,
        prompt,
        buf,
        cursor,
        selected,
        previous_rows,
        catalog,
        menu_dismissed,
        selection_explicit,
    )
}

/// Render a complete composer repaint in memory, then submit it in one write.
/// Keeping the whole frame together avoids many small writes while preserving
/// the relative cursor motion needed when menu rows scroll the terminal.
fn redraw_to(
    out: &mut impl Write,
    prompt: &str,
    buf: &str,
    cursor: usize,
    selected: usize,
    previous_rows: &mut usize,
    catalog: &crate::tui::SlashCommandCatalog,
    menu_dismissed: bool,
    selection_explicit: bool,
) -> Result<()> {
    use std::fmt::Write as FmtWrite;
    let mut frame = String::new();
    // Clear only rows previously painted by this menu, then return to the
    // composer row before repainting. Relative movement remains valid if the
    // terminal scrolled while suggestions were displayed.
    if *previous_rows > 0 {
        write!(frame, "\r").expect("writing to String cannot fail");
        for _ in 0..*previous_rows {
            frame.push_str("\x1b[1B\r\x1b[2K");
        }
        write!(frame, "\x1b[{}A\r", *previous_rows).expect("writing to String cannot fail");
    }
    // The buffer is windowed to one row: a wrapped line would desynchronise
    // every relative cursor move below and tear the frame apart.
    let terminal_width = crossterm::terminal::size()
        .map(|(columns, _)| usize::from(columns))
        .unwrap_or(80)
        .max(1);
    let usable = terminal_width.saturating_sub(1).max(1);
    let (visible, column) = crate::tui::composer_window(
        buf,
        cursor,
        usable
            .saturating_sub(crate::codex_ui::display_width(prompt))
            .max(1),
    );
    write!(frame, "\r\x1b[2K{prompt}{visible}").expect("writing to String cannot fail");
    let used = crate::codex_ui::display_width(prompt) + crate::codex_ui::display_width(&visible);
    for _ in used.min(usable)..usable {
        frame.push(' ');
    }
    frame.push_str("\r\n");
    frame.push_str(&composer_footer_frame(&crate::tui::prompt_footer(), usable));
    // Return from the last painted row to the editable row, then restore the
    // in-buffer cursor. Use relative movement instead of save/restore: saved
    // terminal coordinates become unreliable if drawing the menu scrolls at the
    // bottom of the viewport.
    // ANSI paint sequences in `prompt` occupy bytes but no terminal columns.
    // The visible input prefix is always "  › ", which is four columns.
    let entries = if menu_dismissed {
        Vec::new()
    } else if menu_trigger(buf) {
        catalog.matches(buf)
    } else {
        catalog.suggest(buf)
    };
    let visible_lines = suggestion_menu_frame(
        &entries,
        selected,
        menu_trigger(buf) || selection_explicit,
        terminal_width.saturating_sub(1).max(1),
    );
    if !visible_lines.is_empty() {
        frame.push_str("\r\n");
        for (index, line) in visible_lines.iter().enumerate() {
            write!(frame, "\r\x1b[2K{line}").expect("writing to String cannot fail");
            if index + 1 < visible_lines.len() {
                frame.push_str("\r\n");
            }
        }
        *previous_rows = visible_lines.len() + 1;
        // The composer, footer, and suggestion rows occupy n + 1 row steps
        // from the composer to the last suggestion: footer is one step below
        // the composer and the first suggestion is one step below the footer.
        // Returning one extra row above the composer makes the next repaint
        // clear the wrong physical rows, leaving stale suggestions behind.
        write!(frame, "\x1b[{}A", visible_lines.len() + 1).expect("writing to String cannot fail");
    } else {
        *previous_rows = 1;
        frame.push_str("\x1b[1A");
    }
    frame.push('\r');
    let column = crate::codex_ui::display_width(prompt) + column;
    if column > 0 {
        write!(frame, "\x1b[{column}C").expect("writing to String cannot fail");
    }
    out.write_all(frame.as_bytes())
        .map_err(|e| format!("failed to write composer frame: {e}"))?;
    out.flush()
        .map_err(|e| format!("failed to flush stdout: {e}"))?;
    Ok(())
}

fn suggestion_menu_frame(
    entries: &[crate::tui::SlashCommandEntry],
    selected: usize,
    highlight_selected: bool,
    width: usize,
) -> Vec<String> {
    let start = selected
        .saturating_sub(5)
        .min(entries.len().saturating_sub(6));
    entries
        .iter()
        .enumerate()
        .skip(start)
        .take(6)
        .map(|(index, entry)| {
            let marker = if index == selected && highlight_selected {
                "› "
            } else {
                "  "
            };
            let line = format!(
                "{marker}{}  {}",
                entry.completion,
                crate::tui::one_line_terminal_text(&entry.description)
            );
            let mut clipped = String::new();
            let mut used = 0usize;
            for character in line.chars() {
                let char_width = UnicodeWidthChar::width(character).unwrap_or(0);
                if used + char_width > width {
                    break;
                }
                clipped.push(character);
                used += char_width;
            }
            clipped
        })
        .collect()
}

fn menu_trigger(buf: &str) -> bool {
    let trimmed = buf.trim_start();
    let Some(trigger) = trimmed.chars().next() else {
        return false;
    };
    if !matches!(trigger, '/' | '@' | '!' | '$' | '#') {
        return false;
    }
    // A space after `!` starts the existing raw shell command form. Keep it
    // out of the picker so Enter submits the user's shell text as typed.
    trigger != '!' || !trimmed[trigger.len_utf8()..].chars().any(char::is_whitespace)
}

enum SlashMenuAction {
    Dismiss,
    Select(usize),
    Complete(String, bool),
    Dispatch(String),
}

fn menu_action(
    entries: &[crate::tui::SlashCommandEntry],
    selected: usize,
    key: KeyEvent,
    keymap: &Keymap,
    slash_query: bool,
    selection_explicit: bool,
) -> Option<SlashMenuAction> {
    if entries.is_empty() {
        return None;
    }
    if key.code == KeyCode::Esc {
        return Some(SlashMenuAction::Dismiss);
    }
    if key.code == KeyCode::Up || keymap.matches(KeyAction::MenuUp, key) {
        return Some(SlashMenuAction::Select(
            (selected + entries.len() - 1) % entries.len(),
        ));
    }
    if key.code == KeyCode::Down || keymap.matches(KeyAction::MenuDown, key) {
        return Some(SlashMenuAction::Select((selected + 1) % entries.len()));
    }
    let choice = &entries[selected.min(entries.len() - 1)];
    if key.code == KeyCode::Tab && key.modifiers.is_empty() {
        return Some(SlashMenuAction::Complete(
            choice.completion.clone(),
            choice.requires_arguments,
        ));
    }
    if key.code == KeyCode::Enter && key.modifiers.is_empty() {
        if !slash_query && !selection_explicit {
            return None;
        }
        return Some(if choice.requires_arguments {
            SlashMenuAction::Complete(choice.completion.clone(), true)
        } else {
            SlashMenuAction::Dispatch(choice.completion.clone())
        });
    }
    None
}

fn slash_menu_action(
    entries: &[crate::tui::SlashCommandEntry],
    selected: usize,
    key: KeyEvent,
    keymap: &Keymap,
) -> Option<SlashMenuAction> {
    menu_action(entries, selected, key, keymap, true, true)
}

/// Run the raw-mode key loop until a high-level [`InputEvent`] is produced.
///
/// `prompt` is redrawn as the user edits. Raw mode is entered for the duration
/// and restored on return (or panic) via [`RawModeGuard`].
pub fn read_event(
    public_test: bool,
    history: &[String],
    keymap: &Keymap,
    initial: &str,
) -> Result<InputEvent> {
    read_event_with_idle(public_test, history, keymap, initial, || Ok(None))
}

/// Read an idle composer event while giving the caller regular opportunities
/// to process asynchronous completion or resume work.
pub fn read_event_with_idle(
    public_test: bool,
    history: &[String],
    keymap: &Keymap,
    initial: &str,
    mut poll_idle: impl FnMut() -> Result<Option<InputEvent>>,
) -> Result<InputEvent> {
    let _guard = RawModeGuard::enter()?;
    let mut reader = TerminalReader::default();
    let mut buf = initial.to_string();
    let mut cursor = buf.len();
    let mut pastes = PasteStore::default();
    let frame = 0usize;
    let mut selected = 0usize;
    let mut menu_rows = 0usize;
    let catalog = crate::tui::SlashCommandCatalog::load(public_test);
    let mut menu_dismissed = false;
    let mut selection_explicit = false;
    let mut history_index = history.len();
    let mut draft = String::new();
    redraw(
        &crate::tui::prompt_frame(frame),
        &buf,
        cursor,
        selected,
        &mut menu_rows,
        &catalog,
        menu_dismissed,
        selection_explicit,
    )?;
    loop {
        let Some(event) = reader.read_event(Duration::from_millis(30))? else {
            // An asynchronous resume may arrive while the user is composing.
            // Defer it until the composer is empty so the caller can safely
            // replace the current objective without dropping a draft.
            if buf.is_empty() {
                if let Some(event) = poll_idle()? {
                    if menu_rows > 0 {
                        redraw(
                            &crate::tui::prompt_frame(frame),
                            &buf,
                            cursor,
                            selected,
                            &mut menu_rows,
                            &catalog,
                            true,
                            false,
                        )?;
                    }
                    let mut out = io::stdout();
                    let _ = write!(out, "\r\x1b[2K");
                    let _ = out.flush();
                    return Ok(event);
                }
            }
            continue;
        };
        if let Event::Resize(_, _) = &event {
            redraw(
                &crate::tui::prompt_frame(frame),
                &buf,
                cursor,
                selected,
                &mut menu_rows,
                &catalog,
                menu_dismissed,
                selection_explicit,
            )?;
            continue;
        }
        if let Event::Paste(raw) = &event {
            insert_paste(&mut pastes, raw, &mut buf, &mut cursor);
            selected = 0;
            menu_dismissed = false;
            selection_explicit = false;
            redraw(
                &crate::tui::prompt_frame(frame),
                &buf,
                cursor,
                selected,
                &mut menu_rows,
                &catalog,
                menu_dismissed,
                selection_explicit,
            )?;
            continue;
        }
        if let Event::Key(key) = event {
            // crossterm may deliver key-release events on some platforms; only
            // act on presses (the default `Press` kind).
            if key.kind != event::KeyEventKind::Press {
                continue;
            }
            let menu_entries = if menu_dismissed {
                Vec::new()
            } else if menu_trigger(&buf) {
                catalog.matches(&buf)
            } else {
                catalog.suggest(&buf)
            };
            match menu_action(
                &menu_entries,
                selected,
                key,
                keymap,
                menu_trigger(&buf),
                selection_explicit,
            ) {
                Some(SlashMenuAction::Dismiss) => {
                    menu_dismissed = true;
                    selected = 0;
                    selection_explicit = false;
                    redraw(
                        &crate::tui::prompt_frame(frame),
                        &buf,
                        cursor,
                        selected,
                        &mut menu_rows,
                        &catalog,
                        menu_dismissed,
                        selection_explicit,
                    )?;
                    continue;
                }
                Some(SlashMenuAction::Select(index)) => {
                    selected = index;
                    selection_explicit = true;
                    redraw(
                        &crate::tui::prompt_frame(frame),
                        &buf,
                        cursor,
                        selected,
                        &mut menu_rows,
                        &catalog,
                        menu_dismissed,
                        selection_explicit,
                    )?;
                    continue;
                }
                Some(SlashMenuAction::Complete(completion, requires_arguments)) => {
                    buf = completion;
                    if requires_arguments {
                        buf.push(' ');
                    }
                    cursor = buf.len();
                    selected = 0;
                    selection_explicit = false;
                    menu_dismissed = false;
                    redraw(
                        &crate::tui::prompt_frame(frame),
                        &buf,
                        cursor,
                        selected,
                        &mut menu_rows,
                        &catalog,
                        menu_dismissed,
                        selection_explicit,
                    )?;
                    continue;
                }
                Some(SlashMenuAction::Dispatch(command)) => {
                    redraw(
                        &crate::tui::prompt_frame(frame),
                        &buf,
                        cursor,
                        selected,
                        &mut menu_rows,
                        &catalog,
                        true,
                        false,
                    )?;
                    let mut out = io::stdout();
                    let _ = write!(out, "\r\x1b[2K");
                    let _ = out.flush();
                    return Ok(InputEvent::Submit(command));
                }
                None => {}
            }
            if !history.is_empty()
                && (key.code == KeyCode::Up || keymap.matches(KeyAction::HistoryUp, key))
            {
                if history_index == history.len() {
                    draft = buf.clone();
                }
                history_index = history_index.saturating_sub(1);
                buf.clone_from(&history[history_index]);
                cursor = buf.len();
                selected = 0;
                selection_explicit = false;
                redraw(
                    &crate::tui::prompt_frame(frame),
                    &buf,
                    cursor,
                    selected,
                    &mut menu_rows,
                    &catalog,
                    menu_dismissed,
                    selection_explicit,
                )?;
                continue;
            }
            if history_index < history.len()
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
                selection_explicit = false;
                redraw(
                    &crate::tui::prompt_frame(frame),
                    &buf,
                    cursor,
                    selected,
                    &mut menu_rows,
                    &catalog,
                    menu_dismissed,
                    selection_explicit,
                )?;
                continue;
            }
            match apply_key(key, &mut buf, &mut cursor, keymap) {
                KeyOutcome::Emit(ev) => {
                    // Let the caller print the submitted text or tab bar once.
                    redraw(
                        &crate::tui::prompt_frame(frame),
                        &buf,
                        cursor,
                        selected,
                        &mut menu_rows,
                        &catalog,
                        true,
                        false,
                    )?;
                    let mut out = io::stdout();
                    let _ = write!(out, "\r\x1b[2K");
                    let _ = out.flush();
                    return Ok(expand_pastes(ev, &mut pastes));
                }
                KeyOutcome::Continue => {
                    selected = 0;
                    selection_explicit = false;
                    menu_dismissed = false;
                    redraw(
                        &crate::tui::prompt_frame(frame),
                        &buf,
                        cursor,
                        selected,
                        &mut menu_rows,
                        &catalog,
                        menu_dismissed,
                        selection_explicit,
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
    read_line_fallback_with_idle(|| Ok(None))
}

type LineRead = Result<Option<String>>;
type LineReadReceiver = Mutex<mpsc::Receiver<LineRead>>;
static LINE_MODE_INPUT: OnceLock<std::result::Result<LineReadReceiver, String>> = OnceLock::new();

fn line_mode_input() -> Result<&'static LineReadReceiver> {
    LINE_MODE_INPUT
        .get_or_init(|| {
            let (sender, receiver) = mpsc::sync_channel::<LineRead>(1);
            thread::Builder::new()
                .name("hii-line-input".into())
                .spawn(move || loop {
                    let mut line = String::new();
                    match io::stdin().read_line(&mut line) {
                        Ok(0) => {
                            let _ = sender.send(Ok(None));
                            break;
                        }
                        Ok(_) => {
                            let line = line.trim_end_matches(['\r', '\n']).to_string();
                            if sender.send(Ok(Some(line))).is_err() {
                                break;
                            }
                        }
                        Err(error) => {
                            let _ = sender.send(Err(format!("failed to read line: {error}")));
                            break;
                        }
                    }
                })
                .map_err(|error| format!("failed to start line input reader: {error}"))?;
            Ok(Mutex::new(receiver))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Read one plain line while continuing to poll asynchronous input sources.
/// A single process-wide reader thread keeps stdin ownership stable when an
/// idle callback wakes the REPL before the user types a line.
pub fn read_line_fallback_with_idle(
    mut poll_idle: impl FnMut() -> Result<Option<InputEvent>>,
) -> Result<Option<InputEvent>> {
    let receiver = line_mode_input()?
        .lock()
        .map_err(|_| "line input receiver is poisoned".to_string())?;
    poll_line_or_idle(&receiver, &mut poll_idle)
}

fn poll_line_or_idle(
    receiver: &mpsc::Receiver<LineRead>,
    poll_idle: &mut impl FnMut() -> Result<Option<InputEvent>>,
) -> Result<Option<InputEvent>> {
    loop {
        if let Some(event) = poll_idle()? {
            return Ok(Some(event));
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(Some(line))) => return Ok(Some(InputEvent::Submit(line))),
            Ok(Ok(None)) | Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(None),
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct CountingWriter {
        bytes: Vec<u8>,
        writes: usize,
        flushes: usize,
    }

    impl Write for CountingWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.writes += 1;
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            self.flushes += 1;
            Ok(())
        }
    }

    #[test]
    fn streaming_preserves_indentation_across_chunks() {
        let mut out = Vec::new();
        let mut column = 0;
        for chunk in ["```rust\nfn main() {\n", "    ", "println!(\"hi\");\n", "}\n```"] {
            write_stream_delta(&mut out, chunk, &mut column, 80, false).unwrap();
        }
        assert_eq!(String::from_utf8(out).unwrap(), "```rust\r\nfn main() {\r\n    println!(\"hi\");\r\n}\r\n```");
    }

    #[test]
    fn empty_left_opens_workspace_without_breaking_text_navigation() {
        let mut buf = String::new();
        let mut cursor = 0;
        assert!(
            matches!(apply_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE), &mut buf, &mut cursor, &Keymap::default()), KeyOutcome::Emit(InputEvent::Submit(value)) if value == "/workspace")
        );
        buf = "hello".into();
        cursor = 2;
        assert!(matches!(
            apply_key(
                KeyEvent::new(KeyCode::Left, KeyModifiers::NONE),
                &mut buf,
                &mut cursor,
                &Keymap::default()
            ),
            KeyOutcome::Continue
        ));
        assert_eq!(cursor, 1);
    }

    #[test]
    fn composer_menu_repaint_preserves_escape_frame_in_one_write() {
        let catalog = crate::tui::SlashCommandCatalog::load(true);
        let mut writer = CountingWriter::default();
        let mut previous_rows = 0;

        redraw_to(
            &mut writer,
            "P",
            "/hel",
            4,
            0,
            &mut previous_rows,
            &catalog,
            false,
            false,
        )
        .unwrap();

        let rendered = String::from_utf8(writer.bytes).unwrap();
        assert!(rendered.contains("P/hel"));
        assert!(rendered.contains("\r\n\x1b[2K"));
        assert!(rendered.contains("/help  Show command help"));
        assert!(rendered.ends_with("\x1b[2A\r\x1b[5C"));
        assert_eq!(previous_rows, 2);
        // One sink write per complete frame instead of several writes per row.
        assert_eq!(writer.writes, 1);
        assert_eq!(writer.flushes, 1);
    }

    #[test]
    fn composer_menu_repaint_clears_old_rows_with_relative_motion() {
        let catalog = crate::tui::SlashCommandCatalog::load(true);
        let mut writer = CountingWriter::default();
        let mut previous_rows = 2;

        redraw_to(
            &mut writer,
            "P",
            "/hel",
            4,
            0,
            &mut previous_rows,
            &catalog,
            false,
            false,
        )
        .unwrap();

        let rendered = String::from_utf8(writer.bytes).unwrap();
        assert!(rendered.starts_with("\r\x1b[1B\r\x1b[2K\x1b[1B\r\x1b[2K\x1b[2A"));
        assert!(rendered.contains("\r\n\x1b[2K"));
        assert!(rendered.ends_with("\x1b[2A\r\x1b[5C"));
        assert_eq!(previous_rows, 2);
        assert_eq!(writer.writes, 1);
    }

    #[test]
    fn dismissing_menu_repaint_starts_at_composer_and_clears_every_old_row() {
        let catalog = crate::tui::SlashCommandCatalog::load(true);
        let mut writer = CountingWriter::default();
        let mut previous_rows = 0;

        redraw_to(
            &mut writer,
            "P",
            "/",
            1,
            0,
            &mut previous_rows,
            &catalog,
            false,
            false,
        )
        .unwrap();
        let old_menu_rows = previous_rows;
        assert!(old_menu_rows > 1);

        writer.bytes.clear();
        redraw_to(
            &mut writer,
            "P",
            "/",
            1,
            0,
            &mut previous_rows,
            &catalog,
            true,
            false,
        )
        .unwrap();

        let repaint = String::from_utf8(writer.bytes).unwrap();
        let cleared_rows = repaint.matches("\x1b[1B\r\x1b[2K").count();
        assert_eq!(cleared_rows, old_menu_rows);
        assert!(repaint.ends_with("\x1b[1A\r\x1b[2C"));
        assert_eq!(previous_rows, 1);
    }

    #[test]
    fn finishing_committed_output_ends_with_one_newline() {
        assert_eq!(finish_stream_sequence(true), "\r\n");
        assert_eq!(finish_stream_sequence(false), "");
    }

    #[test]
    fn line_mode_polls_async_input_while_waiting_for_a_line() {
        let (_sender, receiver) = mpsc::channel::<LineRead>();
        let mut polls = 0;
        let result = poll_line_or_idle(&receiver, &mut || {
            polls += 1;
            if polls == 3 {
                Ok(Some(InputEvent::Submit("phone message".into())))
            } else {
                Ok(None)
            }
        })
        .unwrap();
        assert_eq!(result, Some(InputEvent::Submit("phone message".into())));
        assert_eq!(polls, 3);
    }

    #[test]
    fn line_mode_preserves_line_dispatch_and_eof() {
        let (sender, receiver) = mpsc::channel::<LineRead>();
        sender.send(Ok(Some("typed input".into()))).unwrap();
        assert_eq!(
            poll_line_or_idle(&receiver, &mut || Ok(None)).unwrap(),
            Some(InputEvent::Submit("typed input".into()))
        );
        sender.send(Ok(None)).unwrap();
        assert_eq!(poll_line_or_idle(&receiver, &mut || Ok(None)).unwrap(), None);
    }

    #[test]
    fn first_stream_delta_clears_activity_and_reserves_the_last_column() {
        let mut out = Vec::new();
        let mut column = 0;
        write_stream_delta(&mut out, "abcde", &mut column, 5, true).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "\rabcd\r\ne");
        assert_eq!(column, 1);
    }

    #[test]
    fn streamed_output_counts_wide_text_and_never_executes_control_bytes() {
        let mut out = Vec::new();
        let mut column = 0;
        write_stream_delta(&mut out, "ab界c\x1b[2J", &mut column, 5, false).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "ab界\r\nc�[2\r\nJ");
        assert_eq!(column, 1);
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn decode_bytes(bytes: &[u8]) -> Option<Event> {
        decode_terminal_input(&mut bytes.to_vec(), &mut None)
    }

    #[test]
    fn standard_arrow_and_home_end_encodings_decode_for_menu_navigation() {
        for (sequence, code) in [
            (b"\x1b[A".as_slice(), KeyCode::Up),
            (b"\x1b[B".as_slice(), KeyCode::Down),
            (b"\x1b[C".as_slice(), KeyCode::Right),
            (b"\x1b[D".as_slice(), KeyCode::Left),
            (b"\x1b[H".as_slice(), KeyCode::Home),
            (b"\x1b[F".as_slice(), KeyCode::End),
        ] {
            assert_eq!(decode_bytes(sequence), Some(Event::Key(code.into())));
        }
    }

    #[test]
    fn fragmented_ss3_application_cursor_sequences_decode_without_alt_o_leakage() {
        for (final_byte, code) in [
            (b'A', KeyCode::Up),
            (b'B', KeyCode::Down),
            (b'C', KeyCode::Right),
            (b'D', KeyCode::Left),
            (b'H', KeyCode::Home),
            (b'F', KeyCode::End),
        ] {
            let mut pending = vec![0x1b];
            let mut escape_since = None;
            assert_eq!(decode_terminal_input(&mut pending, &mut escape_since), None);
            pending.push(b'O');
            assert_eq!(decode_terminal_input(&mut pending, &mut escape_since), None);
            pending.push(final_byte);
            assert_eq!(
                decode_terminal_input(&mut pending, &mut escape_since),
                Some(Event::Key(code.into()))
            );
            assert!(pending.is_empty());
        }
    }

    #[test]
    fn unknown_ss3_sequences_are_consumed_as_control_input() {
        let mut pending = b"\x1bOZx".to_vec();
        assert_eq!(
            decode_terminal_input(&mut pending, &mut None),
            Some(Event::FocusLost)
        );
        // The sequence is consumed, and following ordinary input stays intact.
        assert_eq!(
            decode_terminal_input(&mut pending, &mut None),
            Some(Event::Key(KeyCode::Char('x').into()))
        );
    }

    #[test]
    fn legacy_and_kitty_shift_enter_are_decoded_as_multiline_input() {
        for sequence in [
            b"\x1b[27;2;13~".as_slice(),
            b"\x1b[13;2u".as_slice(),
            b"\x1b[13;2:1u".as_slice(),
        ] {
            assert_eq!(
                decode_bytes(sequence),
                Some(Event::Key(KeyEvent::new(
                    KeyCode::Enter,
                    KeyModifiers::SHIFT
                )))
            );
        }
        let mut buf = "hello".to_string();
        let mut cursor = buf.len();
        assert!(
            emit(
                KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT),
                &mut buf,
                &mut cursor
            )
            .is_none()
        );
        assert_eq!(buf, "hello\n");
        assert_eq!(
            emit(key(KeyCode::Enter), &mut buf, &mut cursor),
            Some(InputEvent::Submit("hello\n".into()))
        );
    }

    #[test]
    fn kitty_functional_keys_drive_completion_interrupt_and_navigation() {
        for (sequence, code) in [
            (b"\x1b[9u".as_slice(), KeyCode::Tab),
            (b"\x1b[27u".as_slice(), KeyCode::Esc),
            (b"\x1b[1D".as_slice(), KeyCode::Left),
            (b"\x1b[1C".as_slice(), KeyCode::Right),
            (b"\x1b[1A".as_slice(), KeyCode::Up),
            (b"\x1b[1B".as_slice(), KeyCode::Down),
            (b"\x1b[1H".as_slice(), KeyCode::Home),
            (b"\x1b[1F".as_slice(), KeyCode::End),
            (b"\x1b[3~".as_slice(), KeyCode::Delete),
            (b"\x1b[7~".as_slice(), KeyCode::Home),
            (b"\x1b[8~".as_slice(), KeyCode::End),
            (b"\x1b[127u".as_slice(), KeyCode::Backspace),
        ] {
            assert_eq!(decode_bytes(sequence), Some(Event::Key(code.into())));
        }

        let catalog = crate::tui::SlashCommandCatalog::load(false);
        let matches = catalog.matches("/sta");
        let Event::Key(tab) = decode_bytes(b"\x1b[9u").unwrap() else {
            panic!("kitty Tab did not decode as a key");
        };
        assert!(matches!(
            slash_menu_action(&matches, 0, tab, &Keymap::default()),
            Some(SlashMenuAction::Complete(command, false)) if command == "/status"
        ));
        let Event::Key(escape) = decode_bytes(b"\x1b[27u").unwrap() else {
            panic!("kitty Escape did not decode as a key");
        };
        assert!(matches!(
            slash_menu_action(&matches, 0, escape, &Keymap::default()),
            Some(SlashMenuAction::Dismiss)
        ));
    }

    #[test]
    fn kitty_release_and_unknown_control_or_private_keys_never_leak_as_text() {
        assert_eq!(decode_bytes(b"\x1b[57350;1:3u"), None);
        for sequence in [b"\x1b[1u".as_slice(), b"\x1b[57354u", b"\x1b[57399u"] {
            assert_eq!(decode_bytes(sequence), Some(Event::FocusLost));
        }
        assert_eq!(
            decode_bytes(b"\x1b[47:63;2u"),
            Some(Event::Key(KeyEvent::new(
                KeyCode::Char('/'),
                KeyModifiers::SHIFT
            )))
        );
    }

    #[test]
    fn reader_handoff_keeps_typeahead_after_enter_for_live_input() {
        let mut idle_reader = TerminalReader {
            pending: b"first\rsecond\t".to_vec(),
            escape_since: None,
            size: None,
        };
        for character in "first".chars() {
            assert_eq!(
                idle_reader.decode_pending(),
                Some(Event::Key(KeyCode::Char(character).into()))
            );
        }
        assert_eq!(
            idle_reader.decode_pending(),
            Some(Event::Key(KeyCode::Enter.into()))
        );
        // The idle reader has consumed Enter, but read(2) had already buffered
        // the following typed key sequence.
        drop(idle_reader);
        let mut live_reader = TerminalReader::default();
        assert_eq!(
            live_reader.decode_pending(),
            Some(Event::Key(KeyCode::Char('s').into()))
        );
        assert_eq!(
            live_reader.decode_pending(),
            Some(Event::Key(KeyCode::Char('e').into()))
        );
        assert_eq!(
            live_reader.decode_pending(),
            Some(Event::Key(KeyCode::Char('c').into()))
        );
        assert_eq!(
            live_reader.decode_pending(),
            Some(Event::Key(KeyCode::Char('o').into()))
        );
        assert_eq!(
            live_reader.decode_pending(),
            Some(Event::Key(KeyCode::Char('n').into()))
        );
        assert_eq!(
            live_reader.decode_pending(),
            Some(Event::Key(KeyCode::Char('d').into()))
        );
        assert_eq!(
            live_reader.decode_pending(),
            Some(Event::Key(KeyCode::Tab.into()))
        );
    }

    #[test]
    fn kitty_release_events_are_consumed_without_key_events() {
        let mut bytes = b"\x1b[13;2:3u\x1b[13;2:1u".to_vec();
        assert_eq!(decode_terminal_input(&mut bytes, &mut None), None);
        assert_eq!(
            decode_terminal_input(&mut bytes, &mut None),
            Some(Event::Key(KeyEvent::new(
                KeyCode::Enter,
                KeyModifiers::SHIFT
            )))
        );
    }

    #[test]
    fn terminal_decoder_preserves_unicode_paste_and_swallows_unknown_csi() {
        let mut bytes = "界".as_bytes().to_vec();
        let mut escape_since = None;
        assert_eq!(
            decode_terminal_input(&mut bytes, &mut escape_since),
            Some(Event::Key(KeyCode::Char('界').into()))
        );
        let mut paste = b"\x1b[200~a\nb\x1b[201~".to_vec();
        assert_eq!(
            decode_terminal_input(&mut paste, &mut None),
            Some(Event::Paste("a\nb".into()))
        );
        assert!(paste.is_empty());
        let mut unknown = b"\x1b[99z".to_vec();
        assert_eq!(
            decode_terminal_input(&mut unknown, &mut None),
            Some(Event::FocusLost)
        );
        assert!(unknown.is_empty());
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
    fn slash_prefix_filters_completes_dispatches_and_dismisses_menu() {
        let catalog = crate::tui::SlashCommandCatalog::load(false);
        let matches = catalog.matches("/sta");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].completion, "/status");
        let map = Keymap::default();
        assert!(matches!(
            slash_menu_action(&matches, 0, key(KeyCode::Tab), &map),
            Some(SlashMenuAction::Complete(command, false)) if command == "/status"
        ));
        assert!(matches!(
            slash_menu_action(&matches, 0, key(KeyCode::Enter), &map),
            Some(SlashMenuAction::Dispatch(command)) if command == "/status"
        ));
        assert!(matches!(
            slash_menu_action(&matches, 0, key(KeyCode::Esc), &map),
            Some(SlashMenuAction::Dismiss)
        ));
        assert!(
            slash_menu_action(
                &matches,
                0,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT),
                &map,
            )
            .is_none()
        );

        let attach = catalog.matches("/attach");
        assert!(matches!(
            slash_menu_action(&attach, 0, key(KeyCode::Enter), &map),
            Some(SlashMenuAction::Complete(command, true)) if command == "/attach"
        ));
    }

    #[test]
    fn natural_enter_submits_original_unless_a_plain_suggestion_was_selected() {
        let catalog = crate::tui::SlashCommandCatalog::load(false);
        let query = "model";
        let suggestions = catalog.suggest(query);
        let map = Keymap::default();
        assert!(matches!(
            menu_action(&suggestions, 0, key(KeyCode::Tab), &map, false, false),
            Some(SlashMenuAction::Complete(command, _)) if command.starts_with('/')
        ));
        assert!(menu_action(&suggestions, 0, key(KeyCode::Enter), &map, false, false).is_none());

        let Some(search_index) = suggestions.iter().position(|entry| entry.trigger == "?") else {
            panic!("local search suggestion missing");
        };
        assert!(matches!(
            menu_action(&suggestions, 0, key(KeyCode::Down), &map, false, false),
            Some(SlashMenuAction::Select(1))
        ));
        assert!(matches!(
            menu_action(
                &suggestions,
                search_index,
                key(KeyCode::Enter),
                &map,
                false,
                false
            ),
            None
        ));
        assert!(matches!(
            menu_action(&suggestions, search_index, key(KeyCode::Enter), &map, false, true),
            Some(SlashMenuAction::Dispatch(command)) if command == "? model"
        ));

        let query_suggestions = catalog.suggest("? where is my model");
        assert!(matches!(
            menu_action(&query_suggestions, 0, key(KeyCode::Tab), &map, false, false),
            Some(SlashMenuAction::Complete(completion, false)) if completion == "? where is my model"
        ));
    }

    #[test]
    fn suggestion_frame_is_bounded_and_marks_only_explicit_plain_selection() {
        let catalog = crate::tui::SlashCommandCatalog::load(false);
        let entries = catalog.suggest("model");
        let idle = suggestion_menu_frame(&entries, 0, false, 80);
        assert!(!idle[0].starts_with("› "));
        assert!(idle.len() <= 6);
        let selected = suggestion_menu_frame(&entries, 0, true, 80);
        assert!(selected[0].starts_with("› "));
        assert!(
            selected
                .iter()
                .all(|line| crate::codex_ui::display_width(line) <= 80)
        );

        let slash = catalog.matches("/sta");
        let slash_frame = suggestion_menu_frame(&slash, 0, true, 80);
        assert!(slash_frame[0].starts_with("› /status"));
    }

    #[test]
    fn slash_menu_selection_can_navigate_all_matching_commands() {
        let catalog = crate::tui::SlashCommandCatalog::load(false);
        let matches = catalog.matches("/");
        assert!(matches.len() > 6);
        let map = Keymap::default();
        assert!(matches!(
            slash_menu_action(&matches, 0, key(KeyCode::Up), &map),
            Some(SlashMenuAction::Select(index)) if index == matches.len() - 1
        ));
        assert!(matches!(
            slash_menu_action(&matches, matches.len() - 1, key(KeyCode::Down), &map),
            Some(SlashMenuAction::Select(0))
        ));
    }

    #[test]
    fn slash_prefix_remains_editable_for_menu_filtering() {
        let mut buf = String::from("/clau");
        let mut cursor = buf.len();
        assert!(emit(key(KeyCode::Char('d')), &mut buf, &mut cursor).is_none());
        assert_eq!(buf, "/claud");
    }

    #[test]
    fn shift_tab_with_text_queues_and_empty_shift_tab_switches_sessions() {
        let mut buf = String::from("deploy");
        let mut cursor = buf.len();
        assert_eq!(
            emit(key(KeyCode::BackTab), &mut buf, &mut cursor),
            Some(InputEvent::Queue("deploy".to_string()))
        );
        assert!(buf.is_empty());
        assert_eq!(
            emit(key(KeyCode::BackTab), &mut buf, &mut cursor),
            Some(InputEvent::SwitchSession(-1, String::new()))
        );
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
    fn tab_with_text_queues_and_empty_tab_switches_agent_sessions() {
        let mut buf = String::new();
        let mut cursor = 0;
        assert_eq!(
            emit(key(KeyCode::Tab), &mut buf, &mut cursor),
            Some(InputEvent::SwitchSession(1, String::new()))
        );
        assert_eq!(
            emit(key(KeyCode::BackTab), &mut buf, &mut cursor),
            Some(InputEvent::SwitchSession(-1, String::new()))
        );
        buf = "steer this run".into();
        cursor = buf.len();
        assert_eq!(
            emit(key(KeyCode::Tab), &mut buf, &mut cursor),
            Some(InputEvent::Queue("steer this run".into()))
        );
    }

    #[test]
    fn composer_render_restores_cursor_with_unicode_and_windowing() {
        let mut out = Vec::new();
        write_composer(&mut out, "go 界 now", 6, 12).unwrap();
        let rendered = String::from_utf8(out).unwrap();
        assert!(rendered.starts_with("› go 界 now"));
        assert!(rendered.contains("\r\n\x1b[2K"));
        assert!(rendered.ends_with("\r\x1b[1A\x1b[7C"));
    }

    #[test]
    fn plain_composer_fills_safe_widths_and_footer_clips_narrowly() {
        for width in [80, 32] {
            let frame = composer_frame(
                "hello",
                5,
                width,
                "workspace · model · waiting · Enter send",
            );
            let input = frame.split("\r\n").next().unwrap();
            assert_eq!(crate::codex_ui::display_width(input), width - 1);
            assert!(frame.contains("workspace"));
            assert!(frame.ends_with("\r\x1b[1A\x1b[7C"));
            assert!(!frame.contains("\x1b[48;5;"));
            assert!(!frame.contains("\x1b[38;5;"));
        }
        // The frame is always plain, regardless of the caller's terminal color
        // capability; no background bar is emitted in the narrow layout.
        let narrow = composer_frame("x", 1, 32, "status");
        assert!(!narrow.contains("\x1b[48;5;"));
        assert!(!narrow.contains("\x1b[0m"));
    }

    #[test]
    fn inspection_resume_resets_stream_frame_and_keeps_composer_active() {
        let (mut column, mut output, mut active, mut visible) = (17, true, false, false);
        reset_inspection_stream_frame(&mut column, &mut output, &mut active, &mut visible);
        assert_eq!((column, output, active, visible), (0, false, true, true));

        let mut frame = Vec::new();
        let mut next_column = column;
        write_stream_frame(
            &mut frame,
            "after inspection",
            &mut next_column,
            40,
            output,
            "draft",
            5,
        )
        .unwrap();
        let rendered = String::from_utf8(frame).unwrap();
        assert!(rendered.ends_with("\r\x1b[1A\x1b[7C"));
    }

    #[test]
    fn stream_frame_keeps_an_empty_editable_composer_visible() {
        let mut out = Vec::new();
        let mut column = 0;
        write_stream_frame(&mut out, "Working", &mut column, 20, false, "", 0).unwrap();
        let rendered = String::from_utf8(out).unwrap();
        assert!(rendered.contains("Working\r\n› "));
        assert!(rendered.contains("› "));
        assert!(rendered.contains("\r\n\x1b[2K"));
        assert!(rendered.ends_with("\r\x1b[1A\x1b[2C"));
    }

    #[test]
    fn later_stream_delta_clears_prompt_before_returning_to_output_row() {
        let mut first = Vec::new();
        let mut column = 0;
        write_stream_frame(&mut first, "hello", &mut column, 20, false, "draft", 5).unwrap();
        assert!(
            String::from_utf8(first)
                .unwrap()
                .contains("hello\r\n› draft")
        );

        let mut next = Vec::new();
        write_stream_frame(&mut next, " world", &mut column, 20, true, "draft", 5).unwrap();
        let rendered = String::from_utf8(next).unwrap();
        assert!(rendered.starts_with("\r\x1b[2K\x1b[1A\r\x1b[5C world"));
        assert!(!rendered.contains("\x1b[1A\r\x1b[2K"));
        assert!(rendered.contains("› draft"));
        assert!(rendered.contains("\r\n\x1b[2K"));
        assert!(rendered.ends_with("\r\x1b[1A\x1b[7C"));
    }

    #[test]
    fn stream_wrap_and_trailing_newline_keep_composer_below_reserved_output_row() {
        let mut out = Vec::new();
        let mut column = 0;
        write_stream_frame(&mut out, "123456789\n", &mut column, 6, false, "draft", 5).unwrap();
        assert_eq!(column, 0);
        let rendered = String::from_utf8(out).unwrap();
        assert!(rendered.contains("\r\n\x1b[2K"));
        assert!(rendered.ends_with("\r\x1b[1A\x1b[4C"));
        let mut next = Vec::new();
        write_stream_frame(&mut next, "x", &mut column, 6, true, "draft", 5).unwrap();
        assert!(!String::from_utf8(next).unwrap().contains("\x1b[0C"));
    }

    #[test]
    fn fresh_delta_after_notification_starts_below_status_line() {
        let mut out = Vec::new();
        let mut column = 0;
        write_stream_frame(&mut out, "partial", &mut column, 20, false, "draft", 5).unwrap();
        // Notifications replace the composer row and move the composer below
        // the notification, so the next delta begins in that fresh row.
        column = 0;
        out.clear();
        write_stream_frame(&mut out, "next", &mut column, 20, false, "draft", 5).unwrap();
        assert!(String::from_utf8(out).unwrap().starts_with("\r\x1b[2Knext"));
    }

    #[test]
    fn draft_boundary_expands_pastes_and_keeps_cursor_position() {
        let mut pastes = PasteStore::default();
        let block = pastes.stage("one\ntwo");
        let buf = format!("ask {block} end");
        let cursor = "ask ".len() + block.len();
        assert_eq!(
            expand_draft(&buf, cursor, &pastes),
            ("ask one\ntwo end".into(), 11)
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
    fn slash_char_can_open_the_idle_command_menu() {
        let mut buf = String::new();
        let mut cursor = 0;
        assert!(emit(key(KeyCode::Char('/')), &mut buf, &mut cursor).is_none());
        assert_eq!(buf, "/");
    }
}
