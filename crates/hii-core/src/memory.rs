// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Local file memory over HII's canonical operational graph.
//! A reference is committed before bytes are copied. The original file is never changed.

use crate::operational;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const SPACE: &str = "hii-memory";

fn open(runtime: &Path) -> Result<Connection, String> {
    let connection = operational::database(runtime)?;
    operational::migrate(&connection)?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS memory_versions (
           object_id TEXT NOT NULL,
           version INTEGER NOT NULL,
           hash TEXT NOT NULL,
           size INTEGER NOT NULL,
           captured_at TEXT NOT NULL,
           PRIMARY KEY(object_id, version),
           FOREIGN KEY(object_id) REFERENCES operational_objects(id)
         );
         CREATE TABLE IF NOT EXISTS memory_watches (
           path TEXT PRIMARY KEY,
           kind TEXT NOT NULL CHECK(kind IN ('file','folder')),
           added_at TEXT NOT NULL
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
           object_id UNINDEXED, path, content
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_file_source_path
           ON operational_objects(json_extract(properties_json,'$.path'))
           WHERE space_id='hii-memory' AND type='memory-file' AND deleted_at IS NULL;",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn absolute_file(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("Expected a regular file: {}", path.display()));
    }
    fs::canonicalize(path).map_err(|error| error.to_string())
}

