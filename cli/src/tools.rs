use serde::Serialize;
use std::{
    fs,
    io::Read,
    net::{IpAddr, ToSocketAddrs},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use url::Url;

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
    web_http: ureq::Agent,
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
            web_http: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(20))
                .redirects(0)
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

    /// Fetch one public page selected from research results. This is a bounded
    /// GET-only reader, not a general network client: credentials, non-standard
    /// ports, loopback/private destinations, redirect escapes, and binary
    /// responses are rejected before content reaches the model.
    pub fn web_fetch(&self, raw_url: &str) -> ToolResult {
        let result = (|| {
            let mut current = validate_public_web_url(raw_url)?;
            for _ in 0..=5 {
                let response = match self
                    .web_http
                    .get(current.as_str())
                    .set("User-Agent", "HII/0.1 (+local agent web fetch)")
                    .call()
                {
                    Ok(response) => response,
                    Err(ureq::Error::Status(status, response)) => {
                        if (300..400).contains(&status) {
                            response
                        } else {
                            return Err(format!("web fetch returned HTTP {status}"));
                        }
                    }
                    Err(error) => return Err(format!("web fetch failed: {error}")),
                };
                let status = response.status();
                if (300..400).contains(&status) {
                    let location = response
                        .header("Location")
                        .ok_or_else(|| format!("web fetch redirect {status} had no Location"))?;
                    let redirected = current
                        .join(location)
                        .map_err(|error| format!("invalid redirect URL: {error}"))?;
                    current = validate_public_web_url(redirected.as_str())?;
                    continue;
                }
                if !(200..300).contains(&status) {
                    return Err(format!("web fetch returned HTTP {status}"));
                }
                let content_type = response
                    .header("Content-Type")
                    .unwrap_or("text/plain")
                    .to_ascii_lowercase();
                if !readable_web_content_type(&content_type) {
                    return Err(format!(
                        "web fetch only reads HTML, text, JSON, or XML; received {content_type}"
                    ));
                }
                let mut bytes = Vec::new();
                response
                    .into_reader()
                    .take(MAX_OUTPUT_BYTES as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|error| error.to_string())?;
                let body = String::from_utf8(bytes)
                    .map_err(|_| "web fetch response was not UTF-8 text".to_string())?;
                let text = if content_type.contains("html") {
                    readable_html(&body)
                } else {
                    body.trim().to_string()
                };
                if text.is_empty() {
                    return Err("web fetch returned no readable text".into());
                }
                let text = text.chars().take(48_000).collect::<String>();
                return Ok(format!("SOURCE {}\n\n{text}", current));
            }
            Err("web fetch exceeded 5 redirects".into())
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
        self.shell_in_family(command, verification, deletion_approved, shell_family())
    }

    /// The shell family is a parameter rather than a read of the ambient
    /// environment so the fail-closed path can be exercised without a test
    /// mutating process-global state that its neighbours also read.
    fn shell_in_family(
        &self,
        command: &str,
        verification: bool,
        deletion_approved: bool,
        family: ShellFamily,
    ) -> ToolResult {
        if let Err(error) = validate_shell(command, &self.workspace, deletion_approved) {
            return tool_result(Err(error), verification);
        }
        let process = if verification {
            match pipeline_guard(command, family) {
                PipelineGuard::AsWritten => platform_shell(command),
                PipelineGuard::Guarded(wrapped) => platform_shell(&wrapped),
                // Refused rather than run: a check that cannot see a stage fail
                // would report `ok`, which is worse evidence than none.
                PipelineGuard::Unavailable(reason) => {
                    return tool_result(Err(reason), verification)
                }
            }
        } else {
            platform_shell(command)
        };
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
            let response = match self.ollama_http.get(url).call() {
                Ok(response) => response,
                Err(ureq::Error::Status(status, response)) => {
                    let mut bytes = Vec::new();
                    response
                        .into_reader()
                        .take(MAX_OUTPUT_BYTES as u64)
                        .read_to_end(&mut bytes)
                        .map_err(|error| error.to_string())?;
                    let body = String::from_utf8_lossy(&bytes);
                    return Err(format!("HTTP {status}\n{body}"));
                }
                Err(error) => return Err(error.to_string()),
            };
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
            .args(["status", "--short", "--untracked-files=all", "--", "."])
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

fn readable_html(value: &str) -> String {
    let primary = regex::Regex::new(r"(?is)<(?:main|article)\b[^>]*>(.*?)</(?:main|article)>")
        .expect("valid primary-content regex");
    let value = primary
        .captures(value)
        .and_then(|capture| capture.get(1))
        .map_or(value, |content| content.as_str());
    let hidden = regex::Regex::new(
        r"(?is)<(?:script|style|noscript|svg|template)[^>]*>.*?</(?:script|style|noscript|svg|template)>",
    )
    .expect("valid hidden-content regex");
    let blocks = regex::Regex::new(
        r"(?i)</?(?:article|aside|blockquote|br|div|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)[^>]*>",
    )
    .expect("valid block tag regex");
    let tags = regex::Regex::new(r"(?s)<[^>]+>").expect("valid tag regex");
    let without_hidden = hidden.replace_all(value, " ");
    let with_lines = blocks.replace_all(&without_hidden, "\n");
    let decoded = decode_entities(&tags.replace_all(&with_lines, " "));
    let text = tags.replace_all(&decoded, " ");
    text.lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn readable_web_content_type(value: &str) -> bool {
    [
        "text/",
        "application/json",
        "application/xml",
        "+json",
        "+xml",
    ]
    .iter()
    .any(|kind| value.contains(kind))
}

fn validate_public_web_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|error| format!("invalid web URL: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("web fetch URL must use http or https".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("web fetch URL may not contain credentials".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "web fetch URL must contain a host".to_string())?;
    let lowered = host.trim_end_matches('.').to_ascii_lowercase();
    if lowered == "localhost"
        || lowered.ends_with(".localhost")
        || lowered.ends_with(".local")
        || lowered.ends_with(".internal")
    {
        return Err("web fetch cannot access local or private hosts".into());
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "web fetch URL has no usable port".to_string())?;
    if !matches!((url.scheme(), port), ("http", 80) | ("https", 443)) {
        return Err("web fetch only allows standard HTTP and HTTPS ports".into());
    }
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("cannot resolve web host: {error}"))?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err("web host resolved to no addresses".into());
    }
    if addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err(
            "web fetch cannot access loopback, private, link-local, or reserved networks".into(),
        );
    }
    Ok(url)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224)
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(mapped));
            }
            let segments = ip.segments();
            !(ip.is_unspecified()
                || ip.is_loopback()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xff00) == 0xff00)
        }
    }
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

