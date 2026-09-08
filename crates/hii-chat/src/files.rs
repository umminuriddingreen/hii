// SPDX-License-Identifier: LicenseRef-BSL-1.1
use anyhow::{Context, Result};
use fs2::FileExt;
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
};

pub struct AppFiles {
    pub root: PathBuf,
    database: PathBuf,
    _lock: File,
}

impl AppFiles {
    pub fn acquire(root: &Path) -> Result<Self> {
        Self::acquire_database(root, &root.join("hii.db"))
    }

    pub fn acquire_database(root: &Path, database: &Path) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        // Runtime roots can differ while HII_DB_PATH points both owners at one database.
        let canonical_database = if database.exists() {
            std::fs::canonicalize(database)?
        } else {
            let parent = database
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            std::fs::create_dir_all(parent)?;
            std::fs::canonicalize(parent)?.join(
                database
                    .file_name()
                    .context("Database path needs a filename")?,
            )
        };
        let mut lock_path = canonical_database.into_os_string();
        lock_path.push(".chat-owner.lockfile");
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(PathBuf::from(lock_path))?;
        lock.try_lock_exclusive()
            .context("HII Chat is already using this database")?;
        Ok(Self {
            root: root.to_owned(),
            database: database.to_owned(),
            _lock: lock,
        })
    }

    pub fn database(&self) -> PathBuf {
        self.database.clone()
    }

    pub fn runtime_log(&self) -> Result<File> {
        let logs = self.root.join("logs");
        std::fs::create_dir_all(&logs)?;
        Ok(OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(logs.join(format!("llama-{}.log", crate::model::id())))?)
    }
}
