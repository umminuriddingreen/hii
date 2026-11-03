// SPDX-License-Identifier: Apache-2.0
//! Explicit calls to the installed HII CLI on an enrolled SSH peer.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone)]
pub struct AgentRoute {
    pub url: String,
    pub provider: String,
    pub model: String,
}

impl AgentRoute {
    pub fn new(url: String, provider: String, model: String) -> Result<Self, String> {
        let parsed = url::Url::parse(&url).map_err(|_| "invalid inference URL")?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || !matches!(
                provider.as_str(),
                "native" | "llama.cpp" | "ollama" | "lmstudio"
            )
            || model.trim().is_empty()
            || model.len() > 512
            || model.chars().any(char::is_control)
        {
            return Err("agent inference route requires a credential-free HTTP(S) URL, supported provider and nonempty model".into());
        }
        Ok(Self {
            url,
            provider,
            model,
        })
    }
    fn env(&self) -> [(&str, &str); 3] {
        [
            ("HII_MODEL_URL", &self.url),
            ("HII_MODEL_PROVIDER", &self.provider),
            ("HII_MODEL", &self.model),
        ]
    }
}

/// Construct a bounded peer run; authority and allow-write parameters are legacy inputs.
pub fn agent_arguments(
    workspace: &str,
    authority: &str,
    deadline: u64,
    steps: u32,
    task: &[String],
    allow_write: bool,
) -> Result<Vec<String>, String> {
    agent_arguments_with_verification(
        workspace,
        authority,
        deadline,
        steps,
        task,
        allow_write,
        &[],
    )
}

