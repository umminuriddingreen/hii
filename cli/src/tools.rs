use crate::budget::{Cancel, CancelReason};
use fs2::FileExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::{
    fs::{self, OpenOptions},
    io::Read,
    net::{IpAddr, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use url::Url;

const MAX_OUTPUT_BYTES: usize = 96 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 120;
const GIT_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(2);

/// Capture a small status command without allowing it to block a completed
/// conversation indefinitely. Stdout is drained on a helper thread while the
/// owner polls the child deadline; the buffer is capped independently.
fn run_bounded_snapshot_command(
    mut command: Command,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("could not start status command: {error}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "status command stdout was unavailable".to_string())?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .by_ref()
            .take((MAX_OUTPUT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
            .map_err(|error| error.to_string());
        let _ = sender.send(result);
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => {
                thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "status command timed out after {} seconds",
                    timeout.as_secs()
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("status command wait failed: {error}"));
            }
        }
    };
    let bytes = receiver
        .recv_timeout(Duration::from_millis(100))
        .map_err(|_| "status command stdout did not close".to_string())??;
    if !status.success() {
        return Err(format!("status command exited with {status}"));
    }
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err("status output exceeded 96 KiB".into());
    }
    Ok(bytes)
}

#[derive(Debug, Serialize)]
pub struct ToolResult {
    pub ok: bool,
    pub output: String,
    pub verification: bool,
}

/// Which redirected shell pipe produced an observed output chunk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolOutputStream {
    Stdout,
    Stderr,
}

