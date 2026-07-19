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

    pub fn read(&self, path: &str) -> ToolResult {
        let result = (|| {
            let path = self.resolve_existing(path)?;
            let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
            if !metadata.is_file() {
                return Err(format!("not a file: {}", path.display()));
            }
            if metadata.len() > MAX_OUTPUT_BYTES as u64 {
                return Err(format!(
                    "file is larger than {} KiB; use search or a narrower file",
                    MAX_OUTPUT_BYTES / 1024
                ));
            }
            let bytes = fs::read(&path).map_err(|error| error.to_string())?;
            let text = String::from_utf8(bytes)
                .map_err(|_| "binary files are not readable by this tool".to_string())?;
            Ok(text)
        })();
        tool_result(result, false)
    }

    pub fn list(&self, path: Option<&str>) -> ToolResult {
        let base = match path {
            Some(path) => match self.resolve_existing(path) {
                Ok(path) => path,
                Err(error) => return tool_result(Err(error), false),
            },
            None => self.workspace.clone(),
        };
        let relative = base.strip_prefix(&self.workspace).unwrap_or(Path::new("."));
        let mut command = Command::new("rg");
        command.args(["--files", "--hidden", "-g", "!.git"]);
        if relative != Path::new("") && relative != Path::new(".") {
            command.arg(relative);
        }
        self.run_command(command, false, DEFAULT_TIMEOUT_SECS)
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
        let mut command = Command::new("rg");
        command.args(["-n", "--hidden", "-g", "!.git", "--"]);
        command.arg(query).arg(relative);
        self.run_command(command, false, DEFAULT_TIMEOUT_SECS)
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
        if let Err(error) = validate_shell(command, &self.workspace) {
            return tool_result(Err(error), verification);
        }
        let mut process = Command::new("/bin/zsh");
        process.args(["-lc", command]);
        self.run_command(process, verification, DEFAULT_TIMEOUT_SECS)
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

fn validate_shell(command: &str, workspace: &Path) -> Result<(), String> {
    let normalized = command.to_ascii_lowercase();
    let blocked = [
        "sudo ",
        "rm ",
        "rm\t",
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
        assert!(validate_shell("rm -rf build", &path).is_err());
        assert!(validate_shell("git status --short", &path).is_ok());
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn secret_files_are_blocked() {
        let path = workspace();
        fs::write(path.join(".env"), "TOKEN=nope").unwrap();
        let tools = Toolbelt::new(path.clone()).unwrap();
        assert!(!tools.read(".env").ok);
        let _ = fs::remove_dir_all(path);
    }
}