pub fn agent_arguments_with_verification(
    workspace: &str,
    authority: &str,
    deadline: u64,
    steps: u32,
    task: &[String],
    allow_write: bool,
    verify: &[String],
) -> Result<Vec<String>, String> {
    let _ = (authority, allow_write);
    if workspace.trim().is_empty() || workspace.contains('\0') {
        return Err("remote workspace must be explicit and nonempty".into());
    }
    if !(1..=3600).contains(&deadline) || !(1..=128).contains(&steps) {
        return Err("peer agent requires a 1..3600 second deadline and 1..128 steps".into());
    }
    if task.is_empty() || task.iter().all(|part| part.trim().is_empty()) {
        return Err("peer agent requires a nonempty task".into());
    }
    let mut args = vec![
        "-C".into(),
        workspace.into(),
        "--deadline".into(),
        format!("{deadline}s"),
        "--max-steps".into(),
        steps.to_string(),
        "--no-hooks".into(),
        "run".into(),
        "--json".into(),
        "--authority".into(),
        "yolo".into(),
        "--no-context".into(),
    ];
    if verify.len() > 8
        || verify
            .iter()
            .any(|command| command.trim().is_empty() || command.contains('\0'))
    {
        return Err("peer agent permits up to eight nonempty verification commands".into());
    }
    for command in verify {
        args.extend(["--verify".into(), command.clone()]);
    }
    args.extend(["--".into(), task.join(" ")]);
    Ok(args)
}
fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn quote_ps(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn safe_arguments_to_record(args: &[String]) -> bool {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    if matches!(words.as_slice(), ["--version"] | ["--help"] | ["models"]) {
        return true;
    }
    let (prefix, tail) = if words.starts_with(&["runner", "model", "doctor"])
        || words.starts_with(&["runner", "model", "status"])
    {
        (3, &["--json"][..])
    } else if words.first() == Some(&"home") {
        (1, &["--json", "--brief"][..])
    } else if words.starts_with(&["systems", "list"]) || words.starts_with(&["systems", "status"]) {
        (2, &["--json"][..])
    } else {
        return false;
    };
    words[prefix..].iter().all(|word| tail.contains(word))
}

fn is_peer_agent(args: &[String]) -> bool {
    if args.len() < 14
        || args[0] != "-C"
        || args[2] != "--deadline"
        || args[4] != "--max-steps"
        || args[6] != "--no-hooks"
        || args[7] != "run"
        || args[8] != "--json"
        || args[9] != "--authority"
        || args[11] != "--no-context"
        || args[10] != "yolo"
    {
        return false;
    }
    let tail = &args[12..];
    let Some(verify) = tail.strip_suffix(&["--".into(), args.last().cloned().unwrap_or_default()])
    else {
        return false;
    };
    verify.len() <= 16
        && verify.len() % 2 == 0
        && verify
            .chunks_exact(2)
            .all(|pair| pair[0] == "--verify" && !pair[1].trim().is_empty())
}

fn remote_command(os: &str, args: &[String]) -> Result<String, String> {
    remote_command_with_route(os, args, None)
}

fn remote_command_with_route(
    os: &str,
    args: &[String],
    route: Option<&AgentRoute>,
) -> Result<String, String> {
    if route.is_some() && !is_peer_agent(args) {
        return Err("inference routing is restricted to bounded peer-agent dispatch".into());
    }
    if args.is_empty()
        || args.len() > 128
        || args.iter().map(String::len).sum::<usize>() > 16_384
        || args.iter().any(|s| s.contains('\0'))
    {
        return Err("remote CLI requires 1..128 bounded arguments without NUL bytes".into());
    }
    let route_ps = route
        .map(|route| {
            route
                .env()
                .iter()
                .map(|(key, value)| format!("$env:{key}={}; ", quote_ps(value)))
                .collect::<String>()
        })
        .unwrap_or_default();
    let route_posix = route
        .map(|route| {
            route
                .env()
                .iter()
                .map(|(key, value)| format!("export {key}={}; ", quote_posix(value)))
                .collect::<String>()
        })
        .unwrap_or_default();
    match os {
        "windows" => {
            let script = format!("$ErrorActionPreference='Stop'; $PSNativeCommandArgumentPassing='Standard'; {route_ps}$hii=Join-Path $env:APPDATA 'npm\\hii.ps1'; if (!(Test-Path -LiteralPath $hii)) {{ throw 'Installed HII launcher is missing' }}; & $hii -Args @({}); exit $LASTEXITCODE", args.iter().map(|s| quote_ps(s)).collect::<Vec<_>>().join(", "));
            let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
            let command = format!("pwsh.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}", STANDARD.encode(bytes));
            if command.len() > 30_000 { return Err("remote Windows CLI arguments exceed the encoded command limit".into()); }
            Ok(command)
        }
        "macos" | "darwin" | "linux" => Ok(format!("{route_posix}export PATH=\"$HOME/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; exec \"$HOME/bin/hii\" {}", args.iter().map(|s| quote_posix(s)).collect::<Vec<_>>().join(" "))),
        _ => Err("remote CLI needs an enrolled OS: macos, windows, or linux".into()),
    }
}

struct Capture {
    output: String,
    structured: Option<Value>,
    complete: bool,
}

fn receipt_arguments(args: &[String]) -> Value {
    // A flag and its secret value are separate argv entries. Redacting each
    // entry cannot protect --api-key <value>, prompts or positional secrets.
    // Only the closed read-only grammar has safe argument values to retain.
    if safe_arguments_to_record(args) {
        json!(args)
    } else {
        Value::Null
    }
}

fn redact_json(value: &mut Value) {
    match value {
        Value::String(text) => *text = crate::receipt::redact_text(text),
        Value::Array(items) => items.iter_mut().for_each(redact_json),
        Value::Object(fields) => {
            for (key, value) in fields {
                let key = key.to_ascii_lowercase().replace(['_', '-'], "");
                if [
                    "apikey",
                    "password",
                    "secret",
                    "authorization",
                    "accesstoken",
                    "refreshtoken",
                ]
                .iter()
                .any(|sensitive| key.contains(sensitive))
                {
                    *value = json!("[redacted]");
                } else {
                    redact_json(value);
                }
            }
        }
        _ => (),
    }
}

fn drain(reader: impl Read + Send + 'static) -> mpsc::Receiver<Capture> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = reader;
        let mut saved = Vec::new();
        let mut buffer = [0u8; 8192];
        let mut truncated = false;
        let mut complete = true;
        loop {
            let count = match reader.read(&mut buffer) {
                Ok(count) => count,
                Err(_) => {
                    complete = false;
                    break;
                }
            };
            if count == 0 {
                break;
            }
            let keep = count.min((256 * 1024usize).saturating_sub(saved.len()));
            saved.extend_from_slice(&buffer[..keep]);
            truncated |= keep < count;
        }
        let structured = if !truncated && complete {
            serde_json::from_slice::<Value>(&saved)
                .ok()
                .map(|mut value| {
                    redact_json(&mut value);
                    value
                })
        } else {
            None
        };
        let mut value = structured
            .as_ref()
            .map(Value::to_string)
            .unwrap_or_else(|| crate::receipt::redact_text(&String::from_utf8_lossy(&saved)));
        if truncated {
            value.push_str("\n[remote output truncated at 256 KiB]");
        }
        if !complete {
            value.push_str("\n[remote output read failed]");
        }
        let _ = tx.send(Capture {
            output: value,
            structured,
            complete,
        });
    });
    rx
}

