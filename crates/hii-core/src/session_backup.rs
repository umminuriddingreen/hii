// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Incremental, local-only archives of explicitly selected provider session roots.
//! Device labels are provenance, never an account identity or authorization claim.

use fs2::FileExt;
use ring::digest::{Context, SHA256};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};
use uuid::Uuid;

const CHUNK_SIZE: usize = 1024 * 1024;
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRoot {
    pub provider: String,
    pub source_id: String,
    pub root: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupIssue {
    pub provider: String,
    pub source_id: String,
    pub relative_path: String,
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub snapshot_id: String,
    pub device_id: String,
    pub provider: String,
    pub source_id: String,
    pub relative_path: String,
    pub bytes: u64,
    pub sha256: String,
    pub created_at: i64,
    pub source_grew_during_capture: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    pub run_id: String,
    pub device_id: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub files_scanned: u64,
    pub files_backed_up: u64,
    pub files_unchanged: u64,
    pub entries_skipped: u64,
    #[serde(default)]
    pub links_skipped: u64,
    pub sources_missing: u64,
    pub bytes_read: u64,
    pub chunks_added: u64,
    pub errors: Vec<BackupIssue>,
    pub snapshots: Vec<SnapshotInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub files: u64,
    pub snapshots: u64,
    pub unique_chunks: u64,
    pub stored_bytes: u64,
    pub latest: Vec<SnapshotInfo>,
    pub last_run: Option<BackupReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub snapshot_id: String,
    pub destination: PathBuf,
    pub bytes: u64,
    pub sha256: String,
    pub verified: bool,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn db_error(_: rusqlite::Error) -> String {
    "session_backup_database_error".into()
}
fn valid_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn hash(bytes: &[u8]) -> String {
    hex(ring::digest::digest(&SHA256, bytes).as_ref())
}

fn open_database(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|_| "session_backup_database_directory_unavailable")?;
    }
    protect_database(path)?;
    let db = Connection::open(path).map_err(db_error)?;
    protect_database(path)?;
    db.busy_timeout(Duration::from_secs(5)).map_err(db_error)?;
    db.execute_batch(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
         CREATE TABLE IF NOT EXISTS session_backup_chunks (
             sha256 TEXT PRIMARY KEY NOT NULL, data BLOB NOT NULL
         );
         CREATE TABLE IF NOT EXISTS session_backup_files (
             id TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL, provider TEXT NOT NULL,
             source_id TEXT NOT NULL, relative_path TEXT NOT NULL, source_root TEXT NOT NULL,
             observed_size INTEGER, observed_modified TEXT, latest_snapshot_id TEXT,
             UNIQUE(device_id,provider,source_id,relative_path)
         );
         CREATE TABLE IF NOT EXISTS session_backup_snapshots (
             id TEXT PRIMARY KEY NOT NULL, file_id TEXT NOT NULL REFERENCES session_backup_files(id),
             size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL,
             source_grew_during_capture INTEGER NOT NULL DEFAULT 0,
             UNIQUE(file_id,sha256)
         );
         CREATE TABLE IF NOT EXISTS session_backup_snapshot_chunks (
             snapshot_id TEXT NOT NULL REFERENCES session_backup_snapshots(id),
             position INTEGER NOT NULL, chunk_sha256 TEXT NOT NULL REFERENCES session_backup_chunks(sha256),
             PRIMARY KEY(snapshot_id,position)
         );
         CREATE TABLE IF NOT EXISTS session_backup_runs (
             id TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL, started_at INTEGER NOT NULL,
             report_json TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS session_backup_device_files ON session_backup_files(device_id);
         CREATE INDEX IF NOT EXISTS session_backup_run_device ON session_backup_runs(device_id,started_at);",
    ).map_err(db_error)?;
    protect_database(path)?;
    Ok(db)
}

fn protect_database(path: &Path) -> Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| linked(&metadata)) {
        return Err("session_backup_database_link_disallowed".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in [
            path.to_path_buf(),
            PathBuf::from(format!("{}-wal", path.display())),
            PathBuf::from(format!("{}-shm", path.display())),
        ] {
            match fs::symlink_metadata(&file) {
                Ok(metadata) => {
                    if linked(&metadata) {
                        return Err("session_backup_database_link_disallowed".into());
                    }
                    fs::set_permissions(&file, fs::Permissions::from_mode(0o600))
                        .map_err(|_| "session_backup_database_permissions_failed")?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("session_backup_database_permissions_failed".into()),
            }
        }
    }
    Ok(())
}

fn acquire_backup_lock(database: &Path) -> Result<File> {
    let parent = database
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(|_| "session_backup_database_directory_unavailable")?;
    let canonical = if database.exists() {
        database
            .canonicalize()
            .map_err(|_| "session_backup_database_path_unavailable")?
    } else {
        parent
            .canonicalize()
            .map_err(|_| "session_backup_database_path_unavailable")?
            .join(
                database
                    .file_name()
                    .ok_or("session_backup_database_path_invalid")?,
            )
    };
    let mut name = canonical.as_os_str().to_os_string();
    name.push(".session-backup.lockfile");
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options
        .open(PathBuf::from(name))
        .map_err(|_| "session_backup_lock_unavailable")?;
    if linked(
        &file
            .metadata()
            .map_err(|_| "session_backup_lock_unavailable")?,
    ) {
        return Err("session_backup_lock_link_disallowed".into());
    }
    file.try_lock_exclusive()
        .map_err(|_| "session_backup_already_running")?;
    Ok(file)
}

fn linked(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

fn modified(metadata: &Metadata) -> Option<String> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|time| time.as_nanos().to_string())
}

