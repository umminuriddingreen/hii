use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

const MAX_ATTACHMENTS: usize = 8;
const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 20 * 1024 * 1024;

/// Where files dropped from outside the workspace are copied to.
const IMPORT_DIR: &str = "attachments";

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

    /// Bring a file from outside the workspace in, then attach the copy.
    ///
    /// Dragging an image onto the composer is the ordinary way people hand a
    /// reference to a model, and the path that arrives is absolute and lives
    /// wherever the user keeps their files. [`Self::add`] refuses that by
    /// design, and relaxing it would be the wrong repair: the workspace is what
    /// makes an attachment reproducible, auditable, and safe to re-read later.
    ///
    /// So the file is copied in and the copy is attached through exactly the
    /// same guards as anything else. The receipt then names something that
    /// still exists when someone comes back to check, instead of a path on a
    /// machine that has since moved on.
    pub fn import(&mut self, raw_path: &str) -> Result<String, String> {
        let trimmed = unquote(raw_path);
        if trimmed.is_empty() {
            return Err("usage: /attach <path>".into());
        }
        let source = Path::new(trimmed);

        // Already inside? Then this is an ordinary attach and copying it would
        // just litter the workspace with duplicates.
        if let Ok(relative) = source.strip_prefix(&self.workspace) {
            return self.add(&relative.to_string_lossy());
        }
        if !source.is_absolute() {
            return self.add(trimmed);
        }

        let metadata = fs::symlink_metadata(source)
            .map_err(|error| format!("cannot open {trimmed}: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("symlink attachments are not allowed".into());
        }
        if !metadata.is_file() {
            return Err("attachment must be a regular file".into());
        }

        let name = source
            .file_name()
            .map(|part| part.to_string_lossy().to_string())
            .ok_or_else(|| "that path names no file".to_string())?;
        if is_secret_name(&name) || (self.public_test && name.starts_with('.')) {
            return Err("private, hidden, and secret-bearing files cannot be attached".into());
        }

        // Refuse before copying rather than after. Writing ten megabytes into
        // the workspace only to reject it on the next line would leave the
        // user's directory dirtier than they found it.
        let ceiling = if is_image_name(&name) {
            MAX_IMAGE_BYTES
        } else {
            MAX_TEXT_BYTES
        };
        if metadata.len() > ceiling as u64 {
            return Err(format!(
                "{name} is too large ({} MiB max)",
                ceiling / 1024 / 1024
            ));
        }

        let directory = self.workspace.join(IMPORT_DIR);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("cannot create {IMPORT_DIR}: {error}"))?;
        let target = unique_name(&directory, &sanitise(&name));
        fs::copy(source, directory.join(&target))
            .map_err(|error| format!("cannot copy {name} into the workspace: {error}"))?;

        self.add(&format!("{IMPORT_DIR}/{target}"))
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

/// Strip the quotes a terminal adds when a file is dropped onto it.
///
/// Windows quotes any dropped path; most shells quote one containing a space.
/// The quotes are an artefact of the transport, not part of the name.
fn unquote(raw: &str) -> &str {
    let trimmed = raw.trim();
    let unquoted = trimmed
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .or_else(|| {
            trimmed
                .strip_prefix('\'')
                .and_then(|rest| rest.strip_suffix('\''))
        });
    unquoted.unwrap_or(trimmed)
}

/// Does this path look like a file the composer should offer to attach?
///
/// Used to decide whether a pasted line is a dropped file rather than prose.
/// Deliberately conservative: it must already exist as a regular file, so a
/// sentence that happens to look path-shaped is left alone as text.
pub fn looks_like_dropped_file(line: &str) -> Option<&str> {
    let candidate = unquote(line);
    if candidate.is_empty() || candidate.lines().count() > 1 {
        return None;
    }
    match fs::symlink_metadata(Path::new(candidate)) {
        Ok(metadata) if metadata.is_file() => Some(candidate),
        _ => None,
    }
}

fn is_image_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp"]
        .iter()
        .any(|extension| lower.ends_with(extension))
}

