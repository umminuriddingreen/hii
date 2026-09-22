// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Local HII source feature work and Codex knowledge reconciliation.
use clap::Subcommand;
use fs2::FileExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use uuid::Uuid;

#[derive(Debug, Subcommand)]
pub enum UpdateCommand {
    /// Inspect the source checkout, feature runs, and Codex sync state.
    Status,
    /// Reconcile local Codex skills and memory into HII's local file memory.
    Sync,
    /// Build a requested HII feature in an isolated, clean source worktree.
    Feature {
        #[arg(required = true, num_args = 1..)]
        request: Vec<String>,
    },
    #[command(hide = true)]
    Worker { id: String },
}

fn home() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
        .ok_or_else(|| "Home directory is unavailable".into())
}

fn source_root() -> Result<PathBuf, String> {
    let candidate = env::var_os("HII_SOURCE_CHECKOUT")
        .map(PathBuf::from)
        .unwrap_or(home()?.join("hii"));
    let root = git(&candidate, &["rev-parse", "--show-toplevel"])?;
    let root = PathBuf::from(root);
    if !root.join("docs/HII_AII_MASTER_CONTEXT.md").is_file() {
        return Err("Configured checkout is not HII source; set HII_SOURCE_CHECKOUT".into());
    }
    Ok(root)
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let result = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|_| "Git is unavailable".to_string())?;
    if !result.status.success() {
        return Err(format!("git {} failed", args.first().unwrap_or(&"?")));
    }
    Ok(String::from_utf8_lossy(&result.stdout).trim().to_string())
}