/// Receives bounded raw bytes while a shell command is running. Separate
/// stdout/stderr drain threads preserve stream identity; callbacks are
/// serialized in the order HII observes chunks from those pipes. The callback
/// runs on a pipe-drain thread and should enqueue quickly; blocking it can apply
/// backpressure to the child process.
pub type ToolOutputObserver = Arc<dyn Fn(ToolOutputStream, &[u8]) + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolProcessIdentity {
    pub pid: u32,
    pub started_unix_nanos: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolProcessEvent {
    Started(ToolProcessIdentity),
    Signal {
        identity: ToolProcessIdentity,
        signal: String,
    },
    Reaped {
        identity: ToolProcessIdentity,
        exit_code: Option<i32>,
    },
    PipesDrained {
        identity: ToolProcessIdentity,
        complete: bool,
    },
}

pub type ToolProcessObserver = Arc<dyn Fn(ToolProcessEvent) + Send + Sync>;

pub struct Toolbelt {
    workspace: PathBuf,
    external_tools_bin: Option<PathBuf>,
    ollama_http: ureq::Agent,
    web_http: ureq::Agent,
    output_observer: Option<ToolOutputObserver>,
    process_observer: Option<ToolProcessObserver>,
    cancellation: Cancel,
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
        let external_tools_bin = hii_core::runtime_root()
            .ok()
            .and_then(|runtime| crate::storage::configured_library_root(&runtime))
            .map(|root| root.join("tools").join("bin"))
            .filter(|path| path.is_dir());
        Ok(Self {
            workspace,
            external_tools_bin,
            ollama_http: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(30))
                .build(),
            web_http: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(20))
                .redirects(0)
                .build(),
            output_observer: None,
            process_observer: None,
            cancellation: Cancel::new(),
        })
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub fn set_personal_local(&mut self, enabled: bool) {
        let _ = enabled;
    }

    /// Stream shell output to an optional per-run sink while retaining the
    /// normal bounded capture used by model feedback and receipts.
    pub fn set_output_observer(&mut self, observer: Option<ToolOutputObserver>) {
        self.output_observer = observer;
    }

    /// Attach the run's shared cancellation signal to subsequently started tools.
    pub fn set_cancellation(&mut self, cancellation: Cancel) {
        self.cancellation = cancellation;
    }

    /// Compatibility setter; authority no longer changes tool access.
    pub fn set_owner_mode(&mut self, enabled: bool) {
        let _ = enabled;
    }

    pub fn set_process_observer(&mut self, observer: Option<ToolProcessObserver>) {
        self.process_observer = observer;
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
                    ));
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
            let _lock = self.lock_workspace_write()?;
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
        let base = match path {
            Some(path) => match self.resolve_existing(path) {
                Ok(path) => path,
                Err(error) => return tool_result(Err(error), false),
            },
            None => self.workspace.clone(),
        };
        if has_ripgrep() {
            let mut command = Command::new("rg");
            command.args(["-n", "--hidden", "-g", "!.git", "--"]);
            command.arg(query).arg(&base);
            let result = self.run_command(command, false, DEFAULT_TIMEOUT_SECS, false);
            // ripgrep uses exit 1 for a valid search with no matches. Keep
            // actual errors (exit 2, timeouts, and stderr) as failures.
            if !result.ok && result.output.trim() == "exit 1" {
                return tool_result(Ok(String::new()), false);
            }
            return result;
        }
        tool_result(self.search_native(query, &base), false)
    }

    /// Search via HII's user-level, non-Docker SearXNG service.
    pub fn web_search(&self, query: &str) -> ToolResult {
        let query = query.trim();
        if query.is_empty() {
            return tool_result(Err("web search query cannot be empty".into()), false);
        }
        tool_result(self.search_searxng(query, "", false), false)
    }

    pub fn image_search(&self, query: &str) -> ToolResult {
        let query = query.trim();
        if query.is_empty() {
            return tool_result(Err("image search query cannot be empty".into()), false);
        }
        tool_result(self.search_searxng(query, "", true), false)
    }

    fn search_searxng(&self, query: &str, engine: &str, images: bool) -> Result<String, String> {
        self.search_searxng_at(query, engine, images, "http://127.0.0.1:8888/search")
    }

    fn search_searxng_at(
        &self,
        query: &str,
        engine: &str,
        images: bool,
        endpoint: &str,
    ) -> Result<String, String> {
        let mut url = Url::parse(endpoint).map_err(|error| error.to_string())?;
        let safe_query = query
            .chars()
            .filter(|ch| *ch != '!')
            .take(300)
            .collect::<String>();
        let request_query = if engine.is_empty() {
            safe_query
        } else {
            format!("!{engine} {safe_query}")
        };
        url.query_pairs_mut()
            .append_pair("q", &request_query)
            .append_pair("format", "json")
            .append_pair("categories", if images { "images" } else { "general" });
        let request = self
            .web_http
            .get(url.as_str())
            .set("Accept", "application/json");
        let query = query.chars().take(300).collect::<String>();
        self.run_web_request(move || {
            let response = request.call().map_err(|error| error.to_string())?;
            let mut bytes = Vec::new();
            response.into_reader().take(2_000_001).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
            if bytes.len() > 2_000_000 { return Err("search response exceeds 2 MB limit".into()); }
            let body: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|error| format!("invalid local search response: {error}"))?;
            if images {
                format_image_results(&query, &body)
            } else {
                format_search_results(&query, &body)
            }
        })
        .map_err(|error| {
            if error.starts_with("web request canceled") {
                error
            } else {
                format!(
                    "LOCAL_SEARCH_UNAVAILABLE: {error}; enable the launchd service with node scripts/hii-searxng.mjs enable; no results were observed"
                )
            }
        })
    }

    /// Run a bounded web request away from the agent thread so cancellation can
    /// return promptly while the transport remains protected by its 20-second
    /// timeout. The worker is detached only until that transport bound expires.
    fn run_web_request<T: Send + 'static>(
        &self,
        operation: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        if self.cancellation.is_cancelled() {
            return Err(format!(
                "web request canceled before execution ({:?})",
                self.cancellation.reason()
            ));
        }
        let cancel = self.cancellation.clone();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let _ = sender.send(operation());
        });
        loop {
            if cancel.is_cancelled() {
                return Err(format!("web request canceled ({:?})", cancel.reason()));
            }
            match receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(result) => {
                    if cancel.is_cancelled() {
                        return Err(format!("web request canceled ({:?})", cancel.reason()));
                    }
                    return result;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("web request worker exited without a result".into());
                }
            }
        }
    }

    /// Load a bounded public thumbnail for the CLI's existing Kitty image
    /// renderer. Search metadata remains useful when inline images are off.
    pub fn image_preview(&self, raw_url: &str) -> Result<crate::attachments::ImagePayload, String> {
        let url = validate_public_web_url(raw_url)?;
        let response = self
            .web_http
            .get(url.as_str())
            .call()
            .map_err(|error| format!("thumbnail fetch failed: {error}"))?;
        let mime = response
            .header("Content-Type")
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !matches!(
            mime.as_str(),
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        ) {
            return Err("thumbnail response is not a supported image".into());
        }
        if response
            .header("Content-Length")
            .and_then(|size| size.parse::<u64>().ok())
            .is_some_and(|size| size > 2_000_000)
        {
            return Err("thumbnail exceeds 2 MB limit".into());
        }
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(2_000_001)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() > 2_000_000 {
            return Err("thumbnail exceeds 2 MB limit".into());
        }
        use base64::Engine as _;
        Ok(crate::attachments::ImagePayload {
            mime_type: mime,
            base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }

    /// Fetch one public page selected from research results. This is a bounded
    /// GET-only reader, not a general network client: credentials, non-standard
    /// ports, loopback/private destinations, redirect escapes, and binary
    /// responses are rejected, except bounded raster images saved as local files.
    pub fn web_fetch(&self, raw_url: &str) -> ToolResult {
        let result = (|| {
            let mut current = validate_public_web_url(raw_url)?;
            for _ in 0..=5 {
                let request = self
                    .web_http
                    .get(current.as_str())
                    .set("User-Agent", "HII/0.1 (+local agent web fetch)");
                let (status, location, content_type, bytes) = self.run_web_request(move || {
                    let response = match request.call() {
                        Ok(response) => response,
                        Err(ureq::Error::Status(status, response))
                            if (300..400).contains(&status) =>
                        {
                            response
                        }
                        Err(ureq::Error::Status(status, _)) => {
                            return Err(format!("web fetch returned HTTP {status}"));
                        }
                        Err(error) => return Err(format!("web fetch failed: {error}")),
                    };
                    let status = response.status();
                    let location = response.header("Location").map(str::to_owned);
                    let content_type = response
                        .header("Content-Type")
                        .unwrap_or("text/plain")
                        .to_ascii_lowercase();
                    let mut bytes = Vec::new();
                    let limit = if content_type.starts_with("image/") {
                        8 * 1024 * 1024
                    } else {
                        2 * 1024 * 1024
                    };
                    response
                        .into_reader()
                        .take((limit + 1) as u64)
                        .read_to_end(&mut bytes)
                        .map_err(|error| error.to_string())?;
                    if bytes.len() > limit {
                        return Err(format!(
                            "web response exceeds {limit} byte limit; narrow the source"
                        ));
                    }
                    Ok((status, location, content_type, bytes))
                })?;
                if (300..400).contains(&status) {
                    let location = location
                        .ok_or_else(|| format!("web fetch redirect {status} had no Location"))?;
                    let redirected = current
                        .join(&location)
                        .map_err(|error| format!("invalid redirect URL: {error}"))?;
                    current = validate_public_web_url(redirected.as_str())?;
                    continue;
                }
                if !(200..300).contains(&status) {
                    return Err(format!("web fetch returned HTTP {status}"));
                }
                if content_type.starts_with("image/") {
                    let _lock = self.lock_workspace_write()?;
                    return crate::web_image::save_web_image(
                        &self.workspace,
                        current.as_str(),
                        &content_type,
                        &bytes,
                    );
                }
                if !readable_web_content_type(&content_type) {
                    return Err(format!(
                        "web fetch only reads HTML, text, JSON, or XML; received {content_type}"
                    ));
                }
                let body = String::from_utf8(bytes)
                    .map_err(|_| "web fetch response was not UTF-8 text".to_string())?;
                let text = if content_type.contains("html") {
                    readable_html(&body)
                } else {
                    body.trim().to_string()
                };
                if text.is_empty() && !content_type.contains("html") {
                    return Err("web fetch returned no readable text".into());
                }
                if content_type.contains("html") {
                    return Ok(format_web_page(&current, &body));
                }
                let truncated = text.chars().count() > 12_000;
                let text = text.chars().take(12_000).collect::<String>();
                return Ok(format!(
                    "SOURCE {}\n\n{text}{}",
                    current,
                    if truncated {
                        "\n\n[Text truncated.]"
                    } else {
                        ""
                    }
                ));
            }
            Err("web fetch exceeded 5 redirects".into())
        })();
        tool_result(result, false)
    }

    pub fn write(&self, path: &str, content: &str) -> ToolResult {
        let result = (|| {
            let _lock = self.lock_workspace_write()?;
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

    /// Run a native executable through the same owned process supervisor used
    /// for captured shell actions. Arguments are passed directly to the OS,
    /// without shell parsing or interpolation.
    pub fn run_owned_program(
        &self,
        program: &str,
        args: &[String],
        timeout_secs: u64,
    ) -> ToolResult {
        if program.trim().is_empty() {
            return tool_result(Err("program path cannot be empty".into()), false);
        }
        let mut command = Command::new(program);
        command.args(args);
        self.run_command(command, false, timeout_secs.max(1), true)
    }

    /// Run an owned executable while returning only its stdout on success.
    /// This is for commands with a machine-readable stdout contract; stderr
    /// remains available in failures and still flows through normal lifecycle
    /// observation, but warnings cannot corrupt the structured result.
    pub fn run_owned_program_stdout(
        &self,
        program: &str,
        args: &[String],
        timeout_secs: u64,
    ) -> ToolResult {
        if program.trim().is_empty() {
            return tool_result(Err("program path cannot be empty".into()), false);
        }
        let mut command = Command::new(program);
        command.args(args);
        self.run_command_with_stdout(command, false, timeout_secs.max(1), true)
    }

    /// Clone the active cancellation signal for a related native action.
    pub fn cancellation(&self) -> Cancel {
        self.cancellation.clone()
    }

    pub fn app_uninstall(&self, name: &str) -> ToolResult {
        #[cfg(not(target_os = "macos"))]
        let _ = name;
        #[cfg(target_os = "macos")]
        {
            let _lock = match self.lock_workspace_write() {
                Ok(lock) => lock,
                Err(error) => return tool_result(Err(error), false),
            };
            let Some(home) = dirs::home_dir() else {
                return tool_result(Err("cannot resolve the current user's home".into()), false);
            };
            return tool_result(
                uninstall_mac_app(name, &home, Path::new("/Applications")),
                false,
            );
        }
        #[cfg(not(target_os = "macos"))]
        tool_result(
            Err("app_uninstall is available only on macOS".into()),
            false,
        )
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
        let _lock = if verification {
            None
        } else {
            match self.lock_workspace_write() {
                Ok(lock) => Some(lock),
                Err(error) => return tool_result(Err(error), false),
            }
        };
        if let Err(error) =
            validate_shell_with_owner(command, &self.workspace, deletion_approved, family, false)
        {
            return tool_result(Err(error), verification);
        }
        let process = match pipeline_guard(command, family) {
            PipelineGuard::AsWritten => platform_shell(command),
            PipelineGuard::Guarded(wrapped) => platform_shell(&wrapped),
            // Captured shell actions must report every pipeline stage's status;
            // refusing is safer than turning a failed stage into a success.
            PipelineGuard::Unavailable(reason) => {
                return tool_result(Err(reason), verification);
            }
        };
        self.run_command(process, verification, DEFAULT_TIMEOUT_SECS, true)
    }

    pub fn shell_interactive_with_delete_approval(
        &self,
        command: &str,
        deletion_approved: bool,
    ) -> ToolResult {
        // The CLI owns stdin and keeps its composer active; direct commands
        // share captured output, cancellation and lifecycle supervision.
        self.shell_with_delete_approval(command, false, deletion_approved)
    }

    pub fn http(&self, url: &str) -> ToolResult {
        let result = (|| {
            if !(url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:")) {
                return Err(
                    "http tool is loopback-only and requires an explicit port; use http://127.0.0.1:<port> or http://localhost:<port>"
                        .to_string(),
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
        let mut command = Command::new("git");
        command
            .args(["status", "--short", "--untracked-files=normal", "--", "."])
            .current_dir(&self.workspace);
        match run_bounded_snapshot_command(command, GIT_SNAPSHOT_TIMEOUT) {
            Ok(bytes) => {
                // Preserve porcelain's leading status columns. Trimming the whole
                // value turns ` M file` into `M file`, so downstream path parsing
                // drops the first character of the filename.
                let value = String::from_utf8_lossy(&bytes)
                    .trim_end_matches(['\r', '\n'])
                    .to_string();
                if value.is_empty() {
                    "clean".into()
                } else {
                    value
                }
            }
            Err(error) if error.starts_with("status command exited") => {
                "not a git workspace".into()
            }
            Err(error) => format!("unavailable: {error}"),
        }
    }

    pub fn git_diff_snapshot(&self, paths: &[String]) -> String {
        if paths.is_empty() {
            return String::new();
        }
        let read = |arguments: &[&str]| {
            let output = Command::new("git")
                .args(arguments)
                .arg("--")
                .args(paths)
                .current_dir(&self.workspace)
                .output()
                .ok()?;
            output.status.success().then(|| {
                String::from_utf8_lossy(&output.stdout)
                    .chars()
                    .take(40_000)
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
        };
        let mut snapshot = read(&["diff", "--no-ext-diff", "HEAD"])
            .or_else(|| read(&["diff", "--no-ext-diff"]))
            .unwrap_or_default();
        for path in paths {
            let tracked = Command::new("git")
                .args(["ls-files", "--error-unmatch", "--"])
                .arg(path)
                .current_dir(&self.workspace)
                .output()
                .is_ok_and(|output| output.status.success());
            if tracked {
                continue;
            }
            let Ok(file) = fs::File::open(self.workspace.join(path)) else {
                continue;
            };
            let mut bytes = Vec::new();
            if file.take(10_000).read_to_end(&mut bytes).is_err() {
                continue;
            }
            let Ok(content) = String::from_utf8(bytes) else {
                continue;
            };
            snapshot.push_str(&format!("\n--- /dev/null\n+++ b/{path}\n{content}"));
        }
        snapshot.chars().take(40_000).collect()
    }

    fn run_command(
        &self,
        command: Command,
        verification: bool,
        timeout_secs: u64,
        observe_output: bool,
    ) -> ToolResult {
        self.run_command_with_output_mode(
            command,
            verification,
            timeout_secs,
            observe_output,
            false,
        )
    }

    fn run_command_with_stdout(
        &self,
        command: Command,
        verification: bool,
        timeout_secs: u64,
        observe_output: bool,
    ) -> ToolResult {
        self.run_command_with_output_mode(command, verification, timeout_secs, observe_output, true)
    }

    fn run_command_with_output_mode(
        &self,
        mut command: Command,
        verification: bool,
        timeout_secs: u64,
        observe_output: bool,
        stdout_only_success: bool,
    ) -> ToolResult {
        if self.cancellation.is_cancelled() {
            return tool_result(
                Err(cancellation_output(self.cancellation.reason(), "")),
                verification,
            );
        }
        command
            .current_dir(&self.workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(extra) = &self.external_tools_bin {
            let mut search = vec![extra.clone()];
            if let Some(current) = std::env::var_os("PATH") {
                search.extend(std::env::split_paths(&current));
            }
            let path = std::env::join_paths(search)
                .map_err(|error| format!("could not prepare external HII tools path: {error}"));
            match path {
                Ok(path) => { command.env("PATH", path); }
                Err(error) => return tool_result(Err(error), verification),
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => return tool_result(Err(error.to_string()), verification),
        };
        let identity = ToolProcessIdentity {
            pid: child.id(),
            started_unix_nanos: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
        };
        self.observe_process(ToolProcessEvent::Started(identity.clone()));

        // Drain both pipes while the child runs. Waiting for exit before
        // reading deadlocks as soon as either OS pipe buffer fills.
        let observer = observe_output
            .then(|| self.output_observer.clone())
            .flatten();
        let observer_lock = Arc::new(Mutex::new(()));
        let stdout = match child.stdout.take() {
            Some(pipe) => drain_pipe(
                pipe,
                observer
                    .clone()
                    .map(|sink| (sink, observer_lock.clone(), ToolOutputStream::Stdout)),
            ),
            None => return tool_result(Err("missing child stdout".into()), verification),
        };
        let stderr = match child.stderr.take() {
            Some(pipe) => drain_pipe(
                pipe,
                observer.map(|sink| (sink, observer_lock, ToolOutputStream::Stderr)),
            ),
            None => return tool_result(Err("missing child stderr".into()), verification),
        };

        let started = Instant::now();
        let mut timed_out = false;
        let mut cancelled = false;
        let (mut status, natural_exit) = loop {
            if self.cancellation.is_cancelled() {
                cancelled = true;
                break (
                    Some(match self.stop_process(&mut child, &identity) {
                        Ok(status) => status,
                        Err(error) => {
                            let _ = child.kill();
                            match child.wait() {
                                Ok(status) => status,
                                Err(reap) => {
                                    return tool_result(
                                        Err(format!("{error}; reap failed: {reap}")),
                                        verification,
                                    )
                                }
                            }
                        }
                    }),
                    false,
                );
            }
            if started.elapsed() >= Duration::from_secs(timeout_secs) {
                timed_out = true;
                break (
                    Some(match self.stop_process(&mut child, &identity) {
                        Ok(status) => status,
                        Err(error) => {
                            let _ = child.kill();
                            match child.wait() {
                                Ok(status) => status,
                                Err(reap) => {
                                    return tool_result(
                                        Err(format!("{error}; reap failed: {reap}")),
                                        verification,
                                    )
                                }
                            }
                        }
                    }),
                    false,
                );
            }
            match child_exited_without_reap(&mut child) {
                Ok(true) => break (None, true),
                Ok(false) => thread::sleep(Duration::from_millis(25)),
                Err(error) => {
                    let _ = self.stop_process(&mut child, &identity);
                    return tool_result(
                        Err(format!("could not wait for tool process: {error}")),
                        verification,
                    );
                }
            }
        };
        let (stdout, stdout_complete) = collect_pipe(stdout);
        let (stderr, stderr_complete) = collect_pipe(stderr);
        let pipes_complete = stdout_complete && stderr_complete;
        if natural_exit && !pipes_complete {
            // The leader remains unreaped until its descendants holding either
            // descriptor have been signalled and the owned group is gone.
            status = match self.stop_process(&mut child, &identity) {
                Ok(status) => Some(status),
                Err(error) => {
                    let _ = child.kill();
                    child.wait().ok().or_else(|| {
                        let _ = error;
                        None
                    })
                }
            };
        } else if natural_exit {
            status = child.wait().ok();
        }
        let status = match status {
            Some(status) => status,
            None => {
                return tool_result(
                    Err("could not reap owned tool process".into()),
                    verification,
                )
            }
        };
        self.observe_process(ToolProcessEvent::Reaped {
            identity: identity.clone(),
            exit_code: status.code(),
        });
        self.observe_process(ToolProcessEvent::PipesDrained {
            identity,
            complete: pipes_complete,
        });
        let combined = combine_output(&stdout, &stderr);
        if cancelled {
            return tool_result(
                Err(cancellation_output(self.cancellation.reason(), &combined)),
                verification,
            );
        }
        if timed_out {
            return tool_result(
                Err(format!(
                    "command timed out after {timeout_secs}s\n{combined}"
                )),
                verification,
            );
        }
        if !pipes_complete {
            return tool_result(
                Err(format!(
                    "output incomplete: descendants kept a pipe open\n{combined}"
                )),
                verification,
            );
        }
        if status.success() {
            let successful_output = if stdout_only_success {
                String::from_utf8_lossy(&stdout).to_string()
            } else {
                combined
            };
            tool_result(
                Ok(if stdout_only_success {
                    successful_output
                } else if successful_output.is_empty() {
                    "no output (exit 0)".into()
                } else {
                    successful_output
                }),
                verification,
            )
        } else {
            tool_result(
                Err(format!(
                    "exit {}\n{}",
                    status.code().unwrap_or(-1),
                    combined
                )),
                verification,
            )
        }
    }

    fn observe_process(&self, event: ToolProcessEvent) {
        if let Some(observer) = &self.process_observer {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| observer(event)));
        }
    }

    fn stop_process(
        &self,
        child: &mut std::process::Child,
        identity: &ToolProcessIdentity,
    ) -> Result<std::process::ExitStatus, String> {
        #[cfg(unix)]
        {
            self.signal_process_group(identity, "SIGINT", libc::SIGINT)?;
            thread::sleep(Duration::from_millis(200));
            self.signal_process_group(identity, "SIGTERM", libc::SIGTERM)?;
            thread::sleep(Duration::from_millis(200));
            self.signal_process_group(identity, "SIGKILL", libc::SIGKILL)?;
        }
        #[cfg(not(unix))]
        {
            let _ = identity;
            child.kill().map_err(|e| e.to_string())?;
        }
        child
            .wait()
            .map_err(|e| format!("could not reap tool process: {e}"))
    }

    #[cfg(unix)]
    fn signal_process_group(
        &self,
        identity: &ToolProcessIdentity,
        label: &str,
        signal: i32,
    ) -> Result<(), String> {
        if identity.pid == 0 {
            return Err("invalid owned process identity".into());
        }
        self.observe_process(ToolProcessEvent::Signal {
            identity: identity.clone(),
            signal: label.to_string(),
        });
        // SAFETY: the command was put in a new process group before spawn;
        // a negative pid targets only the process tree owned by this run.
        let result = unsafe { libc::kill(-(identity.pid as i32), signal) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(format!(
                    "could not send {label} to owned process group: {error}"
                ));
            }
        }
        Ok(())
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
        if fs::symlink_metadata(&candidate).is_ok() {
            return self.resolve_existing(raw);
        }
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
        // Models sometimes echo Rust's Windows verbatim display form with one
        // leading slash lost ("\?\C:\..." instead of "\\?\C:\...").
        // Repair only that exact drive-qualified form; never reinterpret a
        // general rooted or relative path.
        #[cfg(target_os = "windows")]
        let repaired;
        #[cfg(target_os = "windows")]
        let raw = if raw.starts_with("\\?\\")
            && raw
                .as_bytes()
                .get(3)
                .is_some_and(|byte| byte.is_ascii_alphabetic())
            && raw.as_bytes().get(4) == Some(&b':')
        {
            repaired = format!(r"\{raw}");
            repaired.as_str()
        } else {
            raw
        };
        let path = Path::new(raw);
        let candidate = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.workspace.join(path)
        };
        Ok(candidate)
    }

    fn ensure_inside(&self, path: PathBuf) -> Result<PathBuf, String> {
        Ok(path)
    }

    fn lock_workspace_write(&self) -> Result<fs::File, String> {
        let digest = Sha256::digest(self.workspace.as_os_str().as_encoded_bytes());
        let lock_path = std::env::temp_dir().join(format!("hii-workspace-{:x}.lock", digest));
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|error| error.to_string())?;
        file.lock_exclusive().map_err(|error| error.to_string())?;
        Ok(file)
    }
}

#[cfg(target_os = "macos")]
fn uninstall_mac_app(name: &str, home: &Path, applications: &Path) -> Result<String, String> {
    let name = name.trim().trim_end_matches(".app").trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || !name
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, ' ' | '-' | '_' | '.'))
    {
        return Err("provide one application name, such as Google Chrome".into());
    }
    let app_file = format!("{name}.app");
    let app = [
        applications.join(&app_file),
        home.join("Applications").join(&app_file),
    ]
    .into_iter()
    .find(|path| path.exists())
    .ok_or_else(|| format!("{name} is not installed in Applications"))?;
    let metadata = fs::symlink_metadata(&app).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("application must be a real .app directory".into());
    }
    let bundle_id = plist::Value::from_file(app.join("Contents/Info.plist"))
        .ok()
        .and_then(|value| value.as_dictionary().cloned())
        .and_then(|dictionary| {
            dictionary
                .get("CFBundleIdentifier")
                .and_then(plist::Value::as_string)
                .map(str::to_owned)
        });
    let mut data_paths = Vec::new();
    if let Some(id) = bundle_id.as_deref() {
        let library = home.join("Library");
        data_paths.extend([
            library.join("Caches").join(id),
            library.join("Preferences").join(format!("{id}.plist")),
            library.join("Application Support").join(id),
            library
                .join("Saved Application State")
                .join(format!("{id}.savedState")),
        ]);
        // Many apps group their profile under Vendor/Product instead of the
        // bundle ID. Derive the candidate from Info.plist, then move it only
        // when it exists; this is one rule for all apps, not a Chrome recipe.
        let segments = id.split('.').collect::<Vec<_>>();
        if segments.len() >= 3 {
            let vendor = title_case_ascii(segments[1]);
            let product = title_case_ascii(segments[2]);
            for root in ["Application Support", "Caches"] {
                data_paths.push(library.join(root).join(&vendor).join(&product));
            }
        }
    }
    data_paths.sort();
    data_paths.dedup();
    stop_mac_app_processes(&app)?;
    let trash = home.join(".Trash").join(format!(
        "HII-{name}-{}-{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S"),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    fs::create_dir_all(&trash).map_err(|error| error.to_string())?;
    let mut moved = Vec::new();
    let paths =
        std::iter::once(app.clone()).chain(data_paths.into_iter().filter(|path| path.exists()));
    for source in paths {
        let relative = source
            .strip_prefix(home)
            .map(Path::to_path_buf)
            .unwrap_or_else(|_| source.strip_prefix("/").unwrap_or(&source).to_path_buf());
        let destination = trash.join(relative);
        let result = destination
            .parent()
            .ok_or_else(|| "invalid Trash destination".to_string())
            .and_then(|parent| fs::create_dir_all(parent).map_err(|error| error.to_string()))
            .and_then(|_| fs::rename(&source, &destination).map_err(|error| error.to_string()));
        if let Err(error) = result {
            for (from, to) in moved.iter().rev() {
                let _ = fs::rename(to, from);
            }
            return Err(format!(
                "uninstall stopped while moving {}: {error}; inspect {}",
                source.display(),
                trash.display()
            ));
        }
        moved.push((source, destination));
    }
    if app.exists() {
        return Err(format!(
            "application still exists at {}; inspect {}",
            app.display(),
            trash.display()
        ));
    }
    Ok(format!(
        "Uninstalled {name}; moved {} item(s) to {}. Restore from Trash if needed.",
        moved.len(),
        trash.display()
    ))
}

#[cfg(target_os = "macos")]
fn title_case_ascii(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(target_os = "macos")]
fn stop_mac_app_processes(app: &Path) -> Result<(), String> {
    let output = Command::new("ps")
        .args(["-axo", "pid=,comm="])
        .output()
        .map_err(|error| error.to_string())?;
    let prefix = format!("{}/", app.display());
    let mut pids = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim_start();
        let Some((pid, executable)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        if executable.trim_start().starts_with(&prefix) {
            if let Ok(pid) = pid.parse::<i32>() {
                pids.push(pid);
            }
        }
    }
    for pid in &pids {
        unsafe {
            libc::kill(*pid, libc::SIGTERM);
        }
    }
    for _ in 0..15 {
        if pids.iter().all(|pid| unsafe { libc::kill(*pid, 0) } != 0) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
    if pids.is_empty() {
        Ok(())
    } else {
        Err(format!("{app:?} is still running; quit it and retry"))
    }
}

fn format_search_results(query: &str, body: &serde_json::Value) -> Result<String, String> {
    let results = body
        .get("results")
        .and_then(|value| value.as_array())
        .ok_or("search response had no results; no results were observed")?;
    let mut lines = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for result in results {
        let (Some(title), Some(link)) = (
            result.get("title").and_then(|value| value.as_str()),
            result.get("url").and_then(|value| value.as_str()),
        ) else {
            continue;
        };
        if title.trim().is_empty()
            || link.len() > 2048
            || validate_public_web_url(link).is_err()
            || !seen.insert(link.to_string())
        {
            continue;
        }
        let description = result
            .get("content")
            .and_then(|value| value.as_str())
            .map(readable_html)
            .unwrap_or_default();
        lines.push(format!(
            "{}. {}\nURL: {}\nEngine: {}\n{}",
            lines.len() + 1,
            readable_html(title).chars().take(250).collect::<String>(),
            link,
            result
                .get("engine")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown")
                .chars()
                .take(80)
                .collect::<String>(),
            description.chars().take(500).collect::<String>()
        ));
        if lines.len() == 8 {
            break;
        }
    }
    if lines.is_empty() {
        let failures = body
            .get("unresponsive_engines")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_array())
                    .filter_map(|pair| pair.first()?.as_str())
                    .take(4)
                    .map(|name| name.chars().take(80).collect::<String>())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if failures.is_empty() {
            Ok("No web results found.".into())
        } else {
            Ok(format!(
                "No web results found. Unresponsive engines: {}",
                failures.join(", ")
            ))
        }
    } else {
        Ok(format!(
            "SEARCH RESULTS for {query}\n\n{}",
            lines.join("\n\n")
        ))
    }
}

fn format_image_results(query: &str, body: &serde_json::Value) -> Result<String, String> {
    let results = body
        .get("results")
        .and_then(|value| value.as_array())
        .ok_or("image search response had no results; no images were observed")?;
    let mut lines = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for result in results {
        let (Some(title), Some(source), Some(image)) = (
            result.get("title").and_then(|value| value.as_str()),
            result.get("url").and_then(|value| value.as_str()),
            result.get("img_src").and_then(|value| value.as_str()),
        ) else {
            continue;
        };
        if source.len() > 2048
            || image.len() > 2048
            || validate_public_web_url(source).is_err()
            || validate_public_web_url(image).is_err()
            || !seen.insert(image.to_string())
        {
            continue;
        }
        let thumbnail = result
            .get("thumbnail")
            .and_then(|value| value.as_str())
            .filter(|url| url.len() <= 2048 && validate_public_web_url(url).is_ok())
            .unwrap_or(image);
        lines.push(format!(
            "{}. {}\nImage: {}\nThumbnail: {}\nSource: {}\nEngine: {}",
            lines.len() + 1,
            readable_html(title).chars().take(250).collect::<String>(),
            image,
            thumbnail,
            source,
            result
                .get("engine")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown")
                .chars()
                .take(80)
                .collect::<String>()
        ));
        if lines.len() == 8 {
            break;
        }
    }
    if lines.is_empty() {
        let failures = body
            .get("unresponsive_engines")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_array())
                    .filter_map(|pair| pair.first()?.as_str())
                    .take(4)
                    .map(|name| name.chars().take(80).collect::<String>())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if failures.is_empty() {
            Ok("No image results found.".into())
        } else {
            Ok(format!(
                "No image results found. Unresponsive engines: {}",
                failures.join(", ")
            ))
        }
    } else {
        Ok(format!(
            "IMAGE RESULTS for {query}\n\n{}",
            lines.join("\n\n")
        ))
    }
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

/// Build a compact HTML page result. This intentionally reads source markup only;
/// images and links created by JavaScript are not observed.
fn format_web_page(page: &Url, html: &str) -> String {
    // Embedded examples and script strings are not page image/link elements.
    let hidden = regex::Regex::new(r"(?is)<!--.*?-->|<(?:script|style|noscript|template|svg)\b[^>]*>.*?</(?:script|style|noscript|template|svg)\s*>").unwrap();
    let markup = hidden.replace_all(html, " ");
    let html = markup.as_ref();
    fn attr(tag: &str, name: &str) -> Option<String> {
        let pattern = format!(r#"(?is)(?:^|\s){name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))"#);
        let captures = regex::Regex::new(&pattern).ok()?.captures(tag)?;
        let value = captures
            .get(1)
            .or_else(|| captures.get(2))
            .or_else(|| captures.get(3))?
            .as_str();
        Some(decode_entities(value).trim().to_string())
    }
    fn resolve(page: &Url, raw: &str) -> Option<String> {
        if raw.trim().is_empty() || raw.len() > 2048 || raw.starts_with('#') {
            return None;
        }
        let url = page.join(raw.trim()).ok()?;
        validate_public_web_url(url.as_str())
            .ok()
            .map(|_| url.to_string())
    }
    let tag_re = regex::Regex::new(r"(?is)<(?:img|meta|a)\b[^>]*>").unwrap();
    let mut images: Vec<(String, String)> = Vec::new();
    let mut image_seen = std::collections::HashSet::new();
    let mut links: Vec<(String, String)> = Vec::new();
    let mut link_seen = std::collections::HashSet::new();
    let mut og_image = None;
    let mut scanned = 0;
    for tag_match in tag_re.find_iter(html).take(512) {
        scanned += 1;
        let tag = tag_match.as_str();
        let lower = tag.to_ascii_lowercase();
        if lower.starts_with("<img") {
            if images.len() >= 9 {
                continue;
            }
            let alt = attr(tag, "alt").unwrap_or_default();
            let candidates = [
                attr(tag, "data-src"),
                attr(tag, "data-lazy-src"),
                attr(tag, "src"),
            ];
            for raw in
                candidates
                    .into_iter()
                    .flatten()
                    .chain(attr(tag, "srcset").into_iter().flat_map(|s| {
                        s.split(',')
                            .filter_map(|part| part.split_whitespace().next().map(str::to_owned))
                            .collect::<Vec<_>>()
                    }))
            {
                if let Some(url) = resolve(page, &raw) {
                    if image_seen.insert(url.clone()) {
                        images.push((url, alt.clone()));
                    }
                    break;
                }
            }
        } else if lower.starts_with("<a") {
            if links.len() >= 9 {
                continue;
            }
            if let Some(raw) = attr(tag, "href") {
                if let Some(url) = resolve(page, &raw) {
                    let tail = &html[tag_match.end()..];
                    let end = tail.to_ascii_lowercase().find("</a").unwrap_or(0);
                    let label = readable_html(&tail[..end])
                        .chars()
                        .take(120)
                        .collect::<String>();
                    if !label.trim().is_empty() && link_seen.insert(url.clone()) {
                        links.push((url, label));
                    }
                }
            }
        } else if attr(tag, "property").as_deref() == Some("og:image")
            || attr(tag, "name").as_deref() == Some("og:image")
        {
            og_image = attr(tag, "content").and_then(|raw| resolve(page, &raw));
        }
    }
    if images.is_empty() {
        if let Some(url) = og_image {
            images.push((url, String::new()));
        }
    }
    let text = readable_html(html);
    let text_truncated = text.chars().count() > 12_000;
    let mut output = format!(
        "SOURCE {}\n[Untrusted page content; static HTML only.]\n\n{}",
        page,
        text.chars().take(12_000).collect::<String>()
    );
    if !images.is_empty() {
        output.push_str("\n\nIMAGES");
        for (url, alt) in images.iter().take(8) {
            output.push_str(&format!(
                "\n- {}{}",
                url,
                if alt.is_empty() {
                    String::new()
                } else {
                    format!(
                        " — {}",
                        readable_html(alt).chars().take(160).collect::<String>()
                    )
                }
            ));
        }
    }
    if !links.is_empty() {
        output.push_str("\n\nLINKS");
        for (url, label) in links.iter().take(8) {
            output.push_str(&format!("\n- {} — {}", readable_html(label), url));
        }
    }
    if text_truncated || images.len() > 8 || links.len() > 8 || scanned == 512 {
        output.push_str("\n\n[Page content truncated to bounded text and metadata.] ");
    }
    output
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
    let found = std::env::split_paths(&paths).any(|dir| {
        exe_suffixes.iter().any(|suffix| {
            let candidate = dir.join(format!("{program}{suffix}"));
            candidate.is_file()
        })
    });
    // Windows can put a Microsoft Store launcher named python3.exe on PATH
    // even though it cannot run Python. Treat this as a missing interpreter,
    // not a missing module or a failing project test. Do not silently switch
    // interpreters: virtual environments and versions belong to the command.
    #[cfg(windows)]
    if found && program.trim_end_matches(".exe").starts_with("python") {
        return python_runs(program);
    }
    found
}

#[cfg(windows)]
fn python_runs(program: &str) -> bool {
    use std::os::windows::process::CommandExt;
    let Ok(mut child) = Command::new(program)
        .args(["-I", "-S", "-c", "pass"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .spawn()
    else {
        return false;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() < Duration::from_secs(2) => {
                thread::sleep(Duration::from_millis(10))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
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

fn validate_shell(
    command: &str,
    workspace: &Path,
    deletion_approved: bool,
    family: ShellFamily,
) -> Result<(), String> {
    validate_shell_with_owner(command, workspace, deletion_approved, family, false)
}

fn validate_shell_with_owner(
    command: &str,
    workspace: &Path,
    deletion_approved: bool,
    family: ShellFamily,
    owner_mode: bool,
) -> Result<(), String> {
    let _ = (workspace, deletion_approved, family, owner_mode);
    if command.trim().is_empty() {
        return Err("shell command cannot be empty".into());
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
        let head = crate::text::clip_bytes(&combined, MAX_OUTPUT_BYTES / 2);
        let mut tail_start = combined.len() - MAX_OUTPUT_BYTES / 2;
        while !combined.is_char_boundary(tail_start) {
            tail_start += 1;
        }
        combined = format!(
            "{head}\n[output truncated; beginning and end retained]\n{}",
            &combined[tail_start..]
        );
    }
    combined.trim().to_string()
}

#[cfg(unix)]
fn child_exited_without_reap(child: &mut std::process::Child) -> std::io::Result<bool> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // WNOWAIT leaves the leader's PID reserved while captured pipes are
    // drained, so escalation can still target its process group safely.
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { info.si_pid() } == child.id() as i32)
}

#[cfg(not(unix))]
fn child_exited_without_reap(child: &mut std::process::Child) -> std::io::Result<bool> {
    child.try_wait().map(|status| status.is_some())
}

struct PipeCapture {
    receiver: mpsc::Receiver<Result<Vec<u8>, String>>,
    partial: Arc<Mutex<Vec<u8>>>,
    stop: Arc<AtomicBool>,
}

#[cfg(unix)]
trait PipeRead: Read + AsRawFd {}
#[cfg(unix)]
impl<T: Read + AsRawFd> PipeRead for T {}
#[cfg(not(unix))]
trait PipeRead: Read {}
#[cfg(not(unix))]
impl<T: Read> PipeRead for T {}

fn drain_pipe(
    mut pipe: impl PipeRead + Send + 'static,
    observer: Option<(ToolOutputObserver, Arc<Mutex<()>>, ToolOutputStream)>,
) -> PipeCapture {
    #[cfg(unix)]
    {
        // ChildStdout/ChildStderr are owned descriptors from our child; making
        // them nonblocking lets the reader stop if an escaped descendant keeps
        // a pipe open after the child is gone.
        unsafe {
            let flags = libc::fcntl(pipe.as_raw_fd(), libc::F_GETFL);
            if flags >= 0 {
                let _ = libc::fcntl(pipe.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK);
            }
        }
    }
    let (sender, receiver) = mpsc::channel();
    let partial = Arc::new(Mutex::new(Vec::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let partial_copy = partial.clone();
    let stop_copy = stop.clone();
    thread::spawn(move || {
        let mut captured = Vec::new();
        let mut total = 0usize;
        let mut buffer = [0u8; 8192];
        let result = (|| {
            loop {
                if stop_copy.load(Ordering::Relaxed) {
                    break;
                }
                let size = match pipe.read(&mut buffer) {
                    Ok(size) => size,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error.to_string()),
                };
                if size == 0 {
                    break;
                }
                total = total.saturating_add(size);
                let available = MAX_OUTPUT_BYTES.saturating_sub(captured.len());
                let kept = size.min(available);
                captured.extend_from_slice(&buffer[..kept]);
                if kept > 0 {
                    if let Ok(mut shared) = partial_copy.lock() {
                        shared.extend_from_slice(&buffer[..kept]);
                    }
                }
                if kept > 0 {
                    if let Some((sink, lock, stream)) = &observer {
                        // A broken presentation sink must not stop pipe draining
                        // or change the command's captured result.
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            if let Ok(_guard) = lock.lock() {
                                sink(*stream, &buffer[..kept]);
                            }
                        }));
                    }
                }
            }
            if total > captured.len() {
                captured.extend_from_slice(
                    format!(
                        "\n[stream truncated: captured {} of {total} bytes]",
                        captured.len()
                    )
                    .as_bytes(),
                );
            }
            Ok(captured)
        })();
        let _ = sender.send(result);
    });
    PipeCapture {
        receiver,
        partial,
        stop,
    }
}

fn collect_pipe(capture: PipeCapture) -> (Vec<u8>, bool) {
    match capture.receiver.recv_timeout(Duration::from_millis(350)) {
        Ok(Ok(output)) => (output, true),
        Ok(Err(error)) => (format!("[output read failed: {error}]").into_bytes(), false),
        Err(_) => {
            // A descendant may have inherited the descriptor. On Unix the
            // reader is nonblocking, so request its exit and retain bytes read
            // before the deadline instead of leaving a parked thread behind.
            capture.stop.store(true, Ordering::Relaxed);
            let mut output = match capture.receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(output)) => output,
                _ => capture
                    .partial
                    .lock()
                    .map(|bytes| bytes.clone())
                    .unwrap_or_default(),
            };
            output.extend_from_slice(b"\n[output incomplete: descendant kept pipe open]");
            (output, false)
        }
    }
}

fn cancellation_output(reason: Option<CancelReason>, output: &str) -> String {
    let reason = match reason {
        Some(CancelReason::Interrupt) => "operator interrupt",
        Some(CancelReason::Budget(_)) => "run budget exhausted",
        Some(CancelReason::Client) | None => "client cancellation",
    };
    if output.is_empty() {
        format!("CANCELLED: {reason}")
    } else {
        format!("CANCELLED: {reason}\n{output}")
    }
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
    fn write_accepts_paths_outside_workspace() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        assert!(tools.write("notes/proof.txt", "verified").ok);
        assert_eq!(
            fs::read_to_string(path.join("notes/proof.txt")).unwrap(),
            "verified"
        );
        assert!(tools.write("../escape.txt", "outside").ok);
        assert_eq!(
            fs::read_to_string(path.parent().unwrap().join("escape.txt")).unwrap(),
            "outside"
        );
        let _ = fs::remove_file(path.parent().unwrap().join("escape.txt"));
        let _ = fs::remove_dir_all(path);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn app_uninstall_moves_bundle_and_derived_data_to_recoverable_trash() {
        let root = workspace();
        let home = root.join("home");
        let applications = root.join("Applications");
        let bundle = applications.join("Fixture Browser.app");
        fs::create_dir_all(bundle.join("Contents")).unwrap();
        fs::write(bundle.join("Contents/Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.Browser</string></dict></plist>"#).unwrap();
        let profile = home.join("Library/Application Support/Example/Browser");
        fs::create_dir_all(&profile).unwrap();
        fs::write(profile.join("profile.txt"), "keep this recoverable").unwrap();
        let unrelated = home.join("Library/Application Support/Other/Browser");
        fs::create_dir_all(&unrelated).unwrap();
        fs::write(unrelated.join("profile.txt"), "untouched").unwrap();
        let result = uninstall_mac_app("Fixture Browser", &home, &applications).unwrap();
        assert!(result.contains("Restore from Trash"));
        assert!(!bundle.exists());
        assert!(!profile.exists());
        assert!(unrelated.exists());
        let trash = fs::read_dir(home.join(".Trash"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(trash.join(bundle.strip_prefix("/").unwrap()).exists());
        assert_eq!(
            fs::read_to_string(
                trash.join("Library/Application Support/Example/Browser/profile.txt")
            )
            .unwrap(),
            "keep this recoverable"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn write_rejects_symlink_target_outside_authority() {
        use std::os::unix::fs::symlink;
        let root = workspace();
        let outside = workspace();
        symlink(outside.join("secret.txt"), root.join("escape.txt")).unwrap();
        let tools = Toolbelt::new(root.clone()).unwrap();
        assert!(!tools.write("escape.txt", "escaped").ok);
        assert!(!outside.join("secret.txt").exists());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn shell_allows_redirects_and_deletion_without_approval() {
        let path = workspace();
        assert!(validate_shell("echo 'x' > calc.py", &path, false, ShellFamily::Posix).is_ok());
        assert!(validate_shell("rm -rf build", &path, false, ShellFamily::Posix).is_ok());
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn shell_allows_absolute_parent_and_secret_paths() {
        let root = workspace();
        assert!(validate_shell("cat ../shared.txt", &root, false, ShellFamily::Posix).is_ok());
        assert!(validate_shell("cat /tmp/shared.txt", &root, false, ShellFamily::Posix).is_ok());
        assert!(validate_shell_with_owner(
            "cat ../shared.txt /tmp/shared.txt",
            &root,
            false,
            ShellFamily::Posix,
            true,
        )
        .is_ok());
        assert!(validate_shell_with_owner(
            "echo secret > ../.env",
            &root,
            false,
            ShellFamily::Posix,
            true,
        )
        .is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn captured_pipelines_report_an_early_failure_for_nonverification_shells() {
        let root = workspace();
        let tools = Toolbelt::new(root.clone()).unwrap();
        let result = tools.shell("sh -c 'exit 22' | cat", false);
        assert!(!result.ok, "masked pipeline failure: {}", result.output);
        assert!(result.output.contains("exit 22"), "{}", result.output);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn owned_program_passes_arguments_without_shell_interpolation() {
        let root = workspace();
        let tools = Toolbelt::new(root.clone()).unwrap();
        let result =
            tools.run_owned_program("printf", &["%s".into(), "literal;$(echo unsafe)".into()], 2);
        assert!(result.ok, "{}", result.output);
        assert_eq!(result.output, "literal;$(echo unsafe)");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_signals_owned_group_captures_partial_output_and_reaps() {
        let root = workspace();
        let mut tools = Toolbelt::new(root.clone()).unwrap();
        let cancel = Cancel::new();
        tools.set_cancellation(cancel.clone());
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_copy = events.clone();
        tools.set_process_observer(Some(Arc::new(move |event| {
            events_copy.lock().unwrap().push(event);
        })));
        let request = cancel.clone();
        let interrupter = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            request.cancel(CancelReason::Interrupt);
        });
        let started = Instant::now();
        let result = tools.shell("trap '' INT TERM; echo partial-output; sleep 20", false);
        interrupter.join().unwrap();
        assert!(!result.ok);
        assert!(result.output.contains("CANCELLED:"), "{}", result.output);
        assert!(
            result.output.contains("partial-output"),
            "{}",
            result.output
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        let events = events.lock().unwrap();
        assert!(events
            .iter()
            .any(|event| matches!(event, ToolProcessEvent::Started(_))));
        assert!(events.iter().any(
            |event| matches!(event, ToolProcessEvent::Signal { signal, .. } if signal == "SIGINT")
        ));
        assert!(events
            .iter()
            .any(|event| matches!(event, ToolProcessEvent::Reaped { .. })));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn descendant_holding_pipe_is_killed_and_partial_output_is_returned() {
        let root = workspace();
        let tools = Toolbelt::new(root.clone()).unwrap();
        let result = tools.shell("sleep 20 & echo descendant-started", false);
        assert!(!result.ok);
        assert!(
            result.output.contains("output incomplete"),
            "{}",
            result.output
        );
        assert!(
            result.output.contains("descendant-started"),
            "{}",
            result.output
        );
        let _ = fs::remove_dir_all(root);
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
    fn shell_distinguishes_windows_slash_switches_from_posix_absolute_paths() {
        let path = workspace();
        assert!(validate_shell("dir /s /b *.gh", &path, false, ShellFamily::PowerShell,).is_ok());
        assert!(validate_shell("ls /s", &path, false, ShellFamily::Posix).is_ok());
        assert!(validate_shell(
            "type /outside/file.txt",
            &path,
            false,
            ShellFamily::PowerShell,
        )
        .is_ok());
        let _ = fs::remove_dir_all(path);
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
        let interpreters = if cfg!(windows) {
            ["python", "python3"]
        } else {
            ["python3", "python"]
        };
        if let Some(interpreter) = interpreters.into_iter().find(|name| which_on_path(name)) {
            let missing = preflight_command(
                &format!("{interpreter} -m definitely_not_a_module_xyz"),
                &path,
            )
            .expect_err("a missing module is a missing dependency");
            assert_eq!(missing.program, "definitely_not_a_module_xyz");
            preflight_command(&format!("{interpreter} -m json.tool"), &path)
                .expect("stdlib module resolves");
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
    fn destructive_shell_is_not_approval_gated() {
        let path = workspace();
        assert!(validate_shell("rm -rf build", &path, false, ShellFamily::Posix).is_ok());
        assert!(validate_shell("rm -rf build", &path, true, ShellFamily::Posix).is_ok());
        assert!(validate_shell("git status --short", &path, false, ShellFamily::Posix).is_ok());
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn git_snapshot_is_scoped_to_workspace_path() {
        let repo = workspace();
        let nested = repo.join("nested").join("task");
        fs::create_dir_all(&nested).unwrap();
        Command::new("git")
            .args(["init"])
            .current_dir(&repo)
            .output()
            .expect("git init");
        fs::write(repo.join("outside.txt"), "outside").unwrap();

        let tools = Toolbelt::new(nested.clone()).unwrap();
        assert_eq!(tools.git_snapshot(), "clean");

        fs::write(nested.join("inside.txt"), "inside").unwrap();
        let snapshot = tools.git_snapshot();
        assert_ne!(snapshot, "clean");
        assert!(!snapshot.contains("outside.txt"));
        let _ = fs::remove_dir_all(repo);
    }

    #[cfg(unix)]
    #[test]
    fn bounded_status_timeout_is_reported_instead_of_claimed_clean() {
        let mut command = Command::new("sh");
        command.args(["-c", "exec sleep 5"]);
        let error = run_bounded_snapshot_command(command, Duration::from_millis(80))
            .expect_err("sleep must exceed status deadline");
        assert!(error.contains("timed out"), "{error}");
        assert_ne!(error, "clean");
    }

    #[test]
    fn git_snapshot_preserves_porcelain_status_columns() {
        let repo = workspace();
        Command::new("git")
            .args(["init"])
            .current_dir(&repo)
            .output()
            .expect("git init");
        fs::write(repo.join("tracked.txt"), "before\n").unwrap();
        Command::new("git")
            .args(["add", "tracked.txt"])
            .current_dir(&repo)
            .output()
            .expect("git add");
        Command::new("git")
            .args([
                "-c",
                "user.name=HII Test",
                "-c",
                "user.email=hii@example.invalid",
                "commit",
                "-m",
                "fixture",
            ])
            .current_dir(&repo)
            .output()
            .expect("git commit");
        fs::write(repo.join("tracked.txt"), "after\n").unwrap();

        let tools = Toolbelt::new(repo.clone()).unwrap();
        assert_eq!(tools.git_snapshot(), " M tracked.txt");
        assert!(tools
            .git_diff_snapshot(&["tracked.txt".into()])
            .contains("+after"));
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn git_diff_snapshot_includes_untracked_artifact_content() {
        let repo = workspace();
        Command::new("git")
            .args(["init"])
            .current_dir(&repo)
            .output()
            .expect("git init");
        fs::write(repo.join("created.txt"), "review this content\n").unwrap();

        let tools = Toolbelt::new(repo.clone()).unwrap();
        let snapshot = tools.git_diff_snapshot(&["created.txt".into()]);
        assert!(snapshot.contains("+++ b/created.txt"));
        assert!(snapshot.contains("review this content"));
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn secret_files_are_readable() {
        let path = workspace();
        fs::write(path.join(".env"), "TOKEN=nope").unwrap();
        let tools = Toolbelt::new(path.clone()).unwrap();
        assert!(tools.read_range(".env", None, None).ok);
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
    fn search_no_matches_is_not_a_tool_failure() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        assert!(tools.write("sample.txt", "known content\n").ok);
        let result = tools.search("absent-pattern", None);
        assert!(result.ok, "{}", result.output);
        assert!(result.output.is_empty());
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn search_results_include_only_public_source_links() {
        let body = serde_json::json!({"results":[
            {"title":"A <b>source</b>","url":"https://example.com/a","content":"Some <b>context</b>","engine":"google cse"},
            {"title":"Internal","url":"http://127.0.0.1/private","engine":"google cse"},
            {"title":"Wrong engine","url":"https://example.com/brave","engine":"brave"}
        ]});
        let result = format_search_results("test", &body).unwrap();
        assert!(result.contains("https://example.com/a"));
        assert!(result.contains("Some context"));
        assert!(!result.contains("127.0.0.1"));
        assert!(result.contains("Wrong engine"));
    }

    #[test]
    fn search_aggregates_engines_deduplicates_and_reports_failures() {
        let body = serde_json::json!({"results":[
            {"title":"First","url":"https://example.com/a","engine":"google cse"},
            {"title":"Duplicate","url":"https://example.com/a","engine":"bing"},
            {"title":"Second","url":"https://example.com/b","engine":"bing"}
        ],"unresponsive_engines":[["duckduckgo","timeout"]]});
        let result = format_search_results("test", &body).unwrap();
        assert!(result.contains("Engine: google cse") && result.contains("Engine: bing"));
        assert_eq!(result.matches("https://example.com/a").count(), 1);
        let failed = format_search_results(
            "test",
            &serde_json::json!({"results":[],"unresponsive_engines":[["bing","timeout"]]}),
        )
        .unwrap();
        assert!(failed.contains("Unresponsive engines: bing"));
    }

    #[test]
    fn image_results_include_direct_image_thumbnail_and_source() {
        let body = serde_json::json!({"results":[
            {"title":"Facade","url":"https://example.com/page","img_src":"https://example.com/a.jpg","thumbnail":"https://example.com/thumb.jpg","engine":"bing images"},
            {"title":"Internal","url":"http://127.0.0.1/page","img_src":"https://example.com/b.jpg","engine":"bing images"},
            {"title":"Wrong engine","url":"https://example.com/page","img_src":"https://example.com/b.jpg","engine":"brave.images"}
        ]});
        let result = format_image_results("facade", &body).unwrap();
        assert!(result.contains("Image: https://example.com/a.jpg"));
        assert!(result.contains("Thumbnail: https://example.com/thumb.jpg"));
        assert!(result.contains("Source: https://example.com/page"));
        assert!(!result.contains("127.0.0.1"));
        assert!(result.contains("Wrong engine"));
    }

    #[test]
    fn native_image_search_requests_local_engine_and_returns_observed_result() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let size = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..size]);
            assert!(request.contains("q=%21bii+facade+study"));
            assert!(!request.to_ascii_lowercase().contains("subscription-token"));
            let body = r#"{"results":[{"title":"Facade","url":"https://example.com/page","img_src":"https://example.com/a.jpg","thumbnail":"https://example.com/t.jpg","engine":"bing images"}]}"#;
            use std::io::Write;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        let result = tools
            .search_searxng_at(
                "facade study",
                "bii",
                true,
                &format!("http://{address}/images/search"),
            )
            .unwrap();
        assert!(result.contains("Image: https://example.com/a.jpg"));
        server.join().unwrap();
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn web_request_returns_promptly_when_run_is_cancelled() {
        use std::io::{Read, Write};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            std::thread::sleep(Duration::from_millis(750));
            let body = "{}";
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
        });
        let path = workspace();
        let mut tools = Toolbelt::new(path.clone()).unwrap();
        let cancellation = Cancel::new();
        tools.set_cancellation(cancellation.clone());
        let cancel_after = cancellation.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(40));
            cancel_after.cancel(CancelReason::Client);
        });
        let started = Instant::now();
        let request = tools.web_http.get(&format!("http://{address}/search"));
        let error = tools
            .run_web_request(move || {
                request
                    .call()
                    .map_err(|error| error.to_string())?
                    .into_string()
                    .map_err(|error| error.to_string())
            })
            .unwrap_err();
        assert!(error.contains("web request canceled"), "{error}");
        assert!(started.elapsed() < Duration::from_millis(500));
        canceller.join().unwrap();
        server.join().unwrap();
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn image_preview_rejects_private_urls() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        assert!(tools
            .image_preview("http://127.0.0.1:8888/image.png")
            .is_err());
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    #[ignore = "requires the user's local non-Docker search service"]
    fn live_local_web_and_image_search() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        let web = tools.web_search("architecture facade");
        assert!(
            web.ok && web.output.contains("URL: https://"),
            "{}",
            web.output
        );
        let images = tools.image_search("architecture facade");
        assert!(
            images.ok && images.output.contains("Image: https://"),
            "{}",
            images.output
        );
        let thumbnail = images
            .output
            .lines()
            .find_map(|line| line.strip_prefix("Thumbnail: "))
            .unwrap();
        let preview = tools.image_preview(thumbnail).unwrap();
        assert!(preview.mime_type.starts_with("image/") && !preview.base64.is_empty());
        let _ = fs::remove_dir_all(path);
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
    fn web_fetch_html_metadata_resolves_deduplicates_and_filters_private_urls() {
        let page = Url::parse("https://example.com/guide/page").unwrap();
        let html = r#"<main><p>Readable page</p>
          <img src="../img/a.jpg" alt="A &amp; B"><img src="https://example.com/img/a.jpg" alt="duplicate">
          <img src="http://127.0.0.1/private.jpg" alt="private">
          <a href="../next">Next page</a><a href="../next">Duplicate</a>
          <a href="/nested"><img data-src="../img/lazy.jpg" src="/placeholder.gif" alt="Lazy image"></a>
          <script>const fake = '<img src="/fake.jpg">';</script>
        </main>"#;
        let output = format_web_page(&page, html);
        assert!(output.contains("https://example.com/img/a.jpg — A & B"));
        assert_eq!(output.matches("https://example.com/img/a.jpg").count(), 1);
        assert!(output.contains("Next page — https://example.com/next"));
        assert!(!output.contains("127.0.0.1"));
        assert!(output.contains("https://example.com/img/lazy.jpg"));
        assert!(!output.contains("placeholder.gif"));
        assert!(!output.contains("fake.jpg"));
    }

    #[test]
    fn web_fetch_html_metadata_is_bounded_and_discloses_truncation() {
        let page = Url::parse("https://example.com/").unwrap();
        let mut html = format!("<p>{}</p>", "x".repeat(12_100));
        for i in 0..12 {
            html.push_str(&format!(
                "<img src='/i{i}.jpg' alt='i{i}'><a href='/l{i}'>link {i}</a>"
            ));
        }
        let output = format_web_page(&page, &html);
        assert!(output.contains("[Page content truncated"));
        assert_eq!(
            output
                .lines()
                .filter(|line| line.starts_with("- https://example.com/i"))
                .count(),
            8
        );
        assert_eq!(
            output
                .lines()
                .filter(|line| line.starts_with("- link "))
                .count(),
            8
        );
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
    fn http_rejects_public_urls_and_loopback_without_a_port() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();

        for url in [
            "https://example.com/",
            "http://localhost",
            "http://127.0.0.1",
        ] {
            let result = tools.http(url);
            assert!(!result.ok, "{url} should be blocked");
            assert!(result.verification);
            assert!(result.output.contains("requires an explicit port"));
        }

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

    #[cfg(target_os = "windows")]
    #[test]
    fn repairs_single_slash_windows_verbatim_paths_from_model_output() {
        let path = workspace();
        fs::write(path.join("proof.txt"), "ok").unwrap();
        let tools = Toolbelt::new(path.clone()).unwrap();
        let displayed = tools.workspace().display().to_string();
        assert!(displayed.starts_with(r"\\?\"), "{displayed}");
        let malformed = displayed.replacen(r"\\?\", r"\?\", 1);
        let listed = tools.list(Some(&malformed));
        assert!(listed.ok, "{}", listed.output);
        assert!(listed.output.contains("proof.txt"));
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn windows_destructive_patterns_are_not_approval_gated() {
        let path = workspace();
        assert!(validate_shell("del important.txt", &path, false, ShellFamily::PowerShell).is_ok());
        assert!(validate_shell("Remove-Item x", &path, false, ShellFamily::PowerShell).is_ok());
        assert!(validate_shell("cargo test", &path, false, ShellFamily::PowerShell).is_ok());
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

    #[test]
    fn command_drains_stdout_and_stderr_before_exit() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        #[cfg(windows)]
        let command = {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Out.Write('x' * 200000); [Console]::Error.Write('y' * 200000)",
            ]);
            command
        };
        #[cfg(not(windows))]
        let command = {
            let mut command = Command::new("sh");
            command.args(["-c", "i=0; while [ $i -lt 12000 ]; do printf 'stdout0123456789\\n'; printf 'stderr0123456789\\n' >&2; i=$((i+1)); done"]);
            command
        };
        let result = tools.run_command(command, true, 10, false);
        assert!(result.ok, "{}", result.output);
        assert!(result.verification);
        assert!(result.output.contains("truncated"));
        assert!(result.output.len() < MAX_OUTPUT_BYTES + 256);
        let _ = fs::remove_dir_all(path);
    }

    #[cfg(not(windows))]
    #[test]
    fn owned_stdout_mode_keeps_json_clean_and_retains_stderr_on_failure() {
        let path = workspace();
        let tools = Toolbelt::new(path.clone()).unwrap();
        let result = tools.run_owned_program_stdout(
            "sh",
            &[
                "-c".into(),
                "printf '{\"choices\":[]}\\n'; printf 'ExperimentalWarning: noisy diagnostic\\n' >&2".into(),
            ],
            5,
        );
        assert!(result.ok, "{}", result.output);
        assert_eq!(result.output, "{\"choices\":[]}\n");
        assert!(serde_json::from_str::<serde_json::Value>(&result.output).is_ok());

        let failed = tools.run_owned_program_stdout(
            "sh",
            &[
                "-c".into(),
                "printf '{\"choices\":[]}\\n'; printf 'catalog failed\\n' >&2; exit 2".into(),
            ],
            5,
        );
        assert!(!failed.ok);
        assert!(
            failed.output.contains("catalog failed"),
            "{}",
            failed.output
        );
        let _ = fs::remove_dir_all(path);
    }

    #[cfg(unix)]
    #[test]
    fn shell_observer_streams_both_pipes_and_keeps_capture() {
        let path = workspace();
        let mut tools = Toolbelt::new(path.clone()).unwrap();
        let chunks = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = chunks.clone();
        tools.set_output_observer(Some(Arc::new(move |stream, bytes| {
            observed
                .lock()
                .unwrap()
                .push((stream, String::from_utf8_lossy(bytes).to_string()));
        })));

        let result = tools.shell(
            "printf 'hello stdout\\n'; printf 'real stderr\\n' >&2",
            true,
        );
        assert!(result.ok, "{}", result.output);
        assert!(result.output.contains("hello stdout"));
        assert!(result.output.contains("real stderr"));
        let chunks = chunks.lock().unwrap();
        assert!(chunks.iter().any(|(stream, value)| {
            *stream == ToolOutputStream::Stdout && value.contains("hello stdout")
        }));
        assert!(chunks.iter().any(|(stream, value)| {
            *stream == ToolOutputStream::Stderr && value.contains("real stderr")
        }));
        assert!(chunks.iter().map(|(_, value)| value.len()).sum::<usize>() <= 2 * MAX_OUTPUT_BYTES);
        let _ = fs::remove_dir_all(path);
    }

    #[cfg(unix)]
    #[test]
    fn silent_shell_success_has_no_observed_output_but_keeps_result_metadata() {
        let path = workspace();
        let mut tools = Toolbelt::new(path.clone()).unwrap();
        let observed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = observed.clone();
        tools.set_output_observer(Some(Arc::new(move |_, bytes| {
            count.fetch_add(bytes.len(), Ordering::Relaxed);
        })));
        let result = tools.shell(":", true);
        assert!(result.ok);
        assert_eq!(result.output, "no output (exit 0)");
        assert_eq!(observed.load(Ordering::Relaxed), 0);

        // A literal `ok` printed by the command is distinguishable because it
        // arrives as actual stdout bytes, so the presentation layer can retain it.
        let printed = tools.shell("printf ok", true);
        assert!(printed.ok);
        assert!(observed.load(Ordering::Relaxed) > 0);
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn output_clipping_preserves_unicode_boundaries_and_error_tail() {
        let output = combine_output(
            "é".repeat(MAX_OUTPUT_BYTES).as_bytes(),
            b"important stderr diagnosis",
        );
        assert!(output.contains("important stderr diagnosis"));
        assert!(output.contains("truncated"));
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
