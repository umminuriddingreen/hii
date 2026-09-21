use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const CONFIG_VERSION: u8 = 1;
const ACTIONS: &[&str] = &[
    "queue",
    "interrupt",
    "background",
    "tasks",
    "menu_up",
    "menu_down",
    "history_up",
    "history_down",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyAction {
    Queue,
    Interrupt,
    Background,
    Tasks,
    MenuUp,
    MenuDown,
    HistoryUp,
    HistoryDown,
}

impl KeyAction {
    fn name(self) -> &'static str {
        match self {
            Self::Queue => "queue",
            Self::Interrupt => "interrupt",
            Self::Background => "background",
            Self::Tasks => "tasks",
            Self::MenuUp => "menu_up",
            Self::MenuDown => "menu_down",
            Self::HistoryUp => "history_up",
            Self::HistoryDown => "history_down",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeymapFile {
    version: u8,
    profile: String,
    bindings: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct Keymap {
    path: PathBuf,
    file: KeymapFile,
}

impl Default for Keymap {
    fn default() -> Self {
        Self {
            path: PathBuf::new(),
            file: profile("default").expect("built-in default keymap"),
        }
    }
}

impl Keymap {
    pub fn load(runtime: &Path) -> Result<Self, String> {
        let path = runtime.join("config").join("keybindings.json");
        if !path.exists() {
            return Ok(Self {
                path,
                file: profile("default")?,
            });
        }
        validate_config_file(&path)?;
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        let file: KeymapFile = serde_json::from_slice(&bytes)
            .map_err(|error| format!("invalid HII keymap: {error}"))?;
        validate_file(&file)?;
        Ok(Self { path, file })
    }

    pub fn matches(&self, action: KeyAction, key: KeyEvent) -> bool {
        self.file
            .bindings
            .get(action.name())
            .is_some_and(|binding| chord(key).as_deref() == Some(binding.as_str()))
    }

    pub fn command(&mut self, requested: Option<&str>) -> Result<String, String> {
        let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(self.render());
        };
        let parts = requested.split_whitespace().collect::<Vec<_>>();
        match parts.as_slice() {
            ["default"] | ["vim"] => {
                self.file = profile(parts[0])?;
                self.persist()?;
            }
            ["reset"] => {
                self.file = profile("default")?;
                self.persist()?;
            }
            ["bind", action, key] => {
                if !ACTIONS.contains(action) {
                    return Err(format!("unknown key action: {action}"));
                }
                validate_chord(key)?;
                let mut next = self.file.clone();
                next.bindings.insert((*action).into(), normalize_chord(key));
                next.profile = "custom".into();
                validate_file(&next)?;
                self.file = next;
                self.persist()?;
            }
            _ => return Err("usage: /keymap [default|vim|reset|bind <action> <chord>]".into()),
        }
        Ok(self.render())
    }

    pub fn render(&self) -> String {
        let rows = ACTIONS
            .iter()
            .filter_map(|action| {
                self.file
                    .bindings
                    .get(*action)
                    .map(|key| format!("  {action:<12} {key}"))
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "KEYMAP  {}\n{}\n\nProfiles: default | vim\nCustomize: /keymap bind <action> <chord>\nIdle: Esc opens HII work · Ctrl+C exits\nRunning: Esc stops · Enter steers",
            self.file.profile, rows
        )
    }

    pub fn profile_name(&self) -> &str {
        &self.file.profile
    }

    fn persist(&self) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "keymap config has no parent directory".to_string())?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        crate::store::set_directory_mode(parent)?;
        if self.path.exists() {
            validate_config_file(&self.path)?;
        }
        let temporary = parent.join(format!(
            ".keybindings-{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let bytes = serde_json::to_vec_pretty(&self.file).map_err(|error| error.to_string())?;
        write_private(&temporary, &bytes)?;
        fs::rename(&temporary, &self.path).map_err(|error| error.to_string())
    }
}

fn profile(name: &str) -> Result<KeymapFile, String> {
    let bindings = match name {
        "default" => [
            ("queue", "shift+tab"),
            ("interrupt", "escape"),
            ("background", "ctrl+b"),
            ("tasks", "ctrl+t"),
            ("menu_up", "up"),
            ("menu_down", "down"),
            ("history_up", "up"),
            ("history_down", "down"),
        ],
        "vim" => [
            ("queue", "shift+tab"),
            ("interrupt", "escape"),
            ("background", "ctrl+b"),
            ("tasks", "ctrl+t"),
            ("menu_up", "alt+k"),
            ("menu_down", "alt+j"),
            ("history_up", "ctrl+p"),
            ("history_down", "ctrl+n"),
        ],
        _ => return Err("keymap profile must be default or vim".into()),
    };
    Ok(KeymapFile {
        version: CONFIG_VERSION,
        profile: name.into(),
        bindings: bindings
            .into_iter()
            .map(|(action, key)| (action.into(), key.into()))
            .collect(),
    })
}

fn validate_file(file: &KeymapFile) -> Result<(), String> {
    if file.version != CONFIG_VERSION {
        return Err(format!(
            "unsupported keymap version {}; expected {CONFIG_VERSION}",
            file.version
        ));
    }
    for action in ACTIONS {
        let binding = file
            .bindings
            .get(*action)
            .ok_or_else(|| format!("keymap is missing {action}"))?;
        validate_chord(binding)?;
    }
    if file
        .bindings
        .keys()
        .any(|action| !ACTIONS.contains(&action.as_str()))
    {
        return Err("keymap contains an unknown action".into());
    }
    let controls = ["queue", "interrupt", "background", "tasks"];
    for (index, action) in controls.iter().enumerate() {
        let chord = &file.bindings[*action];
        if controls[index + 1..]
            .iter()
            .any(|other| file.bindings[*other] == *chord)
        {
            return Err(format!("conflicting key binding: {chord}"));
        }
    }
    Ok(())
}

fn validate_chord(value: &str) -> Result<(), String> {
    let value = normalize_chord(value);
    let allowed_named = matches!(
        value.as_str(),
        "tab" | "shift+tab" | "escape" | "up" | "down" | "left" | "right" | "home" | "end"
    );
    let allowed_modified = value
        .strip_prefix("ctrl+")
        .or_else(|| value.strip_prefix("alt+"))
        .is_some_and(|key| {
            key.len() == 1 && key.chars().all(|character| character.is_ascii_alphabetic())
        });
    if allowed_named || allowed_modified {
        Ok(())
    } else {
        Err("key chord must be Tab, Shift+Tab, Escape, an arrow, Home/End, Ctrl+letter, or Alt+letter".into())
    }
}

fn normalize_chord(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace(' ', "")
}

fn chord(key: KeyEvent) -> Option<String> {
    if key.code == KeyCode::BackTab
        || (key.code == KeyCode::Tab && key.modifiers.contains(KeyModifiers::SHIFT))
    {
        return Some("shift+tab".into());
    }
    let prefix = if key.modifiers.contains(KeyModifiers::CONTROL) {
        "ctrl+"
    } else if key.modifiers.contains(KeyModifiers::ALT) {
        "alt+"
    } else {
        ""
    };
    let key = match key.code {
        KeyCode::Char(character) if !prefix.is_empty() => {
            character.to_ascii_lowercase().to_string()
        }
        KeyCode::Tab => "tab".into(),
        KeyCode::Esc => "escape".into(),
        KeyCode::Up => "up".into(),
        KeyCode::Down => "down".into(),
        KeyCode::Left => "left".into(),
        KeyCode::Right => "right".into(),
        KeyCode::Home => "home".into(),
        KeyCode::End => "end".into(),
        _ => return None,
    };
    Some(format!("{prefix}{key}"))
}

fn validate_config_file(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("HII keymap config may not be a symlink".into());
    }
    if !metadata.is_file() {
        return Err("HII keymap config must be a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err("HII keymap config must be owned by the current user".into());
        }
        if metadata.mode() & 0o022 != 0 {
            return Err("HII keymap config may not be group- or world-writable".into());
        }
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    fn runtime() -> PathBuf {
        let path = std::env::temp_dir().join(format!("hii-keymap-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn vim_profile_adds_navigation_without_removing_recovery_keys() {
        let root = runtime();
        let mut map = Keymap::load(&root).unwrap();
        map.command(Some("vim")).unwrap();
        assert!(map.matches(
            KeyAction::MenuDown,
            KeyEvent::new(KeyCode::Char('j'), KeyModifiers::ALT)
        ));
        assert_eq!(map.profile_name(), "vim");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn custom_bindings_persist_and_conflicts_fail() {
        let root = runtime();
        let mut map = Keymap::load(&root).unwrap();
        map.command(Some("bind background ctrl+g")).unwrap();
        let loaded = Keymap::load(&root).unwrap();
        assert!(loaded.matches(
            KeyAction::Background,
            KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL)
        ));
        assert!(map.command(Some("bind tasks ctrl+g")).is_err());
        assert!(map.matches(
            KeyAction::Tasks,
            KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL)
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn symlinked_config_is_rejected() {
        let root = runtime();
        let config = root.join("config");
        fs::create_dir_all(&config).unwrap();
        let outside = root.join("outside.json");
        fs::write(
            &outside,
            serde_json::to_vec(&profile("default").unwrap()).unwrap(),
        )
        .unwrap();
        symlink(&outside, config.join("keybindings.json")).unwrap();
        assert!(Keymap::load(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
