use crate::config::AppPaths;
use chrono::{DateTime, Local};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LocalIdentity {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Local>,
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Local>,
}

pub struct IdentityStore {
    path: PathBuf,
}

impl IdentityStore {
    pub fn open(paths: &AppPaths) -> Self {
        Self {
            path: paths.runtime.join("identity/local-user.json"),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn current(&self) -> Result<Option<LocalIdentity>, String> {
        if !self.path.is_file() {
            return Ok(None);
        }
        let raw = fs::read_to_string(&self.path).map_err(|error| error.to_string())?;
        let identity = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        Ok(Some(identity))
    }

    pub fn create_or_update(
        &self,
        name: &str,
        email: Option<&str>,
    ) -> Result<LocalIdentity, String> {
        let name = name.trim();
        if name.chars().count() < 2 {
            return Err("local HII login needs a display name".into());
        }
        let now = Local::now();
        let existing = self.current()?;
        let identity = LocalIdentity {
            id: existing
                .as_ref()
                .map(|identity| identity.id.clone())
                .unwrap_or_else(new_identity_id),
            name: name.to_string(),
            email: email
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            created_at: existing
                .as_ref()
                .map(|identity| identity.created_at)
                .unwrap_or(now),
            updated_at: now,
        };
        write_private_json(&self.path, &identity)?;
        Ok(identity)
    }

    pub fn clear(&self) -> Result<bool, String> {
        if !self.path.exists() {
            return Ok(false);
        }
        fs::remove_file(&self.path).map_err(|error| error.to_string())?;
        Ok(true)
    }
}

fn new_identity_id() -> String {
    let rng = SystemRandom::new();
    let mut bytes = [0_u8; 16];
    rng.fill(&mut bytes).expect("system randomness");
    format!("hii-user-{}", hex(&bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join("")
}

fn write_private_json(path: &Path, identity: &LocalIdentity) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(identity).map_err(|error| error.to_string())?;
    fs::write(path, format!("{raw}\n")).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env,
        sync::atomic::{AtomicUsize, Ordering},
    };

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            static COUNT: AtomicUsize = AtomicUsize::new(0);
            let path = env::temp_dir().join(format!(
                "hii-identity-test-{}-{label}-{}",
                std::process::id(),
                COUNT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn local_identity_is_created_updated_and_cleared() {
        let temp = TempDir::new("roundtrip");
        let paths = AppPaths {
            repo: temp.0.join("repo"),
            runtime: temp.0.join("runtime"),
        };
        let store = IdentityStore::open(&paths);
        assert!(store.current().unwrap().is_none());

        let first = store.create_or_update("Ummi", None).unwrap();
        assert!(first.id.starts_with("hii-user-"));
        assert_eq!(first.name, "Ummi");

        let second = store
            .create_or_update("Ummi Nur", Some("ummi@example.test"))
            .unwrap();
        assert_eq!(second.id, first.id);
        assert_eq!(second.email.as_deref(), Some("ummi@example.test"));
        assert_eq!(store.current().unwrap().unwrap().name, "Ummi Nur");

        assert!(store.clear().unwrap());
        assert!(store.current().unwrap().is_none());
    }
}
