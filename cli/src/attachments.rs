use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

const MAX_ATTACHMENTS: usize = 8;
const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 20 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImagePayload {
    pub mime_type: String,
    pub base64: String,
}

#[derive(Clone, Debug)]
enum AttachmentData {
    Text(String),
    Image(ImagePayload),
}

#[derive(Clone, Debug)]
struct Attachment {
    relative_path: PathBuf,
    bytes: usize,
    data: AttachmentData,
}

#[derive(Clone, Debug, Default)]
pub struct AttachmentPayload {
    pub text_context: String,
    pub images: Vec<ImagePayload>,
    pub count: usize,
    pub bytes: usize,
}

#[derive(Clone, Debug)]
pub struct AttachmentQueue {
    workspace: PathBuf,
    public_test: bool,
    items: Vec<Attachment>,
}

impl AttachmentQueue {
    pub fn new(workspace: &Path, public_test: bool) -> Self {
        Self {
            workspace: workspace.to_path_buf(),
            public_test,
            items: Vec::new(),
        }
    }

    pub fn add(&mut self, raw_path: &str) -> Result<String, String> {
        if self.items.len() >= MAX_ATTACHMENTS {
            return Err(format!("attachment limit reached ({MAX_ATTACHMENTS})"));
        }
        let (absolute, relative) = self.resolve(raw_path)?;
        if self.items.iter().any(|item| item.relative_path == relative) {
            return Err(format!("already attached: {}", relative.display()));
        }
        let bytes = fs::read(&absolute)
            .map_err(|error| format!("cannot read {}: {error}", relative.display()))?;
        let byte_len = bytes.len();
        let data = if let Some(mime_type) = image_mime(&bytes) {
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err(format!(
                    "{} is too large ({} MiB max for images)",
                    relative.display(),
                    MAX_IMAGE_BYTES / 1024 / 1024
                ));
            }
            AttachmentData::Image(ImagePayload {
                mime_type: mime_type.into(),
                base64: STANDARD.encode(&bytes),
            })
        } else {
            if bytes.len() > MAX_TEXT_BYTES {
                return Err(format!(
                    "{} is too large ({} KiB max for text)",
                    relative.display(),
                    MAX_TEXT_BYTES / 1024
                ));
            }
            let text = String::from_utf8(bytes).map_err(|_| {
                "unsupported binary; attach UTF-8 text, PNG, JPEG, GIF, or WebP".to_string()
            })?;
            AttachmentData::Text(text)
        };
        let next_total = self.total_bytes().saturating_add(byte_len);
        if next_total > MAX_TOTAL_BYTES {
            return Err(format!(
                "attachment context would exceed the {} MiB session limit",
                MAX_TOTAL_BYTES / 1024 / 1024
            ));
        }
        let attachment = Attachment {
            relative_path: relative.clone(),
            bytes: byte_len,
            data,
        };
        let kind = match attachment.data {
            AttachmentData::Text(_) => "text",
            AttachmentData::Image(_) => "image",
        };
        let size = format_bytes(attachment.bytes);
        self.items.push(attachment);
        Ok(format!(
            "Attached {} · {kind} · {size}\n{}",
            relative.display(),
            self.summary()
        ))
    }

    pub fn remove(&mut self, requested: Option<&str>) -> Result<String, String> {
        let requested = requested.unwrap_or("all").trim();
        if requested.eq_ignore_ascii_case("all") {
            let count = self.items.len();
            self.items.clear();
            return Ok(format!("Removed {count} pending attachment(s)."));
        }
        let index = requested
            .parse::<usize>()
            .map_err(|_| "usage: /detach <number|all>".to_string())?;
        if index == 0 || index > self.items.len() {
            return Err(format!("attachment number must be 1-{}", self.items.len()));
        }
        let removed = self.items.remove(index - 1);
        Ok(format!("Detached {}.", removed.relative_path.display()))
    }

    pub fn summary(&self) -> String {
        if self.items.is_empty() {
            return "No pending attachments.".into();
        }
        let mut lines = vec![format!(
            "{} pending attachment(s) · {} total · applied to the next prompt",
            self.items.len(),
            format_bytes(self.total_bytes())
        )];
        for (index, item) in self.items.iter().enumerate() {
            let kind = match item.data {
                AttachmentData::Text(_) => "text",
                AttachmentData::Image(_) => "image",
            };
            lines.push(format!(
                "  {}. {} · {} · {}",
                index + 1,
                item.relative_path.display(),
                kind,
                format_bytes(item.bytes)
            ));
        }
        lines.join("\n")
    }

    pub fn has_images(&self) -> bool {
        self.items
            .iter()
            .any(|item| matches!(item.data, AttachmentData::Image(_)))
    }

    pub fn count(&self) -> usize {
        self.items.len()
    }

    pub fn total_bytes(&self) -> usize {
        self.items.iter().map(|item| item.bytes).sum()
    }

    pub fn take(&mut self) -> AttachmentPayload {
        let items = std::mem::take(&mut self.items);
        let mut payload = AttachmentPayload {
            count: items.len(),
            bytes: items.iter().map(|item| item.bytes).sum(),
            ..Default::default()
        };
        for item in items {
            match item.data {
                AttachmentData::Text(text) => {
                    payload.text_context.push_str(&format!(
                        "\n\n[HII ATTACHMENT: {} | UTF-8 text | {}]\n{}\n[END HII ATTACHMENT]",
                        item.relative_path.display(),
                        format_bytes(item.bytes),
                        text
                    ));
                }
                AttachmentData::Image(image) => payload.images.push(image),
            }
        }
        payload
    }

    fn resolve(&self, raw_path: &str) -> Result<(PathBuf, PathBuf), String> {
        let requested = Path::new(raw_path.trim());
        if raw_path.trim().is_empty() {
            return Err("usage: /attach <workspace-relative-path>".into());
        }
        if requested.is_absolute() {
            return Err("attachments must use a workspace-relative path".into());
        }
        if requested.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err("attachment path may not leave the workspace".into());
        }
        if requested.components().any(|part| {
            let value = part.as_os_str().to_string_lossy();
            value == ".git"
                || is_secret_name(&value)
                || (self.public_test && value.starts_with('.'))
        }) {
            return Err("private, hidden, and secret-bearing files cannot be attached".into());
        }
        let absolute = self
            .workspace
            .join(requested)
            .canonicalize()
            .map_err(|error| format!("cannot open {}: {error}", requested.display()))?;
        if !absolute.starts_with(&self.workspace) {
            return Err("attachment path escaped the workspace".into());
        }
        let metadata = fs::symlink_metadata(self.workspace.join(requested))
            .map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("symlink attachments are not allowed".into());
        }
        if !metadata.is_file() {
            return Err("attachment must be a regular file".into());
        }
        let relative = absolute
            .strip_prefix(&self.workspace)
            .map_err(|_| "attachment path escaped the workspace".to_string())?
            .to_path_buf();
        Ok((absolute, relative))
    }
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn is_secret_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == ".env"
        || name.starts_with(".env.")
        || name.contains("credential")
        || name.contains("secret")
        || name.contains("private_key")
        || name == "id_rsa"
        || name == "id_ed25519"
        || name.ends_with(".pem")
        || name.ends_with(".key")
}

