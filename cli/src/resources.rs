// SPDX-License-Identifier: Apache-2.0
//! Narrow, receipt-backed access to Docker and Tailscale on enrolled systems.
use crate::config::AppPaths;
use base64::{engine::general_purpose::STANDARD, Engine};
use clap::Subcommand;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(20);
const OUTPUT_LIMIT: usize = 128 * 1024;

#[derive(Debug, Subcommand)]
pub enum ResourcesCommand {
    #[command(about = "List Docker containers and current Tailscale status")]
    List {
        #[arg(long)]
        system: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Check fresh Docker and Tailscale readiness and configuration separately")]
    Status {
        #[arg(long)]
        system: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Manage Docker containers")]
    Docker {
        #[command(subcommand)]
        action: DockerCommand,
    },
    #[command(about = "Inspect or expose a private Tailscale TCP service")]
    Tailscale {
        #[command(subcommand)]
        action: TailscaleCommand,
    },
    #[command(about = "Open a safe URL or registered application URL in Chrome")]
    Open {
        #[arg(long, conflicts_with = "service", required_unless_present = "service")]
        url: Option<String>,
        #[arg(long, required_unless_present = "url")]
        service: Option<String>,
        #[arg(long)]
        system: Option<String>,
        #[arg(
            long,
            help = "Legacy compatibility flag; HII application permission gates are disabled"
        )]
        allow_write: bool,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum DockerCommand {
    Start {
        container: String,
        #[arg(long)]
        system: Option<String>,
        #[arg(
            long,
            help = "Legacy compatibility flag; HII application permission gates are disabled"
        )]
        allow_write: bool,
        #[arg(long)]
        json: bool,
    },
    Stop {
        container: String,
        #[arg(long)]
        system: Option<String>,
        #[arg(
            long,
            help = "Legacy compatibility flag; HII application permission gates are disabled"
        )]
        allow_write: bool,
        #[arg(long)]
        json: bool,
    },
    Restart {
        container: String,
        #[arg(long)]
        system: Option<String>,
        #[arg(
            long,
            help = "Legacy compatibility flag; HII application permission gates are disabled"
        )]
        allow_write: bool,
        #[arg(long)]
        json: bool,
    },
    Logs {
        container: String,
        #[arg(long, default_value_t = 100)]
        tail: u16,
        #[arg(long)]
        system: Option<String>,
        #[arg(long)]
        json: bool,
    },
    Inspect {
        container: String,
        #[arg(long)]
        system: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Diagnose the selected Docker runtime and print a non-installing onboarding plan"
    )]
    Doctor {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum TailscaleCommand {
    Status {
        #[arg(long)]
        system: Option<String>,
        #[arg(long)]
        json: bool,
    },
    ServeStatus {
        #[arg(long)]
        system: Option<String>,
        #[arg(long)]
        json: bool,
    },
    Expose {
        #[arg(long)]
        port: u16,
        #[arg(long, value_name = "PORT")]
        target_port: u16,
        #[arg(long, help = "Serve this port with Tailscale HTTPS instead of raw TCP")]
        https: bool,
        #[arg(long)]
        system: Option<String>,
        #[arg(
            long,
            help = "Legacy compatibility flag; HII application permission gates are disabled"
        )]
        allow_write: bool,
        #[arg(long)]
        json: bool,
    },
    Unexpose {
        #[arg(long)]
        port: u16,
        #[arg(long, help = "Remove only this Tailscale HTTPS mapping")]
        https: bool,
        #[arg(long)]
        system: Option<String>,
        #[arg(
            long,
            help = "Legacy compatibility flag; HII application permission gates are disabled"
        )]
        allow_write: bool,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemRecord {
    id: String,
    host: String,
    os: String,
    transport: String,
    local: bool,
}
#[derive(Debug, Deserialize)]
struct SystemsRegistry {
    systems: Vec<SystemRecord>,
}