/// Reduce a name from anywhere on disk to one that is safe inside the workspace.
fn sanitise(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(['.', '-']).to_string();
    if cleaned.is_empty() {
        "attachment".into()
    } else {
        cleaned
    }
}

/// A name that is not already taken, so importing twice keeps both files.
fn unique_name(directory: &Path, name: &str) -> String {
    if !directory.join(name).exists() {
        return name.to_string();
    }
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) => (stem, format!(".{extension}")),
        None => (name, String::new()),
    };
    for index in 2..1000 {
        let candidate = format!("{stem}-{index}{extension}");
        if !directory.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{stem}-{}{extension}", std::process::id())
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
    // Symlink creation is unprivileged only on unix; the tests that use it
    // check a unix-specific escape, so they compile only where it exists.
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    fn workspace() -> PathBuf {
        let path = std::env::temp_dir().join(format!("hii-attachments-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
    }

    /// A one-pixel PNG, so the magic-byte check sees a real image.
    fn png() -> Vec<u8> {
        STANDARD
            .decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            )
            .unwrap()
    }

    #[test]
    fn imports_a_file_dropped_from_outside_the_workspace() {
        let space = workspace();
        let elsewhere = workspace();
        let dropped = elsewhere.join("reference shot.png");
        fs::write(&dropped, png()).unwrap();

        let mut queue = AttachmentQueue::new(&space, false);
        // Quoted, because that is what a terminal produces on drop.
        let message = queue
            .import(&format!("\"{}\"", dropped.display()))
            .expect("a dropped image should attach");

        assert!(message.contains("image"), "{message}");
        assert!(
            space.join(IMPORT_DIR).join("reference-shot.png").is_file(),
            "the file should have been copied into the workspace"
        );
        assert!(queue.has_images());
    }

    #[test]
    fn importing_the_same_name_twice_keeps_both() {
        let space = workspace();
        let first = workspace();
        let second = workspace();
        fs::write(first.join("plan.png"), png()).unwrap();
        fs::write(second.join("plan.png"), png()).unwrap();

        let mut queue = AttachmentQueue::new(&space, false);
        queue.import(&first.join("plan.png").display().to_string()).unwrap();
        queue
            .import(&second.join("plan.png").display().to_string())
            .expect("a second file of the same name should not collide");

        assert!(space.join(IMPORT_DIR).join("plan.png").is_file());
        assert!(space.join(IMPORT_DIR).join("plan-2.png").is_file());
        assert_eq!(queue.count(), 2);
    }

    #[test]
    fn importing_does_not_copy_what_is_already_inside() {
        let space = workspace();
        fs::write(space.join("notes.txt"), b"already here").unwrap();

        let mut queue = AttachmentQueue::new(&space, false);
        queue
            .import(&space.join("notes.txt").display().to_string())
            .unwrap();

        assert!(
            !space.join(IMPORT_DIR).exists(),
            "a file already in the workspace should be attached where it lies"
        );
    }

    #[test]
    fn importing_still_refuses_a_secret() {
        let elsewhere = workspace();
        let secret = elsewhere.join("id_rsa");
        fs::write(&secret, b"-----BEGIN PRIVATE KEY-----").unwrap();

        let space = workspace();
        let mut queue = AttachmentQueue::new(&space, false);
        let refusal = queue
            .import(&secret.display().to_string())
            .expect_err("a secret must not be importable just because it was dropped");

        assert!(refusal.contains("secret-bearing"), "{refusal}");
        assert!(!space.join(IMPORT_DIR).exists(), "nothing should have been copied");
    }

    #[test]
    fn a_dropped_path_is_recognised_but_prose_is_not() {
        let elsewhere = workspace();
        let dropped = elsewhere.join("sketch.png");
        fs::write(&dropped, png()).unwrap();

        let quoted = format!("\"{}\"", dropped.display());
        assert_eq!(
            looks_like_dropped_file(&quoted),
            Some(dropped.display().to_string().as_str())
        );
        assert_eq!(looks_like_dropped_file("make this 40 mm wide"), None);
        assert_eq!(looks_like_dropped_file("C:/nothing/here.png"), None);
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
    #[cfg(unix)]
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