fn linked_ancestor(path: &Path) -> Result<bool> {
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| "source_ancestor_unreadable")?;
        if linked(&metadata) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn same_file(left: &Metadata, right: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if left.dev() != right.dev() || left.ino() != right.ino() {
            return false;
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if left.creation_time() != right.creation_time() {
            return false;
        }
    }
    true
}

fn open_source(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    options
        .open(path)
        .map_err(|_| "session_source_unreadable".into())
}

fn allowed_file(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    extension.eq_ignore_ascii_case("jsonl")
        && ![
            "auth",
            "credentials",
            "config",
            "settings",
            "secrets",
            "tokens",
        ]
        .contains(&name.as_str())
}

fn issue(
    report: &mut BackupReport,
    source: &SourceRoot,
    relative_path: &str,
    kind: impl Into<String>,
) {
    report.errors.push(BackupIssue {
        provider: source.provider.clone(),
        source_id: source.source_id.clone(),
        relative_path: relative_path.into(),
        kind: kind.into(),
    });
}

fn checkpoint_report(db: &Connection, report: &BackupReport) -> Result<()> {
    let mut value =
        serde_json::to_value(report).map_err(|_| "session_backup_report_encoding_failed")?;
    if report.finished_at.is_none() {
        value["snapshots"] = serde_json::json!([]);
    }
    let json =
        serde_json::to_string(&value).map_err(|_| "session_backup_report_encoding_failed")?;
    db.execute("INSERT INTO session_backup_runs VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET report_json=excluded.report_json",
        params![report.run_id, report.device_id, report.started_at, json]).map_err(db_error)?;
    Ok(())
}