#[derive(Debug)]
struct ResultData {
    status: i32,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        && value.as_bytes()[0].is_ascii_alphanumeric()
}
fn valid_container(value: &str) -> bool {
    valid_id(value)
}
fn valid_port(port: u16) -> bool {
    port != 0
}
fn posix_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn command_text(os: &str, program: &str, args: &[String]) -> Result<String, String> {
    if !matches!(program, "docker" | "tailscale" | "open" | "google-chrome")
        || args.iter().any(|a| a.contains('\0'))
    {
        return Err("resource command is outside the fixed Docker/Tailscale operation set".into());
    }
    match os {
        "windows" => {
            let exe = format!("{program}.exe");
            let script = format!(
                "$ErrorActionPreference='Stop'; & {exe} {}; exit $LASTEXITCODE",
                args.iter()
                    .map(|a| ps_quote(a))
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
            Ok(format!(
                "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
                STANDARD.encode(bytes)
            ))
        }
        "macos" | "darwin" | "linux" => Ok(format!(
            "{} {}",
            posix_quote(program),
            args.iter()
                .map(|a| posix_quote(a))
                .collect::<Vec<_>>()
                .join(" ")
        )),
        _ => Err("resource control requires an enrolled OS of macos, windows, or linux".into()),
    }
}

fn run_local(program: &str, args: &[String]) -> ResultData {
    let mut command = Command::new(program);
    command.args(args);
    run_process(&mut command)
}
fn run_remote(system: &SystemRecord, program: &str, args: &[String]) -> ResultData {
    let command = match command_text(&system.os.to_ascii_lowercase(), program, args) {
        Ok(v) => v,
        Err(e) => {
            return ResultData {
                status: 127,
                stdout: String::new(),
                stderr: e,
                timed_out: false,
            }
        }
    };
    run_ssh_command(system, &command)
}
fn run_ssh_command(system: &SystemRecord, command: &str) -> ResultData {
    let mut c = Command::new("ssh");
    c.args([
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
        &system.host,
        command,
    ]);
    run_process(&mut c)
}
fn run_process(command: &mut Command) -> ResultData {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ResultData {
                status: 127,
                stdout: String::new(),
                stderr: format!("failed to start resource command: {e}"),
                timed_out: false,
            }
        }
    };
    let out_rx = drain(child.stdout.take().unwrap());
    let err_rx = drain(child.stderr.take().unwrap());
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s.code().unwrap_or(1),
            Ok(None) => (),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                break {
                    let _ = e;
                    1
                };
            }
        }
        if started.elapsed() >= TIMEOUT {
            timed_out = true;
            let _ = child.kill();
            let _ = child.wait();
            break 124;
        }
        thread::sleep(Duration::from_millis(20));
    };
    ResultData {
        status,
        stdout: receive(out_rx),
        stderr: receive(err_rx),
        timed_out,
    }
}
fn drain(mut reader: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut data = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let keep = n.min(OUTPUT_LIMIT.saturating_sub(data.len()));
                    data.extend_from_slice(&buf[..keep]);
                    // Keep draining after the receipt cap so the child cannot
                    // block on a full pipe or change its exit status.
                }
            }
        }
        let mut text = crate::receipt::redact_text(&String::from_utf8_lossy(&data));
        if data.len() >= OUTPUT_LIMIT {
            text.push_str("\n[output truncated at 128 KiB]");
        }
        let _ = tx.send(text);
    });
    rx
}
fn receive(rx: mpsc::Receiver<String>) -> String {
    rx.recv_timeout(Duration::from_secs(2))
        .unwrap_or_else(|_| "[output unavailable]".into())
}

fn load_target(paths: &AppPaths, id: Option<&str>) -> Result<Option<SystemRecord>, String> {
    let Some(id) = id else { return Ok(None) };
    if !valid_id(id) {
        return Err("invalid system identifier".into());
    }
    let path = paths.runtime.join("systems.json");
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("cannot read enrolled systems registry: {e}"))?;
    let registry: SystemsRegistry = serde_json::from_str(&raw)
        .map_err(|e| format!("cannot parse enrolled systems registry: {e}"))?;
    let system = registry
        .systems
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("unknown system `{id}`; run `hii systems list`"))?;
    if system.local {
        return Ok(None);
    }
    if !matches!(system.transport.as_str(), "ssh" | "tailscale-ssh") {
        return Err("resource control needs an enrolled SSH transport".into());
    }
    if system.host.is_empty()
        || system.host.starts_with('-')
        || !system
            .host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-@:".contains(&b))
    {
        return Err("invalid enrolled SSH host".into());
    }
    Ok(Some(system))
}
fn invoke(target: Option<&SystemRecord>, program: &str, args: &[String]) -> ResultData {
    target.map_or_else(
        || run_local(program, args),
        |s| run_remote(s, program, args),
    )
}
fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| (*s).to_owned()).collect()
}
fn serve_argv(port: u16, target_port: Option<u16>, https: bool) -> Vec<String> {
    let mut args = vec!["serve".to_owned()];
    if let Some(target_port) = target_port {
        args.push("--bg".into());
        if https {
            args.push(format!("--https={port}"));
            args.push(format!("http://127.0.0.1:{target_port}"));
        } else {
            args.push(format!("--tcp={port}"));
            args.push(format!("tcp://127.0.0.1:{target_port}"));
        }
    } else {
        args.push(format!("--{}={port}", if https { "https" } else { "tcp" }));
        args.push("off".into());
    }
    args
}
fn output_value(r: ResultData) -> Value {
    let complete =
        !r.stdout.contains("[output truncated") && !r.stderr.contains("[output truncated");
    json!({"exitCode":r.status,"ok":r.status==0,"outcome":if r.timed_out {"unknown-outcome"} else if r.status==0 {"completed"} else {"failed"},"timedOut":r.timed_out,"outputComplete":complete,"stdout":r.stdout,"stderr":r.stderr})
}

