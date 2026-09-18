//! Bounded model observations with workspace-scoped, private, retrievable evidence.
use crate::{receipt::redact_text, tools::ToolResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const PREVIEW_BYTES: usize = 12 * 1024;
const MAX_RECORD_BYTES: u64 = 2 * 1024 * 1024;
const MAX_STORE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PAGE_BYTES: usize = 16 * 1024;

pub fn is_runtime_read(tool: &str) -> bool {
    matches!(
        tool,
        "mcp_search" | "mcp_schema" | "artifact_read" | "checkpoint_read"
    )
}

/// Shared serial dispatch for tools whose scope is the current session/runtime.
pub fn execute_read(
    runtime: &Path,
    workspace: &Path,
    clients: &crate::mcp_client::McpClients,
    tool: &str,
    query: Option<&str>,
    arguments: Option<&serde_json::Value>,
    limit: Option<usize>,
) -> ToolResult {
    let arguments = arguments.cloned().unwrap_or(serde_json::Value::Null);
    let result = match tool {
        "mcp_search" => clients.search_tools(query.unwrap_or(""), limit.unwrap_or(6)),
        "mcp_schema" => match (arguments["server"].as_str(), arguments["tool"].as_str()) {
            (Some(server), Some(tool)) => clients.tool_schema(server, tool),
            _ => Err("mcp_schema requires arguments.server and arguments.tool strings".into()),
        },
        "artifact_read" | "checkpoint_read" => {
            let Some(id) = arguments["id"].as_str() else {
                return ToolResult {
                    ok: false,
                    verification: false,
                    output: format!("{tool} requires arguments.id"),
                };
            };
            let offset = match unsigned(&arguments, "offset", 0) {
                Ok(value) => value,
                Err(output) => {
                    return ToolResult {
                        ok: false,
                        verification: false,
                        output,
                    }
                }
            };
            let limit = match unsigned(
                &arguments,
                "limit",
                if tool == "checkpoint_read" {
                    4096
                } else {
                    8192
                },
            ) {
                Ok(value) => value,
                Err(output) => {
                    return ToolResult {
                        ok: false,
                        verification: false,
                        output,
                    }
                }
            };
            return if tool == "checkpoint_read" {
                crate::context_budget::read_checkpoint(runtime, workspace, id, offset, limit)
            } else {
                read(runtime, workspace, id, offset, limit)
            };
        }
        _ => Err(format!("unknown runtime read: {tool}")),
    };
    match result {
        Ok(output) => ToolResult {
            ok: true,
            verification: false,
            output,
        },
        Err(output) => ToolResult {
            ok: false,
            verification: false,
            output,
        },
    }
}

fn unsigned(arguments: &serde_json::Value, key: &str, default: usize) -> Result<usize, String> {
    match arguments.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| format!("artifact {key} must be a non-negative integer")),
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    version: u8,
    id: String,
    source: String,
    created_at: String,
    ok: bool,
    verification: bool,
    sha256: String,
    output: String,
}

/// Bound observations without converting a failed tool/check into a successful one.
/// Storage is best effort: if unavailable, say what was omitted and why.
pub fn bound_result(
    runtime: &Path,
    workspace: &Path,
    source: &str,
    mut result: ToolResult,
) -> ToolResult {
    result.output = redact_text(&result.output);
    if result.output.len() <= PREVIEW_BYTES {
        return result;
    }
    let reference = persist(runtime, workspace, source, &result);
    let original_bytes = result.output.len();
    let head = crate::text::clip_bytes(&result.output, PREVIEW_BYTES / 2);
    let tail_start = ceil_boundary(
        &result.output,
        original_bytes.saturating_sub(PREVIEW_BYTES / 2),
    );
    let tail = &result.output[tail_start..];
    result.output = match reference {
        Ok(id) => format!("{head}\n[observation shortened; {original_bytes} bytes retained in artifact {id}; use artifact_read with arguments {{\"id\":\"{id}\",\"offset\":0,\"limit\":8192}}. Byte offsets refer to the redacted original output.]\n{tail}"),
        Err(error) => format!("{head}\n[observation shortened; full output NOT retained: {}]\n{tail}", redact_text(&error)),
    };
    result
}

/// Artifact retrieval is observation, never a new passing verification.
pub fn read(runtime: &Path, workspace: &Path, id: &str, offset: usize, limit: usize) -> ToolResult {
    let result = (|| {
        if uuid::Uuid::parse_str(id).is_err() || id.len() != 36 {
            return Err("invalid tool artifact ID".into());
        }
        if limit == 0 || limit > MAX_PAGE_BYTES {
            return Err(format!("artifact limit must be 1..={MAX_PAGE_BYTES} bytes"));
        }
        let directory = directory(runtime, workspace, false)?;
        let path = directory.join(format!("{id}.json"));
        check_path(&path, false, true)?;
        let file = fs::File::open(&path).map_err(|error| error.to_string())?;
        if file.metadata().map_err(|error| error.to_string())?.len() > MAX_RECORD_BYTES {
            return Err("tool artifact exceeds size limit".into());
        }
        let mut data = Vec::new();
        file.take(MAX_RECORD_BYTES + 1)
            .read_to_end(&mut data)
            .map_err(|error| error.to_string())?;
        if data.len() as u64 > MAX_RECORD_BYTES {
            return Err("tool artifact exceeds size limit".into());
        }
        let record: Record = serde_json::from_slice(&data)
            .map_err(|error| format!("invalid tool artifact: {error}"))?;
        if record.version != 1
            || record.id != id
            || record.sha256 != digest(record.output.as_bytes())
        {
            return Err("tool artifact identity or checksum mismatch".into());
        }
        if offset > record.output.len() || !record.output.is_char_boundary(offset) {
            return Err("artifact offset must be a UTF-8 boundary within the output; use nextOffset from the previous page".into());
        }
        let mut end = offset.saturating_add(limit).min(record.output.len());
        while !record.output.is_char_boundary(end) {
            end -= 1;
        }
        if end == offset && end < record.output.len() {
            end = ceil_boundary(&record.output, end + 1);
        }
        Ok(serde_json::json!({"artifactId":id,"source":record.source,"sha256":record.sha256,"originalOk":record.ok,"originalVerification":record.verification,"offset":offset,"endOffset":end,"nextOffset":if end < record.output.len(){Some(end)}else{None},"totalBytes":record.output.len(),"output":&record.output[offset..end]}).to_string())
    })();
    match result {
        Ok(output) => ToolResult {
            ok: true,
            output,
            verification: false,
        },
        Err(output) => ToolResult {
            ok: false,
            output,
            verification: false,
        },
    }
}