/// Read only explicitly supplied session roots. Missing roots are counted separately
/// from unreadable sources; a failed file never replaces an earlier snapshot.
/// Unchanged files use size and modification time; their bytes are not rehashed.
pub fn backup(database: &Path, device_id: &str, sources: &[SourceRoot]) -> Result<BackupReport> {
    if !valid_label(device_id) {
        return Err("session_backup_device_label_invalid".into());
    }
    let mut identities = std::collections::HashSet::new();
    for source in sources {
        if !["codex", "claude", "pi"].contains(&source.provider.as_str())
            || !valid_label(&source.source_id)
            || !source.root.is_absolute()
            || !identities.insert((&source.provider, &source.source_id))
        {
            return Err("session_backup_source_invalid".into());
        }
    }
    let _owner = acquire_backup_lock(database)?;
    let mut db = open_database(database)?;
    let mut report = BackupReport {
        run_id: Uuid::new_v4().to_string(),
        device_id: device_id.into(),
        started_at: now(),
        finished_at: None,
        files_scanned: 0,
        files_backed_up: 0,
        files_unchanged: 0,
        entries_skipped: 0,
        links_skipped: 0,
        sources_missing: 0,
        bytes_read: 0,
        chunks_added: 0,
        errors: vec![],
        snapshots: vec![],
    };
    checkpoint_report(&db, &report)?;
    for source in sources {
        let root_metadata = match fs::symlink_metadata(&source.root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                report.sources_missing += 1;
                continue;
            }
            Err(_) => {
                issue(&mut report, source, "", "source_root_unreadable");
                continue;
            }
        };
        if linked(&root_metadata) {
            report.entries_skipped += 1;
            report.links_skipped += 1;
            continue;
        }
        match linked_ancestor(&source.root) {
            Ok(true) => {
                report.entries_skipped += 1;
                report.links_skipped += 1;
                continue;
            }
            Err(kind) => {
                issue(&mut report, source, "", kind);
                continue;
            }
            Ok(false) => {}
        }
        if !root_metadata.is_dir() {
            issue(&mut report, source, "", "source_root_not_directory");
            continue;
        }
        let mut pending = vec![source.root.clone()];
        while let Some(directory) = pending.pop() {
            let relative_dir = directory
                .strip_prefix(&source.root)
                .unwrap_or(Path::new(""));
            match linked_ancestor(&directory) {
                Ok(true) => {
                    report.entries_skipped += 1;
                    report.links_skipped += 1;
                    continue;
                }
                Err(kind) => {
                    issue(&mut report, source, &relative_dir.to_string_lossy(), kind);
                    continue;
                }
                Ok(false) => {}
            }
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(_) => {
                    issue(
                        &mut report,
                        source,
                        &relative_dir.to_string_lossy(),
                        "source_directory_unreadable",
                    );
                    continue;
                }
            };
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => {
                        issue(
                            &mut report,
                            source,
                            &relative_dir.to_string_lossy(),
                            "source_entry_unreadable",
                        );
                        continue;
                    }
                };
                let path = entry.path();
                let relative = match path.strip_prefix(&source.root).ok().and_then(Path::to_str) {
                    Some(relative) => relative.replace(std::path::MAIN_SEPARATOR, "/"),
                    None => {
                        issue(&mut report, source, "", "source_path_not_unicode");
                        continue;
                    }
                };
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(_) => {
                        issue(
                            &mut report,
                            source,
                            &relative,
                            "source_metadata_unavailable",
                        );
                        continue;
                    }
                };
                if linked(&metadata) {
                    report.entries_skipped += 1;
                    report.links_skipped += 1;
                    continue;
                }
                if metadata.is_dir() {
                    pending.push(path);
                    continue;
                }
                if !metadata.is_file() || !allowed_file(&path) {
                    report.entries_skipped += 1;
                    continue;
                }
                report.files_scanned += 1;
                match backup_file(&mut db, device_id, source, &path, &relative, &metadata) {
                    Ok(Some((snapshot, chunks))) => {
                        report.files_backed_up += 1;
                        report.bytes_read += snapshot.bytes * 2;
                        report.chunks_added += chunks;
                        report.snapshots.push(snapshot);
                    }
                    Ok(None) => report.files_unchanged += 1,
                    Err(kind) => issue(&mut report, source, &relative, kind),
                }
                checkpoint_report(&db, &report)?;
            }
        }
    }
    report.finished_at = Some(now());
    checkpoint_report(&db, &report)?;
    Ok(report)
}