fn safe_url(raw: &str) -> Result<String, String> {
    let url =
        url::Url::parse(raw).map_err(|_| "URL must be an absolute http(s) URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.as_str().bytes().any(|b| b.is_ascii_control())
    {
        return Err("only credential-free absolute http(s) URLs are allowed".into());
    }
    Ok(url.to_string())
}
fn redact_url(raw: &str) -> String {
    url::Url::parse(raw)
        .map(|mut u| {
            u.set_query(None);
            u.set_fragment(None);
            u.to_string()
        })
        .unwrap_or_else(|_| "[invalid URL]".into())
}
fn registered_url(paths: &AppPaths, id: &str) -> Result<String, String> {
    if !valid_id(id) {
        return Err("invalid registered application identifier".into());
    }
    let path = paths.runtime.join("applications/registry.json");
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("cannot read registered application catalog: {e}"))?;
    let value: Value =
        serde_json::from_str(&raw).map_err(|e| format!("cannot parse application catalog: {e}"))?;
    let row = value["applications"]
        .as_array()
        .and_then(|a| a.iter().find(|r| r["id"] == id))
        .ok_or_else(|| format!("unknown registered application `{id}`"))?;
    let url = row["surfaces"]["canvas"]["entryUrl"]
        .as_str()
        .ok_or("registered application has no web entry URL")?;
    safe_url(url)
}

fn emit(
    value: Value,
    json_output: bool,
    run_id: &str,
    receipt: &std::path::Path,
) -> Result<(), String> {
    let mut value = value;
    value["observedAt"] = json!(chrono::Utc::now().to_rfc3339());
    let mut result = value;
    result["runId"] = json!(run_id);
    result["receipt"] = json!(receipt.display().to_string());
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
        );
    } else {
        println!(
            "HII resources · {} · {}",
            result["operation"].as_str().unwrap_or("resource"),
            result["system"].as_str().unwrap_or("local")
        );
        for (key, item) in result.as_object().into_iter().flatten() {
            if key != "receipt" && key != "system" && key != "operation" {
                println!(
                    "{key}: {}",
                    item.as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| item.to_string())
                );
            }
        }
        println!("run: {}", run_id);
        println!("receipt: {}", receipt.display());
    }
    if result["ok"] == false {
        return Err(format!(
            "{} failed; see receipt {}",
            result["operation"].as_str().unwrap_or("resource operation"),
            receipt.display()
        ));
    }
    Ok(())
}

