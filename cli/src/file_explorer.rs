use std::{
    cmp::Ordering,
    fs,
    io::{self, IsTerminal, Write},
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
            KeyCode::Right | KeyCode::Enter | KeyCode::Char('l') => {
                self.open_selected()?;
                Ok(BrowserAction::Continue)
            }
            KeyCode::Char('a') => self
                .selected_path()
                .map(BrowserAction::Attach)
                .ok_or_else(|| "nothing selected".into()),
            KeyCode::Char('e') => {
                self.edit_selected()?;
                Ok(BrowserAction::Continue)
            }
            _ => Ok(BrowserAction::Continue),
        }
    }

    fn draw(&mut self) -> Result<()> {
        let (columns, rows) = terminal::size().map_err(|error| error.to_string())?;
        let height = usize::from(rows).saturating_sub(4).max(1);
        self.keep_selected_visible(height);
        let mut out = io::stdout();
        execute!(out, cursor::MoveTo(0, 0), terminal::Clear(ClearType::All))
            .map_err(|error| error.to_string())?;
        writeln!(out, "HII files  {}", self.cwd.display()).map_err(|error| error.to_string())?;
        writeln!(
            out,
            "j/k move  h parent  l/enter open  a attach  e vim  g/G top/bottom  q close"
        )
        .map_err(|error| error.to_string())?;
        let width = usize::from(columns).saturating_sub(4).max(16);
        for (row, entry) in self
            .entries
            .iter()
            .enumerate()
            .skip(self.scroll)
            .take(height)
        {
            let marker = if row == self.selected { ">" } else { " " };
            let suffix = if entry.is_dir { "/" } else { "" };
            let name = crate::text::clip(&format!("{}{}", entry.name, suffix), width);
            writeln!(out, "{marker} {name}").map_err(|error| error.to_string())?;
        }
        if self.entries.is_empty() {
            writeln!(out, "  empty directory").map_err(|error| error.to_string())?;
        }
        out.flush().map_err(|error| error.to_string())
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

    fn open_selected(&mut self) -> Result<()> {
        let Some(entry) = self.entries.get(self.selected) else {
            return Ok(());
        };
        if entry.is_dir {
            self.cwd = entry.path.clone();
            self.entries = read_entries(&self.cwd)?;
            self.selected = 0;
            self.scroll = 0;
        }
        Ok(())
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
        terminal::disable_raw_mode().map_err(|error| error.to_string())?;
        execute!(io::stdout(), cursor::Show).map_err(|error| error.to_string())?;
        let editor = std::env::var("EDITOR").unwrap_or_else(|_| "vim".into());
        let status = Command::new(editor)
            .arg(&path)
            .status()
            .map_err(|error| error.to_string());
        execute!(io::stdout(), cursor::Hide).map_err(|error| error.to_string())?;
        terminal::enable_raw_mode().map_err(|error| error.to_string())?;
        status?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