fn collect(receiver: mpsc::Receiver<Capture>) -> Capture {
    receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap_or_else(|_| Capture {
            output: "[remote output unavailable]".into(),
            structured: None,
            complete: false,
        })
}

fn outcome(exit_code: Option<i32>, output_complete: bool) -> &'static str {
    match exit_code {
        None | Some(255) => "unknown-remote-outcome",
        Some(0) if output_complete => "completed",
        Some(0) => "incomplete-output",
        Some(_) => "failed",
    }
}

pub fn run(
    runtime: &Path,
    host: &str,
    os: &str,
    args: &[String],
    allow_write: bool,
    timeout_secs: u64,
    route: Option<&AgentRoute>,
) -> Result<Value, String> {
    if host.is_empty()
        || host.starts_with('-')
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-@:".contains(&b))
    {
        return Err("invalid enrolled SSH host; use a configured SSH alias".into());
    }
    let _ = allow_write;
    let command_text = remote_command_with_route(os, args, route)?;
    let id = uuid::Uuid::new_v4().to_string();
    let receipt_path = runtime
        .join("runs")
        .join("remote")
        .join(format!("{id}.json"));
    let mut receipt = json!({"schemaVersion":1,"id":id,"kind":"hii.remote-cli","host":host,"os":os,"args":receipt_arguments(args),"argumentCount":args.len(),"argumentsOmitted":!safe_arguments_to_record(args),"applicationPermissionGatesDisabled":true,"status":"starting","startedAt":chrono::Utc::now().to_rfc3339(),"receipt":receipt_path});
    crate::store::write_json_atomic(&receipt_path, &receipt)?;
    let mut command = Command::new("ssh");
    command
        .args([
            "-T",
            "-a",
            "-x",
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=8",
            "-o",
            "ServerAliveInterval=10",
            "-o",
            "ServerAliveCountMax=2",
            host,
            &command_text,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            receipt["status"] = json!("failed-to-start");
            receipt["error"] = json!(error.to_string());
            crate::store::write_json_atomic(&receipt_path, &receipt)?;
            return Err(format!(
                "cannot start SSH: {error}; receipt {}",
                receipt_path.display()
            ));
        }
    };
    let out = drain(child.stdout.take().ok_or("SSH stdout missing")?);
    let err = drain(child.stderr.take().ok_or("SSH stderr missing")?);
    let started = Instant::now();
    let deadline = Duration::from_secs(timeout_secs.clamp(1, 3600));
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => (),
            Err(error) => {
                receipt["error"] = json!(crate::receipt::redact_text(&error.to_string()));
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
        if started.elapsed() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        thread::sleep(Duration::from_millis(25));
    };
    receipt["exitCode"] = json!(exit_code);
    let out = collect(out);
    let err = collect(err);
    receipt["outputComplete"] = json!(out.complete && err.complete);
    receipt["status"] = json!(outcome(exit_code, out.complete && err.complete));
    receipt["stdout"] = json!(out.output);
    receipt["stderr"] = json!(err.output);
    receipt["wallMs"] = json!(started.elapsed().as_millis() as u64);
    receipt["finishedAt"] = json!(chrono::Utc::now().to_rfc3339());
    if matches!(exit_code, None | Some(255)) {
        receipt["next"] = json!("Connection ended without a reliable remote outcome. Inspect the remote task before retrying; remote execution may still be running.");
    }
    // Recognize the closed argv form emitted by agent_arguments. Prompts stay omitted.
    if is_peer_agent(args) {
        receipt["agent"] = json!({
            "authority": args[10],
            "workspace": crate::receipt::redact_text(&args[1]),
            "deadline": args[3],
            "maxSteps": args[5].parse::<u32>().ok(),
            "hooksEnabled": false,
            "contextPreloadEnabled": false,
        });
        if let Some(route) = route {
            receipt["agent"]["inference"] = json!({"url": route.url, "provider": route.provider, "model": route.model, "source": "explicit per-process environment"});
        }
        receipt["agent"]["verificationCommandCount"] = json!((args.len() - 14) / 2);
        if let Some(result) = out.structured {
            receipt["remoteResult"] = result;
        }
    }
    crate::store::write_json_atomic(&receipt_path, &receipt)?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| (*s).into()).collect()
    }
    #[test]
    fn receipt_records_only_closed_nonmutating_arguments() {
        assert!(safe_arguments_to_record(&strings(&[
            "runner", "model", "doctor", "--json"
        ])));
        assert!(!safe_arguments_to_record(&strings(&[
            "runner", "model", "start"
        ])));
        assert!(!safe_arguments_to_record(&strings(&[
            "home", "--json", "ship"
        ])));
        assert!(!safe_arguments_to_record(&strings(&[
            "--version",
            "run",
            "rm"
        ])));
    }
    #[test]
    fn unix_arguments_are_literal() {
        let command =
            remote_command("macos", &strings(&["echo", "a'b $(touch /tmp/no)\nnext"])).unwrap();
        assert!(command.ends_with("'echo' 'a'\\''b $(touch /tmp/no)\nnext'"));
    }
    #[test]
    fn windows_arguments_are_encoded_and_literal() {
        let command = remote_command(
            "windows",
            &strings(&[
                "a'b",
                "$(Get-Content secret)",
                r#"if ($x -ne "HII") { throw "content mismatch" }"#,
            ]),
        )
        .unwrap();
        let bytes = STANDARD
            .decode(command.split_whitespace().last().unwrap())
            .unwrap();
        let words: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|x| u16::from_le_bytes(*x))
            .collect();
        let script = String::from_utf16(&words).unwrap();
        assert!(command.starts_with("pwsh.exe -NoLogo"));
        assert!(script.contains("$PSNativeCommandArgumentPassing='Standard';"));
        assert!(script.contains(r#"& $hii -Args @('a''b', '$(Get-Content secret)', 'if ($x -ne "HII") { throw "content mismatch" }')"#));
    }
    #[test]
    fn receipt_never_records_separate_secret_values() {
        let args = strings(&["model", "--api-key", "private-value-with-no-marker"]);
        assert_eq!(receipt_arguments(&args), Value::Null);
        assert_eq!(
            receipt_arguments(&strings(&["--version"])),
            json!(["--version"])
        );
    }
    #[test]
    fn incomplete_or_lost_transport_is_not_reported_complete() {
        assert_eq!(outcome(Some(0), false), "incomplete-output");
        assert_eq!(outcome(Some(255), true), "unknown-remote-outcome");
        assert_eq!(outcome(None, true), "unknown-remote-outcome");
        assert_eq!(outcome(Some(0), true), "completed");
    }
    #[test]
    fn remote_arguments_are_bounded_before_ssh() {
        assert!(remote_command("windows", &["x".repeat(16_384)]).is_err());
        assert!(remote_command("linux", &["x".repeat(16_384), "y".into()]).is_err());
        assert!(remote_command("linux", &["a\0b".into()]).is_err());
    }
}