fn operation(
    connection: &Connection,
    object_id: &str,
    kind: &str,
    payload: &Value,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    connection.execute(
        "INSERT INTO operational_operations
         (id,space_id,actor_id,type,target_id,lamport,payload_json,created_at,provenance_class,authority_json)
         VALUES (?1,?2,'human:local',?3,?4,
           (SELECT COALESCE(MAX(lamport),0)+1 FROM operational_operations WHERE space_id=?2),
           ?5,?6,'human_authored','{\"authority\":\"local-file-save\"}')",
        params![Uuid::now_v7().to_string(), SPACE, kind, object_id, payload.to_string(), now],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn reference(connection: &mut Connection, path: &Path) -> Result<String, String> {
    let path_string = path.to_string_lossy().to_string();
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT id FROM operational_objects
         WHERE space_id=?1 AND type='memory-file' AND deleted_at IS NULL
         AND json_extract(properties_json,'$.path')=?2 LIMIT 1",
            params![SPACE, path_string],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = Uuid::now_v7().to_string();
    let now = Utc::now().to_rfc3339();
    let properties = json!({
        "path": path_string, "name": path.file_name().unwrap_or_default().to_string_lossy(),
        "status": "referenced", "latestVersion": 0
    });
    tx.execute(
        "INSERT INTO operational_objects
         (id,space_id,type,schema_version,properties_json,provenance_json,
          owner_actor_id,created_at,updated_at,semantic_version,canonical_source,provenance_class)
         VALUES (?1,?2,'memory-file',1,?3,?4,'human:local',?5,?5,1,'graph','human_authored')",
        params![
            id,
            SPACE,
            properties.to_string(),
            json!({"source":"local-file","path":path_string}).to_string(),
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    operation(
        &tx,
        &id,
        "memory.file.referenced",
        &json!({"path":path_string}),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut source = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = source.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn preserve(runtime: &Path, source: &Path) -> Result<(String, u64), String> {
    let before = fs::metadata(source).map_err(|e| e.to_string())?;
    let tmp_dir = runtime.join("memory/tmp");
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(&tmp_dir).map_err(|e| e.to_string())?;
    let mut input = File::open(source).map_err(|e| e.to_string())?;
    let mut hasher = blake3::Hasher::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        temporary
            .write_all(&buffer[..n])
            .map_err(|e| e.to_string())?;
        hasher.update(&buffer[..n]);
        size += n as u64;
    }
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    let after = fs::metadata(source).map_err(|e| e.to_string())?;
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || size != after.len()
    {
        return Err(format!(
            "Source changed during capture: {}",
            source.display()
        ));
    }
    let hash = hasher.finalize().to_hex().to_string();
    let target = runtime
        .join("memory/blobs/blake3")
        .join(&hash[..2])
        .join(&hash);
    fs::create_dir_all(target.parent().expect("hash target parent")).map_err(|e| e.to_string())?;
    if target.exists() {
        if hash_file(&target)? != hash {
            return Err(format!("Stored blob failed verification: {hash}"));
        }
    } else if let Err(error) = temporary.persist_noclobber(&target) {
        if error.error.kind() != std::io::ErrorKind::AlreadyExists || hash_file(&target)? != hash {
            return Err(error.error.to_string());
        }
    }
    Ok((hash, size))
}

/// Reference a selected file, then preserve a verified immutable copy.
/// An interrupted copy leaves an inspectable reference rather than a false version.
pub fn save(runtime: &Path, path: &Path) -> Result<Value, String> {
    let path = absolute_file(path)?;
    if path.starts_with(runtime) {
        return Err("Cannot capture HII's own runtime directory".into());
    }
    let mut connection = open(runtime)?;
    let id = reference(&mut connection, &path)?;
    let (hash, size) = preserve(runtime, &path)?;
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    let latest: Option<(i64, String)> = tx.query_row(
        "SELECT version,hash FROM memory_versions WHERE object_id=?1 ORDER BY version DESC LIMIT 1",
        [&id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|e| e.to_string())?;
    if let Some((version, old_hash)) = &latest {
        if old_hash == &hash {
            return Ok(
                json!({"id":id,"path":path,"version":version,"hash":hash,"changed":false,"status":"preserved"}),
            );
        }
    }
    let version = latest.map_or(1, |(number, _)| number + 1);
    let now = Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO memory_versions (object_id,version,hash,size,captured_at) VALUES (?1,?2,?3,?4,?5)",
        params![id, version, hash, size as i64, now],
    ).map_err(|e| e.to_string())?;
    let properties = json!({
        "path":path, "name":path.file_name().unwrap_or_default().to_string_lossy(),
        "status":"preserved", "latestVersion":version, "latestHash":hash, "size":size
    });
    tx.execute(
        "UPDATE operational_objects SET properties_json=?2,updated_at=?3,
         semantic_version=semantic_version+1 WHERE id=?1",
        params![id, properties.to_string(), now],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM memory_fts WHERE object_id=?1", [&id])
        .map_err(|e| e.to_string())?;
    let content = if size <= 1024 * 1024 {
        let blob = runtime
            .join("memory/blobs/blake3")
            .join(&hash[..2])
            .join(&hash);
        fs::read(&blob)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .unwrap_or_default()
    } else {
        String::new()
    };
    tx.execute(
        "INSERT INTO memory_fts(object_id,path,content) VALUES (?1,?2,?3)",
        params![id, path.to_string_lossy(), content],
    )
    .map_err(|e| e.to_string())?;
    operation(
        &tx,
        &id,
        "memory.file.version.saved",
        &json!({
            "version":version,"hash":hash,"size":size,"sourcePath":path
        }),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(
        json!({"id":id,"path":path,"version":version,"hash":hash,"changed":true,"status":"preserved"}),
    )
}

pub fn watch(runtime: &Path, path: &Path) -> Result<Value, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Symlink watches are not supported".into());
    }
    let kind = if metadata.is_dir() {
        "folder"
    } else if metadata.is_file() {
        "file"
    } else {
        return Err("Watch path must be a file or folder".into());
    };
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if path.starts_with(runtime) {
        return Err("Cannot watch HII's own runtime directory".into());
    }
    let connection = open(runtime)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO memory_watches(path,kind,added_at) VALUES (?1,?2,?3)",
            params![path.to_string_lossy(), kind, Utc::now().to_rfc3339()],
        )
        .map_err(|e| e.to_string())?;
    Ok(json!({"path":path,"kind":kind,"watching":true}))
}

/// Reconciliation scan. Safe to run repeatedly or from a scheduler.
pub fn scan(runtime: &Path) -> Result<Value, String> {
    let connection = open(runtime)?;
    let mut statement = connection
        .prepare("SELECT path,kind FROM memory_watches ORDER BY path")
        .map_err(|e| e.to_string())?;
    let watches: Vec<(String, String)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(statement);
    drop(connection);
    let mut checked = 0u64;
    let mut changed = 0u64;
    let mut errors = Vec::new();
    for (path, kind) in watches {
        let files: Vec<PathBuf> = if kind == "file" {
            vec![PathBuf::from(path)]
        } else {
            walkdir::WalkDir::new(&path)
                .follow_links(false)
                .into_iter()
                .filter_map(|entry| match entry {
                    Ok(entry) if entry.file_type().is_file() => Some(entry.path().to_path_buf()),
                    Ok(_) => None,
                    Err(error) => {
                        errors.push(error.to_string());
                        None
                    }
                })
                .collect()
        };
        for file in files {
            if file.starts_with(runtime) {
                continue;
            }
            checked += 1;
            match save(runtime, &file) {
                Ok(value) => {
                    if value["changed"] == true {
                        changed += 1;
                    }
                }
                Err(error) => errors.push(format!("{}: {error}", file.display())),
            }
        }
    }
    Ok(json!({"checked":checked,"changed":changed,"errors":errors}))
}

pub fn get(runtime: &Path, id: &str) -> Result<Value, String> {
    let connection = open(runtime)?;
    let raw: String = connection
        .query_row(
            "SELECT properties_json FROM operational_objects WHERE id=?1 AND space_id=?2
         AND type='memory-file' AND deleted_at IS NULL",
            params![id, SPACE],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    value["id"] = json!(id);
    Ok(value)
}

pub fn versions(runtime: &Path, id: &str) -> Result<Vec<Value>, String> {
    get(runtime, id)?;
    let connection = open(runtime)?;
    let mut statement = connection.prepare(
        "SELECT version,hash,size,captured_at FROM memory_versions WHERE object_id=?1 ORDER BY version DESC"
    ).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([id], |row| {
            Ok(json!({
                "version":row.get::<_,i64>(0)?,"hash":row.get::<_,String>(1)?,
                "size":row.get::<_,i64>(2)?,"capturedAt":row.get::<_,String>(3)?
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn search(runtime: &Path, query: &str, limit: usize) -> Result<Vec<Value>, String> {
    let words: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .take(8)
        .map(|word| format!("\"{}\"", word))
        .collect();
    if words.is_empty() {
        return Ok(Vec::new());
    }
    let connection = open(runtime)?;
    let mut statement = connection
        .prepare(
            "SELECT o.id,o.properties_json FROM memory_fts
         JOIN operational_objects o ON o.id=memory_fts.object_id
         WHERE memory_fts MATCH ?1 AND o.deleted_at IS NULL
         ORDER BY rank LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![words.join(" AND "), limit.min(100) as i64], |row| {
            let id: String = row.get(0)?;
            let raw: String = row.get(1)?;
            let mut value: Value = serde_json::from_str(&raw).unwrap_or_default();
            value["id"] = json!(id);
            Ok(value)
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn restore(runtime: &Path, id: &str, version: i64, output: &Path) -> Result<Value, String> {
    get(runtime, id)?;
    let connection = open(runtime)?;
    let hash: String = connection
        .query_row(
            "SELECT hash FROM memory_versions WHERE object_id=?1 AND version=?2",
            params![id, version],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid stored blob hash".into());
    }
    let blob = runtime
        .join("memory/blobs/blake3")
        .join(&hash[..2])
        .join(&hash);
    if hash_file(&blob)? != hash {
        return Err("Stored blob failed verification".into());
    }
    if output.exists() {
        return Err(format!("Output already exists: {}", output.display()));
    }
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    let mut source = File::open(&blob).map_err(|e| e.to_string())?;
    std::io::copy(&mut source, &mut temporary).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary
        .persist_noclobber(output)
        .map_err(|e| e.error.to_string())?;
    Ok(json!({"id":id,"version":version,"output":output,"hash":hash,"verified":true}))
}

pub fn status(runtime: &Path) -> Result<Value, String> {
    let connection = open(runtime)?;
    let objects: i64 = connection.query_row(
        "SELECT COUNT(*) FROM operational_objects WHERE space_id=?1 AND type='memory-file' AND deleted_at IS NULL",
        [SPACE], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    let watches: i64 = connection
        .query_row("SELECT COUNT(*) FROM memory_watches", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    Ok(
        json!({"objects":objects,"watches":watches,"sync":"unavailable","encryption":"unavailable","cloudflareRequired":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn save_scan_search_restore_preserves_versions() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let source = temp.path().join("notes.txt");
        fs::write(&source, "first memory").unwrap();
        let first = save(&runtime, &source).unwrap();
        assert_eq!(first["version"], 1);
        assert_eq!(save(&runtime, &source).unwrap()["changed"], false);
        watch(&runtime, &source).unwrap();
        fs::write(&source, "second memory").unwrap();
        assert_eq!(scan(&runtime).unwrap()["changed"], 1);
        let id = first["id"].as_str().unwrap();
        assert_eq!(versions(&runtime, id).unwrap().len(), 2);
        assert_eq!(search(&runtime, "second", 10).unwrap().len(), 1);
        let output = temp.path().join("restored.txt");
        restore(&runtime, id, 1, &output).unwrap();
        assert_eq!(fs::read_to_string(&output).unwrap(), "first memory");
        assert!(restore(&runtime, id, 1, &output).is_err());
    }
}