/// A command that cannot run because the program it invokes is not installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingDependency {
    pub program: String,
    pub command: String,
}

/// Shell builtins and keywords that never resolve on `PATH`.
const SHELL_BUILTINS: &[&str] = &[
    "cd", "echo", "export", "set", "unset", "test", "true", "false", "source", ".", "exit", "read",
    "printf", "pwd", "eval", "exec", "wait", "trap", "shift", "return", "local", "if", "then",
    "else", "fi", "for", "while", "do", "done", "case", "esac",
];

/// Confirm every program a command invokes actually exists.
///
/// Without this a declared check like `pytest -q` runs the entire agent loop and
/// only then fails with exit 127, and a missing binary is indistinguishable from
/// a real test failure — which drove the repair loop to rewrite correct code.
pub(crate) fn preflight_command(command: &str, workspace: &Path) -> Result<(), MissingDependency> {
    for segment in command.split(['|', ';']).flat_map(|part| part.split("&&")) {
        let mut words = segment.split_whitespace().peekable();
        // Skip `VAR=value` and `env VAR=value` prefixes to reach the program.
        let program = loop {
            match words.next() {
                None => break None,
                Some("env") => continue,
                Some(word) if word.contains('=') && !word.starts_with('/') => continue,
                Some(word) => break Some(word),
            }
        };
        let Some(program) = program else { continue };
        let program = program.trim_matches(|character| matches!(character, '\'' | '"' | '('));
        if program.is_empty() || SHELL_BUILTINS.contains(&program) {
            continue;
        }
        // A workspace-relative script is checked on disk rather than on PATH.
        if program.starts_with("./") || program.contains('/') {
            let candidate = workspace.join(program.trim_start_matches("./"));
            if candidate.is_file() || Path::new(program).is_file() {
                continue;
            }
            return Err(MissingDependency {
                program: program.to_string(),
                command: command.to_string(),
            });
        }
        if !which_on_path(program) {
            return Err(MissingDependency {
                program: program.to_string(),
                command: command.to_string(),
            });
        }
        // `python3 -m pytest` names a module, not a program. The interpreter
        // resolves fine while the module is absent, which is exactly how a
        // missing test runner used to reach the loop disguised as a test failure.
        if let Some(module) = interpreter_module(program, &mut words) {
            if !module_is_importable(program, &module) {
                return Err(MissingDependency {
                    program: module,
                    command: command.to_string(),
                });
            }
        }
    }
    Ok(())
}

