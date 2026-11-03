//! Bounded native file search and application launch helpers.
//!
//! Search reads the operating system's existing index. Opening a path only
//! reports whether the native launcher accepted the request; it cannot prove
//! that an application loaded the document.

use serde::Serialize;
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_LIMIT: usize = 100;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub query: String,
    pub root: Option<String>,
    pub indexed_scope: bool,
    pub fallback_used: bool,
    pub truncated: bool,
    pub results: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct OpenResult {
    pub path: String,
    pub app: Option<String>,
    pub launched: bool,
    pub message: String,
}

/// Search the system index, optionally restricted to a directory. Results are
/// ranked by filename match and then path, with a hard cap on returned rows.
pub fn search(query: &str, limit: usize, root: Option<&Path>) -> Result<SearchResult, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("search query cannot be empty".into());
    }
    if limit == 0 {
        return Err("search limit must be at least 1".into());
    }
    let limit = limit.min(MAX_LIMIT);
    let root = root
        .map(|path| {
            let resolved = path
                .canonicalize()
                .map_err(|e| format!("could not resolve search root: {e}"))?;
            if !resolved.is_dir() {
                return Err(format!(
                    "search root is not a directory: {}",
                    resolved.display()
                ));
            }
            Ok(resolved)
        })
        .transpose()?;

    #[cfg(target_os = "macos")]
    let (mut paths, timed_out, output_capped) = mac_search(query, root.as_deref())?;
    #[allow(unused_mut)]
    let mut fallback_timed_out = false;
    #[allow(unused_mut)]
    let mut fallback_used = false;
    #[cfg(target_os = "macos")]
    if paths.is_empty() {
        if let Some(root) = root.as_deref() {
            fallback_used = true;
            let (fallback, capped) = root_filename_fallback(query, root);
            paths = fallback;
            fallback_timed_out = capped;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let (mut paths, timed_out, output_capped) = platform_search(query, root.as_deref())?;

    let needle = query.to_lowercase();
    paths.sort_by_key(|path| {
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let rank = if name == needle {
            0
        } else if name.starts_with(&needle) {
            1
        } else if name.contains(&needle) {
            2
        } else {
            3
        };
        (rank, path.to_string_lossy().to_lowercase())
    });
    paths.dedup();
    let truncated = timed_out || output_capped || fallback_timed_out || paths.len() > limit;
    paths.truncate(limit);
    Ok(SearchResult {
        query: query.to_string(),
        root: root.as_deref().map(|p| p.display().to_string()),
        indexed_scope: true,
        fallback_used,
        truncated,
        results: paths.into_iter().map(|p| p.display().to_string()).collect(),
    })
}

#[cfg(target_os = "macos")]
fn root_filename_fallback(query: &str, root: &Path) -> (Vec<PathBuf>, bool) {
    const MAX_ENTRIES: usize = 5000;
    const WALK_TIMEOUT: Duration = Duration::from_secs(2);
    let needle = query.to_lowercase();
    let started = Instant::now();
    let mut seen = 0usize;
    let mut matches = Vec::new();
    for entry in ignore::WalkBuilder::new(root).hidden(false).build() {
        if seen >= MAX_ENTRIES || started.elapsed() >= WALK_TIMEOUT {
            return (matches, true);
        }
        seen += 1;
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        if entry
            .file_name()
            .to_string_lossy()
            .to_lowercase()
            .contains(&needle)
        {
            matches.push(entry.into_path());
        }
    }
    (matches, false)
}

/// Launch the registered application for an existing path. On macOS, `app`
/// is passed as the value to `open -a` without shell interpretation.
pub fn open(path: &Path, app: Option<&str>) -> Result<OpenResult, String> {
    if !path.exists() {
        return Err(format!("path does not exist: {}", path.display()));
    }
    let path = path
        .canonicalize()
        .map_err(|e| format!("could not resolve path: {e}"))?;
    if app.is_some_and(|name| name.trim().is_empty()) {
        return Err("application name cannot be empty".into());
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = Command::new("open");
        if let Some(app) = app {
            c.args(["-a", app]);
        }
        c.arg(&path);
        c
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        if app.is_some() {
            return Err("--app is currently supported only on macOS".into());
        }
        let mut c = Command::new("xdg-open");
        c.arg(&path);
        c
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        if app.is_some() {
            return Err("--app is currently supported only on macOS".into());
        }
        let mut c = Command::new("explorer.exe");
        c.arg(&path);
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    return Err("native open is unsupported on this platform".into());

    let status = command
        .status()
        .map_err(|e| format!("could not start native opener: {e}"))?;
    let launched = status.success();
    let message = if launched {
        "native launcher accepted the request; document load was not verified".into()
    } else {
        format!("native launcher exited with {status}")
    };
    Ok(OpenResult {
        path: path.display().to_string(),
        app: app.map(str::to_string),
        launched,
        message,
    })
}

pub fn render_search(result: &SearchResult, json: bool) -> Result<String, String> {
    if json {
        return serde_json::to_string_pretty(result).map_err(|e| e.to_string());
    }
    if result.results.is_empty() {
        return Ok(format!("No indexed results for {:?}.", result.query));
    }
    let mut lines = result.results.clone();
    if result.truncated {
        lines.push("(results bounded; refine the query or root)".into());
    }
    Ok(lines.join("\n"))
}

pub fn render_open(result: &OpenResult, json: bool) -> Result<String, String> {
    if json {
        return serde_json::to_string_pretty(result).map_err(|e| e.to_string());
    }
    Ok(result.message.clone())
}

#[cfg(target_os = "macos")]
fn mac_search(query: &str, root: Option<&Path>) -> Result<(Vec<PathBuf>, bool, bool), String> {
    // Escape the Spotlight query-language string literal. Passing this as one
    // argv value avoids shell parsing; escaping also prevents query operators.
    let literal = query
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('*', "\\*")
        .replace('?', "\\?");
    let expression =
        format!("(kMDItemFSName == \"*{literal}*\"cd || kMDItemTextContent == \"*{literal}*\"cd)");
    let mut cmd = Command::new("mdfind");
    if let Some(root) = root {
        cmd.args(["-onlyin"]).arg(root);
    }
    let mut child = cmd
        .arg(expression)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start Spotlight search: {e}"))?;
    // Drain both pipes concurrently so a broad query cannot block mdfind on a
    // full pipe. Retain only bounded output while continuing to drain.
    let mut stdout = child.stdout.take().expect("piped stdout");
    let stdout_reader = thread::spawn(move || {
        let mut kept = Vec::new();
        let mut capped = false;
        let mut buf = [0u8; 8192];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let remaining = 4 * 1024 * 1024usize - kept.len();
                    kept.extend_from_slice(&buf[..n.min(remaining)]);
                    capped |= n > remaining;
                }
            }
        }
        (kept, capped)
    });
    let mut stderr = child.stderr.take().expect("piped stderr");
    let stderr_reader = thread::spawn(move || {
        let mut kept = Vec::new();
        let mut buf = [0u8; 1024];
        loop {
            match stderr.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let remaining = 4096usize - kept.len();
                    kept.extend_from_slice(&buf[..n.min(remaining)]);
                }
            }
        }
        kept
    });
    let started = Instant::now();
    let mut timed_out = false;
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if started.elapsed() >= SEARCH_TIMEOUT {
            timed_out = true;
            let _ = child.kill();
            break;
        }
        thread::sleep(Duration::from_millis(30));
    }
    let status = child
        .wait()
        .map_err(|e| format!("could not wait for Spotlight: {e}"))?;
    let (stdout, output_capped) = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    if !status.success() && !timed_out {
        return Err(format!(
            "Spotlight search failed: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    let paths = String::from_utf8_lossy(&stdout)
        .lines()
        .map(PathBuf::from)
        .collect();
    Ok((paths, timed_out, output_capped))
}

#[cfg(not(target_os = "macos"))]
fn platform_search(query: &str, root: Option<&Path>) -> Result<(Vec<PathBuf>, bool, bool), String> {
    let _ = (query, root);
    Err("indexed file search is currently available on macOS only".into())
}
