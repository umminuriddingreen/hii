use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_OUTPUT_BYTES: usize = 96 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 120;

#[derive(Debug, Serialize)]
pub struct ToolResult {
    pub ok: bool,
    pub output: String,
    pub verification: bool,
}

pub struct Toolbelt {
    workspace: PathBuf,
    ollama_http: ureq::Agent,
}

impl Toolbelt {
    pub fn new(workspace: PathBuf) -> Result<Self, String> {
        let workspace = workspace
            .canonicalize()
            .map_err(|error| format!("cannot open workspace {}: {error}", workspace.display()))?;
        if !workspace.is_dir() {
            return Err(format!(
                "workspace is not a directory: {}",
                workspace.display()
            ));
        }
        Ok(Self {
            workspace,
            ollama_http: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(30))
                .build(),
        })
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    /// Read a file, optionally windowed to `[offset, offset+limit)` lines
    /// (1-indexed, `cat -n` style). Large files are readable in slices instead
    /// of being rejected; binary files return a clear hint rather than an error
    /// the model cannot recover from.
    pub fn read_range(
        &self,
        path: &str,
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> ToolResult {
        let result = (|| {
            let path = self.resolve_existing(path)?;
            let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
            if !metadata.is_file() {
                return Err(format!("not a file: {}", path.display()));
            }
            let bytes = fs::read(&path).map_err(|error| error.to_string())?;
            let text = match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(_) => {
                    return Ok(format!(
                        "binary file ({} bytes); not readable as text. Use search for content or shell for a hex/metadata view.",
                        metadata.len()
                    ))
                }
            };
            let windowed = offset.is_some() || limit.is_some();
            if !windowed && metadata.len() > MAX_OUTPUT_BYTES as u64 {
                return Err(format!(
                    "file is {} KiB (> {} KiB); pass offset/limit to read a line range, or use search",
                    metadata.len() / 1024,
                    MAX_OUTPUT_BYTES / 1024
                ));
            }
            if !windowed {
                return Ok(text);
            }
            let start = offset.unwrap_or(1).max(1);
            let lines: Vec<&str> = text.lines().collect();
            let total = lines.len();
            if start > total {
                return Err(format!(
                    "offset {start} is past end of file ({total} lines)"
                ));
            }
            let take = limit.unwrap_or(total);
            let slice = lines
                .iter()
                .enumerate()
                .skip(start - 1)
                .take(take)
                .map(|(index, line)| format!("{:>6}\t{}", index + 1, line))
                .collect::<Vec<_>>()
                .join("\n");
            Ok(slice)
        })();
        tool_result(result, false)
    }

    /// Replace an exact, unique occurrence of `old` with `new`. Fails when the
    /// match is absent or ambiguous (unless `replace_all`), mirroring the
    /// discipline of an editor's precise edit rather than a blind rewrite.
    pub fn edit(&self, path: &str, old: &str, new: &str, replace_all: bool) -> ToolResult {
        let result = (|| {
            if old.is_empty() {
                return Err("edit requires a non-empty target string".into());
            }
            if old == new {
                return Err("edit target and replacement are identical".into());
            }
            let resolved = self.resolve_existing(path)?;
            self.ensure_inside(resolved.clone())?;
            let content = fs::read_to_string(&resolved)
                .map_err(|error| format!("cannot edit {}: {error}", resolved.display()))?;
            let count = content.matches(old).count();
            if count == 0 {
                return Err("edit target string was not found".into());
            }
            if count > 1 && !replace_all {
                return Err(format!(
                    "edit target is ambiguous: {count} matches. Add more context or set replace_all"
                ));
            }
            let updated = if replace_all {
                content.replace(old, new)
            } else {
                content.replacen(old, new, 1)
            };
            fs::write(&resolved, updated).map_err(|error| error.to_string())?;
            let relative = resolved.strip_prefix(&self.workspace).unwrap_or(&resolved);
            let replacements = if replace_all { count } else { 1 };
            let plural = if replacements == 1 { "" } else { "s" };
            Ok(format!(
                "edited {} ({replacements} replacement{plural})",
                relative.display()
            ))
        })();
        tool_result(result, false)
    }

