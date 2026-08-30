use std::{
    cmp::Ordering,
    fs,
    io::{self, IsTerminal, Read, Write},
    path::{Path, PathBuf},
    process::Command,
};

use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEvent, KeyModifiers},
    execute,
    terminal::{self, ClearType},
};

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    path: PathBuf,
    name: String,
    is_dir: bool,
}

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> Result<Self> {
        terminal::enable_raw_mode().map_err(|error| error.to_string())?;
        execute!(io::stdout(), terminal::EnterAlternateScreen, cursor::Hide)
            .map_err(|error| error.to_string())?;
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(io::stdout(), cursor::Show, terminal::LeaveAlternateScreen);
        let _ = terminal::disable_raw_mode();
    }
}

pub fn browse(root: &Path) -> Result<Option<PathBuf>> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err("file explorer needs an interactive terminal".into());
    }
    let _guard = TerminalGuard::enter()?;
    let mut state = BrowserState::new(root)?;
    loop {
        state.draw()?;
        let Event::Key(key) = event::read().map_err(|error| error.to_string())? else {
            continue;
        };
        if key.kind != event::KeyEventKind::Press {
            continue;
        }
        match state.handle_key(key)? {
            BrowserAction::Continue => {}
            BrowserAction::Attach(path) => return Ok(Some(path)),
            BrowserAction::Quit => return Ok(None),
        }
    }
}

enum BrowserAction {
    Continue,
    Attach(PathBuf),
    Quit,
}

struct BrowserState {
    root: PathBuf,
    cwd: PathBuf,
    entries: Vec<Entry>,
    selected: usize,
    scroll: usize,
}

impl BrowserState {
    fn new(root: &Path) -> Result<Self> {
        let root = root.canonicalize().map_err(|error| error.to_string())?;
        let entries = read_entries(&root)?;
        Ok(Self {
            root: root.clone(),
            cwd: root,
            entries,
            selected: 0,
            scroll: 0,
        })
    }