#[cfg(test)]
mod agent_dispatch_tests {
    use super::*;
    #[test]
    fn verification_remains_literal_and_json_receipts_keep_shape() {
        let verify = vec![
            "powershell.exe -Command \"if ((Get-Content source.txt) -ne 'OK') { exit 1 }\"".into(),
        ];
        let args = agent_arguments_with_verification(
            "C:\\work",
            "read-only",
            60,
            8,
            &["inspect".into()],
            true,
            &verify,
        )
        .unwrap();
        assert!(is_peer_agent(&args));
        assert_eq!(&args[12..14], &["--verify".to_string(), verify[0].clone()]);
        let mut hostile = args.clone();
        hostile[12] = "--yolo".into();
        assert!(!is_peer_agent(&hostile));
        let capture = collect(drain(std::io::Cursor::new(br#"{"status":"completed","tool":"read_file","apiKey":"bare-private-value","usage":{"promptTokens":123},"nested":{"summary":"authorization: Bearer private"}}"#.to_vec())));
        let result = capture.structured.unwrap();
        assert_eq!(result["status"], "completed");
        assert_eq!(result["tool"], "read_file");
        assert_eq!(result["apiKey"], "[redacted]");
        assert_eq!(result["usage"]["promptTokens"], 123);
        assert!(!result["nested"]["summary"]
            .as_str()
            .unwrap()
            .contains("Bearer private"));
    }
    #[test]
    fn inference_routes_reject_credentials_and_stay_process_scoped() {
        for url in [
            "http://user:secret@localhost:11437",
            "http://localhost/?secret=x",
            "http://localhost/#secret",
            "file:///tmp/model",
        ] {
            assert!(AgentRoute::new(url.into(), "native".into(), "model".into()).is_err());
        }
        let route = AgentRoute::new(
            "http://127.0.0.1:11437".into(),
            "native".into(),
            "mlx-community/Qwen3.8-27B-4bit".into(),
        )
        .unwrap();
        assert!(remote_command_with_route("windows", &["--version".into()], Some(&route)).is_err());
        let args =
            agent_arguments("C:\\work", "read-only", 60, 8, &["inspect".into()], true).unwrap();
        let command = remote_command_with_route("windows", &args, Some(&route)).unwrap();
        let bytes = STANDARD
            .decode(command.split_whitespace().last().unwrap())
            .unwrap();
        let words: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|x| u16::from_le_bytes(*x))
            .collect();
        let script = String::from_utf16(&words).unwrap();
        assert!(script.contains("$env:HII_MODEL_URL='http://127.0.0.1:11437';"));
        assert!(script.contains("$env:HII_MODEL_PROVIDER='native';"));
        assert!(script.contains("$env:HII_MODEL='mlx-community/Qwen3.8-27B-4bit';"));
    }
    #[test]
    fn peer_agent_preserves_task_and_enforces_bounds() {
        let args = agent_arguments(
            "C:\\work",
            "retired-untrusted-label",
            60,
            8,
            &["--yolo $(echo secret)".into()],
            false,
        )
        .unwrap();
        assert_eq!(args[10], "yolo");
        let command = remote_command("macos", &args).unwrap();
        assert!(!command.contains("unset HII_YOLO HII_AUTHORITY"));
        let command = remote_command("windows", &args).unwrap();
        let bytes = STANDARD
            .decode(command.split_whitespace().last().unwrap())
            .unwrap();
        let words: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|x| u16::from_le_bytes(*x))
            .collect();
        assert!(!String::from_utf16(&words)
            .unwrap()
            .contains("Remove-Item Env:HII_YOLO, Env:HII_AUTHORITY"));
        assert!(args.contains(&"--no-context".into()));
        assert!(args.contains(&"--no-hooks".into()));
        assert!(args.contains(&"--json".into()));
        assert!(agent_arguments("/tmp", "read-only", 60, 8, &["task".into()], false).is_ok());
        assert_eq!(args[1], "C:\\work");
        assert_eq!(args[args.len() - 2], "--");
        assert_eq!(args.last().unwrap(), "--yolo $(echo secret)");
        assert!(agent_arguments("", "read-only", 60, 8, &["task".into()], true).is_err());
        assert!(agent_arguments("/tmp", "owner", 60, 8, &["task".into()], true).is_ok());
        assert!(agent_arguments("/tmp", "workspace", 0, 8, &["task".into()], true).is_err());
        assert!(agent_arguments("/tmp", "workspace", 60, 0, &["task".into()], true).is_err());
    }
}
