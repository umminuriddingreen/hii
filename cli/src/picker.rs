//! Inline type-to-filter selection list.
//!
//! HII already renders a slash-command menu under the composer; this is the
//! same idea promoted to a standalone widget so any command that ends in
//! "choose one of these" can present a live list instead of a static table the
//! operator has to retype from. It draws inline (never the alternate screen)
//! so the terminal scrollback stays the record of what happened.

use std::io::{self, IsTerminal, Write};

use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode},
};

use crate::tui;

type Result<T> = std::result::Result<T, String>;

/// One selectable row. `value` is what the caller acts on; `detail` is the
/// trailing dim column, and `current` marks the row already in effect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub value: String,
    pub detail: String,
    pub current: bool,
}

impl Choice {
    pub fn new(value: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            detail: detail.into(),
            current: false,
        }
    }

    pub fn current(mut self, current: bool) -> Self {
        self.current = current;
        self
    }
}

const VISIBLE_ROWS: usize = 8;

/// Whether a picker can run here. Callers fall back to a printed table when
/// this is false so piped and scripted use keeps working unchanged.
pub fn is_available() -> bool {
    std::env::var_os("HII_UI_LINE_MODE").is_none()
        && io::stdin().is_terminal()
        && io::stdout().is_terminal()
}

/// Present `choices` under `title` and return the chosen value, or `None` if
/// the operator cancelled with Esc or Ctrl+C.
pub fn select(title: &str, choices: &[Choice]) -> Result<Option<String>> {
    if choices.is_empty() {
        return Ok(None);
    }
    let _guard = PickerGuard::enter()?;
    let mut query = String::new();
    let mut selected = choices
        .iter()
        .position(|choice| choice.current)
        .unwrap_or(0);
    let mut rendered = 0usize;
    let mut out = io::stdout();

    let outcome = loop {
        let visible = filter(choices, &query);
        selected = selected.min(visible.len().saturating_sub(1));
        draw(
            &mut out,
            &frame(title, &query, choices, &visible, selected),
            &mut rendered,
        )?;

        let Event::Key(key) = event::read().map_err(|error| error.to_string())? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        let control = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Esc => break None,
            KeyCode::Char('c' | 'd') if control => break None,
            KeyCode::Enter => {
                break visible
                    .get(selected)
                    .map(|index| choices[*index].value.clone())
            }
            KeyCode::Up => selected = step(selected, visible.len(), -1),
            KeyCode::Char('p') if control => selected = step(selected, visible.len(), -1),
            KeyCode::Down | KeyCode::Tab => selected = step(selected, visible.len(), 1),
            KeyCode::Char('n') if control => selected = step(selected, visible.len(), 1),
            KeyCode::Backspace => {
                query.pop();
                selected = 0;
            }
            KeyCode::Char('u') if control => {
                query.clear();
                selected = 0;
            }
            KeyCode::Char(character) if !control => {
                query.push(character);
                selected = 0;
            }
            _ => {}
        }
    };

    clear(&mut out, rendered)?;
    Ok(outcome)
}

/// Indexes into `choices` that survive `query`, best match first.
fn filter(choices: &[Choice], query: &str) -> Vec<usize> {
    let query = query.trim().to_ascii_lowercase();
    let mut ranked = choices
        .iter()
        .enumerate()
        .filter_map(|(index, choice)| score(&choice.value, &query).map(|score| (score, index)))
        .collect::<Vec<_>>();
    ranked.sort_by_key(|(score, index)| (*score, *index));
    ranked.into_iter().map(|(_, index)| index).collect()
}

/// Lower is a better match: prefix beats substring beats subsequence.
fn score(value: &str, query: &str) -> Option<usize> {
    if query.is_empty() {
        return Some(0);
    }
    let value = value.to_ascii_lowercase();
    if value.starts_with(query) {
        return Some(0);
    }
    if let Some(at) = value.find(query) {
        return Some(1 + at);
    }
    let mut haystack = value.chars();
    for needle in query.chars() {
        haystack.find(|character| *character == needle)?;
    }
    Some(1_000)
}