fn format_bytes(bytes: usize) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MiB", bytes as f64 / 1024.0 / 1024.0)
    } else if bytes >= 1024 {
        format!("{:.1} KiB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn workspace() -> PathBuf {
        let path = std::env::temp_dir().join(format!("hii-attachments-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
    }

    #[test]
    fn queues_text_and_consumes_once() {
        let root = workspace();
        fs::write(root.join("brief.txt"), "make it purple").unwrap();
        let mut queue = AttachmentQueue::new(&root, false);
        assert!(queue
            .add("brief.txt")
            .unwrap()
            .contains("Attached brief.txt"));
        let payload = queue.take();
        assert!(payload.text_context.contains("make it purple"));
        assert_eq!(payload.count, 1);
        assert_eq!(queue.count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validates_image_magic_and_encodes_payload() {
        let root = workspace();
        fs::write(root.join("reference.png"), b"\x89PNG\r\n\x1a\nimage").unwrap();
        let mut queue = AttachmentQueue::new(&root, false);
        queue.add("reference.png").unwrap();
        let payload = queue.take();
        assert_eq!(payload.images[0].mime_type, "image/png");
        assert!(!payload.images[0].base64.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn blocks_escape_symlink_and_secret_paths() {
        let root = workspace();
        fs::write(root.join(".env"), "TOKEN=nope").unwrap();
        let outside = root.parent().unwrap().join("outside.txt");
        fs::write(&outside, "private").unwrap();
        symlink(&outside, root.join("link.txt")).unwrap();
        let mut queue = AttachmentQueue::new(&root, true);
        assert!(queue.add("../outside.txt").is_err());
        assert!(queue.add("link.txt").is_err());
        assert!(queue.add(".env").is_err());
        fs::remove_file(outside).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