pub fn execute(
    paths: &AppPaths,
    action: ResourcesCommand,
) -> Result<std::process::ExitCode, String> {
    use std::process::ExitCode;
    let (system_id, json_output, op, task) = match action {
        ResourcesCommand::List { system, json } => (system, json, "list", Task::List),
        ResourcesCommand::Status { system, json } => (system, json, "status", Task::Status),
        ResourcesCommand::Docker { action } => match action {
            DockerCommand::Start {
                container,
                system,
                allow_write: _,
                json,
            } => (
                system,
                json,
                "docker.start",
                Task::Docker(container, "start"),
            ),
            DockerCommand::Stop {
                container,
                system,
                allow_write: _,
                json,
            } => (system, json, "docker.stop", Task::Docker(container, "stop")),
            DockerCommand::Restart {
                container,
                system,
                allow_write: _,
                json,
            } => (
                system,
                json,
                "docker.restart",
                Task::Docker(container, "restart"),
            ),
            DockerCommand::Logs {
                container,
                tail,
                system,
                json,
            } => (system, json, "docker.logs", Task::Logs(container, tail)),
            DockerCommand::Inspect {
                container,
                system,
                json,
            } => (system, json, "docker.inspect", Task::Inspect(container)),
            DockerCommand::Doctor { json } => (None, json, "docker.doctor", Task::DockerDoctor),
        },
        ResourcesCommand::Tailscale { action } => match action {
            TailscaleCommand::Status { system, json } => {
                (system, json, "tailscale.status", Task::TailStatus)
            }
            TailscaleCommand::ServeStatus { system, json } => {
                (system, json, "tailscale.serve-status", Task::ServeStatus)
            }
            TailscaleCommand::Expose {
                port,
                target_port,
                https,
                system,
                allow_write: _,
                json,
            } => (
                system,
                json,
                "tailscale.expose",
                Task::Expose(port, target_port, https),
            ),
            TailscaleCommand::Unexpose {
                port,
                https,
                system,
                allow_write: _,
                json,
            } => (
                system,
                json,
                "tailscale.unexpose",
                Task::Unexpose(port, https),
            ),
        },
        ResourcesCommand::Open {
            url,
            service,
            system,
            allow_write: _,
            json,
        } => (system, json, "open", Task::Open(url, service)),
    };
    let target = load_target(paths, system_id.as_deref())?;
    let system_name = target
        .as_ref()
        .map(|s| s.id.clone())
        .unwrap_or_else(|| system_id.unwrap_or_else(|| "local".into()));
    let write_action = writes(&task);
    let authority = "unrestricted";
    let mut run = crate::receipt::RunStore::create(&paths.runtime)?;
    run.set_authority(authority)?;
    let target_details = target
        .as_ref()
        .map(|s| json!({"id":s.id,"host":s.host,"os":s.os,"transport":s.transport}))
        .unwrap_or_else(|| json!({"id":system_name,"execution":"local"}));
    run.event(
        "resource.action.started",
        json!({"operation":op,"system":target_details.clone(),"writeRequested":write_action}),
    )?;
    let outcome = match run_task(paths, target.as_ref(), &task) {
        Ok(value) => value,
        Err(error) => json!({"ok":false,"error":error}),
    };
    let mut value = outcome;
    value["system"] = json!(system_name);
    value["target"] = target_details.clone();
    value["operation"] = json!(op);
    value["writeRequested"] = json!(write_action);
    value["observedAt"] = json!(chrono::Utc::now().to_rfc3339());
    let ok = value["ok"] == true;
    let verification = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    run.event(
        if ok {
            "resource.action.completed"
        } else {
            "resource.action.failed"
        },
        json!({"operation":op,"system":target_details,"writeRequested":write_action,"result":value}),
    )?;
    let now = crate::clock::unix_ms();
    let receipt_value = json!({
        "schema_version": 9,
        "id": run.id,
        "created_at_unix_ms": run.started_at_unix_ms,
        "finished_at_unix_ms": now,
        "status": if ok { "completed" } else { "incomplete" },
        "goal": format!("hii resources {op}"),
        "workspace": paths.repo.display().to_string(),
        "model": "deterministic",
        "review_model": null,
        "steps": 1,
        "summary": if ok { format!("{op} completed") } else { format!("{op} failed") },
        "verification": [{"command":format!("hii resources {op}"),"ok":ok,"output":verification}],
        "git_status": "",
        "next": null,
        "review": null,
        "risk": if write_action { "requested Docker, Tailscale, or Chrome resource operation" } else { "read-only resource observation" },
        "authority": authority,
        "outcome": if ok { "completed" } else if has_timeout(&value) { "unknown-outcome" } else { "infra-error" },
        "exit_code": if ok { 0 } else { 1 }
    });
    let receipt: crate::receipt::Receipt = serde_json::from_value(receipt_value)
        .map_err(|e| format!("cannot construct resource receipt: {e}"))?;
    let receipt_path = run.finish(&paths.runtime, &receipt)?;
    emit(value, json_output, &run.id, &receipt_path)?;
    Ok(ExitCode::SUCCESS)
}

