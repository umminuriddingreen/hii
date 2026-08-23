use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use fs2::FileExt;
use rand::{distributions::Alphanumeric, Rng};
use thiserror::Error;

use crate::{IdentityAuthority, IdentityConfig, IdentityError, TrustLedger};

const MAX_LEDGER_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct LedgerStore {
    path: PathBuf,
    lock_path: PathBuf,
}

impl LedgerStore {
    pub fn new(path: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let path = path.into();
        let parent = path.parent().ok_or(StoreError::InvalidPath)?;
        if parent.exists() {
            ensure_secure_directory(parent)?;
        } else {
            fs::create_dir_all(parent)?;
            restrict_new_directory(parent)?;
        }
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(StoreError::InvalidPath)?;
        let lock_path = parent.join(format!(".{file_name}.lock"));
        Ok(Self { path, lock_path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn exists(&self) -> bool {
        self.path.is_file()
    }

    pub fn load(&self) -> Result<TrustLedger, StoreError> {
        self.with_lock(|| self.load_unlocked())
    }

    pub fn load_authority(&self, config: IdentityConfig) -> Result<IdentityAuthority, StoreError> {
        Ok(IdentityAuthority::from_ledger(config, self.load()?)?)
    }

    pub fn create(&self, ledger: &TrustLedger) -> Result<(), StoreError> {
        self.with_lock(|| {
            if self.path.exists() {
                return Err(StoreError::AlreadyExists);
            }
            self.write_unlocked(ledger)
        })
    }

    pub fn save(&self, ledger: &TrustLedger) -> Result<(), StoreError> {
        self.with_lock(|| {
            if !self.path.exists() {
                return Err(StoreError::NotFound);
            }
            self.write_unlocked(ledger)
        })
    }

    pub fn save_if_revision(
        &self,
        ledger: &TrustLedger,
        expected_revision: u64,
    ) -> Result<(), StoreError> {
        self.with_lock(|| {
            let current = self.load_unlocked()?;
            if current.revision != expected_revision {
                return Err(StoreError::ConcurrentModification);
            }
            self.write_unlocked(ledger)
        })
    }

    fn load_unlocked(&self) -> Result<TrustLedger, StoreError> {
        reject_symlink(&self.path)?;
        let metadata = fs::metadata(&self.path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                StoreError::NotFound
            } else {
                StoreError::Io(error)
            }
        })?;
        ensure_owner_only(&metadata)?;
        if metadata.len() > MAX_LEDGER_BYTES {
            return Err(StoreError::BoundExceeded);
        }
        let file = File::open(&self.path)?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_LEDGER_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_LEDGER_BYTES {
            return Err(StoreError::BoundExceeded);
        }
        Ok(serde_json::from_slice(&bytes)?)
    }

    fn write_unlocked(&self, ledger: &TrustLedger) -> Result<(), StoreError> {
        let bytes = serde_json::to_vec(ledger)?;
        if bytes.len() as u64 > MAX_LEDGER_BYTES {
            return Err(StoreError::BoundExceeded);
        }
        let parent = self.path.parent().ok_or(StoreError::InvalidPath)?;
        let suffix: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(16)
            .map(char::from)
            .collect();
        let temporary = parent.join(format!(".identity-{suffix}.tmp"));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            set_create_mode(&mut options, 0o600);
            let mut file = options.open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, &self.path)?;
            ensure_owner_only(&fs::metadata(&self.path)?)?;
            File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn with_lock<T>(
        &self,
        operation: impl FnOnce() -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        reject_symlink(&self.lock_path)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        set_create_mode(&mut options, 0o600);
        let lock = options.open(&self.lock_path)?;
        ensure_owner_only(&fs::metadata(&self.lock_path)?)?;
        lock.lock_exclusive()?;
        let result = operation();
        let unlock_result = FileExt::unlock(&lock);
        match (result, unlock_result) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(StoreError::Io(error)),
        }
    }
}

#[cfg(unix)]
fn restrict_new_directory(path: &Path) -> Result<(), StoreError> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)?.permissions();
    if permissions.mode() & 0o077 != 0 {
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn restrict_new_directory(_path: &Path) -> Result<(), StoreError> {
    Ok(())
}

fn ensure_secure_directory(path: &Path) -> Result<(), StoreError> {
    reject_symlink(path)?;
    let metadata = fs::metadata(path)?;
    if !metadata.is_dir() {
        return Err(StoreError::InvalidPath);
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), StoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(StoreError::SymlinkDenied),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(StoreError::Io(error)),
    }
}

#[cfg(unix)]
fn ensure_owner_only(metadata: &fs::Metadata) -> Result<(), StoreError> {
    use std::os::unix::fs::PermissionsExt;
    if metadata.permissions().mode() & 0o077 == 0 {
        Ok(())
    } else {
        Err(StoreError::InsecurePermissions)
    }
}

#[cfg(not(unix))]
fn ensure_owner_only(_metadata: &fs::Metadata) -> Result<(), StoreError> {
    Ok(())
}

#[cfg(unix)]
fn set_create_mode(options: &mut OpenOptions, mode: u32) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(mode);
}

#[cfg(not(unix))]
fn set_create_mode(_options: &mut OpenOptions, _mode: u32) {}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("identity ledger path is invalid")]
    InvalidPath,
    #[error("identity ledger already exists")]
    AlreadyExists,
    #[error("identity ledger does not exist")]
    NotFound,
    #[error("identity ledger exceeds its size bound")]
    BoundExceeded,
    #[error("identity ledger permissions are not owner-only")]
    InsecurePermissions,
    #[error("identity ledger changed in another process")]
    ConcurrentModification,
    #[error("symbolic links are not accepted for identity storage")]
    SymlinkDenied,
    #[error("identity ledger I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("identity ledger serialization failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("identity ledger validation failed: {0}")]
    Identity(#[from] IdentityError),
}
