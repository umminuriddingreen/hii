// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Reading and writing HII's local JSON and JSONL state.
//!
//! Nine modules carried private copies of these five operations. The copies had
//! drifted in ways that mattered: `applications` wrote through a uniquely-named
//! temporary file, while `skill_lifecycle` used a fixed `*.json.tmp` name that two
//! concurrent writers would collide on — and the file at stake there is the one whose
//! loss silently resets every skill to `proposed`. Durability belongs in one place so
//! it can be reasoned about once.

use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

/// Read and deserialize a JSON file, treating any failure as absence.
///
/// For optional local state, where a missing file and an unreadable one lead to the
/// same place: fall back to a default rather than fail the command.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Read a JSON file as an untyped [`Value`], treating any failure as absence.
pub fn read_value(path: &Path) -> Option<Value> {
    read_json(path)
}

/// Write JSON so a reader never observes a partial file.
///
/// Write-then-rename through a uniquely-named temporary: `rename` is atomic within a
/// filesystem, so a crash leaves either the old file or the new one, never a truncated
/// one. The temporary name carries a UUID because a fixed name is a collision between
/// two writers, which is the corruption this function exists to prevent.
pub fn write_json_atomic<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    ensure_parent(path)?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    if let Err(error) = fs::write(&temporary, bytes) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("failed to write {}: {error}", path.display()));
    }
    replace(&temporary, path)
}

/// Append one JSON object as a line to an append-only log.
pub fn append_jsonl<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    ensure_parent(path)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    let raw = serde_json::to_string(value).map_err(|error| error.to_string())?;
    writeln!(file, "{raw}").map_err(|error| error.to_string())
}

/// Read an append-only log, failing on the first malformed line.
///
/// A missing file is an empty log, not an error: the first append creates it.
pub fn read_jsonl<T: DeserializeOwned>(path: &Path) -> Result<Vec<T>, String> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Ok(Vec::new());
    };
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(|error| error.to_string()))
        .collect()
}

/// A non-empty string field, or `None`.
///
/// Present-but-empty is absent for every caller in this CLI: an empty id, name, or
/// path is not a value worth propagating.
pub fn field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|found| !found.is_empty())
}

/// The string members of an array field, skipping anything that is not a string.
pub fn field_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

/// Restrict a directory to its owner (`0700`). A no-op off Unix.
///
/// Three modules defined this identically; HII's runtime directories hold keys,
/// credentials, and receipts, so the mode is a property of the runtime rather than
/// of whichever module happened to create the directory.
pub fn set_directory_mode(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// [`write_json_atomic`], with the file readable only by its owner (`0600`).
///
/// For anything HII would not want another local account to read: keys, tokens,
/// credentials, enrollment state. The mode is set on the temporary file *before* the
/// rename, so the target is never briefly world-readable.
pub fn write_json_private_atomic<T: Serialize + ?Sized>(
    path: &Path,
    value: &T,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    write_private_atomic(path, &bytes)
}

/// [`write_json_private_atomic`] for bytes that are already encoded.
pub fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    ensure_parent(path)?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    let temporary = match parent {
        Some(parent) => parent.join(format!(".hii-{}.tmp", Uuid::new_v4().simple())),
        None => PathBuf::from(format!(".hii-{}.tmp", Uuid::new_v4().simple())),
    };
    let written = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        // `create_new` on a freshly generated name: if it somehow exists, that is a
        // condition to report, never one to overwrite.
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("failed to create {}: {error}", temporary.display()))?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
        return written;
    }
    replace(&temporary, path)
}

