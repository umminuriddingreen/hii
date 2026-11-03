//! HII Drive: User-owned distributed filesystem/object layer
//!
//! No third parties. Your computers become the cloud infrastructure.

pub mod index;
mod paths;
pub mod projection;
pub mod store;
pub mod sync;
pub mod watcher;

pub use index::Index;
pub use projection::Projection;
pub use store::Store;
pub use sync::SyncPeer;
pub use watcher::Watcher;

/// Drive configuration
#[derive(Debug, Clone)]
pub struct DriveConfig {
    pub base_path: std::path::PathBuf,
    pub replication_policy: ReplicationPolicy,
    pub sync_interval: std::time::Duration,
}

/// Replication policy for folders/objects
#[derive(Debug, Clone, Default)]
pub struct ReplicationPolicy {
    pub minimum_copies: u32,
    pub pinned_devices: std::collections::HashSet<String>,
}

impl DriveConfig {
    pub fn new<P: Into<std::path::PathBuf>>(base_path: P) -> Self {
        Self {
            base_path: base_path.into(),
            replication_policy: Default::default(),
            sync_interval: std::time::Duration::from_secs(5),
        }
    }
}

/// Error types for HII Drive
#[derive(Debug, thiserror::Error)]
pub enum DriveError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("Chunk hash mismatch: expected {expected}, got {actual}")]
    HashMismatch { expected: String, actual: String },

    #[error("Manifest not found: {0}")]
    ManifestNotFound(String),

    #[error("Device not authenticated: {0}")]
    DeviceUnauthorized(String),

    #[error("Chunk not available: {0}")]
    ChunkNotFound(String),
}

/// Result type for HII Drive
pub type DriveResult<T> = Result<T, DriveError>;