fn persist(
    runtime: &Path,
    workspace: &Path,
    source: &str,
    result: &ToolResult,
) -> Result<String, String> {
    if result.output.len() as u64 > MAX_RECORD_BYTES / 2 {
        return Err("output exceeds bounded artifact storage limit".into());
    }
    let directory = directory(runtime, workspace, true)?;
    let id = uuid::Uuid::new_v4().to_string();
    let record = Record {
        version: 1,
        id: id.clone(),
        source: redact_text(&crate::text::clip_bytes(source, 256)),
        created_at: chrono::Utc::now().to_rfc3339(),
        ok: result.ok,
        verification: result.verification,
        sha256: digest(result.output.as_bytes()),
        output: result.output.clone(),
    };
    let bytes = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err("encoded artifact exceeds size limit".into());
    }
    let mut used = 0u64;
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        used = used.saturating_add(entry.metadata().map_err(|error| error.to_string())?.len());
        if used.saturating_add(bytes.len() as u64) > MAX_STORE_BYTES {
            return Err(
                "workspace tool artifact quota reached (64 MiB); existing evidence was preserved"
                    .into(),
            );
        }
    }
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(directory.join(format!("{id}.json")))
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(id)
}

fn directory(runtime: &Path, workspace: &Path, create: bool) -> Result<PathBuf, String> {
    let workspace = workspace
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let mut path = runtime.canonicalize().map_err(|error| error.to_string())?;
    let scope = digest(workspace.to_string_lossy().as_bytes());
    for component in ["artifacts", "tool-output", scope.as_str()] {
        path.push(component);
        if create && !path.exists() {
            let builder = fs::DirBuilder::new();
            #[cfg(unix)]
            let builder = {
                use std::os::unix::fs::DirBuilderExt;
                let mut builder = builder;
                builder.mode(0o700);
                builder
            };
            match builder.create(&path) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(error) => return Err(error.to_string()),
            }
        }
        check_path(&path, true, component != "artifacts")?;
    }
    Ok(path)
}

fn check_path(path: &Path, directory: bool, private: bool) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err("tool artifact path must be a regular file/directory, never a symlink".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("tool artifact path must not be a junction or reparse point".into());
        }
        let _ = private;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let mask = if private { 0o077 } else { 0o022 };
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.permissions().mode() & mask != 0
        {
            return Err("tool artifact state must be private to the current user".into());
        }
    }
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn ceil_boundary(text: &str, mut offset: usize) -> usize {
    while offset < text.len() && !text.is_char_boundary(offset) {
        offset += 1;
    }
    offset
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_verification_keeps_status_and_retrieves_complete_unicode_evidence() {
        let runtime = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let original = "évidence\n".repeat(4000);
        let result = bound_result(
            runtime.path(),
            workspace.path(),
            "verify",
            ToolResult {
                ok: false,
                verification: true,
                output: original.clone(),
            },
        );
        assert!(!result.ok);
        assert!(result.verification);
        assert!(result.output.len() < original.len());
        let directory = directory(runtime.path(), workspace.path(), false).unwrap();
        let file = fs::read_dir(directory)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let id = file.file_stem().unwrap().to_str().unwrap();
        let mut offset = 0;
        let mut assembled = String::new();
        loop {
            let page = read(runtime.path(), workspace.path(), id, offset, 101);
            assert!(page.ok, "{}", page.output);
            assert!(!page.verification);
            let value: serde_json::Value = serde_json::from_str(&page.output).unwrap();
            assert_eq!(value["originalOk"], false);
            assembled.push_str(value["output"].as_str().unwrap());
            match value["nextOffset"].as_u64() {
                Some(next) => offset = next as usize,
                None => break,
            }
        }
        assert_eq!(assembled, redact_text(&original));
        let other = tempfile::tempdir().unwrap();
        assert!(!read(runtime.path(), other.path(), id, 0, 10).ok);
        assert!(!read(runtime.path(), workspace.path(), "../escape", 0, 10).ok);
    }

    #[test]
    fn storage_failure_does_not_claim_retrievability_or_change_outcome() {
        let workspace = tempfile::tempdir().unwrap();
        let result = bound_result(
            &workspace.path().join("missing"),
            workspace.path(),
            "read",
            ToolResult {
                ok: true,
                verification: false,
                output: "x".repeat(20_000),
            },
        );
        assert!(result.ok);
        assert!(result.output.contains("NOT retained"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_artifact_directory() {
        let runtime = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(workspace.path(), runtime.path().join("artifacts")).unwrap();
        assert!(directory(runtime.path(), workspace.path(), true).is_err());
    }
}