enum Task {
    List,
    Status,
    DockerDoctor,
    Docker(String, &'static str),
    Logs(String, u16),
    Inspect(String),
    TailStatus,
    ServeStatus,
    Expose(u16, u16, bool),
    Unexpose(u16, bool),
    Open(Option<String>, Option<String>),
}
fn writes(task: &Task) -> bool {
    match task {
        Task::Docker(_, _) | Task::Expose(_, _, _) | Task::Unexpose(_, _) | Task::Open(_, _) => {
            true
        }
        _ => false,
    }
}
fn has_timeout(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.iter().any(|(key, child)| {
            ((key == "timedOut" || key.ends_with("TimedOut")) && child == true)
                || has_timeout(child)
        }),
        Value::Array(items) => items.iter().any(has_timeout),
        _ => false,
    }
}
fn command_result(target: Option<&SystemRecord>, program: &str, args: &[String]) -> Value {
    output_value(invoke(target, program, args))
}
fn docker_rows(value: &Value) -> Vec<Value> {
    value["stdout"]
        .as_str()
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(docker_row)
        .collect()
}
fn docker_row(line: &str) -> Option<Value> {
    let fields: Vec<&str> = line.splitn(6, '|').collect();
    (fields.len() == 6).then(|| json!({
        "id":fields[0],"name":fields[1],"image":fields[2],"state":fields[3],"status":fields[4],"ports":fields[5]
    }))
}
fn docker_inventory_valid(value: &Value) -> bool {
    value["ok"] == true
        && value["outputComplete"] != false
        && value["stdout"]
            .as_str()
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .all(|line| docker_row(line).is_some())
}
fn docker_client_version(value: &Value) -> Option<&str> {
    if value["ok"] != true {
        return None;
    }
    let line = value["stdout"].as_str()?.lines().next()?.trim();
    let version = line
        .strip_prefix("Docker version ")?
        .split(',')
        .next()?
        .trim();
    let mut bytes = version.bytes();
    if !bytes.next().is_some_and(|byte| byte.is_ascii_digit())
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".+-_".contains(&byte))
    {
        return None;
    }
    Some(version)
}
fn tailscale_state(value: &Value) -> Value {
    let command_ok = value["ok"] == true && value["exitCode"] == 0;
    let parsed = value["stdout"]
        .as_str()
        .and_then(|s| serde_json::from_str::<Value>(s).ok());
    let Some(raw) = parsed else {
        return json!({"ready":false,"backendState":"unknown","error":value["stderr"],"exitCode":value["exitCode"],"timedOut":value["timedOut"]});
    };
    let self_node = &raw["Self"];
    let state = raw["BackendState"].as_str().unwrap_or("unknown");
    json!({"ready":command_ok && state.eq_ignore_ascii_case("Running"),"backendState":state,"dnsName":self_node["DNSName"],"online":self_node["Online"],"addresses":self_node["TailscaleIPs"],"peerCount":raw["Peer"].as_object().map_or(0,|p|p.len()),"exitCode":value["exitCode"],"timedOut":value["timedOut"],"error":value["stderr"]})
}
fn check_container(name: &str) -> Result<(), String> {
    if valid_container(name) {
        Ok(())
    } else {
        Err("invalid Docker container identifier; use a name or ID made of letters, digits, _, ., or -".into())
    }
}
fn run_task(paths: &AppPaths, target: Option<&SystemRecord>, task: &Task) -> Result<Value, String> {
    Ok(match task {
        Task::List => {
            // Keep Docker's Labels and other extended metadata out of the
            // receipt. Full `{{json .}}` output can contain strings such as
            // `ACCESS_TOKEN`; the line redactor then replaces the whole JSON
            // row, making a healthy daemon look like an invalid inventory.
            const DOCKER_PS_FORMAT: &str =
                "{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}";
            let docker = command_result(
                target,
                "docker",
                &argv(&["ps", "-a", "--format", DOCKER_PS_FORMAT]),
            );
            let tail = command_result(target, "tailscale", &argv(&["status", "--json"]));
            let docker_ok = docker_inventory_valid(&docker);
            let tail = tailscale_state(&tail);
            let tail_ok = tail["ready"] == true;
            json!({"ok":docker_ok && tail_ok,"docker":{"fresh":true,"ready":docker_ok,"timedOut":docker["timedOut"],"outputComplete":docker["outputComplete"],"containers":docker_rows(&docker),"error":docker["stderr"]},"tailscale":{"fresh":true,"ready":tail_ok,"status":tail}})
        }
        Task::DockerDoctor => {
            let context = command_result(target, "docker", &argv(&["context", "show"]));
            let contexts = command_result(
                target,
                "docker",
                &argv(&["context", "ls", "--format", "{{.Name}}"]),
            );
            let server = command_result(
                target,
                "docker",
                &argv(&["info", "--format", "{{.ServerVersion}}"]),
            );
            let containers = command_result(target, "docker", &argv(&["ps", "-aq"]));
            let volumes = command_result(target, "docker", &argv(&["volume", "ls", "-q"]));
            // The root --version flag is a client-only probe; `docker version`
            // may fail while contacting a stopped daemon even when the CLI is
            // present.
            let client = command_result(target, "docker", &argv(&["--version"]));
            let client_version = docker_client_version(&client);
            let client_ready = client_version.is_some();
            let daemon_ready = server["ok"] == true;
            let count = |value: &Value| {
                value["stdout"]
                    .as_str()
                    .unwrap_or_default()
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .count()
            };
            json!({
                "ok": true,
                "diagnostic": {
                    "clientAvailable": client_ready,
                    "clientVersion": client_version,
                    "daemonReady": daemon_ready,
                    "serverVersion": server["stdout"],
                    "activeContext": context["stdout"],
                    "contextCount": count(&contexts),
                    "containerCount": count(&containers),
                    "volumeCount": count(&volumes),
                    "containersObserved": containers["ok"] == true,
                    "volumesObserved": volumes["ok"] == true
                },
                "plan": docker_onboarding_plan(client_ready, daemon_ready),
                "readOnly": true
            })
        }
        Task::Status => {
            let docker = command_result(
                target,
                "docker",
                &argv(&["info", "--format", "{{.ServerVersion}}"]),
            );
            let tail = command_result(target, "tailscale", &argv(&["status", "--json"]));
            let serve = command_result(target, "tailscale", &argv(&["serve", "status", "--json"]));
            let tail = tailscale_state(&tail);
            json!({"ok":docker["ok"]==true && tail["ready"]==true,"configuration":{"docker":{"owner":"Docker CLI/daemon"},"tailscale":{"owner":"Tailscale CLI/daemon"}},"fresh":{"dockerReady":docker["ok"],"dockerTimedOut":docker["timedOut"],"dockerVersion":docker["stdout"],"dockerError":docker["stderr"],"tailscaleReady":tail["ready"],"tailscale":tail,"serveStatus":serve["stdout"],"serveError":serve["stderr"],"serveReady":serve["ok"],"serveTimedOut":serve["timedOut"]}})
        }
        Task::Docker(name, verb) => {
            check_container(name)?;
            let args = vec![verb.to_string(), name.clone()];
            let v = command_result(target, "docker", &args);
            json!({"ok":v["ok"],"container":name,"action":verb,"result":v})
        }
        Task::Logs(name, tail) => {
            check_container(name)?;
            let n = tail.clamp(&1, &500);
            let args = vec!["logs".into(), "--tail".into(), n.to_string(), name.clone()];
            let v = command_result(target, "docker", &args);
            json!({"ok":v["ok"],"container":name,"result":v})
        }
        Task::Inspect(name) => {
            check_container(name)?;
            let args = vec![
                "inspect".into(),
                "--format".into(),
                "{{.State.Status}} {{.State.Running}} {{.State.ExitCode}} {{.Config.Image}} {{.Name}}".into(),
                name.clone(),
            ];
            let v = command_result(target, "docker", &args);
            json!({"ok":v["ok"],"container":name,"result":v})
        }
        Task::TailStatus => {
            let v = command_result(target, "tailscale", &argv(&["status", "--json"]));
            let state = tailscale_state(&v);
            json!({"ok":v["ok"]==true && state["ready"]==true,"fresh":true,"result":state})
        }
        Task::ServeStatus => {
            let v = command_result(target, "tailscale", &argv(&["serve", "status", "--json"]));
            json!({"ok":v["ok"],"fresh":true,"result":v})
        }
        Task::Expose(port, target_port, https) => {
            if !valid_port(*port) || !valid_port(*target_port) {
                return Err("TCP ports must be from 1 to 65535".into());
            }
            let args = serve_argv(*port, Some(*target_port), *https);
            let v = command_result(target, "tailscale", &args);
            json!({"ok":v["ok"],"port":port,"https":https,"target":"127.0.0.1","targetPort":target_port,"result":v,"scope":"tailnet-private Tailscale Serve only; Funnel is not enabled"})
        }
        Task::Unexpose(port, https) => {
            if !valid_port(*port) {
                return Err("TCP port must be from 1 to 65535".into());
            }
            let args = serve_argv(*port, None, *https);
            let v = command_result(target, "tailscale", &args);
            json!({"ok":v["ok"],"port":port,"https":https,"result":v,"scope":"removed only the selected Tailscale Serve mapping"})
        }
        Task::Open(url, service) => {
            let url = if let Some(id) = service {
                registered_url(paths, id)?
            } else {
                safe_url(url.as_deref().ok_or("provide --url or --service")?)?
            };
            let r = if target.is_some_and(|s| s.os.eq_ignore_ascii_case("windows")) {
                let script = format!(
                    r#"$ErrorActionPreference='Stop'; $user=(Get-CimInstance Win32_ComputerSystem).UserName; if (!$user) {{ throw 'No signed-in interactive user session' }}; $name='HII-OpenChrome-{}'; $url={}; $inner=@'
$ErrorActionPreference='Stop'; $paths=@("$env:ProgramFiles\Google\Chrome\Application\chrome.exe","${{env:ProgramFiles(x86)}}\Google\Chrome\Application\chrome.exe","$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"); $chrome=$paths | Where-Object {{ Test-Path -LiteralPath $_ }} | Select-Object -First 1; if (!$chrome) {{ throw 'Chrome is not installed in a standard per-machine or per-user location' }}; $url={}; Start-Process -FilePath $chrome -ArgumentList ('"'+$url+'"')
'@
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner)); $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded"; $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited; Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Force | Out-Null; try {{ Start-ScheduledTask -TaskName $name; Start-Sleep -Seconds 3; $info=Get-ScheduledTaskInfo -TaskName $name; if ($info.LastTaskResult -ne 0) {{ throw "Chrome launch task failed with $($info.LastTaskResult)" }}; [pscustomobject]@{{requested=$true; taskResult=$info.LastTaskResult}} | ConvertTo-Json -Compress }} finally {{ Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue }}"#,
                    uuid::Uuid::new_v4().simple(),
                    ps_quote(&url),
                    ps_quote(&url)
                );
                let encoded = STANDARD.encode(
                    script
                        .encode_utf16()
                        .flat_map(u16::to_le_bytes)
                        .collect::<Vec<_>>(),
                );
                let remote = format!(
                    "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}"
                );
                output_value(run_ssh_command(target.unwrap(), &remote))
            } else if target.is_some_and(|s| s.os.eq_ignore_ascii_case("macos"))
                || (target.is_none() && cfg!(target_os = "macos"))
            {
                command_result(target, "open", &argv(&["-a", "Google Chrome", &url]))
            } else if cfg!(target_os = "windows") {
                let mut command = Command::new("powershell.exe");
                command.args([
                    "-NoProfile",
                    "-Command",
                    &format!("Start-Process chrome.exe -ArgumentList {}", ps_quote(&url)),
                ]);
                output_value(run_process(&mut command))
            } else {
                command_result(target, "google-chrome", &vec![url.clone()])
            };
            json!({"ok":r["ok"],"launchRequested":r["ok"],"url":redact_url(&url),"result":r})
        }
    })
}