fn backup_file(
    db: &mut Connection,
    device: &str,
    source: &SourceRoot,
    path: &Path,
    relative: &str,
    before: &Metadata,
) -> Result<Option<(SnapshotInfo, u64)>> {
    let identity = serde_json::to_vec(&(device, &source.provider, &source.source_id, relative))
        .map_err(|_| "session_identity_encoding_failed")?;
    let file_id = hash(&identity);
    let prior: Option<(u64, Option<String>)> = db.query_row(
        "SELECT observed_size,observed_modified FROM session_backup_files WHERE id=?1 AND latest_snapshot_id IS NOT NULL",
        [&file_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(db_error)?;
    let stamp = modified(before);
    if prior.is_some_and(|(size, time)| size == before.len() && stamp.is_some() && time == stamp) {
        return Ok(None);
    }
    let mut file = open_source(path)?;
    let opened = file.metadata().map_err(|_| "source_metadata_unavailable")?;
    if linked(&opened)
        || !opened.is_file()
        || !same_file(before, &opened)
        || opened.len() < before.len()
    {
        return Err("source_changed_during_backup".into());
    }
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    tx.execute("INSERT INTO session_backup_files (id,device_id,provider,source_id,relative_path,source_root) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO NOTHING",
        params![file_id, device, source.provider, source.source_id, relative, source.root.to_string_lossy()]).map_err(db_error)?;
    let mut whole = Context::new(&SHA256);
    let mut buffer = vec![0; CHUNK_SIZE];
    let mut total = 0u64;
    let mut manifest = Vec::new();
    let mut chunks_added = 0;
    // Fixed-size chunks keep existing full chunks identical after an append.
    while total < before.len() {
        let wanted = (before.len() - total).min(CHUNK_SIZE as u64) as usize;
        let mut count = 0;
        while count < wanted {
            match file.read(&mut buffer[count..wanted]) {
                Ok(0) => break,
                Ok(read) => count += read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err("source_read_failed".into()),
            }
        }
        if count == 0 {
            break;
        }
        total += count as u64;
        let bytes = &buffer[..count];
        whole.update(bytes);
        let digest = hash(bytes);
        chunks_added += tx
            .execute(
                "INSERT INTO session_backup_chunks VALUES (?1,?2) ON CONFLICT(sha256) DO NOTHING",
                params![digest, bytes],
            )
            .map_err(db_error)? as u64;
        manifest.push(digest);
    }
    let sha256 = hex(whole.finish().as_ref());
    // A live append is safe when the captured prefix is unchanged. Re-read that
    // exact prefix so truncation or in-place edits cannot create a mixed snapshot.
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "source_read_failed")?;
    let mut verified = Context::new(&SHA256);
    let mut remaining = total;
    while remaining > 0 {
        let wanted = remaining.min(CHUNK_SIZE as u64) as usize;
        file.read_exact(&mut buffer[..wanted])
            .map_err(|_| "source_changed_during_backup")?;
        verified.update(&buffer[..wanted]);
        remaining -= wanted as u64;
    }
    if hex(verified.finish().as_ref()) != sha256 {
        return Err("source_changed_during_backup".into());
    }
    let after = file.metadata().map_err(|_| "source_metadata_unavailable")?;
    let path_after = fs::symlink_metadata(path).map_err(|_| "source_changed_during_backup")?;
    if total != before.len()
        || after.len() < total
        || path_after.len() < total
        || linked(&path_after)
        || !same_file(before, &path_after)
    {
        return Err("source_changed_during_backup".into());
    }
    let grew = after.len() > total || path_after.len() > total;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != path_after.dev() || before.ino() != path_after.ino() {
            return Err("source_changed_during_backup".into());
        }
    }
    let existing: Option<(String, i64)> = tx
        .query_row(
            "SELECT id,created_at FROM session_backup_snapshots WHERE file_id=?1 AND sha256=?2",
            params![file_id, sha256],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    let (snapshot_id, created_at) = existing
        .clone()
        .unwrap_or_else(|| (Uuid::new_v4().to_string(), now()));
    if existing.is_none() {
        tx.execute(
            "INSERT INTO session_backup_snapshots VALUES (?1,?2,?3,?4,?5,?6)",
            params![snapshot_id, file_id, total, sha256, created_at, grew],
        )
        .map_err(db_error)?;
        for (position, digest) in manifest.iter().enumerate() {
            tx.execute(
                "INSERT INTO session_backup_snapshot_chunks VALUES (?1,?2,?3)",
                params![snapshot_id, position as u64, digest],
            )
            .map_err(db_error)?;
        }
    }
    // Never cache a newer timestamp for bytes captured before an in-place edit.
    let observed_modified = if !grew && stamp == modified(&after) && stamp == modified(&path_after)
    {
        stamp
    } else {
        None
    };
    tx.execute("UPDATE session_backup_files SET observed_size=?2,observed_modified=?3,latest_snapshot_id=?4,source_root=?5 WHERE id=?1",
        params![file_id, total, observed_modified, snapshot_id, source.root.to_string_lossy()]).map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    Ok(Some((
        SnapshotInfo {
            snapshot_id,
            device_id: device.into(),
            provider: source.provider.clone(),
            source_id: source.source_id.clone(),
            relative_path: relative.into(),
            bytes: total,
            sha256,
            created_at,
            source_grew_during_capture: grew,
        },
        chunks_added,
    )))
}

pub fn status(database: &Path, device_id: Option<&str>) -> Result<BackupStatus> {
    if device_id.is_some_and(|id| !valid_label(id)) {
        return Err("session_backup_device_label_invalid".into());
    }
    let mut connection = open_database(database)?;
    let db = connection.transaction().map_err(db_error)?;
    let files = db.query_row("SELECT COUNT(*) FROM session_backup_files WHERE (?1 IS NULL OR device_id=?1) AND latest_snapshot_id IS NOT NULL", [device_id], |row| row.get(0)).map_err(db_error)?;
    let snapshots = db.query_row("SELECT COUNT(*) FROM session_backup_snapshots s JOIN session_backup_files f ON f.id=s.file_id WHERE ?1 IS NULL OR f.device_id=?1", [device_id], |row| row.get(0)).map_err(db_error)?;
    let (unique_chunks, stored_bytes) = db.query_row("SELECT COUNT(*),COALESCE(SUM(length(data)),0) FROM session_backup_chunks WHERE sha256 IN (SELECT sc.chunk_sha256 FROM session_backup_snapshot_chunks sc JOIN session_backup_snapshots s ON s.id=sc.snapshot_id JOIN session_backup_files f ON f.id=s.file_id WHERE ?1 IS NULL OR f.device_id=?1)", [device_id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(db_error)?;
    let mut statement = db.prepare("SELECT s.id,f.device_id,f.provider,f.source_id,f.relative_path,s.size,s.sha256,s.created_at,s.source_grew_during_capture FROM session_backup_files f JOIN session_backup_snapshots s ON s.id=f.latest_snapshot_id WHERE ?1 IS NULL OR f.device_id=?1 ORDER BY f.provider,f.source_id,f.relative_path").map_err(db_error)?;
    let latest = statement
        .query_map([device_id], |row| {
            Ok(SnapshotInfo {
                snapshot_id: row.get(0)?,
                device_id: row.get(1)?,
                provider: row.get(2)?,
                source_id: row.get(3)?,
                relative_path: row.get(4)?,
                bytes: row.get(5)?,
                sha256: row.get(6)?,
                created_at: row.get(7)?,
                source_grew_during_capture: row.get(8)?,
            })
        })
        .map_err(db_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let last: Option<String> = db.query_row("SELECT report_json FROM session_backup_runs WHERE ?1 IS NULL OR device_id=?1 ORDER BY started_at DESC,rowid DESC LIMIT 1", [device_id], |row| row.get(0)).optional().map_err(db_error)?;
    let last_run = last
        .map(|raw| {
            serde_json::from_str(&raw).map_err(|_| "session_backup_report_invalid".to_owned())
        })
        .transpose()?;
    Ok(BackupStatus {
        files,
        snapshots,
        unique_chunks,
        stored_bytes,
        latest,
        last_run,
    })
}

pub fn list(database: &Path, provider: Option<&str>) -> Result<Vec<SnapshotInfo>> {
    if provider.is_some_and(|provider| !["codex", "claude", "pi"].contains(&provider)) {
        return Err("session_backup_provider_invalid".into());
    }
    Ok(status(database, None)?
        .latest
        .into_iter()
        .filter(|snapshot| provider.is_none_or(|provider| snapshot.provider == provider))
        .collect())
}

/// Verify archive contents before creating the destination, then verify the written
/// bytes again. A failed write leaves a new partial file with an explicit error;
/// it never removes or overwrites any existing destination.
pub fn restore(database: &Path, snapshot_id: &str, destination: &Path) -> Result<RestoreReport> {
    let mut connection = open_database(database)?;
    let db = connection.transaction().map_err(db_error)?;
    let (expected_size, expected_hash): (u64, String) = db
        .query_row(
            "SELECT size,sha256 FROM session_backup_snapshots WHERE id=?1",
            [snapshot_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or("session_backup_snapshot_not_found")?;
    let mut statement = db.prepare("SELECT sc.position,c.sha256,c.data FROM session_backup_snapshot_chunks sc JOIN session_backup_chunks c ON c.sha256=sc.chunk_sha256 WHERE sc.snapshot_id=?1 ORDER BY sc.position").map_err(db_error)?;
    for pass in 0..2 {
        let mut output = if pass == 1 {
            let mut options = OpenOptions::new();
            options.create_new(true).read(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            Some(
                options
                    .open(destination)
                    .map_err(|_| "restore_destination_exists_or_unavailable")?,
            )
        } else {
            None
        };
        let mut rows = statement.query([snapshot_id]).map_err(db_error)?;
        let mut whole = Context::new(&SHA256);
        let mut bytes = 0u64;
        let mut position = 0u64;
        while let Some(row) = rows.next().map_err(db_error)? {
            let sequence: u64 = row.get(0).map_err(db_error)?;
            let digest: String = row.get(1).map_err(db_error)?;
            let data: Vec<u8> = row.get(2).map_err(db_error)?;
            if sequence != position || data.len() > CHUNK_SIZE || hash(&data) != digest {
                return Err("session_backup_checksum_mismatch".into());
            }
            position += 1;
            bytes += data.len() as u64;
            whole.update(&data);
            if let Some(file) = output.as_mut() {
                file.write_all(&data)
                    .map_err(|_| "restore_write_failed_partial_file_retained")?;
            }
        }
        if bytes != expected_size || hex(whole.finish().as_ref()) != expected_hash {
            return Err("session_backup_checksum_mismatch".into());
        }
        if let Some(mut file) = output {
            use std::io::{Seek, SeekFrom};
            file.sync_all()
                .map_err(|_| "restore_flush_failed_partial_file_retained")?;
            file.seek(SeekFrom::Start(0))
                .map_err(|_| "restore_verification_failed")?;
            let mut actual = Context::new(&SHA256);
            let mut buffer = vec![0; CHUNK_SIZE];
            loop {
                let count = file
                    .read(&mut buffer)
                    .map_err(|_| "restore_verification_failed")?;
                if count == 0 {
                    break;
                }
                actual.update(&buffer[..count]);
            }
            if hex(actual.finish().as_ref()) != expected_hash {
                return Err("restore_verification_failed".into());
            }
        }
    }
    Ok(RestoreReport {
        snapshot_id: snapshot_id.into(),
        destination: destination.into(),
        bytes: expected_size,
        sha256: expected_hash,
        verified: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(directory: &Path, provider: &str) -> SourceRoot {
        let root = directory.join("sessions");
        fs::create_dir_all(&root).unwrap();
        SourceRoot {
            provider: provider.into(),
            source_id: "sessions".into(),
            root: root.canonicalize().unwrap(),
        }
    }

    #[test]
    fn database_lock_serializes_aliases_before_and_after_database_creation() -> Result<()> {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("hii.db");
        let alias = directory.path().join(".").join("hii.db");
        let owner = acquire_backup_lock(&database)?;
        assert_eq!(
            acquire_backup_lock(&alias).unwrap_err(),
            "session_backup_already_running"
        );
        drop(open_database(&database)?);
        assert_eq!(
            acquire_backup_lock(&alias).unwrap_err(),
            "session_backup_already_running"
        );
        drop(owner);
        drop(acquire_backup_lock(&alias)?);
        Ok(())
    }

    #[test]
    fn changed_timestamp_during_capture_forces_next_scan_to_recheck() -> Result<()> {
        let directory = tempfile::tempdir().unwrap();
        let source = source(directory.path(), "pi");
        let database = directory.path().join("hii.db");
        let path = source.root.join("session.jsonl");
        fs::write(&path, b"first\n").unwrap();
        let before = fs::metadata(&path).unwrap();
        fs::write(&path, b"other\n").unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(before.modified().unwrap() + Duration::from_secs(5)),
            )
            .unwrap();
        let mut db = open_database(&database)?;
        backup_file(&mut db, "mac", &source, &path, "session.jsonl", &before)?;
        let stamp: Option<String> = db
            .query_row(
                "SELECT observed_modified FROM session_backup_files",
                [],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        assert_eq!(stamp, None);
        drop(db);
        let rechecked = backup(&database, "mac", std::slice::from_ref(&source))?;
        assert_eq!(rechecked.files_backed_up, 1);
        assert_eq!(rechecked.chunks_added, 0);
        assert_eq!(backup(&database, "mac", &[source])?.files_unchanged, 1);
        Ok(())
    }

    #[test]
    fn incremental_chunks_preserve_append_truncate_and_exact_restore() -> Result<()> {
        let directory = tempfile::tempdir().unwrap();
        let source = source(directory.path(), "codex");
        let database = directory.path().join("hii.db");
        let path = source.root.join("rollout.jsonl");
        let mut original = vec![b'a'; CHUNK_SIZE];
        original.extend_from_slice(b"\n{\"partial\":\"\xc3\xa9");
        fs::write(&path, &original).unwrap();
        let first = backup(&database, "windows", std::slice::from_ref(&source))?;
        assert_eq!(first.files_backed_up, 1);
        assert_eq!(first.chunks_added, 2);
        assert!(first.errors.is_empty());
        let first_id = first.snapshots[0].snapshot_id.clone();
        let unchanged = backup(&database, "windows", std::slice::from_ref(&source))?;
        assert_eq!(unchanged.files_unchanged, 1);
        assert_eq!(unchanged.bytes_read, 0);
        assert_eq!(unchanged.chunks_added, 0);
        let mut appended = original.clone();
        appended.extend_from_slice(b"nd\"}\n");
        fs::write(&path, &appended).unwrap();
        let second = backup(&database, "windows", std::slice::from_ref(&source))?;
        assert_eq!(second.chunks_added, 1);
        assert_eq!(status(&database, None)?.snapshots, 2);
        fs::write(&path, b"short\n").unwrap();
        backup(&database, "windows", std::slice::from_ref(&source))?;
        assert_eq!(status(&database, None)?.snapshots, 3);
        let restored = directory.path().join("restored.jsonl");
        assert!(restore(&database, &first_id, &restored)?.verified);
        assert_eq!(fs::read(&restored).unwrap(), original);
        assert!(restore(&database, &second.snapshots[0].snapshot_id, &restored).is_err());
        assert_eq!(fs::read(&restored).unwrap(), original);
        let restored_append = directory.path().join("restored-append.jsonl");
        restore(
            &database,
            &second.snapshots[0].snapshot_id,
            &restored_append,
        )?;
        assert_eq!(fs::read(restored_append).unwrap(), appended);
        Ok(())
    }

    #[test]
    fn growing_source_captures_verified_prefix_and_next_run_captures_append() -> Result<()> {
        let directory = tempfile::tempdir().unwrap();
        let source = source(directory.path(), "claude");
        let database = directory.path().join("hii.db");
        let path = source.root.join("session.jsonl");
        fs::write(&path, b"first\n").unwrap();
        let before = fs::metadata(&path).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"second\n")
            .unwrap();
        let mut db = open_database(&database)?;
        let (captured, _) =
            backup_file(&mut db, "mac", &source, &path, "session.jsonl", &before)?.unwrap();
        assert!(captured.source_grew_during_capture);
        assert_eq!(captured.bytes, 6);
        drop(db);
        let restored = directory.path().join("prefix.jsonl");
        restore(&database, &captured.snapshot_id, &restored)?;
        assert_eq!(fs::read(restored).unwrap(), b"first\n");
        let next = backup(&database, "mac", &[source])?;
        assert_eq!(next.files_backed_up, 1);
        assert_eq!(next.snapshots[0].bytes, 13);
        Ok(())
    }

    #[test]
    fn excludes_credentials_and_counts_missing_roots_without_erasing_history() -> Result<()> {
        let directory = tempfile::tempdir().unwrap();
        let source = source(directory.path(), "pi");
        let database = directory.path().join("hii.db");
        for name in [
            "auth.json",
            "config.json",
            "credentials.jsonl",
            "settings.jsonl",
        ] {
            fs::write(source.root.join(name), "excluded fixture").unwrap();
        }
        fs::create_dir(source.root.join("subagents")).unwrap();
        fs::write(source.root.join("subagents/session.jsonl"), "raw fixture\n").unwrap();
        let first = backup(&database, "device", std::slice::from_ref(&source))?;
        assert_eq!(first.files_scanned, 1);
        assert_eq!(first.entries_skipped, 4);
        assert_eq!(first.snapshots[0].relative_path, "subagents/session.jsonl");
        let missing = SourceRoot {
            root: directory.path().join("missing"),
            ..source.clone()
        };
        let second = backup(&database, "device", &[missing])?;
        assert_eq!(second.sources_missing, 1);
        assert_eq!(status(&database, Some("device"))?.files, 1);
        assert_eq!(list(&database, Some("codex"))?.len(), 0);
        assert_eq!(list(&database, Some("pi"))?.len(), 1);
        Ok(())
    }

    #[test]
    fn corrupt_chunk_is_detected_before_creating_restore_destination() -> Result<()> {
        let directory = tempfile::tempdir().unwrap();
        let source = source(directory.path(), "codex");
        let database = directory.path().join("hii.db");
        fs::write(source.root.join("session.jsonl"), b"original\n").unwrap();
        let captured = backup(&database, "device", &[source])?;
        let db = open_database(&database)?;
        db.execute(
            "UPDATE session_backup_chunks SET data=?1",
            [b"corrupt".as_slice()],
        )
        .unwrap();
        drop(db);
        let destination = directory.path().join("restored.jsonl");
        assert_eq!(
            restore(&database, &captured.snapshots[0].snapshot_id, &destination).unwrap_err(),
            "session_backup_checksum_mismatch"
        );
        assert!(!destination.exists());
        Ok(())
    }

    #[test]
    fn provider_and_device_namespaces_share_chunks_without_sharing_identity() -> Result<()> {
        let directory = tempfile::tempdir().unwrap();
        let source = source(directory.path(), "codex");
        let database = directory.path().join("hii.db");
        fs::write(source.root.join("session.jsonl"), b"same bytes\n").unwrap();
        backup(&database, "mac", std::slice::from_ref(&source))?;
        backup(&database, "windows", std::slice::from_ref(&source))?;
        backup(
            &database,
            "mac",
            &[SourceRoot {
                provider: "claude".into(),
                ..source
            }],
        )?;
        let all = status(&database, None)?;
        assert_eq!(all.files, 3);
        assert_eq!(all.snapshots, 3);
        assert_eq!(all.unique_chunks, 1);
        assert_eq!(all.stored_bytes, 11);
        assert_eq!(status(&database, Some("mac"))?.files, 2);
        Ok(())
    }

    #[test]
    fn archive_coexists_with_hii_schema_and_supports_empty_session() -> Result<()> {
        let directory = tempfile::tempdir().unwrap();
        let source = source(directory.path(), "pi");
        let database = directory.path().join("hii.db");
        {
            let db = Connection::open(&database).unwrap();
            db.execute_batch("PRAGMA user_version=42; CREATE TABLE existing_hii (value TEXT); INSERT INTO existing_hii VALUES ('preserved');").unwrap();
        }
        fs::write(source.root.join("empty.jsonl"), b"").unwrap();
        let captured = backup(&database, "device", &[source])?;
        let db = open_database(&database)?;
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            42
        );
        assert_eq!(
            db.query_row("SELECT value FROM existing_hii", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "preserved"
        );
        drop(db);
        let destination = directory.path().join("restored.jsonl");
        assert_eq!(
            restore(&database, &captured.snapshots[0].snapshot_id, &destination)?.bytes,
            0
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&database).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        Ok(())
    }

    #[test]
    fn linked_directories_and_source_ancestors_are_never_traversed() -> Result<()> {
        let directory = tempfile::tempdir().unwrap();
        let source = source(directory.path(), "claude");
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("private.jsonl"), b"outside fixture").unwrap();
        let link = source.root.join("linked");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        {
            let result = std::process::Command::new("cmd.exe")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .output()
                .unwrap();
            assert!(result.status.success(), "fixture junction creation failed");
        }
        let database = directory.path().join("hii.db");
        let report = backup(&database, "device", std::slice::from_ref(&source))?;
        assert_eq!(report.entries_skipped, 1);
        assert_eq!(report.files_scanned, 0);
        fs::create_dir(outside.join("child")).unwrap();
        let aliased = SourceRoot {
            root: link.join("child"),
            ..source
        };
        let report = backup(&database, "device", &[aliased])?;
        assert_eq!(report.entries_skipped, 1);
        assert_eq!(report.files_scanned, 0);
        #[cfg(windows)]
        fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        fs::remove_file(&link).unwrap();
        Ok(())
    }
}
