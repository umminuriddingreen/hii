use crate::receipt::redact_text;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};

const MAX_ACTIVE_JOBS: usize = 1;
const LOG_TAIL_BYTES: u64 = 32 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobRecord {
    schema_version: u8,
    id: String,
    goal: String,
    workspace: PathBuf,
    model: String,
    pid: u32,
    status: String,
    started_at: String,
    #[serde(default)]
    finished_at: Option<String>,
    #[serde(default)]
    exit_code: Option<i32>,
    log: PathBuf,
    #[serde(default)]
    proof: Option<PathBuf>,
    #[serde(default)]
    summary: Option<String>,
}

pub struct BackgroundJobs {
    root: PathBuf,
    workspace: PathBuf,
    children: HashMap<String, Child>,
}

impl BackgroundJobs {
    pub fn new(runtime: &Path, workspace: &Path) -> Result<Self, String> {
        let root = runtime.join("background-jobs");
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        crate::store::set_directory_mode(&root)?;
        Ok(Self {
            root,
            workspace: workspace.to_path_buf(),
            children: HashMap::new(),
        })
    }

    pub fn start(&mut self, goal: &str, model: &str) -> Result<String, String> {
        let goal = goal.trim();
        if goal.is_empty() {
            return Err("usage: /background <task>".into());
        }
        self.refresh()?;
        if self.active_records()?.len() >= MAX_ACTIVE_JOBS {
            return Err(
                "One background job is already active in this workspace. Use /jobs or /job <id> cancel."
                    .into(),
            );
        }
        let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let directory = self.root.join(&id);
        fs::create_dir(&directory).map_err(|error| error.to_string())?;
        crate::store::set_directory_mode(&directory)?;
        let log = directory.join("output.jsonl");
        let stdout = secure_log(&log)?;
        let stderr = stdout.try_clone().map_err(|error| error.to_string())?;
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut command = Command::new(&executable);
        command
            .arg("--cwd")
            .arg(&self.workspace)
            .arg("--model")
            .arg(model)
            .arg("--max-steps")
            .arg("0")
            .arg("run")
            .arg("--authority")
            .arg("workspace")
            .arg("--jsonl")
            .arg(goal)
            .current_dir(&self.workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .env("HII_BACKGROUND_JOB_ID", &id);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("could not start background HII: {error}"))?;
        let record = JobRecord {
            schema_version: 1,
            id: id.clone(),
            goal: redact_text(goal),
            workspace: self.workspace.clone(),
            model: model.into(),
            pid: child.id(),
            status: "running".into(),
            started_at: chrono::Utc::now().to_rfc3339(),
            finished_at: None,
            exit_code: None,
            log,
            proof: None,
            summary: None,
        };
        self.write_record(&record)?;
        self.children.insert(id.clone(), child);
        Ok(format!(
            "Background job {id} started · {}\nUse /jobs or /job {id} logs.",
            record.goal
        ))
    }

    pub fn list(&mut self) -> Result<String, String> {
        self.refresh()?;
        let mut records = self.records()?;
        records.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        if records.is_empty() {
            return Ok("No background jobs yet.".into());
        }
        Ok(records
            .into_iter()
            .take(12)
            .map(|record| {
                let proof = record
                    .proof
                    .as_ref()
                    .map(|_| " · proof")
                    .unwrap_or_default();
                format!(
                    "{}  {:<9} {}{}",
                    record.id,
                    record.status,
                    crate::text::clip(&record.goal, 64),
                    proof
                )
            })
            .collect::<Vec<_>>()
            .join("\n"))
    }

    pub fn operate(&mut self, id: &str, action: &str) -> Result<String, String> {
        validate_id(id)?;
        self.refresh()?;
        let record = self.read_record(id)?;
        match action {
            "status" => Ok(render_record(&record)),
            "logs" => tail(&record.log),
            "proof" => record
                .proof
                .as_ref()
                .map(|path| path.display().to_string())
                .ok_or_else(|| "This job has not produced a receipt yet.".into()),
            "cancel" | "stop" => self.cancel(record),
            _ => Err("job action must be status, logs, proof, or cancel".into()),
        }
    }

