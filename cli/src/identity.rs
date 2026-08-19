use crate::config::AppPaths;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{DateTime, Local};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{Ed25519KeyPair, KeyPair},
};
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactCard {
    pub schema_version: u8,
    pub kind: String,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub public_key: String,
    pub issued_at: DateTime<Local>,
    pub signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnsignedContactCard<'a> {
    schema_version: u8,
    kind: &'static str,
    id: &'a str,
    name: &'a str,
    email: &'a Option<String>,
    public_key: &'a str,
    issued_at: DateTime<Local>,
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

    pub fn contact_card(&self) -> Result<ContactCard, String> {
        let identity = self.current()?.ok_or(
            "No local HII user yet. Run `hii login local --name <name>` before sharing a contact card.",
        )?;
        let key_path = self.path.with_file_name("contact-ed25519.pkcs8");
        let key_bytes = if key_path.is_file() {
            fs::read(&key_path).map_err(|error| error.to_string())?
        } else {
            let generated = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .map_err(|_| "could not generate the HII contact signing key")?;
            write_private_bytes(&key_path, generated.as_ref())?;
            generated.as_ref().to_vec()
        };
        let key_pair = Ed25519KeyPair::from_pkcs8(&key_bytes)
            .map_err(|_| "the local HII contact signing key is invalid")?;
        let public_key = BASE64.encode(key_pair.public_key().as_ref());
        let issued_at = Local::now();
        let unsigned = UnsignedContactCard {
            schema_version: 1,
            kind: "hii.contact-card/1",
            id: &identity.id,
            name: &identity.name,
            email: &identity.email,
            public_key: &public_key,
            issued_at,
        };
        let payload = serde_json::to_vec(&unsigned).map_err(|error| error.to_string())?;
        Ok(ContactCard {
            schema_version: 1,
            kind: "hii.contact-card/1".into(),
            id: identity.id,
            name: identity.name,
            email: identity.email,
            public_key,
            issued_at,
            signature: BASE64.encode(key_pair.sign(&payload).as_ref()),
        })
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

fn write_private_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, bytes).map_err(|error| error.to_string())?;
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

    #[test]
    fn contact_card_is_signed_by_its_declared_public_key() {
        use ring::signature::{UnparsedPublicKey, ED25519};

        let temp = TempDir::new("contact-card");
        let paths = AppPaths {
            repo: temp.0.join("repo"),
            runtime: temp.0.join("runtime"),
        };
        let store = IdentityStore::open(&paths);
        store.create_or_update("Ummi", None).unwrap();
        let card = store.contact_card().unwrap();
        let unsigned = UnsignedContactCard {
            schema_version: card.schema_version,
            kind: "hii.contact-card/1",
            id: &card.id,
            name: &card.name,
            email: &card.email,
            public_key: &card.public_key,
            issued_at: card.issued_at,
        };
        let payload = serde_json::to_vec(&unsigned).unwrap();
        UnparsedPublicKey::new(&ED25519, BASE64.decode(&card.public_key).unwrap())
            .verify(&payload, &BASE64.decode(&card.signature).unwrap())
            .unwrap();
        assert!(store.path.with_file_name("contact-ed25519.pkcs8").is_file());
    }
}
