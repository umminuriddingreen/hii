//! Validated, workspace-scoped storage for images returned by web tools.
use image::{ImageFormat, ImageReader};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_DIMENSION: u32 = 16_384;
const MAX_ALLOC: u64 = 64 * 1024 * 1024;

/// Validate and atomically save a downloaded raster image and its provenance.
///
/// The returned receipt contains workspace-relative paths, digest, format, and
/// dimensions. Image bytes are never encoded into the receipt.
pub fn save_web_image(
    workspace: &Path,
    source_url: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<String, String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(format!("image must be between 1 and {MAX_BYTES} bytes"));
    }
    if source_url.is_empty() || source_url.len() > 8192 {
        return Err("source URL must be between 1 and 8192 bytes".into());
    }

    let (format, extension, canonical_mime) = match mime.split(';').next().unwrap_or("").trim() {
        "image/png" => (ImageFormat::Png, "png", "image/png"),
        "image/jpeg" => (ImageFormat::Jpeg, "jpg", "image/jpeg"),
        "image/webp" => (ImageFormat::WebP, "webp", "image/webp"),
        "image/gif" => (ImageFormat::Gif, "gif", "image/gif"),
        _ => return Err("unsupported image MIME type".into()),
    };

    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "image format could not be detected".to_string())?;
    if reader.format() != Some(format) {
        return Err("image bytes do not match the declared MIME type".into());
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "image dimensions could not be decoded".to_string())?;
    if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(format!(
            "image dimensions exceed the {MAX_DIMENSION}px limit"
        ));
    }

    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_ALLOC);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| "image failed raster validation within configured limits".to_string())?;

    let workspace = workspace
        .canonicalize()
        .map_err(|error| format!("workspace is unavailable: {error}"))?;
    let store = workspace.join(".hii").join("web-images");
    ensure_directory(&workspace, &workspace.join(".hii"))?;
    ensure_directory(&workspace, &store)?;

    let digest = format!("{:x}", Sha256::digest(bytes));
    let image_name = format!("{digest}.{extension}");
    let image_path = store.join(&image_name);
    let provenance_path = store.join(format!("{digest}.json"));
    if let Some(metadata) = existing_regular_file(&image_path)? {
        if fs::read(&image_path).map_err(|error| error.to_string())? != bytes {
            return Err("existing image path does not match its content digest".into());
        }
        // Reuse an identical prior image; provenance is updated atomically below.
        let _ = metadata;
    } else {
        atomic_create(&image_path, bytes)?;
    }

    let provenance = json!({
        "sourceUrl": source_url,
        "retrievedAtUnixMs": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis(),
        "mime": canonical_mime,
        "bytes": bytes.len(),
        "width": width,
        "height": height,
        "sha256": digest,
    });
    let provenance_bytes = serde_json::to_vec(&provenance).map_err(|error| error.to_string())?;
    atomic_replace(&provenance_path, &provenance_bytes)?;

    Ok(json!({
        "path": format!(".hii/web-images/{image_name}"),
        "provenance": format!(".hii/web-images/{}.json", digest),
        "sha256": digest,
        "mime": canonical_mime,
        "bytes": bytes.len(),
        "width": width,
        "height": height,
    })
    .to_string())
}

fn ensure_directory(workspace: &Path, directory: &Path) -> Result<(), String> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(format!(
                "refusing symlink in image store path: {}",
                directory.display()
            ));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(format!(
                "image store path is not a directory: {}",
                directory.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(directory)
                .map_err(|error| format!("cannot create image store: {error}"))?;
        }
        Err(error) => return Err(format!("cannot inspect image store: {error}")),
    }
    let canonical = directory
        .canonicalize()
        .map_err(|error| format!("cannot resolve image store: {error}"))?;
    if !canonical.starts_with(workspace) {
        return Err("image store resolves outside the workspace".into());
    }
    Ok(())
}

fn existing_regular_file(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "refusing symlink at image output path: {}",
            path.display()
        )),
        Ok(metadata) if !metadata.is_file() => Err(format!(
            "image output path is not a regular file: {}",
            path.display()
        )),
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("cannot inspect image output path: {error}")),
    }
}

fn atomic_create(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = temporary_path(path);
    let result = write_new(&temporary, bytes).and_then(|()| {
        if existing_regular_file(path)?.is_some() {
            return Err("image output appeared during save".into());
        }
        fs::rename(&temporary, path).map_err(|error| format!("cannot publish image: {error}"))
    });
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // Validate the current entry before replacing it; rename never follows a symlink.
    let _ = existing_regular_file(path)?;
    let temporary = temporary_path(path);
    let result = write_new(&temporary, bytes).and_then(|()| {
        fs::rename(&temporary, path).map_err(|error| format!("cannot publish provenance: {error}"))
    });
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn temporary_path(path: &Path) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!(".{name}.{}.tmp", Uuid::new_v4()))
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file: File = options
        .open(path)
        .map_err(|error| format!("cannot create temporary image file: {error}"))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("cannot write image file: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::DynamicImage;
    use std::io::Cursor;
    use tempfile::tempdir;

    fn tiny_png() -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgba8(2, 3)
            .write_to(&mut bytes, ImageFormat::Png)
            .expect("encode test PNG");
        bytes.into_inner()
    }

    #[test]
    fn saves_valid_png_and_provenance() {
        let workspace = tempdir().expect("workspace");
        let bytes = tiny_png();
        let receipt = save_web_image(
            workspace.path(),
            "https://example.test/i.png",
            "image/png",
            &bytes,
        )
        .expect("valid image should save");
        let receipt: serde_json::Value = serde_json::from_str(&receipt).expect("receipt JSON");
        assert_eq!(receipt["width"], 2);
        assert_eq!(receipt["height"], 3);
        let image_path = workspace.path().join(receipt["path"].as_str().unwrap());
        assert_eq!(fs::read(image_path).expect("saved image"), bytes);
        let provenance: serde_json::Value = serde_json::from_slice(
            &fs::read(
                workspace
                    .path()
                    .join(receipt["provenance"].as_str().unwrap()),
            )
            .expect("provenance"),
        )
        .expect("provenance JSON");
        assert_eq!(provenance["sourceUrl"], "https://example.test/i.png");
    }

    #[test]
    fn rejects_malformed_and_oversized_images() {
        let workspace = tempdir().expect("workspace");
        assert!(save_web_image(
            workspace.path(),
            "https://example.test/x",
            "image/png",
            b"not an image"
        )
        .is_err());
        assert!(save_web_image(
            workspace.path(),
            "https://example.test/x",
            "image/png",
            &vec![0; MAX_BYTES + 1]
        )
        .is_err());
        assert!(!workspace.path().join(".hii").exists());
    }
}
