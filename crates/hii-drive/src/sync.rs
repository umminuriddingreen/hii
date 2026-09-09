//! Peer-to-peer synchronization protocol

use crate::{index, store};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::RwLock;

/// Sync messages exchanged between peers
#[derive(Debug, Serialize, Deserialize)]
pub enum SyncMessage {
    /// Device identification and capabilities
    Hello {
        device_id: String,
        device_name: String,
        capabilities: Vec<String>,
    },

    /// Current state of a device
    State { manifests: Vec<ManifestSummary> },

    /// "I have this manifest"
    ManifestHave { manifest_hash: String },

    /// "I need to sync from this manifest"
    ManifestWant { manifest_hash: String },

    /// "I have this chunk"
    ChunkHave { chunk_hash: String },

    /// "Request missing chunks"
    ChunkWant {
        object_id: String,
        missing_chunks: Vec<String>,
    },

    /// Chunk data payload
    ChunkData { chunk_hash: String, data: Vec<u8> },

    /// Commit a new version
    Commit {
        object_id: String,
        version: u32,
        manifest_hash: String,
    },

    /// Acknowledgment
    Ack { success: bool, message: String },
}

/// Manifest summary for state exchange
#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestSummary {
    pub object_id: String,
    pub manifest_hash: String,
    pub version: u32,
}

/// Sync peer for communication with other devices
pub struct SyncPeer {
    device_id: String,
    device_name: String,
    store: Arc<RwLock<store::Store>>,
    index_path: PathBuf,
}

impl SyncPeer {
    /// Create a new sync peer
    pub fn new(device_id: String, device_name: String) -> Self {
        let base_path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".hii")
            .join("drive");
        Self::with_base_path(device_id, device_name, base_path)
    }

    /// Create a new sync peer rooted at a specific local drive path.
    pub fn with_base_path<P: Into<PathBuf>>(
        device_id: String,
        device_name: String,
        base_path: P,
    ) -> Self {
        let base_path = base_path.into();
        Self {
            device_id,
            device_name,
            store: Arc::new(RwLock::new(store::Store::new(&base_path))),
            index_path: base_path,
        }
    }

    /// Start listening for incoming connections
    pub async fn listen(&self, port: u16) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let addr = format!("127.0.0.1:{port}");
        let listener = TcpListener::bind(&addr).await?;

        eprintln!("HII Drive listening on {}", addr);

        loop {
            let (socket, addr) = listener.accept().await?;
            let peer = self.clone();

            tokio::spawn(async move {
                if let Err(e) = peer.handle_connection(socket, addr).await {
                    eprintln!("Connection error: {}", e);
                }
            });
        }
    }

    /// Handle incoming connection
    async fn handle_connection(
        &self,
        _socket: tokio::net::TcpStream,
        _addr: std::net::SocketAddr,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // TODO: Implement connection handling
        // Exchange Hello messages
        // Synchronize state
        // Transfer missing chunks

        Ok(())
    }

    /// Connect to a remote peer
    pub async fn connect(
        &self,
        _remote_addr: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // TODO: Implement connection logic
        Ok(())
    }

    /// Synchronize with a remote peer
    pub async fn sync_with(
        &self,
        _remote_device_id: &str,
        _remote_manifests: Vec<ManifestSummary>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Compare manifests with remote
        // Request missing chunks
        // Update local state

        Ok(())
    }

    /// Broadcast a new file to all connected peers
    pub async fn broadcast_file(
        &self,
        file_path: &Path,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Chunk and store file
        let mut store_write = self.store.write().await;
        let (chunks, size) = store_write.chunk_file(file_path)?;

        // Create file record
        let record = index::FileRecord {
            object_id: uuid::Uuid::new_v4().to_string(),
            path: file_path.to_path_buf(),
            version: 1,
            size,
            modified_by: self.device_id.clone(),
            modified_at: chrono::Utc::now(),
            chunks,
        };

        drop(store_write);

        // Log to index
        let index = index::Index::open(&self.index_path)?;
        index.add_file_record(&record)?;
        index.log_sync_event(
            &record.object_id,
            "artifact.created",
            &serde_json::json!({ "path": file_path.to_string_lossy() }),
        )?;

        Ok(())
    }

    /// Clone for async operations
    fn clone(&self) -> Self {
        Self {
            device_id: self.device_id.clone(),
            device_name: self.device_name.clone(),
            store: self.store.clone(),
            index_path: self.index_path.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_peer_creation() {
        let peer = SyncPeer::new("test-device".to_string(), "Test Device".to_string());
        assert_eq!(peer.device_id, "test-device");
    }
}
