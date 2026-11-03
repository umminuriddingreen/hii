//! Content-addressed chunk storage

use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;

/// Store manages content-addressed chunks
pub struct Store {
    base_path: PathBuf,
    chunk_size: u64,
}

impl Store {
    /// Create a new chunk store
    pub fn new<P: Into<PathBuf>>(base_path: P) -> Self {
        let base_path = base_path.into();
        let objects_path = base_path.join("objects");

        if !objects_path.exists() {
            fs::create_dir_all(&objects_path).expect("Failed to create objects directory");
        }

        Self {
            base_path,
            chunk_size: 1024 * 1024, // 1MB chunks
        }
    }

    /// Store a chunk and return its hash
    pub fn store_chunk(
        &mut self,
        data: &[u8],
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        use sha2::{Digest, Sha256};

        let hash = hex::encode(Sha256::digest(data)).to_string();

        let path = self.object_path(&hash)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        // Publish complete bytes atomically, including when repairing a chunk.
        let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        file.write_all(data)?;
        file.as_file().sync_all()?;
        file.persist(&path)?;

        Ok(hash)
    }

    /// Retrieve a chunk by its hash
    pub fn get_chunk(
        &self,
        hash: &str,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
        let path = self.object_path(hash)?;

        if !path.exists() {
            return Err(format!("Chunk not found: {}", hash).into());
        }

        let mut file = fs::File::open(&path)?;
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;

        use sha2::{Digest, Sha256};
        let actual = hex::encode(Sha256::digest(&data));
        if actual != hash {
            return Err(crate::DriveError::HashMismatch {
                expected: hash.into(),
                actual,
            }
            .into());
        }

        Ok(data)
    }

    /// Check if a chunk exists
    pub fn chunk_exists(&self, hash: &str) -> bool {
        self.object_path(hash).is_ok_and(|path| path.is_file())
    }

    /// Chunk a file and store all chunks
    pub fn chunk_file<P: Into<PathBuf>>(
        &mut self,
        file_path: P,
    ) -> Result<(Vec<String>, u64), Box<dyn std::error::Error + Send + Sync>> {
        use sha2::{Digest, Sha256};

        let file_path = file_path.into();
        let mut file = fs::File::open(&file_path)?;
        let file_size = file.metadata()?.len();

        let mut chunks = Vec::new();
        let mut buffer = vec![0u8; self.chunk_size as usize];
        loop {
            let bytes_read = file.read(&mut buffer)?;
            if bytes_read == 0 {
                break;
            }

            let chunk_hash = hex::encode(Sha256::digest(&buffer[..bytes_read])).to_string();

            // Write chunk to store
            let chunk_data = buffer[..bytes_read].to_vec();
            self.store_chunk(&chunk_data)?;

            chunks.push(chunk_hash);
        }

        Ok((chunks, file_size))
    }

    /// Reconstruct a file from its chunks
    pub fn reconstruct_file<P: Into<PathBuf>>(
        &self,
        output_path: P,
        chunks: &[String],
    ) -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
        let output_path = output_path.into();