/// The module name in `<python> -m <module>`, if this is that form.
fn interpreter_module<'a>(
    program: &str,
    words: &mut impl Iterator<Item = &'a str>,
) -> Option<String> {
    let file = Path::new(program).file_name()?.to_str()?;
    if !file.starts_with("python") {
        return None;
    }
    let mut rest = words.skip_while(|word| *word != "-m");
    rest.next()?;
    rest.next().map(str::to_string)
}

/// Ask the interpreter itself, so virtualenvs and interpreter mismatches are
/// judged the same way the check will be.
fn module_is_importable(interpreter: &str, module: &str) -> bool {
    if module.is_empty()
        || !module
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '.')
    {
        return true; // Not a plain module name; leave it to the run.
    }
    Command::new(interpreter)
        .args(["-c", &format!("import {module}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(true)
}

/// Why a command failed, when the reason is not the code under test.
///
/// A missing runner and a genuine assertion failure look identical from the
/// outside, and treating the first as the second is what drives a repair loop to
/// rewrite code that was never wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureClass {
    MissingDependency,
    PermissionDenied,
    PortInUse,
    Timeout,
    /// A real failure of the thing being checked.
    AssertionFailure,
}

pub fn classify_failure(output: &str) -> FailureClass {
    let lower = output.to_ascii_lowercase();
    if lower.contains("command not found")
        || lower.contains("no such file or directory")
        || lower.contains("modulenotfounderror")
        || lower.contains("importerror")
        || lower.contains("is not recognized as an internal")
        || lower.contains("no module named")
        || lower.contains("cannot find module")
    {
        FailureClass::MissingDependency
    } else if lower.contains("permission denied") || lower.contains("eacces") {
        FailureClass::PermissionDenied
    } else if lower.contains("address already in use") || lower.contains("eaddrinuse") {
        FailureClass::PortInUse
    } else if lower.contains("command timed out after") {
        FailureClass::Timeout
    } else {
        FailureClass::AssertionFailure
    }
}

impl FailureClass {
    /// What to tell the model. `None` means the failure is about the code and
    /// the normal repair path applies.
    pub fn environment_hint(self) -> Option<&'static str> {
        match self {
            FailureClass::AssertionFailure => None,
            FailureClass::MissingDependency => Some(
                "ENVIRONMENT_BLOCKED: the check could not run because something it needs is not installed. This is an environment problem, not a code problem — do not edit code to work around it. Use a check that relies on an available tool, or return final describing the blocker.",
            ),
            FailureClass::PermissionDenied => Some(
                "ENVIRONMENT_BLOCKED: the check was refused by filesystem permissions. Do not edit code to work around it; return final describing the blocker.",
            ),
            FailureClass::PortInUse => Some(
                "ENVIRONMENT_BLOCKED: the port the check needs is already in use. Do not edit code to work around it; choose another check or return final describing the blocker.",
            ),
            FailureClass::Timeout => Some(
                "ENVIRONMENT_BLOCKED: the check exceeded its time limit rather than failing. Narrow the check instead of rewriting code.",
            ),
        }
    }
}