/// Rename `temporary` over `path`, cleaning up if it cannot.
///
/// Keep the destination intact when replacement fails, including on Windows.
fn replace(temporary: &Path, path: &Path) -> Result<(), String> {
    // Rename replaces an existing file on supported platforms. Removing the
    // destination first creates a data-loss window if replacement then fails.
    fs::rename(temporary, path).map_err(|error| {
        let _ = fs::remove_file(temporary);
        format!("failed to replace {}: {error}", path.display())
    })
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hii-store-{name}-{nonce}"));
        fs::create_dir_all(&dir).expect("create scratch directory");
        dir
    }

    #[test]
    fn absent_and_unreadable_state_both_read_as_absent() {
        let dir = scratch("absent");
        assert!(read_value(&dir.join("missing.json")).is_none());
        let broken = dir.join("broken.json");
        fs::write(&broken, b"{not json").expect("write");
        assert!(read_value(&broken).is_none());
    }

    /// The reason this is one function and not nine: a fixed temporary name means
    /// two writers of the same file race, and `skill_lifecycle` was writing the
    /// store whose loss resets every skill to `proposed`.
    #[test]
    fn concurrent_atomic_writes_do_not_collide() {
        let dir = scratch("atomic");
        let target = dir.join("nested/state.json");
        std::thread::scope(|scope| {
            for worker in 0..8 {
                let target = target.clone();
                scope.spawn(move || {
                    for round in 0..8 {
                        write_json_atomic(&target, &serde_json::json!({ "w": worker, "r": round }))
                            .expect("atomic write should succeed under contention");
                    }
                });
            }
        });
        // Whoever landed last, the file is a whole document — never a truncated one.
        let value = read_value(&target).expect("state survives concurrent writers");
        assert!(value.get("w").is_some() && value.get("r").is_some());
    }

    /// Private state is HII's keys and credentials. A file that is briefly
    /// world-readable between write and chmod is a window, so the mode goes on the
    /// temporary file and the rename carries it over.
    #[cfg(unix)]
    #[test]
    fn private_writes_are_owner_only_and_never_briefly_public() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("private");
        let target = dir.join("keys/state.json");
        write_json_private_atomic(&target, &serde_json::json!({ "secret": true })).expect("write");
        let mode = fs::metadata(&target).expect("stat").permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "state was left readable by other accounts"
        );
        // Replacing it must not widen the mode.
        write_json_private_atomic(&target, &serde_json::json!({ "secret": false }))
            .expect("rewrite");
        let mode = fs::metadata(&target).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    /// Replacing an existing file is the common case, and the one that fails on
    /// Windows without an explicit unlink.
    #[test]
    fn atomic_writes_replace_an_existing_file() {
        let dir = scratch("replace");
        let target = dir.join("state.json");
        write_json_atomic(&target, &serde_json::json!({ "v": 1 })).expect("first");
        write_json_atomic(&target, &serde_json::json!({ "v": 2 })).expect("second");
        assert_eq!(read_value(&target).map(|v| v["v"].clone()), Some(2.into()));
        write_json_private_atomic(&target, &serde_json::json!({ "v": 3 })).expect("third");
        assert_eq!(read_value(&target).map(|v| v["v"].clone()), Some(3.into()));
    }

    /// A failed write must not leave `.hii-*.tmp` litter beside the real state.
    #[test]
    fn a_failed_write_leaves_no_temporary_behind() {
        let dir = scratch("litter");
        let blocked = dir.join("a-file");
        fs::write(&blocked, b"not a directory").expect("write");
        assert!(write_json_atomic(&blocked.join("state.json"), &serde_json::json!({})).is_err());
        let strays: Vec<_> = fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(
            strays.is_empty(),
            "left {} temporary files behind",
            strays.len()
        );
    }

    #[test]
    fn writing_creates_missing_parent_directories() {
        let dir = scratch("parents");
        let target = dir.join("a/b/c/state.json");
        write_json_atomic(&target, &serde_json::json!({ "ok": true })).expect("write");
        assert_eq!(
            read_value(&target).and_then(|v| v["ok"].as_bool()),
            Some(true)
        );
    }

    #[test]
    fn a_missing_log_is_an_empty_log_not_an_error() {
        let dir = scratch("jsonl");
        let missing = dir.join("events.jsonl");
        assert!(read_jsonl::<Value>(&missing).expect("empty").is_empty());
    }

    /// A malformed line is a corrupt log, not a line to skip: callers that read
    /// their own state must hear about it rather than silently lose records.
    #[test]
    fn a_malformed_line_fails_the_read() {
        let dir = scratch("lossy");
        let log = dir.join("events.jsonl");
        append_jsonl(&log, &serde_json::json!({ "n": 1 })).expect("append");
        fs::write(&log, "{\"n\":1}\n{ truncated\n\n{\"n\":2}\n").expect("write");
        assert!(read_jsonl::<Value>(&log).is_err());
    }

    #[test]
    fn appending_creates_the_log_and_preserves_order() {
        let dir = scratch("append");
        let log = dir.join("nested/events.jsonl");
        for n in 0..4 {
            append_jsonl(&log, &serde_json::json!({ "n": n })).expect("append");
        }
        let read: Vec<Value> = read_jsonl(&log).expect("read");
        assert_eq!(
            read.iter()
                .map(|v| v["n"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
    }

    /// Every caller treated present-but-empty as absent; now that is stated once.
    #[test]
    fn empty_string_fields_read_as_absent() {
        let value = serde_json::json!({ "id": "", "name": "hii", "tags": ["a", 2, "b"] });
        assert_eq!(field(&value, "id"), None);
        assert_eq!(field(&value, "missing"), None);
        assert_eq!(field(&value, "name").as_deref(), Some("hii"));
        assert_eq!(field_array(&value, "tags"), vec!["a", "b"]);
        assert!(field_array(&value, "missing").is_empty());
    }
}
