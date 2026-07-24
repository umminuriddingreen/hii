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

use std::io::{self, IsTerminal, Write};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
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
    /// Ctrl+B — background the current run.
    Background,
    /// Ctrl+T — show the task/status view.
    TaskView,
}

/// Whether the interactive raw-mode loop is usable (both stdin and stdout TTY).
///
/// The REPL gates on this and calls [`read_line_fallback`] otherwise, so piped
/// or non-interactive invocations keep working.
pub fn is_interactive() -> bool {
    io::stdin().is_terminal() && io::stdout().is_terminal()
}

/// RAII wrapper that enables raw mode on construction and always restores the
/// terminal on drop — including during unwinding — so a panic never leaves the
/// user's shell in raw mode.
struct RawModeGuard;

impl RawModeGuard {
    fn enter() -> Result<Self> {
        enable_raw_mode().map_err(|e| format!("failed to enable raw terminal mode: {e}"))?;
        Ok(RawModeGuard)
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        // Best-effort: nothing useful to do if restoring fails.
        let _ = disable_raw_mode();
    }
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
fn apply_key(key: KeyEvent, buf: &mut String) -> KeyOutcome {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        KeyCode::Enter => KeyOutcome::Emit(InputEvent::Submit(std::mem::take(buf))),
        KeyCode::Tab => KeyOutcome::Emit(InputEvent::Queue(std::mem::take(buf))),
        KeyCode::Esc => KeyOutcome::Emit(InputEvent::Interrupt),
        KeyCode::Char('b') if ctrl => KeyOutcome::Emit(InputEvent::Background),
        KeyCode::Char('t') if ctrl => KeyOutcome::Emit(InputEvent::TaskView),
        KeyCode::Backspace => {
            buf.pop();
            KeyOutcome::Continue
        }
        // Ignore other control chords; only insert real characters.
        KeyCode::Char(c) if !ctrl => {
            buf.push(c);
            KeyOutcome::Continue
        }
        _ => KeyOutcome::Continue,
    }
}

/// Redraw the prompt and current buffer on one line (carriage-return refresh).
fn redraw(prompt: &str, buf: &str) -> Result<()> {
    let mut out = io::stdout();
    // \r to column 0, clear to end of line, then reprint.
    write!(out, "\r\x1b[2K{prompt}{buf}").map_err(|e| format!("failed to write prompt: {e}"))?;
    out.flush()
        .map_err(|e| format!("failed to flush stdout: {e}"))?;
    Ok(())
}

/// Run the raw-mode key loop until a high-level [`InputEvent`] is produced.
///
/// `prompt` is redrawn as the user edits. Raw mode is entered for the duration
/// and restored on return (or panic) via [`RawModeGuard`].
pub fn read_event(prompt: &str) -> Result<InputEvent> {
    let _guard = RawModeGuard::enter()?;
    let mut buf = String::new();
    redraw(prompt, &buf)?;
    loop {
        if let Event::Key(key) =
            event::read().map_err(|e| format!("failed to read terminal event: {e}"))?
        {
            // crossterm may deliver key-release events on some platforms; only
            // act on presses (the default `Press` kind).
            if key.kind != event::KeyEventKind::Press {
                continue;
            }
            match apply_key(key, &mut buf) {
                KeyOutcome::Emit(ev) => {
                    // Move to a fresh line so subsequent output is not clobbered.
                    let mut out = io::stdout();
                    let _ = write!(out, "\r\n");
                    let _ = out.flush();
                    return Ok(ev);
                }
                KeyOutcome::Continue => redraw(prompt, &buf)?,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::CONTROL)
    }

    fn emit(key: KeyEvent, buf: &mut String) -> Option<InputEvent> {
        match apply_key(key, buf) {
            KeyOutcome::Emit(ev) => Some(ev),
            KeyOutcome::Continue => None,
        }
    }

    #[test]
    fn typing_then_enter_submits_buffer() {
        let mut buf = String::new();
        assert!(emit(key(KeyCode::Char('h')), &mut buf).is_none());
        assert!(emit(key(KeyCode::Char('i')), &mut buf).is_none());
        assert_eq!(
            emit(key(KeyCode::Enter), &mut buf),
            Some(InputEvent::Submit("hi".to_string()))
        );
        // Buffer is drained on submit.
        assert!(buf.is_empty());
    }

    #[test]
    fn tab_queues_current_line_without_losing_text() {
        let mut buf = String::from("deploy");
        assert_eq!(
            emit(key(KeyCode::Tab), &mut buf),
            Some(InputEvent::Queue("deploy".to_string()))
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn control_keys_map_to_run_controls() {
        let mut buf = String::new();
        assert_eq!(
            emit(key(KeyCode::Esc), &mut buf),
            Some(InputEvent::Interrupt)
        );
        assert_eq!(
            emit(ctrl(KeyCode::Char('b')), &mut buf),
            Some(InputEvent::Background)
        );
        assert_eq!(
            emit(ctrl(KeyCode::Char('t')), &mut buf),
            Some(InputEvent::TaskView)
        );
    }

    #[test]
    fn backspace_edits_and_ctrl_chars_are_not_inserted() {
        let mut buf = String::from("ab");
        assert!(emit(key(KeyCode::Backspace), &mut buf).is_none());
        assert_eq!(buf, "a");
        // A ctrl chord that is not a mapped control must not type a character.
        assert!(emit(ctrl(KeyCode::Char('x')), &mut buf).is_none());
        assert_eq!(buf, "a");
    }
}