fn status(runtime: &Path) -> Result<Value, String> {
    let source = source_root().ok().and_then(|path| {
        let commit = git(&path, &["rev-parse", "HEAD"]).ok()?;
        let branch = git(&path, &["branch", "--show-current"]).ok()?;
        let changes = git(&path, &["status", "--porcelain=v1", "--untracked-files=normal"]).ok()?;
        Some(json!({"path":path,"commit":commit,"branch":branch,"dirty":!changes.is_empty(),"changedFiles":changes.lines().count()}))
    });
    let sync_path = runtime.join("update/codex-sync.json");
    let sync = fs::read_to_string(sync_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let runs = runtime.join("update/runs");
    let feature_runs: Vec<Value> = fs::read_dir(runs)
        .ok()
        .map(|items| {
            items
                .flatten()
                .filter_map(|entry| {
                    let path = entry.path().join("run.json");
                    let mut report: Value = fs::read_to_string(path)
                        .ok()
                        .and_then(|s| serde_json::from_str(&s).ok())?;
                    if report["status"] == "running" {
                        if let Some(pid) = report["pid"].as_u64() {
                            #[cfg(unix)]
                            {
                                let alive = unsafe { libc::kill(pid as i32, 0) == 0 }
                                    || std::io::Error::last_os_error().raw_os_error()
                                        == Some(libc::EPERM);
                                if !alive {
                                    report["observedStatus"] = json!("interrupted");
                                }
                            }
                        }
                    }
                    Some(report)
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(
        json!({"schemaVersion":1,"kind":"hii.update.status","source":source,"codexSync":sync,"featureRunCount":feature_runs.len(),"featureRuns":feature_runs,"appUpdate":"Use the signed desktop updater; source changes do not install an app."}),
    )
}

fn collect_skills(root: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 10 || !root.is_dir() {
        return;
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_symlink() {
                continue;
            }
            if path.is_file() && path.file_name().is_some_and(|s| s == "SKILL.md") {
                out.push(path);
            } else if path.is_dir() {
                collect_skills(&path, out, depth + 1);
            }
        }
    }
}

fn sync(runtime: &Path) -> Result<Value, String> {
    let update_dir = runtime.join("update");
    fs::create_dir_all(&update_dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&update_dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let lock = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(update_dir.join("codex-sync.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock_exclusive().map_err(|e| e.to_string())?;
    let home = home()?;
    let mut files = Vec::new();
    for root in [
        home.join(".codex/skills"),
        home.join(".agents/skills"),
        home.join(".codex/memories/skills"),
        home.join(".codex/plugins/cache"),
    ] {
        collect_skills(&root, &mut files, 0);
    }
    for path in [
        home.join(".codex/memories/MEMORY.md"),
        home.join(".codex/memories/memory_summary.md"),
    ] {
        if path.is_file() {
            files.push(path);
        }
    }
    files.sort();
    files.dedup();
    let state_path = runtime.join("update/codex-sync.json");
    let prior = fs::read_to_string(&state_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(json!({}));
    let old = prior.get("files").and_then(Value::as_object);
    let mut current = serde_json::Map::new();
    let mut changed = 0;
    for path in files {
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let key = path.to_string_lossy().to_string();
        if old.and_then(|m| m.get(&key)).and_then(Value::as_str) != Some(digest.as_str()) {
            hii_core::memory::save(runtime, &path)?;
            changed += 1;
        }
        current.insert(key, Value::String(digest));
    }
    let report = json!({"schemaVersion":1,"kind":"hii.update.codex-sync","source":"local Codex skill and memory files","changed":changed,"tracked":current.len(),"files":current,"syncedAt":chrono::Utc::now().to_rfc3339(),"remoteTransfer":false});
    let temp = state_path.with_extension("tmp");
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        use std::io::Write;
        file.write_all(&serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    fs::write(
        &temp,
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&temp, state_path).map_err(|e| e.to_string())?;
    Ok(
        json!({"changed":changed,"tracked":report["tracked"],"syncedAt":report["syncedAt"],"remoteTransfer":false}),
    )
}

fn codex_binary() -> Result<PathBuf, String> {
    let home = home()?;
    let mut candidates = Vec::new();
    if let Some(path) = env::var_os("HII_CODEX_BINARY") {
        candidates.push(PathBuf::from(path));
    }
    if let Some(path) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&path).map(|dir| dir.join("codex")));
    }
    candidates.extend([
        home.join(".local/bin/codex"),
        home.join(".npm-global/bin/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ]);
    candidates
        .into_iter()
        .find(|path| {
            if !path.is_file() {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                return fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0);
            }
            #[cfg(not(unix))]
            {
                true
            }
        })
        .ok_or_else(|| {
            "Codex CLI unavailable; set HII_CODEX_BINARY to its absolute executable path".into()
        })
}

fn write_report(path: &Path, report: &Value) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(report).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())
}

fn worker(runtime: &Path, id: &str) -> Result<(), String> {
    let id = Uuid::parse_str(id).map_err(|_| "Invalid feature run id".to_string())?;
    let folder = runtime.join("update/runs").join(id.to_string());
    let report_path = folder.join("run.json");
    let mut report: Value =
        serde_json::from_slice(&fs::read(&report_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    report["pid"] = json!(std::process::id());
    report["status"] = json!("running");
    write_report(&report_path, &report)?;
    let worktree = PathBuf::from(report["worktree"].as_str().ok_or("Missing worktree")?);
    let request = report["request"]
        .as_str()
        .ok_or("Missing feature request")?;
    let task = format!("Implement this requested HII feature in this isolated worktree: {request}\n\nFollow AGENTS.md and the required product decisions. HII is glue across local software and the user's own network, not an operating system replacement. Preserve other worktrees. Build the smallest complete slice, test it, and commit only your changes in this branch. Do not push or deploy. Report the commit, checks, and any remaining gap.");
    let log = fs::File::create(folder.join("events.jsonl")).map_err(|e| e.to_string())?;
    let err = fs::File::create(folder.join("stderr.log")).map_err(|e| e.to_string())?;
    let codex = report["codexBinary"]
        .as_str()
        .map(PathBuf::from)
        .ok_or("Missing Codex binary")?;
    let outcome = Command::new(codex)
        .args(["exec", "-m", "gpt-6-luna", "-C"])
        .arg(&worktree)
        .args(["--json", "--ephemeral", "-s", "workspace-write", "-o"])
        .arg(folder.join("last.txt"))
        .arg(&task)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .status();
    report["finishedAt"] = json!(chrono::Utc::now().to_rfc3339());
    report["headCommit"] = json!(git(&worktree, &["rev-parse", "HEAD"]).ok());
    report["dirty"] = json!(git(&worktree, &["status", "--porcelain=v1"])
        .map(|s| !s.is_empty())
        .ok());
    match outcome {
        Ok(exit) => {
            report["exitCode"] = json!(exit.code());
            report["status"] = json!(if exit.success() {
                "completed"
            } else {
                "failed"
            });
        }
        Err(error) => {
            report["status"] = json!("failed");
            report["error"] = json!(error.to_string());
        }
    }
    write_report(&report_path, &report)
}

fn feature(runtime: &Path, request: String) -> Result<Value, String> {
    let request = request.trim();
    if request.chars().count() < 8 || request.chars().count() > 2000 {
        return Err("Feature request must be 8 to 2000 characters".into());
    }
    let source = source_root()?;
    let codex = codex_binary()?;
    // A worktree branches from the source HEAD and never stages or rewrites its files.
    // Existing dirty worktrees therefore remain untouched.
    let id = Uuid::new_v4().to_string();
    let branch = format!("hii/feature-{}", &id[..8]);
    let folder = runtime.join("update/runs").join(&id);
    let worktree = folder.join("source");
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    git(
        &source,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            worktree.to_str().ok_or("Invalid worktree path")?,
            "HEAD",
        ],
    )?;
    let report = json!({"schemaVersion":1,"kind":"hii.update.feature","id":id,"request":request,"branch":branch,"worktree":worktree,"sourceCommit":git(&source,&["rev-parse","HEAD"])?,"model":"gpt-6-luna","codexBinary":codex,"events":folder.join("events.jsonl"),"stderr":folder.join("stderr.log"),"status":"starting","createdAt":chrono::Utc::now().to_rfc3339()});
    let report_path = folder.join("run.json");
    write_report(&report_path, &report)?;
    let spawn = Command::new(env::current_exe().map_err(|e| e.to_string())?)
        .args(["update", "worker", &id])
        .stdin(Stdio::null())
        .stdout(Stdio::from(
            fs::File::create(folder.join("worker.log")).map_err(|e| e.to_string())?,
        ))
        .stderr(Stdio::null())
        .spawn();
    if let Err(error) = spawn {
        let mut failed = report.clone();
        failed["status"] = json!("failed");
        failed["error"] = json!(format!("Could not start HII update worker: {error}"));
        failed["finishedAt"] = json!(chrono::Utc::now().to_rfc3339());
        write_report(&report_path, &failed)?;
        return Err(failed["error"]
            .as_str()
            .unwrap_or("Worker unavailable")
            .into());
    }
    Ok(report)
}

pub fn execute(action: UpdateCommand) -> Result<(), String> {
    let runtime = hii_core::runtime_root()?;
    let output = match action {
        UpdateCommand::Status => status(&runtime)?,
        UpdateCommand::Sync => sync(&runtime)?,
        UpdateCommand::Feature { request } => feature(&runtime, request.join(" "))?,
        UpdateCommand::Worker { id } => {
            worker(&runtime, &id)?;
            return Ok(());
        }
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&output).map_err(|e| e.to_string())?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_local_skill_files_without_following_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let skill = root.path().join("tools/demo/SKILL.md");
        fs::create_dir_all(skill.parent().unwrap()).unwrap();
        fs::write(&skill, "demo").unwrap();
        let mut files = Vec::new();
        collect_skills(root.path(), &mut files, 0);
        assert_eq!(files, vec![skill]);
    }

    #[cfg(unix)]
    #[test]
    fn worker_records_completed_receipt() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        let folder = root.path().join("update/runs").join(&id);
        let worktree = folder.join("source");
        fs::create_dir_all(&worktree).unwrap();
        let codex = folder.join("codex");
        fs::write(&codex, "#!/bin/sh\nprintf 'model response\\n'\nexit 0\n").unwrap();
        let mut permissions = fs::metadata(&codex).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&codex, permissions).unwrap();
        write_report(
            &folder.join("run.json"),
            &json!({
                "id": id, "request": "Add a visible button", "worktree": worktree,
                "codexBinary": codex, "status": "starting"
            }),
        )
        .unwrap();
        worker(root.path(), &id).unwrap();
        let result: Value =
            serde_json::from_slice(&fs::read(folder.join("run.json")).unwrap()).unwrap();
        assert_eq!(result["status"], "completed");
        assert_eq!(result["exitCode"], 0);
        assert!(result["finishedAt"].as_str().is_some());
        assert!(folder.join("events.jsonl").is_file());
    }
}