/// Minimal cross-platform `which`: is `program` resolvable on `PATH`?
pub(crate) fn which_on_path(program: &str) -> bool {
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

/// Which shell family `platform_shell` will hand the command to.
///
/// Pipeline exit-status semantics differ per family, and the difference decides
/// whether a declared check can fail closed at all, so the choice is made once
/// here rather than inferred from `cfg!(windows)` at each site.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShellFamily {
    Posix,
    PowerShell,
    Cmd,
}

pub(crate) fn shell_family() -> ShellFamily {
    if let Ok(shell) = std::env::var("HII_SHELL") {
        let lower = shell.trim().to_ascii_lowercase();
        if lower == "powershell" || lower == "pwsh" {
            return ShellFamily::PowerShell;
        }
        if lower == "cmd" || lower.ends_with("cmd.exe") {
            return ShellFamily::Cmd;
        }
        if !lower.is_empty() {
            return ShellFamily::Posix;
        }
    }
    if cfg!(windows) {
        ShellFamily::PowerShell
    } else {
        ShellFamily::Posix
    }
}

/// What to do with a declared verification command that contains a pipeline.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PipelineGuard {
    /// No pipeline, or a family where the plain command already fails closed.
    AsWritten,
    /// Wrapped so every stage's failure is visible.
    Guarded(String),
    /// Pipeline status cannot be established here, so the check must not run.
    Unavailable(String),
}

/// True when the command contains a real `|` pipeline.
///
/// `||` is an or-operator and `|` inside quotes is data. Neither masks an exit
/// status, and treating them as pipelines would refuse to run checks that are
/// already fail-closed.
fn has_pipeline(command: &str) -> bool {
    let bytes = command.as_bytes();
    let mut at = 0;
    let mut single = false;
    let mut double = false;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' if !single => at += 1,
            b'\'' if !double => single = !single,
            b'"' if !single => double = !double,
            b'|' if !single && !double => {
                if bytes.get(at + 1) == Some(&b'|') {
                    at += 1; // `||`, an or-operator
                } else if at > 0 && bytes[at - 1] == b'|' {
                    // already consumed as the tail of `||`
                } else {
                    return true;
                }
            }
            _ => {}
        }
        at += 1;
    }
    false
}

/// Make a verification command report the failure of any stage in a pipeline.
///
/// `a | b` exits with `b`'s status, so `npm test | tee log` reported success
/// while the tests failed. A check that cannot see its own failure is not a
/// check.
///
/// When pipeline status cannot be established the command is refused rather
/// than run. Falling back to last-command status would reintroduce exactly the
/// masking this exists to prevent, and it would do it silently — the check would
/// still report `ok`, which is worse than not running.
pub(crate) fn pipeline_guard(command: &str, family: ShellFamily) -> PipelineGuard {
    if !has_pipeline(command) {
        return PipelineGuard::AsWritten;
    }
    match family {
        ShellFamily::Posix => PipelineGuard::Guarded(format!(
            "if ! (set -o pipefail) 2>/dev/null; then\n  \
             echo 'hii: this shell cannot report pipeline exit status' >&2\n  \
             exit {PIPELINE_STATUS_UNAVAILABLE}\n\
             fi\n\
             set -o pipefail\n{command}"
        )),
        ShellFamily::PowerShell => PipelineGuard::Unavailable(
            "PowerShell reports only the last stage of a pipeline, so this declared check cannot \
             fail closed. Split the pipeline into separate checks, or write the intermediate \
             output to a file and check it separately."
                .to_string(),
        ),
        ShellFamily::Cmd => PipelineGuard::Unavailable(
            "cmd.exe reports only the last stage of a pipeline, so this declared check cannot \
             fail closed. Split the pipeline into separate checks, or write the intermediate \
             output to a file and check it separately."
                .to_string(),
        ),
    }
}

