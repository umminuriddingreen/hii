//! Filesystem projection - presents objects as normal files

use crate::{index, store};
use std::fs;
use std::path::{Path, PathBuf};

/// Projection presents stored objects as a normal filesystem
pub struct Projection {
    base_path: PathBuf,
    workspace_path: PathBuf,
}

impl Projection {
    /// Create a new projection
    pub fn new<P: Into<PathBuf>>(base_path: P) -> Self {
        let base_path = base_path.into();
        let workspace_path = base_path.join("workspace");

        if !workspace_path.exists() {
            fs::create_dir_all(&workspace_path).expect("Failed to create workspace directory");
        }

        Self {
            base_path,
            workspace_path,
        }
    }

    /// Get the workspace path (where files appear)
    pub fn workspace_path(&self) -> &PathBuf {
        &self.workspace_path
    }

    /// Mount an object as a file
    pub fn mount_object<P: AsRef<Path>>(
        &self,
        object_id: &str,
        relative_path: P,
        _store: &store::Store,
    ) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
        let target_path = crate::paths::beneath(&self.workspace_path, relative_path.as_ref())?;

        // Ensure parent directory exists
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)?;
        }

        // Get file record from index
        let index = index::Index::open(&self.base_path)?;

        if let Some(record) = index.get_by_path(&target_path)? {
            if record.object_id != object_id {
                return Err("Requested object identity does not match the indexed file".into());
            }
            // Get chunks from store and reconstruct file
            let store = self.store_path();

            let reconstructed_size = store.reconstruct_file(&target_path, &record.chunks)?;

            eprintln!(
                "Mounted {} -> {} ({} bytes)",
                object_id,
                target_path.display(),
                reconstructed_size
            );

            Ok(target_path)
        } else {
            Err(format!("File not found in index: {}", target_path.display()).into())
        }
    }

    /// Get all mounted files
    pub fn list_mounted(&self) -> Result<Vec<PathBuf>, std::io::Error> {
        crate::paths::reject_link(&self.workspace_path)?;
        let mut files = Vec::new();

        if self.workspace_path.exists() {
            for entry in fs::read_dir(&self.workspace_path)? {
                let entry = entry?;
                let path = entry.path();
                crate::paths::reject_link(&path)?;

                if path.is_file() {
                    files.push(path);
                } else if path.is_dir() {
                    // Recursively get files in subdirectories
                    files.extend(self.list_recursive(&path)?);
                }
            }
        }

        Ok(files)
    }

    /// Recursively list files in a directory
    fn list_recursive(&self, dir: &PathBuf) -> Result<Vec<PathBuf>, std::io::Error> {
        let mut files = Vec::new();

        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            crate::paths::reject_link(&path)?;

            if path.is_file() {
                files.push(path);
            } else if path.is_dir() {
                files.extend(self.list_recursive(&path)?);
            }
        }

        Ok(files)
    }

    /// Check if a file exists in the workspace
    pub fn file_exists(&self, relative_path: &Path) -> bool {
        crate::paths::beneath(&self.workspace_path, relative_path).is_ok_and(|path| path.is_file())
    }

    /// Read a file from the workspace
    pub fn read<P: AsRef<Path>>(&self, relative_path: P) -> Result<Vec<u8>, std::io::Error> {
        let path = crate::paths::beneath(&self.workspace_path, relative_path.as_ref())?;
        fs::read(&path)
    }

    /// Write a file to the workspace (mark for sync)
    pub fn write<P: AsRef<Path>, C: AsRef<[u8]>>(
        &self,
        relative_path: P,
        content: C,
    ) -> Result<(), std::io::Error> {
        let path = crate::paths::beneath(&self.workspace_path, relative_path.as_ref())?;

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        fs::write(&path, content)?;

        Ok(())
    }

    /// Delete a file from the workspace (mark for sync)
    pub fn delete<P: AsRef<Path>>(&self, relative_path: P) -> Result<(), std::io::Error> {
        let path = crate::paths::beneath(&self.workspace_path, relative_path.as_ref())?;

        if path.exists() {
            fs::remove_file(&path)?;
        }

        Ok(())
    }

    /// Get the store path for the projection
    fn store_path(&self) -> store::Store {
        store::Store::new(&self.base_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_projection() {
        let temp_dir = tempfile::tempdir().unwrap();
        let projection_path = temp_dir.path().join("projection");

        let projection = Projection::new(&projection_path);

        // Write a file
        projection.write("test.txt", "Hello, HII Drive!").unwrap();

        // Read it back
        let content = projection.read("test.txt").unwrap();
        assert_eq!(content, b"Hello, HII Drive!");

        // Check file exists
        assert!(projection.file_exists(&PathBuf::from("test.txt")));

        // Delete it
        projection.delete("test.txt").unwrap();
        assert!(!projection.file_exists(&PathBuf::from("test.txt")));
    }

    #[test]
    fn rejects_paths_outside_workspace() {
        let root = tempfile::tempdir().unwrap();
        let projection = Projection::new(root.path());
        let absolute = root.path().join("outside");
        fs::write(&absolute, "preserved").unwrap();
        for path in [
            Path::new("../outside"),
            Path::new("nested/../../outside"),
            Path::new(""),
            Path::new("C:\\outside"),
            absolute.as_path(),
        ] {
            assert!(projection.write(path, "overwrite").is_err());
            assert!(projection.read(path).is_err());
            assert!(projection.delete(path).is_err());
            assert!(!projection.file_exists(path));
        }
        assert_eq!(fs::read_to_string(absolute).unwrap(), "preserved");
        projection.write("nested/inside", "allowed").unwrap();
        assert_eq!(projection.read("nested/inside").unwrap(), b"allowed");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_files_and_ancestors() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let projection = Projection::new(root.path());
        let victim = outside.path().join("private");
        fs::write(&victim, "preserved").unwrap();
        std::os::unix::fs::symlink(outside.path(), projection.workspace_path.join("link")).unwrap();
        for path in ["link/private", "link/new"] {
            assert!(projection.write(path, "overwrite").is_err());
            assert!(projection.read(path).is_err());
            assert!(projection.delete(path).is_err());
        }
        assert!(projection.list_mounted().is_err());
        assert_eq!(fs::read_to_string(victim).unwrap(), "preserved");
        assert!(!outside.path().join("new").exists());
    }
}