fn docker_onboarding_plan(client_available: bool, daemon_ready: bool) -> Value {
    let (platform, official_install_url, prerequisites): (&str, &str, &[&str]) = match std::env::consts::OS {
        "macos" => ("macOS", "https://docs.docker.com/desktop/setup/install/mac-install/", &["Use a supported macOS version and CPU architecture.", "Review Docker Desktop licensing and terms before accepting."]),
        "windows" => ("Windows", "https://docs.docker.com/desktop/setup/install/windows-install/", &["Use a supported Windows release.", "For WSL 2, install/update WSL and enable hardware virtualization.", "Review Docker Desktop licensing and terms before accepting."]),
        "linux" => ("Linux", "https://docs.docker.com/engine/install/", &["Use a supported distribution and architecture.", "Review firewall implications and existing Docker packages before changing the host."]),
        _ => ("unsupported", "https://docs.docker.com/engine/install/", &["Install Docker using its official documentation for this platform."]),
    };
    let action = if daemon_ready {
        "reuse-existing-runtime"
    } else if client_available {
        "start-or-repair-existing-runtime"
    } else {
        "review-official-installation"
    };
    json!({
        "platform": platform,
        "action": action,
        "officialInstallUrl": official_install_url,
        "prerequisites": prerequisites,
        "installerConsentRequired": true,
        "autoAcceptTerms": false,
        "autoInstall": false,
        "migration": "none",
        "preserve": ["Docker contexts", "containers", "images", "volumes", "networks"],
        "healthCheck": ["docker version", "docker info", "hii resources docker doctor --json"]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_builders_quote_shell_metacharacters_literally() {
        let unix = command_text(
            "linux",
            "docker",
            &vec!["logs".into(), "x; touch /tmp/no".into()],
        )
        .unwrap();
        assert!(unix.ends_with("'logs' 'x; touch /tmp/no'"));
        let win = command_text("windows", "docker", &vec!["inspect".into(), "a'b".into()]).unwrap();
        let enc = win.split_whitespace().last().unwrap();
        let bytes = STANDARD.decode(enc).unwrap();
        let words: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|x| u16::from_le_bytes([x[0], x[1]]))
            .collect();
        assert!(String::from_utf16(&words).unwrap().contains("'a''b'"));
    }
    #[test]
    fn identifiers_reject_injection() {
        assert!(valid_container("hii-hii-map"));
        assert!(!valid_container("x;rm -rf /"));
        assert!(!valid_container("-x"));
    }
    #[test]
    fn docker_plan_reuses_ready_runtime_and_never_installs_or_accepts_terms() {
        let plan = docker_onboarding_plan(true, true);
        assert_eq!(plan["action"], "reuse-existing-runtime");
        assert_eq!(plan["autoInstall"], false);
        assert_eq!(plan["autoAcceptTerms"], false);
        assert_eq!(plan["installerConsentRequired"], true);
        assert_eq!(plan["migration"], "none");
        assert!(plan["preserve"]
            .as_array()
            .unwrap()
            .contains(&json!("volumes")));
    }
    #[test]
    fn docker_plan_distinguishes_missing_client_from_stopped_daemon() {
        assert_eq!(
            docker_onboarding_plan(true, false)["action"],
            "start-or-repair-existing-runtime"
        );
        assert_eq!(
            docker_onboarding_plan(false, false)["action"],
            "review-official-installation"
        );
    }
    #[test]
    fn docker_client_probe_reports_cli_when_daemon_version_query_fails() {
        let client = json!({
            "ok": true,
            "exitCode": 0,
            "stdout": "Docker version 27.5.1, build deadbeef\n",
            "stderr": ""
        });
        let daemon = json!({
            "ok": false,
            "exitCode": 1,
            "stdout": "",
            "stderr": "Cannot connect to the Docker daemon"
        });

        assert_eq!(docker_client_version(&client), Some("27.5.1"));
        assert_eq!(daemon["ok"], false);
        assert_eq!(
            docker_onboarding_plan(
                docker_client_version(&client).is_some(),
                daemon["ok"] == true
            )["action"],
            "start-or-repair-existing-runtime"
        );
        assert_eq!(docker_client_version(&daemon), None);
        assert_eq!(
            docker_client_version(&json!({"ok":true,"stdout":"not a docker version"})),
            None
        );
    }
    #[test]
    fn unsafe_urls_and_credentials_are_rejected() {
        assert!(safe_url("https://pc.example.ts.net:4173").is_ok());
        assert!(safe_url("file:///etc/passwd").is_err());
        assert!(safe_url("https://u:p@example.test").is_err());
    }
    #[test]
    fn tailscale_serve_commands_are_port_scoped() {
        assert_eq!(
            serve_argv(4173, Some(4173), false),
            vec!["serve", "--bg", "--tcp=4173", "tcp://127.0.0.1:4173"]
        );
        assert_eq!(
            serve_argv(4173, Some(4173), true),
            vec!["serve", "--bg", "--https=4173", "http://127.0.0.1:4173"]
        );
        assert_eq!(
            serve_argv(4173, None, true),
            vec!["serve", "--https=4173", "off"]
        );
    }
    #[test]
    fn tailscale_readiness_requires_successful_fresh_running_json() {
        let status =
            |exit, stdout: &str| json!({"ok":exit==0,"exitCode":exit,"stdout":stdout,"stderr":""});
        assert_eq!(
            tailscale_state(&status(
                0,
                r#"{"BackendState":"Running","Self":{"Online":true,"DNSName":"pc.tail"},"Peer":{}}"#
            ))["ready"],
            true
        );
        assert_eq!(
            tailscale_state(&status(0, r#"{"BackendState":"Stopped","Peer":{}}"#))["ready"],
            false
        );
        assert_eq!(tailscale_state(&status(0, "{truncated"))["ready"], false);
        assert_eq!(
            tailscale_state(&status(1, r#"{"BackendState":"Running","Peer":{}}"#))["ready"],
            false
        );
        assert_eq!(
            tailscale_state(
                &json!({"ok":false,"exitCode":124,"timedOut":true,"stdout":"","stderr":""})
            )["timedOut"],
            true
        );
    }
    #[test]
    fn docker_inventory_rejects_malformed_or_truncated_rows() {
        assert!(docker_inventory_valid(
            &json!({"ok":true,"outputComplete":true,"stdout":""})
        ));
        assert!(docker_inventory_valid(
            &json!({"ok":true,"outputComplete":true,"stdout":"abc|web|image:latest|running|Up 1 minute|127.0.0.1:8080->80/tcp\n"})
        ));
        assert!(!docker_inventory_valid(
            &json!({"ok":true,"outputComplete":true,"stdout":"[redacted]"})
        ));
        assert!(!docker_inventory_valid(
            &json!({"ok":true,"outputComplete":false,"stdout":""})
        ));
    }
    #[test]
    fn docker_inventory_ignores_blank_lines_and_projects_only_selected_fields() {
        let raw = "abc|web|image:latest|running|Up 1 minute|127.0.0.1:8080->80/tcp\n\nxyz|worker|worker:local|exited|Exited (0)|\n";
        let output = json!({"ok":true,"outputComplete":true,"stdout":raw});
        assert!(docker_inventory_valid(&output));
        let rows = docker_rows(&output);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], "abc");
        assert_eq!(rows[0]["name"], "web");
        assert_eq!(rows[0]["ports"], "127.0.0.1:8080->80/tcp");
        assert_eq!(rows[1]["state"], "exited");
        assert!(docker_row("[redacted]").is_none());
    }
    #[test]
    fn nested_resource_timeout_marks_receipt_outcome_unknown() {
        assert!(has_timeout(&json!({"docker":{"timedOut":true}})));
        assert!(has_timeout(&json!({"fresh":{"dockerTimedOut":true}})));
        assert!(!has_timeout(&json!({"docker":{"timedOut":false}})));
    }
    #[test]
    fn resource_mutations_are_classified_without_permission_checks() {
        let root = std::env::temp_dir().join("hii-resource-tests");
        let paths = AppPaths {
            repo: root.clone(),
            runtime: root,
        };
        assert!(writes(&Task::Docker("web".into(), "stop")));
        assert!(writes(&Task::Expose(4173, 4173, true)));
        assert!(writes(&Task::Unexpose(4173, true)));
        assert!(writes(&Task::Open(
            Some("https://example.test".into()),
            None
        )));
        // Invalid inputs still fail before any subprocess can change host state.
        assert!(run_task(&paths, None, &Task::Docker("-x".into(), "stop")).is_err());
        assert!(run_task(&paths, None, &Task::Expose(0, 4173, true)).is_err());
        assert!(run_task(&paths, None, &Task::Unexpose(0, true)).is_err());
        assert!(run_task(
            &paths,
            None,
            &Task::Open(Some("file:///etc/passwd".into()), None)
        )
        .is_err());
        let failed = run_local("hii-no-such-resource-program", &[]);
        assert_eq!(failed.status, 127);
        assert!(!failed.stderr.is_empty());
    }
}