/// Exit status used when a pipeline's real status cannot be established.
const PIPELINE_STATUS_UNAVAILABLE: i32 = 97;

/// The file a shell redirection would write, if it is a workspace file.
///
/// Redirecting into the workspace is how a model rewrites a file wholesale
/// without going through `edit`, which skips both the exact-match discipline and
/// the protected-file list — those live in path resolution, not here. Stream
/// plumbing (`2>&1`, `>&2`) and `/dev/null` are not writes and stay allowed.
fn workspace_redirect_target(command: &str) -> Option<String> {
    let bytes = command.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'>' {
            at += 1;
            continue;
        }
        // `2>`/`1>` and `>>` are still redirections; `>&` is a descriptor dup.
        let mut cursor = at + 1;
        if bytes.get(cursor) == Some(&b'>') {
            cursor += 1;
        }
        if bytes.get(cursor) == Some(&b'&') {
            at = cursor + 1;
            continue;
        }
        let rest = command[cursor..].trim_start();
        let target = rest
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_matches(|character| matches!(character, '\'' | '"' | ';' | ')'));
        at = cursor + 1;
        if target.is_empty() || target.starts_with("/dev/") {
            continue;
        }
        return Some(target.to_string());
    }
    None
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
    if let Some(target) = workspace_redirect_target(command) {
        return Err(format!(
            "SHELL_REDIRECT_BLOCKED: writing {target} through a shell redirection bypasses HII's edit checks and protected-file guards. Use {{\"type\":\"edit\",...}} for an existing file or {{\"type\":\"write\",...}} for a new one."
        ));
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
    use std::{
        io::Write,
        net::TcpListener,
        sync::atomic::{AtomicUsize, Ordering},
    };

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
    fn shell_rejects_writing_a_workspace_file_through_a_redirect() {
        let path = workspace();
        assert!(validate_shell("echo 'x' > calc.py", &path, false)
            .expect_err("redirect into the workspace should be refused")
            .contains("SHELL_REDIRECT_BLOCKED"));
        let _ = fs::remove_dir_all(path);
    }

    /// Stream plumbing is not a file write and must stay usable.
    #[test]
    fn shell_allows_devnull_and_descriptor_duplication() {
        assert_eq!(workspace_redirect_target("ls 2>&1"), None);
        assert_eq!(workspace_redirect_target("ls >/dev/null 2>&1"), None);
        assert_eq!(workspace_redirect_target("echo hi >&2"), None);
        assert_eq!(
            workspace_redirect_target("echo hi > out.txt").as_deref(),
            Some("out.txt")
        );
        assert_eq!(
            workspace_redirect_target("cat a >> log.txt").as_deref(),
            Some("log.txt")
        );
    }

    #[test]
    fn preflight_detects_a_missing_program() {
        let path = workspace();
        let missing = preflight_command("definitely-not-installed-xyz -q", &path)
            .expect_err("missing program should be reported");
        assert_eq!(missing.program, "definitely-not-installed-xyz");
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn preflight_accepts_pipelines_builtins_and_env_prefixes() {
        let path = workspace();
        preflight_command("echo hi", &path).expect("builtin");
        preflight_command("ls | sort", &path).expect("pipeline of real programs");
        preflight_command("FOO=1 ls", &path).expect("env assignment prefix");
        preflight_command("env FOO=1 ls", &path).expect("env command prefix");
        preflight_command("cd . && ls", &path).expect("builtin then program");
        let _ = fs::remove_dir_all(path);
    }

    /// `python3 -m pytest` is the shape that started this work: the interpreter
    /// resolves, the module does not, and the check looks like a test failure.
    #[test]
    fn preflight_checks_interpreter_modules_not_just_programs() {
        let path = workspace();
        if which_on_path("python3") {
            let missing = preflight_command("python3 -m definitely_not_a_module_xyz", &path)
                .expect_err("a missing module is a missing dependency");
            assert_eq!(missing.program, "definitely_not_a_module_xyz");
            preflight_command("python3 -m json.tool", &path).expect("stdlib module resolves");
        }
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn environmental_failures_are_not_treated_as_code_failures() {
        assert_eq!(
            classify_failure("bash: pytest: command not found"),
            FailureClass::MissingDependency
        );
        assert_eq!(
            classify_failure("ModuleNotFoundError: No module named 'pytest'"),
            FailureClass::MissingDependency
        );
        assert_eq!(
            classify_failure("OSError: [Errno 48] Address already in use"),
            FailureClass::PortInUse
        );
        // A real test failure must still drive the repair path.
        let assertion = classify_failure("AssertionError: 5 != -1\nFAILED test_calc.py");
        assert_eq!(assertion, FailureClass::AssertionFailure);
        assert!(assertion.environment_hint().is_none());
        assert!(FailureClass::MissingDependency
            .environment_hint()
            .is_some_and(|hint| hint.contains("not a code problem")));
    }

    /// A pipeline is only as runnable as its least-available program.
    #[test]
    fn preflight_checks_every_segment() {
        let path = workspace();
        let missing = preflight_command("ls | definitely-not-installed-xyz", &path)
            .expect_err("later segments count too");
        assert_eq!(missing.program, "definitely-not-installed-xyz");
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
    fn web_fetch_rejects_private_destinations_and_credentials() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        for url in [
            "http://127.0.0.1/",
            "http://localhost/",
            "http://10.0.0.1/",
            "https://user:secret@example.com/",
            "https://example.com:8443/",
        ] {
            assert!(!tools.web_fetch(url).ok, "{url} should be blocked");
        }
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn web_fetch_html_reader_removes_executable_noise() {
        let html = r#"
          <html><head><style>body { color: red }</style></head>
          <body><main><h1>Verified guide</h1><script>alert("no")</script>
          <p>Use an import map &amp; HTTP.</p></main></body></html>
        "#;
        let text = readable_html(html);
        assert!(text.contains("Verified guide"));
        assert!(text.contains("Use an import map & HTTP."));
        assert!(!text.contains("alert"));
        assert!(!text.contains("color: red"));
    }

    #[test]
    fn public_ip_filter_blocks_local_and_mapped_local_addresses() {
        assert!(!public_ip("127.0.0.1".parse().unwrap()));
        assert!(!public_ip("10.1.2.3".parse().unwrap()));
        assert!(!public_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(public_ip("1.1.1.1".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn http_failure_preserves_browser_diagnostics() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            let body = r#"{"ok":false,"failures":["js: SyntaxError: Missing }"]}"#;
            write!(
                stream,
                "HTTP/1.1 422 Unprocessable Entity\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        let result = tools.http(&format!("http://{address}/__verify/index.html"));
        assert!(!result.ok);
        assert!(result.verification);
        assert!(result.output.contains("HTTP 422"));
        assert!(result.output.contains("SyntaxError: Missing }"));
        server.join().unwrap();
        let _ = fs::remove_dir_all(path);
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

    /// A check that exits non-zero must be recorded as failed, not merely noisy.
    #[test]
    fn verification_reports_a_non_zero_exit_as_failure() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        let result = tools.shell("exit 7", true);
        assert!(!result.ok);
        assert!(result.verification);
        assert!(result.output.contains("exit 7"), "{}", result.output);
        let _ = fs::remove_dir_all(path);
    }

    /// A process killed by a signal has no exit code at all. It must never be
    /// mistaken for success just because `code()` is absent.
    #[cfg(unix)]
    #[test]
    fn verification_reports_signal_termination_as_failure() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        let result = tools.shell("kill -9 $$", true);
        assert!(
            !result.ok,
            "signal termination must fail: {}",
            result.output
        );
        let _ = fs::remove_dir_all(path);
    }

    /// `a | b` exits with b's status, so a failing first stage used to be
    /// invisible to verification.
    #[cfg(unix)]
    #[test]
    fn verification_does_not_let_a_pipeline_mask_an_earlier_failure() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        let result = tools.shell("exit 3 | cat", true);
        assert!(
            !result.ok,
            "pipeline failure must surface: {}",
            result.output
        );
        let _ = fs::remove_dir_all(path);
    }

    /// The mirror case: a failing *last* stage was always visible, and must stay
    /// visible once the guard wraps the command.
    #[cfg(unix)]
    #[test]
    fn verification_reports_a_failing_final_pipeline_stage() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        let result = tools.shell("echo hi | grep -q nothing-here", true);
        assert!(
            !result.ok,
            "failing final stage must surface: {}",
            result.output
        );
        let _ = fs::remove_dir_all(path);
    }

    /// The guard must not turn a genuinely passing pipeline into a failure.
    #[cfg(unix)]
    #[test]
    fn verification_passes_when_every_pipeline_stage_succeeds() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        let result = tools.shell("echo hi | grep -q hi", true);
        assert!(result.ok, "passing pipeline must pass: {}", result.output);
        let _ = fs::remove_dir_all(path);
    }

    /// A stage killed by a signal is a failure even mid-pipeline, where the exit
    /// code of the last stage would otherwise be zero.
    #[cfg(unix)]
    #[test]
    fn verification_reports_signal_termination_inside_a_pipeline() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        let result = tools.shell("sh -c 'kill -9 $$' | cat", true);
        assert!(
            !result.ok,
            "signalled pipeline stage must fail: {}",
            result.output
        );
        let _ = fs::remove_dir_all(path);
    }

    /// Where pipeline status cannot be established, the check is refused. The
    /// forbidden outcome is running it anyway and reporting `ok` from the last
    /// stage.
    #[test]
    fn verification_refuses_a_pipeline_when_status_cannot_be_established() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        let result =
            tools.shell_in_family("echo hi | findstr nothing", true, false, ShellFamily::Cmd);
        assert!(!result.ok, "must fail closed: {}", result.output);
        assert!(result.verification);
        assert!(
            result.output.contains("cannot fail closed"),
            "refusal must say why: {}",
            result.output
        );
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn pipeline_guarding_is_only_added_where_it_is_needed() {
        assert_eq!(
            pipeline_guard("cargo test", ShellFamily::Posix),
            PipelineGuard::AsWritten
        );
        // `||` is an or-operator and a quoted `|` is data; neither masks status.
        assert_eq!(
            pipeline_guard("cargo test || exit 1", ShellFamily::Posix),
            PipelineGuard::AsWritten
        );
        assert_eq!(
            pipeline_guard("grep 'a|b' file", ShellFamily::Posix),
            PipelineGuard::AsWritten
        );
        match pipeline_guard("cargo test | tee log", ShellFamily::Posix) {
            PipelineGuard::Guarded(script) => assert!(script.contains("pipefail")),
            other => panic!("expected a guarded pipeline, got {other:?}"),
        }
        // Never silently fall back to last-command status.
        for family in [ShellFamily::PowerShell, ShellFamily::Cmd] {
            assert!(matches!(
                pipeline_guard("a | b", family),
                PipelineGuard::Unavailable(_)
            ));
        }
    }

    /// A shell that accepts `set -o pipefail` in a subshell but not in the
    /// script body would leave the pipeline unguarded, so the guard sets it for
    /// real after the probe rather than trusting the probe alone.
    #[test]
    fn the_posix_guard_sets_pipefail_outside_the_probe() {
        let PipelineGuard::Guarded(script) = pipeline_guard("a | b", ShellFamily::Posix) else {
            panic!("expected a guarded pipeline");
        };
        let lines: Vec<&str> = script.lines().collect();
        assert!(
            lines.iter().any(|line| line.trim() == "set -o pipefail"),
            "{script}"
        );
        assert!(
            script.contains(&format!("exit {PIPELINE_STATUS_UNAVAILABLE}")),
            "{script}"
        );
    }
}