    pub fn refresh(&mut self) -> Result<Vec<String>, String> {
        let mut updates = Vec::new();
        let ids = self.children.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            let Some(child) = self.children.get_mut(&id) else {
                continue;
            };
            let Some(status) = child.try_wait().map_err(|error| error.to_string())? else {
                continue;
            };
            let mut record = self.read_record(&id)?;
            let log = record.log.clone();
            finalize_record(&mut record, status.code(), &log)?;
            self.write_record(&record)?;
            self.children.remove(&id);
            updates.push(format!(
                "Background job {} {}{}",
                id,
                record.status,
                record
                    .summary
                    .as_ref()
                    .map(|summary| format!(" · {summary}"))
                    .unwrap_or_default()
            ));
        }
        for mut record in self.records()? {
            if record.status != "running" || self.children.contains_key(&record.id) {
                continue;
            }
            if process_alive(record.pid) {
                continue;
            }
            let log = record.log.clone();
            finalize_record(&mut record, None, &log)?;
            self.write_record(&record)?;
        }
        Ok(updates)
    }

    fn cancel(&mut self, mut record: JobRecord) -> Result<String, String> {
        if record.status != "running" {
            return Ok(format!(
                "Background job {} is already {}.",
                record.id, record.status
            ));
        }
        terminate_process_group(record.pid)?;
        if let Some(mut child) = self.children.remove(&record.id) {
            let _ = child.wait();
        }
        record.status = "cancelled".into();
        record.finished_at = Some(chrono::Utc::now().to_rfc3339());
        record.summary = Some("Cancelled by the operator.".into());
        self.write_record(&record)?;
        Ok(format!("Cancelled background job {}.", record.id))
    }

    fn active_records(&self) -> Result<Vec<JobRecord>, String> {
        Ok(self
            .records()?
            .into_iter()
            .filter(|record| {
                record.workspace == self.workspace
                    && record.status == "running"
                    && process_alive(record.pid)
            })
            .collect())
    }

    fn records(&self) -> Result<Vec<JobRecord>, String> {
        Ok(fs::read_dir(&self.root)
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                fs::read(entry.path().join("job.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            })
            .filter(|record: &JobRecord| record.workspace == self.workspace)
            .collect())
    }

    fn read_record(&self, id: &str) -> Result<JobRecord, String> {
        let path = self.root.join(id).join("job.json");
        let bytes =
            fs::read(&path).map_err(|error| format!("cannot read background job {id}: {error}"))?;
        serde_json::from_slice(&bytes).map_err(|error| format!("invalid job record: {error}"))
    }

    fn write_record(&self, record: &JobRecord) -> Result<(), String> {
        let directory = self.root.join(&record.id);
        let target = directory.join("job.json");
        let temporary = directory.join("job.json.tmp");
        let bytes = serde_json::to_vec_pretty(record).map_err(|error| error.to_string())?;
        write_private(&temporary, &bytes)?;
        fs::rename(&temporary, &target).map_err(|error| error.to_string())
    }
}

fn finalize_record(
    record: &mut JobRecord,
    exit_code: Option<i32>,
    log: &Path,
) -> Result<(), String> {
    record.finished_at = Some(chrono::Utc::now().to_rfc3339());
    record.exit_code = exit_code;
    let final_event = final_event(log)?;
    record.proof = final_event
        .as_ref()
        .and_then(|value| value["data"]["proof"].as_str())
        .map(PathBuf::from);
    let receipt = final_event.as_ref().map(|value| &value["data"]["receipt"]);
    record.summary = receipt
        .and_then(|value| value["summary"].as_str())
        .map(redact_text);
    record.status = receipt
        .and_then(|value| value["status"].as_str())
        .unwrap_or_else(|| {
            if exit_code == Some(0) {
                "completed"
            } else {
                "failed"
            }
        })
        .into();
    Ok(())
}

fn final_event(path: &Path) -> Result<Option<Value>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    Ok(raw.lines().rev().find_map(|line| {
        let value: Value = serde_json::from_str(line).ok()?;
        (value["event"] == "run.finished").then_some(value)
    }))
}

