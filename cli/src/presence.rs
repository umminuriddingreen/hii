//! A truthful projection of HII's ongoing relationship with its operator.
//!
//! Presence is not a consciousness claim. It joins durable local continuity,
//! current attention, recent proof, and the authority boundary into one small
//! system-owned view. Models may later reflect over this projection, but they
//! do not own it and their inferences never become the operator's identity.

use crate::{
    board::{Board, Task},
    config::AppPaths,
    ollama::Ollama,
    receipt::{latest_receipt_pointer, Receipt},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

const MAX_ATTENTION: usize = 3;
const MAX_RECEIPT_STATUS_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Presence {
    schema_version: u8,
    kind: &'static str,
    state: &'static str,
    claim: &'static str,
    runtime: RuntimeIdentity,
    wake: Wake,
    supervisor: Supervisor,
    model: ModelRuntime,
    trace_coverage: TraceCoverage,
    relationship: Relationship,
    continuity: Continuity,
    context: Context,
    attention: Vec<Attention>,
    recent_proof: Option<RecentProof>,
    authority: Authority,
    next: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeIdentity {
    component: &'static str,
    version: &'static str,
    pid: u32,
    invocation: &'static str,
    persistent_process: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Wake {
    reason: &'static str,
    source: &'static str,
    continuous_inference: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Supervisor {
    state: String,
    pid: Option<u32>,
    process_alive: bool,
    status_path: String,
    updated_at: Option<String>,
    autonomy: String,
    managed_instances: usize,
    live_executors: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelRuntime {
    provider: String,
    endpoint: String,
    state: &'static str,
    ownership: &'static str,
    configured_model: String,
    configured_source: &'static str,
    loaded_state: &'static str,
    loaded_models: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TraceCoverage {
    state: &'static str,
    path: String,
    records: usize,
    invalid_records: usize,
    hii_controlled_records: usize,
    last_observed_at: Option<String>,
    last_provider: Option<String>,
    last_model: Option<String>,
    last_receipt: Option<String>,
    scope: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Relationship {
    system: &'static str,
    operator: &'static str,
    representation: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Continuity {
    profile: Option<String>,
    board: String,
    receipts: usize,
    receipt_count_scope: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Context {
    workspace: String,
    sources: Vec<ContextSource>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextSource {
    kind: &'static str,
    path: String,
    state: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Attention {
    id: String,
    title: String,
    lane: String,
    owner: String,
    coordinate: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentProof {
    id: String,
    path: String,
    status: String,
    goal: String,
    verified: usize,
    checks: usize,
    verification: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Authority {
    observe: &'static str,
    propose: &'static str,
    act: &'static str,
    represent: &'static str,
}

pub fn show(paths: &AppPaths, workspace: &Path, json: bool) -> Result<(), String> {
    let presence = snapshot(paths, workspace)?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&presence).map_err(|error| error.to_string())?
        );
        return Ok(());
    }

    println!("HII Presence  ·  grounded, local, ongoing");
    println!("state       {}", presence.state);
    println!(
        "runtime     {} {} · pid {} · {}",
        presence.runtime.component,
        presence.runtime.version,
        presence.runtime.pid,
        presence.runtime.invocation,
    );
    println!(
        "supervisor  {} · pid={} · {} live executor(s)",
        presence.supervisor.state,
        presence
            .supervisor
            .pid
            .map(|pid| pid.to_string())
            .unwrap_or_else(|| "none".into()),
        presence.supervisor.live_executors,
    );
    println!(
        "model       {} · {} · loaded={}",
        presence.model.provider,
        presence.model.state,
        if presence.model.loaded_models.is_empty() {
            presence.model.loaded_state.to_string()
        } else {
            presence.model.loaded_models.join(", ")
        },
    );
    println!(
        "traces      {} HII-controlled / {} total · {}",
        presence.trace_coverage.hii_controlled_records,
        presence.trace_coverage.records,
        presence.trace_coverage.scope,
    );
    println!(
        "continuity  profile={} · {} open thread(s) · {} recent receipt(s) observed",
        presence.continuity.profile.as_deref().unwrap_or("missing"),
        presence.attention.len(),
        presence.continuity.receipts,
    );
    if let Some(proof) = &presence.recent_proof {
        println!(
            "proof       {} · {} · {} ({}/{} checks)",
            proof.id, proof.status, proof.verification, proof.verified, proof.checks
        );
    } else {
        println!("proof       no receipt for this workspace yet");
    }
    println!("boundary    observes state · proposes visibly · acts only with granted authority");
    println!("identity    HII interpretations stay labeled until you adopt them");
    println!("next        {}", presence.next);
    Ok(())
}

fn snapshot(paths: &AppPaths, workspace: &Path) -> Result<Presence, String> {
    snapshot_with_model(paths, workspace, observe_model(paths))
}

fn snapshot_with_model(
    paths: &AppPaths,
    workspace: &Path,
    model: ModelRuntime,
) -> Result<Presence, String> {
    let tasks = Board::open(&paths.runtime).tasks(false)?;
    let attention = tasks
        .iter()
        .filter(|task| task.lane == "doing" || task.lane == "next")
        .take(MAX_ATTENTION)
        .map(attention_from)
        .collect::<Vec<_>>();
    let recent_receipt = latest_receipt(&paths.runtime, workspace);
    let recent_proof = recent_receipt.as_ref().map(|(path, receipt)| RecentProof {
        id: receipt.id.clone(),
        path: path.display().to_string(),
        status: receipt.status.clone(),
        goal: receipt.goal.clone(),
        verified: receipt.verification.iter().filter(|check| check.ok).count(),
        checks: receipt.verification.len(),
        verification: verification_state(receipt),
    });
    let profile = profile_path(&paths.runtime);
    let supervisor = observe_supervisor(&paths.runtime);
    let trace_coverage = observe_traces(&paths.runtime);
    let context = context_snapshot(
        &paths.runtime,
        workspace,
        profile.as_deref(),
        recent_receipt.as_ref().map(|(path, _)| path.as_path()),
        &trace_coverage,
    );
    let next = attention
        .first()
        .map(|item| format!("Return to '{}' at {}", item.title, item.coordinate))
        .unwrap_or_else(|| {
            "Tell HII what deserves attention; it will keep the thread and proof.".into()
        });

    Ok(Presence {
        schema_version: 1,
        kind: "hii.presence",
        state: if supervisor.live_executors > 0 {
            "working"
        } else {
            "available"
        },
        claim: "operational presence, not a claim of consciousness or sentience",
        runtime: RuntimeIdentity {
            component: "hii-cli",
            version: env!("CARGO_PKG_VERSION"),
            pid: std::process::id(),
            invocation: "operator-invoked",
            persistent_process: false,
        },
        wake: Wake {
            reason: "presence status requested",
            source: "CLI invocation",
            continuous_inference: false,
        },
        supervisor,
        model,
        trace_coverage,
        relationship: Relationship {
            system: "HII",
            operator: "user",
            representation: "user-authored context with source-labeled system inference",
        },
        continuity: Continuity {
            profile: profile.map(|path| path.display().to_string()),
            board: Board::open(&paths.runtime)
                .store_path()
                .display()
                .to_string(),
            receipts: usize::from(recent_receipt.is_some()),
            receipt_count_scope: "latest workspace receipt only; history not scanned",
        },
        context,
        attention,
        recent_proof,
        authority: Authority {
            observe: "read-only local state",
            propose: "visible and reversible",
            act: "only within explicit granted authority",
            represent: "never attribute HII inference to the user without adoption",
        },
        next,
    })
}

fn latest_receipt(runtime: &Path, workspace: &Path) -> Option<(PathBuf, Receipt)> {
    let path = latest_receipt_pointer(runtime, workspace)?;
    if fs::metadata(&path).ok()?.len() > MAX_RECEIPT_STATUS_BYTES {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    let receipt = serde_json::from_str(&raw).ok()?;
    Some((path, receipt))
}

fn verification_state(receipt: &Receipt) -> &'static str {
    if receipt.verification.is_empty() {
        "not-verified"
    } else if receipt.verification.iter().all(|check| check.ok) {
        "verified"
    } else {
        "verification-failed"
    }
}

fn observe_model(paths: &AppPaths) -> ModelRuntime {
    let runtime = Ollama::discover();
    let preference = paths.user_model_preference();
    let (configured_model, configured_source) = match preference {
        Ok(Some(preference)) => (preference.model, "user-config"),
        Ok(None) => (
            runtime.provider().default_model().into(),
            "provider-default",
        ),
        Err(_) => (
            runtime.provider().default_model().into(),
            "invalid-user-config",
        ),
    };
    let (state, loaded_state, loaded_models) = match runtime.running_models() {
        Ok(Some(models)) => ("reachable", "observed", models),
        Ok(None) => match runtime.models() {
            Ok(_) => ("reachable", "not-exposed-by-provider", Vec::new()),
            Err(_) => ("unreachable", "unavailable", Vec::new()),
        },
        Err(_) => ("unreachable", "unavailable", Vec::new()),
    };
    ModelRuntime {
        provider: runtime.provider().id().into(),
        endpoint: safe_endpoint(runtime.base_url()),
        state,
        ownership: "observed local provider; process ownership is not inferred",
        configured_model,
        configured_source,
        loaded_state,
        loaded_models,
    }
}

fn safe_endpoint(raw: &str) -> String {
    let Ok(mut url) = url::Url::parse(raw) else {
        return "configured-local-provider".into();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    url.to_string().trim_end_matches('/').to_string()
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStatusFile {
    state: Option<String>,
    pid: Option<u32>,
    updated_at: Option<String>,
    autonomy: Option<String>,
}

#[derive(Default, Deserialize)]
struct InstancesFile {
    #[serde(default)]
    instances: Vec<InstanceRecord>,
}

#[derive(Deserialize)]
struct InstanceRecord {
    #[serde(default)]
    id: String,
    pid: Option<u32>,
    #[serde(default)]
    owned: bool,
}

fn observe_supervisor(runtime: &Path) -> Supervisor {
    let daemon_dir = runtime.join("daemon");
    let status_path = daemon_dir.join("status.json");
    let status = crate::store::read_json::<DaemonStatusFile>(&status_path).unwrap_or_default();
    let pid_path = daemon_dir.join("daemon.pid");
    let pid = fs::read_to_string(&pid_path)
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .or(status.pid);
    let process_alive = pid.is_some_and(process_is_alive);
    let state = match (process_alive, status.state.as_deref()) {
        (true, _) => "running",
        (false, Some("running" | "starting")) => "stale",
        _ => "stopped",
    }
    .to_string();
    let instances = crate::store::read_json::<InstancesFile>(&daemon_dir.join("instances.json"))
        .unwrap_or_default()
        .instances;
    let managed_instances = instances.iter().filter(|instance| instance.owned).count();
    let live_executors = instances
        .iter()
        .filter(|instance| {
            instance.owned
                && instance.id != "daemon:hiid"
                && instance.pid.is_some_and(process_is_alive)
        })
        .count();
    Supervisor {
        state,
        pid,
        process_alive,
        status_path: status_path.display().to_string(),
        updated_at: status.updated_at,
        autonomy: status.autonomy.unwrap_or_else(|| "reversible-local".into()),
        managed_instances,
        live_executors,
    }
}

fn process_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(windows)]
    {
        // Windows has no kill(pid, 0). Query a process handle without invoking
        // a shell, and always close it. This checks liveness, not ownership.
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn GetExitCodeProcess(handle: *mut std::ffi::c_void, code: *mut u32) -> i32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        if pid == 0 {
            return false;
        }
        unsafe {
            let handle = OpenProcess(0x1000, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code = 0;
            let ok = GetExitCodeProcess(handle, &mut code) != 0 && code == 259;
            CloseHandle(handle);
            ok
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

fn observe_traces(runtime: &Path) -> TraceCoverage {
    let path = runtime.join("traces/llm_requests.jsonl");
    let Some(file) = fs::File::open(&path).ok() else {
        return TraceCoverage {
            state: "absent",
            path: path.display().to_string(),
            records: 0,
            invalid_records: 0,
            hii_controlled_records: 0,
            last_observed_at: None,
            last_provider: None,
            last_model: None,
            last_receipt: None,
            scope: "HII-instrumented calls only; host activity is not observed",
        };
    };
    let mut records = 0;
    let mut invalid_records = 0;
    let mut hii_controlled_records = 0;
    let mut last_hii = None;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            invalid_records += 1;
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        records += 1;
        match serde_json::from_str::<Value>(&line) {
            Ok(value) => {
                let source = value.get("source").and_then(Value::as_str).unwrap_or("");
                if source == "hii-cli" || source.starts_with("hii.") {
                    hii_controlled_records += 1;
                    last_hii = Some(value);
                }
            }
            Err(_) => invalid_records += 1,
        }
    }
    TraceCoverage {
        state: "observed",
        path: path.display().to_string(),
        records,
        invalid_records,
        hii_controlled_records,
        last_observed_at: string_field(last_hii.as_ref(), "ts"),
        last_provider: string_field(last_hii.as_ref(), "provider"),
        last_model: string_field(last_hii.as_ref(), "model"),
        last_receipt: string_field(last_hii.as_ref(), "receipt_id"),
        scope: "HII-instrumented calls only; host activity is not observed",
    }
}

fn string_field(value: Option<&Value>, field: &str) -> Option<String> {
    value?.get(field)?.as_str().map(str::to_string)
}

fn context_snapshot(
    runtime: &Path,
    workspace: &Path,
    profile: Option<&Path>,
    receipt: Option<&Path>,
    traces: &TraceCoverage,
) -> Context {
    let mut sources = vec![ContextSource {
        kind: "board",
        path: Board::open(runtime).store_path().display().to_string(),
        state: "read",
    }];
    if let Some(path) = profile {
        sources.push(ContextSource {
            kind: "profile",
            path: path.display().to_string(),
            state: "located",
        });
    }
    if let Some(path) = receipt {
        sources.push(ContextSource {
            kind: "recent-receipt",
            path: path.display().to_string(),
            state: "read",
        });
    }
    sources.push(ContextSource {
        kind: "model-traces",
        path: traces.path.clone(),
        state: if traces.state == "observed" {
            "read"
        } else {
            "absent"
        },
    });
    Context {
        workspace: workspace.display().to_string(),
        sources,
    }
}

fn attention_from(task: &Task) -> Attention {
    Attention {
        id: task.id.clone(),
        title: task.title.clone(),
        lane: task.lane.clone(),
        owner: task.owner.clone(),
        coordinate: task.coordinate.clone(),
    }
}

fn profile_path(runtime: &Path) -> Option<PathBuf> {
    [runtime.join("profile.md"), runtime.join("user.md")]
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| {
            dirs::home_dir()
                .map(|home| home.join(".hermes/memories/USER.md"))
                .filter(|path| path.is_file())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::AddOptions;
    use std::{fs, time::SystemTime};

    #[test]
    fn presence_is_grounded_in_user_owned_state_and_keeps_identity_boundary() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("hii-presence-{unique}"));
        let runtime = root.join("runtime");
        let workspace = root.join("workspace");
        fs::create_dir_all(&runtime).expect("runtime");
        fs::create_dir_all(&workspace).expect("workspace");
        fs::write(runtime.join("profile.md"), "# My authored context\n").expect("profile");
        Board::open(&runtime)
            .add(
                &workspace,
                AddOptions {
                    title: "Continue the living HII loop".into(),
                    lane: Some("next".into()),
                    priority: Some("high".into()),
                    owner: Some("user".into()),
                    coordinate: Some(workspace.display().to_string()),
                    notes: None,
                    tags: None,
                },
            )
            .expect("task");

        let presence = snapshot_with_model(
            &AppPaths {
                repo: workspace.clone(),
                runtime: runtime.clone(),
            },
            &workspace,
            offline_model(),
        )
        .expect("presence");

        assert_eq!(presence.kind, "hii.presence");
        assert_eq!(presence.state, "available");
        assert!(presence.claim.contains("not a claim of consciousness"));
        assert_eq!(presence.attention.len(), 1);
        assert_eq!(
            presence.relationship.representation,
            "user-authored context with source-labeled system inference"
        );
        assert_eq!(
            presence.authority.act,
            "only within explicit granted authority"
        );
        assert_eq!(
            presence.continuity.profile,
            Some(runtime.join("profile.md").display().to_string())
        );

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn presence_distinguishes_live_processes_from_stale_daemon_files() {
        let root = temp_root("runtime-truth");
        let runtime = root.join("runtime");
        fs::create_dir_all(runtime.join("daemon")).expect("daemon dir");
        fs::write(
            runtime.join("daemon/status.json"),
            format!(
                r#"{{"state":"running","pid":{},"updatedAt":"now","autonomy":"reversible-local"}}"#,
                std::process::id()
            ),
        )
        .expect("status");
        fs::write(
            runtime.join("daemon/instances.json"),
            format!(
                r#"{{"instances":[{{"id":"daemon:hiid","pid":{},"owned":true}},{{"id":"run:live","pid":{},"owned":true}}]}}"#,
                std::process::id(),
                std::process::id()
            ),
        )
        .expect("instances");

        let supervisor = observe_supervisor(&runtime);
        assert_eq!(supervisor.state, "running");
        assert!(supervisor.process_alive);
        assert_eq!(supervisor.live_executors, 1);

        fs::write(
            runtime.join("daemon/status.json"),
            r#"{"state":"running","pid":4294967294,"updatedAt":"old"}"#,
        )
        .expect("stale status");
        fs::remove_file(runtime.join("daemon/daemon.pid")).ok();
        let stale = observe_supervisor(&runtime);
        assert_eq!(stale.state, "stale");
        assert!(!stale.process_alive);

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn trace_coverage_only_attributes_hii_instrumented_calls() {
        let root = temp_root("trace-truth");
        let runtime = root.join("runtime");
        fs::create_dir_all(runtime.join("traces")).expect("traces dir");
        fs::write(
            runtime.join("traces/llm_requests.jsonl"),
            concat!(
                "{\"source\":\"other-tool\",\"model\":\"unknown\"}\n",
                "not-json\n",
                "{\"source\":\"hii-cli\",\"ts\":\"2026-08-19T00:00:00Z\",\"provider\":\"ollama\",\"model\":\"local\",\"receipt_id\":\"run-1\"}\n"
            ),
        )
        .expect("trace log");

        let traces = observe_traces(&runtime);
        assert_eq!(traces.records, 3);
        assert_eq!(traces.invalid_records, 1);
        assert_eq!(traces.hii_controlled_records, 1);
        assert_eq!(traces.last_model.as_deref(), Some("local"));
        assert!(traces.scope.contains("host activity is not observed"));

        fs::remove_dir_all(root).expect("cleanup");
    }

    fn offline_model() -> ModelRuntime {
        ModelRuntime {
            provider: "ollama".into(),
            endpoint: "http://127.0.0.1:11434".into(),
            state: "unreachable",
            ownership: "observed local provider; process ownership is not inferred",
            configured_model: "local".into(),
            configured_source: "provider-default",
            loaded_state: "unavailable",
            loaded_models: Vec::new(),
        }
    }

    fn temp_root(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("hii-presence-{label}-{unique}"))
    }
}