        // Ensure output directory exists
        if let Some(parent) = output_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)?;
        }

        crate::paths::reject_link(&output_path)?;
        let parent = output_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| std::path::Path::new("."));
        let mut output = tempfile::NamedTempFile::new_in(parent)?;
        let mut total_size = 0u64;

        for chunk_hash in chunks {
            let chunk_data = self.get_chunk(chunk_hash)?;
            total_size += chunk_data.len() as u64;
            output.write_all(&chunk_data)?;
        }

        output.as_file().sync_all()?;
        output.persist(&output_path)?;

        Ok(total_size)
    }

    /// Delete a chunk
    pub fn delete_chunk(&self, hash: &str) -> Result<(), std::io::Error> {
        let path = self.object_path(hash)?;
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }

    /// Get the path to an object file
    fn object_path(&self, hash: &str) -> Result<PathBuf, std::io::Error> {
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Expected a lowercase SHA-256 chunk identifier",
            ));
        }
        let prefix = &hash[0..2];
        crate::paths::beneath(
            &self.base_path.join("objects"),
            &PathBuf::from(prefix).join(&hash[2..]),
        )
    }

    /// Verify a chunk's hash
    pub fn verify_chunk(
        &self,
        hash: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        if !self.chunk_exists(hash) {
            return Ok(false);
        }

        let data = self.get_chunk(hash)?;

        use sha2::{Digest, Sha256};
        let actual_hash = hex::encode(Sha256::digest(&data)).to_string();

        Ok(actual_hash == hash)
    }

    /// Count stored chunks
    pub fn chunk_count(&self) -> Result<u64, std::io::Error> {
        let objects_path = self.base_path.join("objects");

        if !objects_path.exists() {
            return Ok(0);
        }

        let mut count = 0u64;
        for entry in fs::read_dir(&objects_path)? {
            let entry = entry?;
            if entry.path().is_dir() {
                count += fs::read_dir(entry.path())?.count() as u64;
            }
        }

        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_chunk_store() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store_path = temp_dir.path().join("store");

        let mut store = Store::new(&store_path);
        let data = b"Hello, HII Drive!";

        let hash = store.store_chunk(data).unwrap();
        assert_eq!(hash.len(), 64);

        let retrieved = store.get_chunk(&hash).unwrap();
        assert_eq!(retrieved, data);
    }

    #[test]
    fn invalid_chunk_identifiers_never_touch_paths_or_panic() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::new(root.path());
        for hash in [
            "",
            "a",
            "é",
            "../../outside",
            &"G".repeat(64),
            &"a".repeat(63),
        ] {
            assert!(store.get_chunk(hash).is_err());
            assert!(store.delete_chunk(hash).is_err());
            assert!(!store.chunk_exists(hash));
        }
    }

    #[test]
    fn reconstruction_preserves_destination_on_missing_or_corrupt_chunk() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::new(root.path());
        let hash = store.store_chunk(b"valid").unwrap();
        let destination = root.path().join("result");
        fs::write(&destination, b"keep me").unwrap();
        assert!(store
            .reconstruct_file(&destination, &[hash.clone(), "a".repeat(64)])
            .is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"keep me");
        fs::write(store.object_path(&hash).unwrap(), b"corrupt").unwrap();
        assert!(store
            .get_chunk(&hash)
            .unwrap_err()
            .to_string()
            .contains("hash mismatch"));
        assert!(store
            .reconstruct_file(&destination, std::slice::from_ref(&hash))
            .is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"keep me");
        assert_eq!(
            fs::read_dir(root.path()).unwrap().count(),
            2,
            "temporary output must be cleaned up"
        );
        store.store_chunk(b"valid").unwrap();
        store.reconstruct_file(&destination, &[hash]).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"valid");
    }

    #[cfg(unix)]
    #[test]
    fn chunks_cannot_follow_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let mut store = Store::new(root.path());
        let hash = store.store_chunk(b"valid").unwrap();
        let chunk = store.object_path(&hash).unwrap();
        fs::remove_file(&chunk).unwrap();
        let victim = outside.path().join("private");
        fs::write(&victim, b"keep me").unwrap();
        std::os::unix::fs::symlink(&victim, &chunk).unwrap();
        assert!(store.get_chunk(&hash).is_err());
        assert!(store.delete_chunk(&hash).is_err());
        assert!(store.store_chunk(b"valid").is_err());
        assert_eq!(fs::read(victim).unwrap(), b"keep me");
    }

    #[test]
    fn test_file_chunking() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store_path = temp_dir.path().join("store");

        let mut store = Store::new(&store_path);

        let test_file = temp_dir.path().join("test.txt");
        fs::write(&test_file, "Test data for chunking").unwrap();

        let (chunks, size) = store.chunk_file(&test_file).unwrap();

        assert!(size > 0);
        assert!(!chunks.is_empty());

        // Reconstruct the file
        let reconstructed = temp_dir.path().join("reconstructed.txt");
        let reconstructed_size = store.reconstruct_file(&reconstructed, &chunks).unwrap();

        assert_eq!(size, reconstructed_size);

        let reconstructed_content = fs::read_to_string(&reconstructed).unwrap();
        let original_content = fs::read_to_string(&test_file).unwrap();
        assert_eq!(reconstructed_content, original_content);
    }
}