fn render_record(record: &JobRecord) -> String {
    format!(
        "{} · {}\n{}\nmodel: {}\npid: {}\nlog: {}{}",
        record.id,
        record.status,
        record.goal,
        record.model,
        record.pid,
        record.log.display(),
        record
            .proof
            .as_ref()
            .map(|path| format!("\nproof: {}", path.display()))
            .unwrap_or_default()
    )
}

fn tail(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(LOG_TAIL_BYTES)))
        .map_err(|error| error.to_string())?;
    let mut raw = String::new();
    file.read_to_string(&mut raw)
        .map_err(|error| error.to_string())?;
    let clean = raw
        .lines()
        .filter_map(|line| {
            let value: Value = serde_json::from_str(line).ok()?;
            let event = value["event"].as_str()?;
            match event {
                "model.response" => value["data"]["content"]
                    .as_str()
                    .map(|content| format!("MODEL  {}", redact_text(content))),
                "tool.result" => Some(format!(
                    "TOOL   {}",
                    redact_text(
                        value["data"]["output"]
                            .as_str()
                            .unwrap_or("tool action completed")
                    )
                )),
                "run.started" => Some(format!(
                    "START  {}",
                    value["data"]["goal"].as_str().unwrap_or_default()
                )),
                "run.finished" => Some(format!(
                    "DONE   {}",
                    value["data"]["receipt"]["summary"]
                        .as_str()
                        .unwrap_or("receipt written")
                )),
                _ => None,
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(if clean.is_empty() {
        "No visible background output yet.".into()
    } else {
        clean
    })
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.len() == 8 && id.chars().all(|character| character.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("invalid background job id".into())
    }
}

fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as i32, 0) };
        result == 0
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn terminate_process_group(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(-(pid as i32), libc::SIGTERM) };
        if result == 0 {
            Ok(())
        } else {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                Err(format!("could not cancel background job: {error}"))
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        Err("background cancellation is unavailable on this platform".into())
    }
}

fn secure_log(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|error| error.to_string())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let path = std::env::temp_dir().join(format!("hii-background-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn final_event_extracts_receipt_and_proof() {
        let root = root();
        let log = root.join("output.jsonl");
        fs::write(
            &log,
            format!(
                "{}\n{}\n",
                serde_json::json!({"event":"model.response","data":{"content":"working"}}),
                serde_json::json!({"event":"run.finished","data":{"receipt":{"status":"completed","summary":"verified"},"proof":"/tmp/receipt.json"}})
            ),
        )
        .unwrap();
        let event = final_event(&log).unwrap().unwrap();
        assert_eq!(event["data"]["receipt"]["summary"], "verified");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn log_tail_only_surfaces_user_facing_events() {
        let root = root();
        let log = root.join("output.jsonl");
        fs::write(
            &log,
            format!(
                "{}\n{}\n{}\n",
                serde_json::json!({"event":"run.started","data":{"goal":"build it"}}),
                serde_json::json!({"event":"internal.protocol","data":{"secret":"hidden"}}),
                serde_json::json!({"event":"run.finished","data":{"receipt":{"summary":"done"}}})
            ),
        )
        .unwrap();
        let output = tail(&log).unwrap();
        assert!(output.contains("START  build it"));
        assert!(output.contains("DONE   done"));
        assert!(!output.contains("hidden"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn job_ids_cannot_escape_runtime() {
        assert!(validate_id("deadbeef").is_ok());
        assert!(validate_id("../job").is_err());
        assert!(validate_id("too-long-job-id").is_err());
    }
}