fn step(selected: usize, length: usize, direction: i8) -> usize {
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

/// The full block of lines for one frame, header and footer included.
fn frame(
    title: &str,
    query: &str,
    choices: &[Choice],
    visible: &[usize],
    selected: usize,
) -> Vec<String> {
    let typed = if query.is_empty() {
        tui::style_dim("Type to filter…")
    } else {
        tui::style_accent(query)
    };
    let mut lines = vec![format!("  {}  {typed}", tui::style_bold(title))];

    if visible.is_empty() {
        lines.push(format!("    {}", tui::style_dim("no match")));
        lines.push(format!(
            "    {}",
            tui::style_dim("↑↓ navigate  Enter select  Esc cancel")
        ));
        return lines;
    }

    let start = window_start(selected, visible.len());
    let width = tui::terminal_width().saturating_sub(24).max(16);
    for (row, index) in visible
        .iter()
        .enumerate()
        .skip(start)
        .take(VISIBLE_ROWS)
        .map(|(row, index)| (row, *index))
    {
        let choice = &choices[index];
        let active = row == selected;
        let marker = if active { "▸" } else { " " };
        // Pad before painting: escape bytes occupy no columns, so a width
        // applied to an already-painted string lines up wrong.
        let plain = crate::text::clip(&choice.value, width);
        let padded = format!(
            "{plain}{}",
            " ".repeat(width.saturating_sub(plain.chars().count()))
        );
        let value = if active {
            tui::style_active(&padded)
        } else {
            tui::style_muted(&padded)
        };
        lines.push(format!(
            "  {} {value} {}",
            tui::style_accent(marker),
            tui::style_dim(&choice.detail)
        ));
    }
    lines.push(format!(
        "    {}",
        tui::style_dim(&format!(
            "↑↓ navigate  Enter select  Esc cancel  ·  {}/{}",
            selected + 1,
            visible.len()
        ))
    ));
    lines
}

fn window_start(selected: usize, total: usize) -> usize {
    if total <= VISIBLE_ROWS {
        return 0;
    }
    selected
        .saturating_sub(VISIBLE_ROWS - 1)
        .min(total - VISIBLE_ROWS)
}

/// Repaint the block in place, leaving the cursor back on its first row.
fn draw(out: &mut impl Write, lines: &[String], rendered: &mut usize) -> Result<()> {
    let mut write_row = |row: usize, body: &str| -> Result<()> {
        if row > 0 {
            write!(out, "\r\n").map_err(|error| error.to_string())?;
        }
        write!(out, "\r\x1b[2K{body}").map_err(|error| error.to_string())
    };
    for (row, line) in lines.iter().enumerate() {
        write_row(row, line)?;
    }
    // A shorter frame than the last one leaves stale rows behind unless the
    // extra rows are visited and cleared.
    for row in lines.len()..*rendered {
        write_row(row, "")?;
    }
    let painted = lines.len().max(*rendered);
    if painted > 1 {
        write!(out, "\x1b[{}A", painted - 1).map_err(|error| error.to_string())?;
    }
    write!(out, "\r").map_err(|error| error.to_string())?;
    *rendered = lines.len();
    out.flush().map_err(|error| error.to_string())
}

fn clear(out: &mut impl Write, rendered: usize) -> Result<()> {
    if rendered == 0 {
        return Ok(());
    }
    draw(out, &[], &mut rendered.clone())
}

struct PickerGuard;

impl PickerGuard {
    fn enter() -> Result<Self> {
        enable_raw_mode()
            .map_err(|error| format!("failed to enable raw terminal mode: {error}"))?;
        let _ = execute!(io::stdout(), cursor::Hide);
        Ok(Self)
    }
}

impl Drop for PickerGuard {
    fn drop(&mut self) {
        let _ = execute!(io::stdout(), cursor::Show);
        let _ = disable_raw_mode();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choices() -> Vec<Choice> {
        vec![
            Choice::new("qwen3.6:35b-mlx", "ollama"),
            Choice::new("gpt-oss:20b", "ollama"),
            Choice::new("llama3.2:3b", "ollama").current(true),
        ]
    }

    #[test]
    fn empty_query_keeps_every_choice_in_order() {
        assert_eq!(filter(&choices(), ""), vec![0, 1, 2]);
    }

    #[test]
    fn prefix_matches_outrank_substring_matches() {
        // "3" is a prefix of nothing and appears inside every name, so ranking
        // falls back to where it appears.
        assert_eq!(filter(&choices(), "llama"), vec![2]);
        assert_eq!(filter(&choices(), "gpt"), vec![1]);
    }

    #[test]
    fn subsequence_matches_rank_last() {
        // "qb" is a subsequence of qwen3.6:35b-mlx only.
        assert_eq!(filter(&choices(), "qb"), vec![0]);
        assert_eq!(score("gpt-oss:20b", "gpt"), Some(0));
        assert!(score("gpt-oss:20b", "gb") > score("gpt-oss:20b", "gpt"));
    }

    #[test]
    fn unmatched_query_selects_nothing() {
        assert!(filter(&choices(), "zzz").is_empty());
    }

    #[test]
    fn selection_wraps_at_both_ends() {
        assert_eq!(step(0, 3, -1), 2);
        assert_eq!(step(2, 3, 1), 0);
        assert_eq!(step(0, 0, 1), 0);
    }

    #[test]
    fn window_follows_the_selection_past_the_visible_rows() {
        assert_eq!(window_start(0, 20), 0);
        assert_eq!(window_start(VISIBLE_ROWS, 20), 1);
        assert_eq!(window_start(19, 20), 20 - VISIBLE_ROWS);
        assert_eq!(window_start(2, 3), 0);
    }

    #[test]
    fn frame_marks_the_selected_row_and_counts_matches() {
        let choices = choices();
        let visible = filter(&choices, "");
        let lines = frame("Select model", "", &choices, &visible, 1);
        assert!(lines[0].contains("Type to filter…"));
        assert!(lines[2].contains("▸"));
        assert!(lines[1].contains("qwen3.6:35b-mlx"));
        assert!(lines.last().unwrap().contains("2/3"));
    }

    #[test]
    fn frame_reports_an_empty_result_without_panicking() {
        let choices = choices();
        let lines = frame("Select model", "zzz", &choices, &[], 0);
        assert!(lines[1].contains("no match"));
    }

    #[test]
    fn draw_returns_the_cursor_to_the_first_row_of_the_block() {
        let mut out = Vec::new();
        let mut rendered = 0;
        let lines = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        draw(&mut out, &lines, &mut rendered).unwrap();
        let painted = String::from_utf8(out).unwrap();
        assert_eq!(painted.matches("\r\n").count(), 2);
        assert!(painted.ends_with("\x1b[2A\r"));
        assert_eq!(rendered, 3);
    }

    #[test]
    fn a_shorter_frame_clears_the_rows_the_taller_one_left_behind() {
        let mut out = Vec::new();
        let mut rendered = 3;
        draw(&mut out, &["only".to_string()], &mut rendered).unwrap();
        let painted = String::from_utf8(out).unwrap();
        // One content row plus two blanked rows, then back up to the top.
        assert_eq!(painted.matches("\x1b[2K").count(), 3);
        assert!(painted.ends_with("\x1b[2A\r"));
        assert_eq!(rendered, 1);
    }

    #[test]
    fn clear_blanks_every_rendered_row() {
        let mut out = Vec::new();
        clear(&mut out, 2).unwrap();
        let painted = String::from_utf8(out).unwrap();
        assert_eq!(painted.matches("\x1b[2K").count(), 2);
        assert!(painted.ends_with("\x1b[1A\r"));
    }

    #[test]
    fn clear_of_an_undrawn_picker_writes_nothing() {
        let mut out = Vec::new();
        clear(&mut out, 0).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn long_values_are_truncated_to_the_column_width() {
        assert_eq!(crate::text::clip("qwen3.6:35b-mlx", 8), "qwen3.6…");
        assert_eq!(crate::text::clip("short", 8), "short");
    }
}
