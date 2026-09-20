//! Filesystem change detection

use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time;

/// Event types for filesystem changes
#[derive(Debug, Clone)]
pub enum WatchEvent {
    Created {
        path: PathBuf,
        size: u64,
    },
    Modified {
        path: PathBuf,
        size: u64,
        version: u32,
    },
    Deleted {
        path: PathBuf,
    },
    Moved {
        from: PathBuf,
        to: PathBuf,
    },
}

/// Watcher monitors a directory for changes
pub struct Watcher {
    base_path: PathBuf,
    sender: mpsc::Sender<WatchEvent>,
}

impl Watcher {
    /// Create a new watcher for the given path
    pub fn new<P: Into<PathBuf>>(base_path: P) -> Self {
        let base_path = base_path.into();
        let (sender, _receiver) = mpsc::channel(100);

        Self { base_path, sender }
    }

    /// Get the base path being watched
    pub fn base_path(&self) -> &PathBuf {
        &self.base_path
    }

    /// Start watching the filesystem (background task)
    pub async fn watch(self) {
        let mut interval = time::interval(Duration::from_secs(1));

        loop {
            interval.tick().await;

            if let Err(e) = self.scan_changes().await {
                eprintln!("Watch error: {e}");
            }
        }
    }

    /// Scan for filesystem changes
    async fn scan_changes(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // TODO: Implement change detection
        // Compare current state with last known state
        // Emit WatchEvent for changes
        let _ = &self.sender;

        Ok(())
    }

    /// Stop watching
    pub fn stop(self) {
        // Drop sender to signal shutdown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_watcher_creation() {
        let watcher = Watcher::new("/tmp/test");
        assert_eq!(watcher.base_path(), &PathBuf::from("/tmp/test"));
    }
}
