// SPDX-License-Identifier: LicenseRef-BSL-1.1
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

fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn quote_ps(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub fn read_only(args: &[String]) -> bool {
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

fn remote_command(os: &str, args: &[String]) -> Result<String, String> {
    if args.is_empty()
        || args.len() > 128
        || args.iter().map(String::len).sum::<usize>() > 16_384
        || args.iter().any(|s| s.contains('\0'))
    {
        return Err("remote CLI requires 1..128 bounded arguments without NUL bytes".into());
    }
    match os {
        "windows" => {
            let script = format!("$ErrorActionPreference='Stop'; $hii=Join-Path $env:APPDATA 'npm\\hii.ps1'; if (!(Test-Path -LiteralPath $hii)) {{ throw 'Installed HII launcher is missing' }}; & $hii {}; exit $LASTEXITCODE", args.iter().map(|s| quote_ps(s)).collect::<Vec<_>>().join(" "));
            let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
            let command = format!("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}", STANDARD.encode(bytes));
            if command.len() > 30_000 { return Err("remote Windows CLI arguments exceed the encoded command limit".into()); }
            Ok(command)
        }
        "macos" | "darwin" | "linux" => Ok(format!("export PATH=\"$HOME/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; exec \"$HOME/bin/hii\" {}", args.iter().map(|s| quote_posix(s)).collect::<Vec<_>>().join(" "))),
        _ => Err("remote CLI needs an enrolled OS: macos, windows, or linux".into()),
    }
}

struct Capture {
    output: String,
    complete: bool,
}

fn receipt_arguments(args: &[String]) -> Value {
    // A flag and its secret value are separate argv entries. Redacting each
    // entry cannot protect --api-key <value>, prompts or positional secrets.
    // Only the closed read-only grammar has safe argument values to retain.
    if read_only(args) {
        json!(args)
    } else {
        Value::Null
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
        let mut value = crate::receipt::redact_text(&String::from_utf8_lossy(&saved));
        if truncated {
            value.push_str("\n[remote output truncated at 256 KiB]");
        }
        if !complete {
            value.push_str("\n[remote output read failed]");
        }
        let _ = tx.send(Capture {
            output: value,
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
) -> Result<Value, String> {
    if host.is_empty()
        || host.starts_with('-')
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-@:".contains(&b))
    {
        return Err("invalid enrolled SSH host; use a configured SSH alias".into());
    }
    if !read_only(args) && !allow_write {
        return Err("this remote CLI command may change state; explicitly add --allow-write before -- to authorize this invocation".into());
    }
    let command_text = remote_command(os, args)?;
    let id = uuid::Uuid::new_v4().to_string();
    let receipt_path = runtime
        .join("runs")
        .join("remote")
        .join(format!("{id}.json"));
    let mut receipt = json!({"schemaVersion":1,"id":id,"kind":"hii.remote-cli","host":host,"os":os,"args":receipt_arguments(args),"argumentCount":args.len(),"argumentsOmitted":!read_only(args),"allowWrite":allow_write,"status":"starting","startedAt":chrono::Utc::now().to_rfc3339(),"receipt":receipt_path});
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
    fn read_only_does_not_accept_hidden_mutations() {
        assert!(read_only(&strings(&[
            "runner", "model", "doctor", "--json"
        ])));
        assert!(!read_only(&strings(&["runner", "model", "start"])));
        assert!(!read_only(&strings(&["home", "--json", "ship"])));
        assert!(!read_only(&strings(&["--version", "run", "rm"])));
    }
    #[test]
    fn unix_arguments_are_literal() {
        let command =
            remote_command("macos", &strings(&["echo", "a'b $(touch /tmp/no)\nnext"])).unwrap();
        assert!(command.ends_with("'echo' 'a'\\''b $(touch /tmp/no)\nnext'"));
    }
    #[test]
    fn windows_arguments_are_encoded_and_literal() {
        let command =
            remote_command("windows", &strings(&["a'b", "$(Get-Content secret)"])).unwrap();
        let bytes = STANDARD
            .decode(command.split_whitespace().last().unwrap())
            .unwrap();
        let words: Vec<u16> = bytes
            .as_chunks::<2>().0
            .iter()
            .map(|x| u16::from_le_bytes(*x))
            .collect();
        let script = String::from_utf16(&words).unwrap();
        assert!(script.contains("'a''b' '$(Get-Content secret)'"));
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