    fn handle_key(&mut self, key: KeyEvent) -> Result<BrowserAction> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Char('q') | KeyCode::Esc => Ok(BrowserAction::Quit),
            KeyCode::Char('c') if ctrl => Ok(BrowserAction::Quit),
            KeyCode::Down | KeyCode::Char('j') => {
                self.move_selection(1);
                Ok(BrowserAction::Continue)
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.move_selection(-1);
                Ok(BrowserAction::Continue)
            }
            KeyCode::Char('g') => {
                self.selected = 0;
                self.scroll = 0;
                Ok(BrowserAction::Continue)
            }
            KeyCode::Char('G') => {
                self.selected = self.entries.len().saturating_sub(1);
                Ok(BrowserAction::Continue)
            }
            KeyCode::Left | KeyCode::Char('h') => {
                self.parent()?;
                Ok(BrowserAction::Continue)
            }
            KeyCode::Right | KeyCode::Enter | KeyCode::Char('l') => self.open_selected(),
            KeyCode::Char('a') => self.attach_selected(),
            KeyCode::Char('e') => {
                self.edit_selected()?;
                Ok(BrowserAction::Continue)
            }
            _ => Ok(BrowserAction::Continue),
        }
    }

    fn draw(&mut self) -> Result<()> {
        let (columns, rows) = terminal::size().map_err(|error| error.to_string())?;
        let height = usize::from(rows).saturating_sub(3).max(1);
        self.keep_selected_visible(height);
        let frame = self.render_frame(usize::from(columns), usize::from(rows))?;
        let mut out = io::stdout();
        execute!(out, cursor::MoveTo(0, 0), terminal::Clear(ClearType::All))
            .map_err(|error| error.to_string())?;
        write!(out, "{frame}").map_err(|error| error.to_string())?;
        out.flush().map_err(|error| error.to_string())
    }

    fn render_frame(&self, columns: usize, rows: usize) -> Result<String> {
        let width = columns.max(24);
        let height = rows.saturating_sub(3).max(1);
        let mut frame = String::new();
        frame.push_str(&crate::text::clip(&self.cwd.display().to_string(), width));
        frame.push('\n');
        frame.push_str(&crate::text::clip(
            "j/k move  h/l browse  enter attach  e edit  q close",
            width,
        ));
        frame.push('\n');

        if width < 60 {
            for line in self.current_lines(height, width) {
                frame.push_str(&line);
                frame.push('\n');
            }
            return Ok(frame);
        }

        let parent_width = width / 4;
        let current_width = width * 2 / 5;
        let preview_width = width.saturating_sub(parent_width + current_width + 6);
        let parent = self.parent_lines(height, parent_width)?;
        let current = self.current_lines(height, current_width);
        let preview = self.preview_lines(height, preview_width)?;
        for row in 0..height {
            frame.push_str(&pad(
                parent.get(row).map(String::as_str).unwrap_or(""),
                parent_width,
            ));
            frame.push_str(" | ");
            frame.push_str(&pad(
                current.get(row).map(String::as_str).unwrap_or(""),
                current_width,
            ));
            frame.push_str(" | ");
            frame.push_str(&crate::text::clip(
                preview.get(row).map(String::as_str).unwrap_or(""),
                preview_width,
            ));
            frame.push('\n');
        }
        Ok(frame)
    }

    fn current_lines(&self, height: usize, width: usize) -> Vec<String> {
        if self.entries.is_empty() {
            return vec!["  empty".into()];
        }
        self.entries
            .iter()
            .enumerate()
            .skip(self.scroll)
            .take(height)
            .map(|(row, entry)| {
                let marker = if row == self.selected { ">" } else { " " };
                let suffix = if entry.is_dir { "/" } else { "" };
                crate::text::clip(&format!("{marker} {}{suffix}", entry.name), width)
            })
            .collect()
    }

    fn parent_lines(&self, height: usize, width: usize) -> Result<Vec<String>> {
        let Some(parent) = self.cwd.parent() else {
            return Ok(Vec::new());
        };
        Ok(read_entries(parent)?
            .into_iter()
            .take(height)
            .map(|entry| {
                let marker = if entry.path == self.cwd { ">" } else { " " };
                let suffix = if entry.is_dir { "/" } else { "" };
                crate::text::clip(&format!("{marker} {}{suffix}", entry.name), width)
            })
            .collect())
    }

    fn preview_lines(&self, height: usize, width: usize) -> Result<Vec<String>> {
        let Some(entry) = self.entries.get(self.selected) else {
            return Ok(Vec::new());
        };
        if entry.is_dir {
            return Ok(read_entries(&entry.path)?
                .into_iter()
                .take(height)
                .map(|child| {
                    let suffix = if child.is_dir { "/" } else { "" };
                    crate::text::clip(&format!("  {}{suffix}", child.name), width)
                })
                .collect());
        }
        preview_file(&entry.path, height, width)
    }

    fn move_selection(&mut self, delta: isize) {
        if self.entries.is_empty() {
            self.selected = 0;
            return;
        }
        let last = self.entries.len() - 1;
        self.selected = if delta < 0 {
            self.selected.saturating_sub(delta.unsigned_abs())
        } else {
            (self.selected + delta as usize).min(last)
        };
    }

    fn keep_selected_visible(&mut self, height: usize) {
        if self.selected < self.scroll {
            self.scroll = self.selected;
        } else if self.selected >= self.scroll + height {
            self.scroll = self.selected.saturating_sub(height - 1);
        }
    }

    fn selected_path(&self) -> Option<PathBuf> {
        self.entries
            .get(self.selected)
            .map(|entry| entry.path.clone())
    }

    fn open_selected(&mut self) -> Result<BrowserAction> {
        let Some(entry) = self.entries.get(self.selected) else {
            return Ok(BrowserAction::Continue);
        };
        if entry.is_dir {
            self.cwd = entry.path.clone();
            self.entries = read_entries(&self.cwd)?;
            self.selected = 0;
            self.scroll = 0;
            Ok(BrowserAction::Continue)
        } else {
            Ok(BrowserAction::Attach(entry.path.clone()))
        }
    }

    fn attach_selected(&self) -> Result<BrowserAction> {
        let Some(entry) = self.entries.get(self.selected) else {
            return Err("nothing selected".into());
        };
        if entry.is_dir {
            return Ok(BrowserAction::Continue);
        }
        Ok(BrowserAction::Attach(entry.path.clone()))
    }

    fn parent(&mut self) -> Result<()> {
        if self.cwd == self.root {
            return Ok(());
        }
        let previous = self.cwd.clone();
        let Some(parent) = self.cwd.parent() else {
            return Ok(());
        };
        self.cwd = parent.to_path_buf();
        self.entries = read_entries(&self.cwd)?;
        self.selected = self
            .entries
            .iter()
            .position(|entry| entry.path == previous)
            .unwrap_or(0);
        self.scroll = 0;
        Ok(())
    }

    fn edit_selected(&mut self) -> Result<()> {
        let Some(path) = self.selected_path() else {
            return Ok(());
        };
        if path.is_dir() {
            return Ok(());
        }
        terminal::disable_raw_mode().map_err(|error| error.to_string())?;
        execute!(io::stdout(), cursor::Show).map_err(|error| error.to_string())?;
        let editor = std::env::var("EDITOR").unwrap_or_else(|_| "vim".into());
        let editor_result = Command::new(editor)
            .arg(&path)
            .status()
            .map_err(|error| error.to_string());
        let cursor_result = execute!(io::stdout(), cursor::Hide).map_err(|error| error.to_string());
        let raw_mode_result = terminal::enable_raw_mode().map_err(|error| error.to_string());
        editor_result?;
        cursor_result?;
        raw_mode_result?;
        self.entries = read_entries(&self.cwd)?;
        Ok(())
    }
}