    fn list_native(&self, base: &Path) -> Result<String, String> {
        let mut files = Vec::new();
        for entry in ignore::WalkBuilder::new(base)
            .hidden(false)
            .git_ignore(true)
            .build()
        {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry.file_type().is_some_and(|kind| kind.is_file()) {
                let path = entry.path();
                if path.components().any(|c| c.as_os_str() == ".git") {
                    continue;
                }
                let shown = path.strip_prefix(&self.workspace).unwrap_or(path);
                files.push(shown.display().to_string());
            }
        }
        files.sort();
        Ok(files.join("\n"))
    }

    fn search_native(&self, query: &str, base: &Path) -> Result<String, String> {
        let regex =
            regex::Regex::new(query).map_err(|error| format!("invalid pattern: {error}"))?;
        let mut hits = Vec::new();
        for entry in ignore::WalkBuilder::new(base)
            .hidden(false)
            .git_ignore(true)
            .build()
        {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                continue;
            }
            let path = entry.path();
            if path.components().any(|c| c.as_os_str() == ".git") {
                continue;
            }
            let Ok(content) = fs::read_to_string(path) else {
                continue;
            };
            let shown = path.strip_prefix(&self.workspace).unwrap_or(path);
            for (number, line) in content.lines().enumerate() {
                if regex.is_match(line) {
                    hits.push(format!("{}:{}:{}", shown.display(), number + 1, line));
                    if hits.len() >= 2000 {
                        return Ok(hits.join("\n"));
                    }
                }
            }
        }
        Ok(hits.join("\n"))
    }

    pub fn list(&self, path: Option<&str>) -> ToolResult {
        let base = match path {
            Some(path) => match self.resolve_existing(path) {
                Ok(path) => path,
                Err(error) => return tool_result(Err(error), false),
            },
            None => self.workspace.clone(),
        };
        // `rg --files` exits with status 1 when a directory contains no files.
        // An empty directory is a valid listing, not a tool failure, so use the
        // native ignore-aware walk whose empty result has the correct meaning.
        tool_result(self.list_native(&base), false)
    }

    pub fn search(&self, query: &str, path: Option<&str>) -> ToolResult {
        if query.trim().is_empty() {
            return tool_result(Err("search query cannot be empty".into()), false);
        }
        let relative = match path {
            Some(path) => match self.resolve_existing(path) {
                Ok(path) => path
                    .strip_prefix(&self.workspace)
                    .unwrap_or(Path::new("."))
                    .to_path_buf(),
                Err(error) => return tool_result(Err(error), false),
            },
            None => PathBuf::from("."),
        };
        if has_ripgrep() {
            let mut command = Command::new("rg");
            command.args(["-n", "--hidden", "-g", "!.git", "--"]);
            command.arg(query).arg(&relative);
            return self.run_command(command, false, DEFAULT_TIMEOUT_SECS);
        }
        let base = self.workspace.join(&relative);
        tool_result(self.search_native(query, &base), false)
    }

    /// Search the public web without giving the model a general-purpose
    /// network shell. Results are intentionally compact and retain their source
    /// URLs so the model can cite what it used.
    pub fn web_search(&self, query: &str) -> ToolResult {
        let query = query.trim();
        if query.is_empty() {
            return tool_result(Err("web search query cannot be empty".into()), false);
        }
        let result = (|| {
            let url = std::env::var("HII_WEB_SEARCH_URL")
                .ok()
                .filter(|value| {
                    value.starts_with("http://127.0.0.1:") || value.starts_with("http://localhost:")
                })
                .map(|value| format!("{value}?q={}", percent_encode(query)))
                .unwrap_or_else(|| {
                    format!(
                        "https://html.duckduckgo.com/html/?q={}",
                        percent_encode(query)
                    )
                });
            let response = self
                .ollama_http
                .get(&url)
                .set("User-Agent", "HII/0.1 (+local agent web search)")
                .call()
                .map_err(|error| format!("web search failed: {error}"))?;
            let mut bytes = Vec::new();
            response
                .into_reader()
                .take(MAX_OUTPUT_BYTES as u64)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            let html = String::from_utf8_lossy(&bytes);
            let results = parse_web_results(&html, 8);
            if results.is_empty() {
                return Err("web search returned no readable results".into());
            }
            Ok(results
                .into_iter()
                .enumerate()
                .map(|(index, (title, url, snippet))| {
                    format!("{}. {}\n   {}\n   {}", index + 1, title, url, snippet)
                })
                .collect::<Vec<_>>()
                .join("\n\n"))
        })();
        tool_result(result, false)
    }

    pub fn write(&self, path: &str, content: &str) -> ToolResult {
        let result = (|| {
            let path = self.resolve_write(path)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(&path, content).map_err(|error| error.to_string())?;
            let relative = path.strip_prefix(&self.workspace).unwrap_or(&path);
            Ok(format!(
                "wrote {} bytes to {}",
                content.len(),
                relative.display()
            ))
        })();
        tool_result(result, false)
    }

    pub fn shell(&self, command: &str, verification: bool) -> ToolResult {
        self.shell_with_delete_approval(command, verification, false)
    }

    pub fn shell_with_delete_approval(
        &self,
        command: &str,
        verification: bool,
        deletion_approved: bool,
    ) -> ToolResult {
        if let Err(error) = validate_shell(command, &self.workspace, deletion_approved) {
            return tool_result(Err(error), verification);
        }
        let process = platform_shell(command);
        self.run_command(process, verification, DEFAULT_TIMEOUT_SECS)
    }

    pub fn shell_interactive_with_delete_approval(
        &self,
        command: &str,
        deletion_approved: bool,
    ) -> ToolResult {
        if let Err(error) = validate_shell(command, &self.workspace, deletion_approved) {
            return tool_result(Err(error), false);
        }
        let result = platform_shell(command)
            .current_dir(&self.workspace)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(|error| error.to_string())
            .and_then(|status| {
                if status.success() {
                    Ok("ok".into())
                } else {
                    Err(format!("exit {}", status.code().unwrap_or(-1)))
                }
            });
        tool_result(result, false)
    }

    pub fn http(&self, url: &str) -> ToolResult {
        let result = (|| {
            if !(url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:")) {
                return Err(
                    "http tool is local-only; URL must use 127.0.0.1 or localhost".to_string(),
                );
            }
            let response = self
                .ollama_http
                .get(url)
                .call()
                .map_err(|error| error.to_string())?;
            let status = response.status();
            let mut bytes = Vec::new();
            response
                .into_reader()
                .take(MAX_OUTPUT_BYTES as u64)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            let body = String::from_utf8_lossy(&bytes);
            Ok(format!("HTTP {status}\n{body}"))
        })();
        tool_result(result, true)
    }

    pub fn git_snapshot(&self) -> String {
        let output = Command::new("git")
            .args(["status", "--short"])
            .current_dir(&self.workspace)
            .output();
        match output {
            Ok(output) if output.status.success() => {
                let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if value.is_empty() {
                    "clean".into()
                } else {
                    value
                }
            }
            _ => "not a git workspace".into(),
        }
    }

    fn run_command(
        &self,
        mut command: Command,
        verification: bool,
        timeout_secs: u64,
    ) -> ToolResult {
        command
            .current_dir(&self.workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let result = (|| {
            let mut child = command.spawn().map_err(|error| error.to_string())?;
            let started = Instant::now();
            loop {
                match child.try_wait().map_err(|error| error.to_string())? {
                    Some(_) => break,
                    None if started.elapsed() >= Duration::from_secs(timeout_secs) => {
                        let _ = child.kill();
                        let output = child
                            .wait_with_output()
                            .map_err(|error| error.to_string())?;
                        return Err(format!(
                            "command timed out after {timeout_secs}s\n{}",
                            combine_output(&output.stdout, &output.stderr)
                        ));
                    }
                    None => thread::sleep(Duration::from_millis(50)),
                }
            }
            let output = child
                .wait_with_output()
                .map_err(|error| error.to_string())?;
            let combined = combine_output(&output.stdout, &output.stderr);
            if output.status.success() {
                Ok(if combined.is_empty() {
                    "ok".into()
                } else {
                    combined
                })
            } else {
                Err(format!(
                    "exit {}\n{}",
                    output.status.code().unwrap_or(-1),
                    combined
                ))
            }
        })();
        tool_result(result, verification)
    }

    fn resolve_existing(&self, raw: &str) -> Result<PathBuf, String> {
        let candidate = self.candidate(raw)?;
        let canonical = candidate
            .canonicalize()
            .map_err(|error| format!("cannot resolve {}: {error}", candidate.display()))?;
        self.ensure_inside(canonical)
    }

    fn resolve_write(&self, raw: &str) -> Result<PathBuf, String> {
        let candidate = self.candidate(raw)?;
        let mut ancestor = candidate.as_path();
        while !ancestor.exists() {
            ancestor = ancestor
                .parent()
                .ok_or_else(|| "path has no existing ancestor".to_string())?;
        }
        let canonical_ancestor = ancestor.canonicalize().map_err(|error| error.to_string())?;
        self.ensure_inside(canonical_ancestor)?;
        Ok(candidate)
    }

    fn candidate(&self, raw: &str) -> Result<PathBuf, String> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err("path cannot be empty".into());
        }
        let path = Path::new(raw);
        if path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            return Err("parent path traversal is outside the workspace boundary".into());
        }
        let candidate = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.workspace.join(path)
        };
        if candidate
            .components()
            .any(|component| component.as_os_str() == ".git")
        {
            return Err("direct writes or reads inside .git are not allowed".into());
        }
        let protected = [
            ".env",
            ".env.local",
            ".env.production",
            "credentials.json",
            "id_rsa",
            "id_ed25519",
        ];
        if candidate
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| protected.contains(&name))
        {
            return Err("secret-bearing files are outside the agent tool boundary".into());
        }
        Ok(candidate)
    }

    fn ensure_inside(&self, path: PathBuf) -> Result<PathBuf, String> {
        if path.starts_with(&self.workspace) {
            Ok(path)
        } else {
            Err(format!(
                "path is outside workspace {}",
                self.workspace.display()
            ))
        }
    }
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            b' ' => "+".into(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn parse_web_results(html: &str, limit: usize) -> Vec<(String, String, String)> {
    let anchor = regex::Regex::new(
        r#"(?s)<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#,
    )
    .expect("valid result regex");
    let snippet = regex::Regex::new(
        r#"(?s)<(?:a|div)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</(?:a|div)>"#,
    )
    .expect("valid snippet regex");
    let mut snippets = snippet
        .captures_iter(html)
        .filter_map(|capture| capture.get(1))
        .map(|value| clean_html(value.as_str()));
    anchor
        .captures_iter(html)
        .take(limit)
        .filter_map(|capture| {
            let url = decode_entities(capture.get(1)?.as_str());
            let url = extract_duckduckgo_target(&url);
            let title = clean_html(capture.get(2)?.as_str());
            let summary = snippets.next().unwrap_or_default();
            Some((title, url, summary))
        })
        .collect()
}

fn clean_html(value: &str) -> String {
    let tags = regex::Regex::new(r"(?s)<[^>]+>").expect("valid tag regex");
    decode_entities(tags.replace_all(value, " ").trim())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}

fn extract_duckduckgo_target(url: &str) -> String {
    let Some(encoded) = url
        .split("uddg=")
        .nth(1)
        .and_then(|tail| tail.split('&').next())
    else {
        return url.to_string();
    };
    percent_decode(encoded).unwrap_or_else(|| url.to_string())
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            output.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            output.push(if bytes[index] == b'+' {
                b' '
            } else {
                bytes[index]
            });
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

/// Whether ripgrep is on `PATH`. Cached for the process so repeated `list`/
/// `search` calls do not re-probe. When absent, the toolbelt falls back to a
/// native Rust walk so the agent works on systems without `rg` installed.
fn has_ripgrep() -> bool {
    use std::sync::OnceLock;
    static PRESENT: OnceLock<bool> = OnceLock::new();
    *PRESENT.get_or_init(|| which_on_path("rg"))
}

/// Minimal cross-platform `which`: is `program` resolvable on `PATH`?
fn which_on_path(program: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    let exe_suffixes: &[&str] = if cfg!(windows) {
        &["", ".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };
    std::env::split_paths(&paths).any(|dir| {
        exe_suffixes.iter().any(|suffix| {
            let candidate = dir.join(format!("{program}{suffix}"));
            candidate.is_file()
        })
    })
}

/// Build the OS-appropriate shell invocation. Honors `HII_SHELL` when set
/// (`powershell`, `pwsh`, `cmd`, or an explicit shell path), otherwise picks a
/// sensible default per platform. On Unix we drop the login flag (`-c`, not
/// `-lc`) so behavior does not depend on the user's interactive profile.
fn platform_shell(command: &str) -> Command {
    if let Ok(shell) = std::env::var("HII_SHELL") {
        let shell = shell.trim();
        let lower = shell.to_ascii_lowercase();
        if lower == "powershell" || lower == "pwsh" {
            let mut process = Command::new(shell);
            process.args(["-NoProfile", "-Command", command]);
            return process;
        }
        if lower == "cmd" || lower.ends_with("cmd.exe") {
            let mut process = Command::new(shell);
            process.args(["/C", command]);
            return process;
        }
        if !shell.is_empty() {
            let mut process = Command::new(shell);
            process.args(["-c", command]);
            return process;
        }
    }
    if cfg!(windows) {
        let mut process = Command::new("powershell");
        process.args(["-NoProfile", "-Command", command]);
        process
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut process = Command::new(shell);
        process.args(["-c", command]);
        process
    }
}

fn validate_shell(command: &str, workspace: &Path, deletion_approved: bool) -> Result<(), String> {
    let normalized = command.to_ascii_lowercase();
    if crate::contract::deletion_shell(command) && !deletion_approved {
        return Err("file deletion requires explicit operator approval".into());
    }
    let blocked = [
        // POSIX
        "sudo ",
        "git reset",
        "git clean",
        "git checkout --",
        "git restore ",
        "diskutil",
        "mkfs",
        "shutdown",
        "reboot",
        "killall",
        "pkill",
        "> /dev/",
        "dd if=",
        "chmod -r",
        // Windows equivalents
        "format ",
        "diskpart",
    ];
    if let Some(pattern) = blocked
        .iter()
        .find(|pattern| normalized.contains(**pattern))
    {
        return Err(format!("blocked destructive shell pattern: {pattern}"));
    }
    if normalized.contains("../") || normalized.contains("~/") || normalized.contains("$home") {
        return Err("shell command may not escape the workspace with parent or home paths".into());
    }
    for token in command.split_whitespace() {
        let clean =
            token.trim_matches(|character| matches!(character, '\'' | '"' | '(' | ')' | ';' | ','));
        if clean.starts_with('/')
            && clean != "/dev/null"
            && !Path::new(clean).starts_with(workspace)
        {
            return Err(format!(
                "absolute path is outside the workspace boundary: {clean}"
            ));
        }
    }
    Ok(())
}

fn combine_output(stdout: &[u8], stderr: &[u8]) -> String {
    let mut combined = String::from_utf8_lossy(stdout).to_string();
    if !stderr.is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&String::from_utf8_lossy(stderr));
    }
    if combined.len() > MAX_OUTPUT_BYTES {
        combined.truncate(MAX_OUTPUT_BYTES);
        combined.push_str("\n… output truncated");
    }
    combined.trim().to_string()
}

fn tool_result(result: Result<String, String>, verification: bool) -> ToolResult {
    match result {
        Ok(output) => ToolResult {
            ok: true,
            output,
            verification,
        },
        Err(output) => ToolResult {
            ok: false,
            output,
            verification,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_WORKSPACE: AtomicUsize = AtomicUsize::new(0);

    fn workspace() -> PathBuf {
        let sequence = NEXT_WORKSPACE.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("hii-tools-{}-{sequence}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn write_stays_inside_workspace() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        assert!(tools.write("notes/proof.txt", "verified").ok);
        assert_eq!(
            fs::read_to_string(path.join("notes/proof.txt")).unwrap(),
            "verified"
        );
        assert!(!tools.write("../escape.txt", "no").ok);
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn destructive_shell_is_blocked() {
        let path = workspace();
        assert!(validate_shell("rm -rf build", &path, false).is_err());
        assert!(validate_shell("rm -rf build", &path, true).is_ok());
        assert!(validate_shell("git status --short", &path, false).is_ok());
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn secret_files_are_blocked() {
        let path = workspace();
        fs::write(path.join(".env"), "TOKEN=nope").unwrap();
        let tools = Toolbelt::new(path.clone()).unwrap();
        assert!(!tools.read_range(".env", None, None).ok);
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn edit_replaces_unique_and_rejects_ambiguous() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        assert!(tools.write("a.txt", "one two one").ok);
        // ambiguous single edit fails
        assert!(!tools.edit("a.txt", "one", "X", false).ok);
        // replace_all succeeds
        assert!(tools.edit("a.txt", "one", "X", true).ok);
        assert_eq!(fs::read_to_string(path.join("a.txt")).unwrap(), "X two X");
        // missing target fails
        assert!(!tools.edit("a.txt", "zzz", "Y", false).ok);
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn read_range_windows_lines() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        assert!(tools.write("f.txt", "l1\nl2\nl3\nl4").ok);
        let result = tools.read_range("f.txt", Some(2), Some(2));
        assert!(result.ok);
        assert!(result.output.contains("l2") && result.output.contains("l3"));
        assert!(!result.output.contains("l1") && !result.output.contains("l4"));
        // offset past end fails
        assert!(!tools.read_range("f.txt", Some(99), None).ok);
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn native_search_and_list_find_content() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        assert!(tools.write("src/x.rs", "fn needle() {}").ok);
        let found = tools.search_native("needle", tools.workspace());
        assert!(found.is_ok() && found.unwrap().contains("needle"));
        let listed = tools.list_native(tools.workspace());
        assert!(listed.unwrap().contains("x.rs"));
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn parses_cited_web_results() {
        let html = r#"
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide">A &amp; B Guide</a>
          <a class="result__snippet">A concise <b>verified</b> answer.</a>
        "#;
        let results = super::parse_web_results(html, 8);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "A & B Guide");
        assert_eq!(results[0].1, "https://example.com/guide");
        assert_eq!(results[0].2, "A concise verified answer.");
    }

    #[test]
    fn list_empty_workspace_succeeds() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        let listed = tools.list(Some("."));
        assert!(listed.ok);
        assert!(listed.output.is_empty());
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn windows_destructive_patterns_are_blocked() {
        let path = workspace();
        assert!(validate_shell("del important.txt", &path, false).is_err());
        assert!(validate_shell("Remove-Item x", &path, false).is_err());
        assert!(validate_shell("cargo test", &path, false).is_ok());
        let _ = fs::remove_dir_all(path);
    }
}
