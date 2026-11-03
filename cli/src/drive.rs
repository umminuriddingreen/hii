//! HII Drive CLI interface

use hii_drive::{DriveConfig, Projection};
use std::path::PathBuf;

type Result<T> = std::result::Result<T, String>;

/// Initialize HII Drive
pub fn drive_init<P: Into<PathBuf>>(path: P) -> Result<()> {
    let base_path = path.into();

    // Create HII Drive structure
    let _config = DriveConfig::new(&base_path);

    let projection = Projection::new(&base_path);

    println!("HII Drive initialized at: {}", base_path.display());
    println!("Workspace available at: {}", projection.workspace_path().display());

    Ok(())
}

/// List synced files
pub fn drive_ls<P: Into<PathBuf>>(path: P) -> Result<()> {
    let base_path = path.into();
    let projection = Projection::new(&base_path);

    let files = projection
        .list_mounted()
        .map_err(|e| format!("Failed to list files: {}", e))?;

    if files.is_empty() {
        println!("No files synced yet.");
    } else {
        for file in files {
            println!("{}", file.display());
        }
    }

    Ok(())
}

/// Show sync status
pub fn drive_status<P: Into<PathBuf>>(path: P) -> Result<()> {
    let base_path = path.into();

    // TODO: Connect to index and show sync status
    println!("HII Drive status at: {}", base_path.display());
    println!("Status: ready (no peer connections yet)");

    Ok(())
}

/// Add replication policy for a folder
pub fn drive_pin<P: Into<PathBuf>>(path: P, device_id: String) -> Result<()> {
    let base_path = path.into();

    // TODO: Implement pinning logic
    println!("Pinning {} to device {}:", base_path.display(), device_id);
    println!("Replication policy will be applied");

    Ok(())
}

/// Sync with a remote peer
pub async fn drive_sync<P: Into<PathBuf>>(path: P, peer_addr: String) -> Result<()> {
    let base_path = path.into();

    // TODO: Connect to peer and sync
    println!("Syncing with {} from {}", peer_addr, base_path.display());

    Ok(())
}