fn read_entries(path: &Path) -> Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" || name == "target" || name == "node_modules" {
            continue;
        }
        entries.push(Entry {
            path: entry.path(),
            name,
            is_dir: file_type.is_dir(),
        });
    }
    entries.sort_by(compare_entries);
    Ok(entries)
}

fn compare_entries(left: &Entry, right: &Entry) -> Ordering {
    right
        .is_dir
        .cmp(&left.is_dir)
        .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        .then_with(|| left.name.cmp(&right.name))
}

fn pad(value: &str, width: usize) -> String {
    let clipped = crate::text::clip(value, width);
    format!("{clipped:<width$}")
}

fn preview_file(path: &Path, height: usize, width: usize) -> Result<Vec<String>> {
    const PREVIEW_BYTES: u64 = 16 * 1024;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(PREVIEW_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Ok(vec!["  binary file".into()]);
    };
    Ok(text
        .lines()
        .take(height)
        .map(|line| crate::text::clip(line, width))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEvent;
    use std::fs;

    #[test]
    fn entries_sort_directories_first_then_names() {
        let mut entries = [
            Entry {
                path: "z.txt".into(),
                name: "z.txt".into(),
                is_dir: false,
            },
            Entry {
                path: "app".into(),
                name: "app".into(),
                is_dir: true,
            },
            Entry {
                path: "Cargo.toml".into(),
                name: "Cargo.toml".into(),
                is_dir: false,
            },
        ];

        entries.sort_by(compare_entries);

        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["app", "Cargo.toml", "z.txt"]
        );
    }

    #[test]
    fn enter_opens_directories_and_attaches_files() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("folder")).unwrap();
        fs::write(temp.path().join("note.txt"), "hello").unwrap();
        let mut state = BrowserState::new(temp.path()).unwrap();
        let root = temp.path().canonicalize().unwrap();

        assert!(matches!(
            state.handle_key(KeyEvent::from(KeyCode::Enter)).unwrap(),
            BrowserAction::Continue
        ));
        assert_eq!(state.cwd, root.join("folder"));

        state.parent().unwrap();
        state.selected = 1;
        assert!(matches!(
            state.handle_key(KeyEvent::from(KeyCode::Enter)).unwrap(),
            BrowserAction::Attach(path) if path == root.join("note.txt")
        ));
    }

    #[test]
    fn attach_key_does_not_attach_directories() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("folder")).unwrap();
        let mut state = BrowserState::new(temp.path()).unwrap();

        assert!(matches!(
            state
                .handle_key(KeyEvent::from(KeyCode::Char('a')))
                .unwrap(),
            BrowserAction::Continue
        ));
    }

    #[test]
    fn wide_frame_has_parent_current_and_preview_panes() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("note.txt"), "first line\nsecond line").unwrap();
        let state = BrowserState::new(temp.path()).unwrap();

        let frame = state.render_frame(100, 12).unwrap();

        assert!(frame.contains(" | > note.txt"));
        assert!(frame.contains(" | first line"));
        assert_eq!(frame.lines().count(), 11);
    }

    #[test]
    fn narrow_frame_falls_back_to_the_current_directory() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("note.txt"), "hello").unwrap();
        let state = BrowserState::new(temp.path()).unwrap();

        let frame = state.render_frame(48, 8).unwrap();

        assert!(frame.contains("> note.txt"));
        assert!(!frame.contains(" | "));
    }
}
