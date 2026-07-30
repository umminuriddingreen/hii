use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

use crate::receipt::{redact_text, unix_ms};

pub const LANES: &[&str] = &["backlog", "next", "doing", "blocked", "done"];
pub const PRIORITIES: &[&str] = &["low", "normal", "high", "urgent"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub lane: String,
    pub priority: String,
    pub owner: String,
    pub coordinate: String,
    pub notes: String,
    #[serde(default, rename = "acceptanceCriteria")]
    pub acceptance_criteria: Vec<String>,
    pub tags: Vec<String>,
    pub source: String,
    pub origin: Option<String>,
    #[serde(rename = "reviewState")]
    pub review_state: Option<String>,
    #[serde(rename = "requestedLane")]
    pub requested_lane: Option<String>,
    #[serde(rename = "approvedAt")]
    pub approved_at: Option<String>,
    #[serde(rename = "approvedBy")]
    pub approved_by: Option<String>,
    #[serde(rename = "runId")]
    pub run_id: Option<String>,
    #[serde(rename = "runStatus")]
    pub run_status: Option<String>,
    #[serde(rename = "receiptRef")]
    pub receipt_ref: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "completedAt", skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

pub struct Board {
    store: PathBuf,
}

#[derive(Default)]
pub struct EditPatch {
    pub lane: Option<String>,
    pub title: Option<String>,
    pub priority: Option<String>,
    pub owner: Option<String>,
    pub coordinate: Option<String>,
    pub notes: Option<String>,
    pub acceptance_criteria: Option<Vec<String>>,
    pub tags: Option<String>,
    pub review_state: Option<String>,
    pub approved_by: Option<String>,
}

pub struct AddOptions {
    pub title: String,
    pub lane: Option<String>,
    pub priority: Option<String>,
    pub owner: Option<String>,
    pub coordinate: Option<String>,
    pub notes: Option<String>,
    pub tags: Option<String>,
}

impl Board {
    pub fn open(runtime: &Path) -> Self {
        Self {
            store: runtime.join("board").join("tasks.jsonl"),
        }
    }

    pub fn store_path(&self) -> &Path {
        &self.store
    }

    fn events(&self) -> Result<Vec<Value>, String> {
        if !self.store.is_file() {
            return Ok(Vec::new());
        }
        let file = fs::File::open(&self.store).map_err(|error| error.to_string())?;
        BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(&line).map_err(|error| error.to_string()))
            .collect()
    }

    fn append(&self, event: Value) -> Result<(), String> {
        if let Some(parent) = self.store.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.store)
            .map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut file, &event).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())
    }

    pub fn tasks(&self, include_done: bool) -> Result<Vec<Task>, String> {
        let mut order: Vec<String> = Vec::new();
        let mut byid: std::collections::HashMap<String, Task> = std::collections::HashMap::new();
        for event in self.events()? {
            let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
            if kind == "created" {
                if let Some(task) = event.get("task") {
                    if let Ok(task) = serde_json::from_value::<Task>(task.clone()) {
                        if !byid.contains_key(&task.id) {
                            order.push(task.id.clone());
                        }
                        byid.insert(task.id.clone(), task);
                    }
                }
            } else if kind == "updated" {
                let id = event.get("id").and_then(Value::as_str).unwrap_or("");
                if let Some(existing) = byid.get_mut(id) {
                    if let Some(patch) = event.get("patch").and_then(Value::as_object) {
                        apply_patch(existing, patch);
                    }
                }
            }
        }
        let mut tasks: Vec<Task> = order
            .into_iter()
            .filter_map(|id| byid.remove(&id))
            .filter(|task| include_done || task.lane != "done")
            .collect();
        tasks.sort_by(|a, b| {
            let lane_a = LANES.iter().position(|lane| *lane == a.lane).unwrap_or(0);
            let lane_b = LANES.iter().position(|lane| *lane == b.lane).unwrap_or(0);
            if lane_a != lane_b {
                return lane_a.cmp(&lane_b);
            }
            let prio_a = PRIORITIES
                .iter()
                .position(|priority| *priority == a.priority)
                .unwrap_or(0);
            let prio_b = PRIORITIES
                .iter()
                .position(|priority| *priority == b.priority)
                .unwrap_or(0);
            if prio_a != prio_b {
                return prio_b.cmp(&prio_a);
            }
            b.updated_at.cmp(&a.updated_at)
        });
        Ok(tasks)
    }

    pub fn add(&self, root: &Path, options: AddOptions) -> Result<Task, String> {
        let title = redact_text(&options.title).trim().to_string();
        if title.chars().count() < 2 {
            return Err(
                "usage: hii board add <title> [--lane backlog|next|doing|blocked|done] [--priority low|normal|high|urgent]"
                    .to_string(),
            );
        }
        if is_command_flag(&title) {
            return Err("Use an outcome-focused task title instead of a command flag.".to_string());
        }
        let now = iso_now();
        let coordinate = truncate_chars(
            redact_text(
                options
                    .coordinate
                    .as_deref()
                    .unwrap_or(&root.display().to_string()),
            )
            .trim(),
            240,
        );
        let key = task_key(&title, &coordinate);
        if let Some(existing) = self
            .tasks(false)?
            .into_iter()
            .find(|task| task_key(&task.title, &task.coordinate) == key)
        {
            return Err(format!(
                "An open task already covers this outcome: {} {}",
                &existing.id[..8.min(existing.id.len())],
                existing.title
            ));
        }
        let task = Task {
            id: Uuid::new_v4().to_string(),
            title: truncate_chars(&title, 240),
            lane: normalize(options.lane.as_deref(), LANES, "backlog"),
            priority: normalize(options.priority.as_deref(), PRIORITIES, "normal"),
            owner: truncate_chars(
                redact_text(options.owner.as_deref().unwrap_or("main agent")).trim(),
                80,
            ),
            coordinate,
            notes: truncate_chars(
                redact_text(options.notes.as_deref().unwrap_or("")).trim(),
                2000,
            ),
            acceptance_criteria: Vec::new(),
            tags: parse_csv_tags(options.tags.as_deref().unwrap_or("")),
            source: "hii board".to_string(),
            origin: Some("human".to_string()),
            review_state: Some("approved".to_string()),
            requested_lane: None,
            approved_at: Some(now.clone()),
            approved_by: Some("local operator".to_string()),
            run_id: None,
            run_status: None,
            receipt_ref: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            completed_at: None,
        };
        self.append(serde_json::json!({
            "type": "created",
            "task": task,
            "ts": now
        }))?;
        Ok(task)
    }

    fn find_one(&self, id_prefix: &str) -> Result<Task, String> {
        let matches: Vec<Task> = self
            .tasks(true)?
            .into_iter()
            .filter(|task| task.id.starts_with(id_prefix))
            .collect();
        match matches.len() {
            0 => Err(format!("task not found: {id_prefix}")),
            1 => Ok(matches.into_iter().next().unwrap()),
            _ => {
                let mut message = format!("task id is ambiguous: {id_prefix}\n");
                for task in matches.iter().take(8) {
                    message.push_str(&format!("  {} {}\n", &task.id[..8], task.title));
                }
                Err(message.trim_end().to_string())
            }
        }
    }

    pub fn update(&self, id_prefix: &str, patch: EditPatch) -> Result<Task, String> {
        let task = self.find_one(id_prefix)?;
        let now = iso_now();
        let mut event = serde_json::json!({});
        let approval_requested = patch.review_state.as_deref() == Some("approved");
        if let Some(lane) = &patch.lane {
            let lane = normalize(Some(lane.as_str()), LANES, "backlog");
            if ["next", "doing"].contains(&lane.as_str())
                && task.review_state.as_deref() == Some("proposed")
                && !approval_requested
            {
                return Err("Approve this proposal before moving it into active work.".to_string());
            }
            if lane == "done"
                && task.run_id.is_some()
                && (task.run_status.as_deref() != Some("completed") || task.receipt_ref.is_none())
            {
                return Err(
                    "A run-linked task needs completed status and a receipt before entering done."
                        .to_string(),
                );
            }
            if lane != task.lane {
                event["lane"] = Value::String(lane.clone());
                if lane == "done" {
                    event["completedAt"] = Value::String(now.clone());
                }
            }
        }
        if let Some(title) = &patch.title {
            let clean = truncate_chars(redact_text(title).trim(), 240);
            if !clean.is_empty() && clean != task.title {
                event["title"] = Value::String(clean);
            }
        }
        if let Some(priority) = &patch.priority {
            let priority = normalize(Some(priority.as_str()), PRIORITIES, "normal");
            if priority != task.priority {
                event["priority"] = Value::String(priority);
            }
        }
        if let Some(owner) = &patch.owner {
            let clean = truncate_chars(redact_text(owner).trim(), 80);
            let owner = if clean.is_empty() {
                task.owner.clone()
            } else {
                clean
            };
            if owner != task.owner {
                event["owner"] = Value::String(owner);
            }
        }
        if let Some(coordinate) = &patch.coordinate {
            let clean = truncate_chars(redact_text(coordinate).trim(), 240);
            let coordinate = if clean.is_empty() {
                task.coordinate.clone()
            } else {
                clean
            };
            if coordinate != task.coordinate {
                event["coordinate"] = Value::String(coordinate);
            }
        }
        if let Some(notes) = &patch.notes {
            let notes = truncate_chars(redact_text(notes).trim(), 2000);
            if notes != task.notes {
                event["notes"] = Value::String(notes);
            }
        }
        if let Some(criteria) = &patch.acceptance_criteria {
            let criteria = normalize_acceptance(criteria);
            if criteria != task.acceptance_criteria {
                event["acceptanceCriteria"] = serde_json::to_value(criteria).unwrap();
            }
        }
        if let Some(tags) = &patch.tags {
            let tags = parse_csv_tags(tags);
            if tags != task.tags {
                event["tags"] = serde_json::to_value(tags).unwrap();
            }
        }
        if approval_requested && task.review_state.as_deref() != Some("approved") {
            let mut candidate = task.clone();
            if let Some(map) = event.as_object() {
                apply_patch(&mut candidate, map);
            }
            let issues = proposal_quality_issues(&candidate);
            if !issues.is_empty() {
                return Err(format!(
                    "Define this proposal before approval: {}",
                    issues.join(" ")
                ));
            }
            event["reviewState"] = Value::String("approved".to_string());
            event["approvedAt"] = Value::String(now.clone());
            event["approvedBy"] = Value::String(truncate_chars(
                redact_text(patch.approved_by.as_deref().unwrap_or("local operator")).trim(),
                80,
            ));
        }
        if event
            .as_object()
            .map(|value| value.is_empty())
            .unwrap_or(true)
        {
            return Ok(task);
        }
        event["updatedAt"] = Value::String(now.clone());
        self.append(serde_json::json!({
            "type": "updated",
            "id": task.id,
            "patch": event,
            "ts": now
        }))?;
        let mut updated = task;
        if let Some(map) = event.as_object() {
            apply_patch(&mut updated, map);
        }
        Ok(updated)
    }

    pub fn approve(&self, id_prefix: &str, lane: Option<String>) -> Result<Task, String> {
        let task = self.find_one(id_prefix)?;
        let target = lane
            .or(task.requested_lane.clone())
            .unwrap_or_else(|| "next".to_string());
        self.update(
            &task.id,
            EditPatch {
                lane: Some(target),
                review_state: Some("approved".to_string()),
                approved_by: Some("local operator".to_string()),
                ..Default::default()
            },
        )
    }

    pub fn dedupe(&self, dry_run: bool) -> Result<Vec<(Task, Task)>, String> {
        let mut groups: std::collections::HashMap<String, Vec<Task>> =
            std::collections::HashMap::new();
        let mut order: Vec<String> = Vec::new();
        for task in self.tasks(false)? {
            let key = dedupe_key(&task);
            if !groups.contains_key(&key) {
                order.push(key.clone());
            }
            groups.entry(key).or_default().push(task);
        }
        let mut reconciled = Vec::new();
        for key in order {
            let mut group = groups.remove(&key).unwrap_or_default();
            if group.len() < 2 {
                continue;
            }
            group.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            let keep = group[0].clone();
            for duplicate in &group[1..] {
                if !dry_run {
                    let note = format!(
                        "Archived duplicate of {} during append-only board reconciliation.",
                        &keep.id[..8.min(keep.id.len())]
                    );
                    let notes = [duplicate.notes.as_str(), note.as_str()]
                        .into_iter()
                        .filter(|value| !value.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n");
                    let notes = truncate_chars(&notes, 2000);
                    self.update(
                        &duplicate.id,
                        EditPatch {
                            lane: Some("done".to_string()),
                            notes: Some(notes),
                            ..Default::default()
                        },
                    )?;
                }
                reconciled.push((duplicate.clone(), keep.clone()));
            }
        }
        Ok(reconciled)
    }
}

fn apply_patch(task: &mut Task, patch: &serde_json::Map<String, Value>) {
    if let Some(lane) = patch.get("lane").and_then(Value::as_str) {
        task.lane = lane.to_string();
    }
    if let Some(title) = patch.get("title").and_then(Value::as_str) {
        task.title = title.to_string();
    }
    if let Some(priority) = patch.get("priority").and_then(Value::as_str) {
        task.priority = priority.to_string();
    }
    if let Some(owner) = patch.get("owner").and_then(Value::as_str) {
        task.owner = owner.to_string();
    }
    if let Some(coordinate) = patch.get("coordinate").and_then(Value::as_str) {
        task.coordinate = coordinate.to_string();
    }
    if let Some(notes) = patch.get("notes").and_then(Value::as_str) {
        task.notes = notes.to_string();
    }
    if let Some(criteria) = patch.get("acceptanceCriteria").and_then(Value::as_array) {
        task.acceptance_criteria = criteria
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
    }
    if let Some(tags) = patch.get("tags").and_then(Value::as_array) {
        task.tags = tags
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
    }
    if let Some(review_state) = patch.get("reviewState").and_then(Value::as_str) {
        task.review_state = Some(review_state.to_string());
    }
    if let Some(approved_at) = patch.get("approvedAt").and_then(Value::as_str) {
        task.approved_at = Some(approved_at.to_string());
    }
    if let Some(approved_by) = patch.get("approvedBy").and_then(Value::as_str) {
        task.approved_by = Some(approved_by.to_string());
    }
    if let Some(run_id) = patch.get("runId").and_then(Value::as_str) {
        task.run_id = Some(run_id.to_string());
    }
    if let Some(run_status) = patch.get("runStatus").and_then(Value::as_str) {
        task.run_status = Some(run_status.to_string());
    }
    if let Some(receipt_ref) = patch.get("receiptRef").and_then(Value::as_str) {
        task.receipt_ref = Some(receipt_ref.to_string());
    }
    if let Some(updated_at) = patch.get("updatedAt").and_then(Value::as_str) {
        task.updated_at = updated_at.to_string();
    }
    if let Some(completed_at) = patch.get("completedAt").and_then(Value::as_str) {
        task.completed_at = Some(completed_at.to_string());
    }
}

fn dedupe_key(task: &Task) -> String {
    [&task.title, &task.coordinate]
        .iter()
        .map(|value| {
            value
                .trim()
                .to_lowercase()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\u{0}")
}

fn task_key(title: &str, coordinate: &str) -> String {
    [title, coordinate]
        .iter()
        .map(|value| {
            value
                .trim()
                .to_lowercase()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\u{0}")
}

fn is_command_flag(title: &str) -> bool {
    let value = title.trim();
    value.starts_with('-')
        && !value.contains(char::is_whitespace)
        && value
            .trim_start_matches('-')
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, '_' | '-'))
}

fn normalize(value: Option<&str>, allowed: &[&str], fallback: &str) -> String {
    match value {
        Some(value) if allowed.contains(&value) => value.to_string(),
        _ => fallback.to_string(),
    }
}

fn normalize_acceptance(values: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        let criterion = truncate_chars(redact_text(value).trim(), 240);
        if !criterion.is_empty() && !out.contains(&criterion) {
            out.push(criterion);
        }
        if out.len() == 8 {
            break;
        }
    }
    out
}

fn proposal_quality_issues(task: &Task) -> Vec<String> {
    if task.origin.as_deref() == Some("human") {
        return Vec::new();
    }
    let mut issues = Vec::new();
    let title = task.title.trim();
    let vague = matches!(
        title.to_lowercase().as_str(),
        "review"
            | "fix"
            | "improve"
            | "update"
            | "task"
            | "todo"
            | "tbd"
            | "do this"
            | "work on it"
    );
    if title.split_whitespace().count() < 2 || vague {
        issues.push("Name a bounded outcome, not a vague activity.".to_string());
    }
    if task.notes.trim().chars().count() < 20 {
        issues.push("Explain why this work matters and what context it uses.".to_string());
    }
    if normalize_acceptance(&task.acceptance_criteria).is_empty() {
        issues.push("Add at least one concrete “done when” criterion.".to_string());
    }
    issues
}

fn parse_csv_tags(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .take(12)
        .map(str::to_string)
        .collect()
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn iso_now() -> String {
    let millis = unix_ms();
    chrono::DateTime::from_timestamp_millis(millis as i64)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

pub fn print_board(store: &Path, tasks: &[Task], include_done: bool) {
    println!("HII Board\n");
    println!("store: {}", store.display());
    println!(
        "open:  {}",
        tasks.iter().filter(|task| task.lane != "done").count()
    );
    if include_done {
        println!("done:  included");
    }
    println!();
    for lane in LANES {
        if !include_done && *lane == "done" {
            continue;
        }
        let lane_tasks: Vec<&Task> = tasks.iter().filter(|task| task.lane == *lane).collect();
        println!("{lane} ({})", lane_tasks.len());
        if lane_tasks.is_empty() {
            println!("  -");
            continue;
        }
        for task in lane_tasks {
            let tags = if task.tags.is_empty() {
                String::new()
            } else {
                format!(" #{}", task.tags.join(" #"))
            };
            let review = if task.review_state.as_deref() == Some("proposed") {
                " [proposal]"
            } else {
                ""
            };
            println!(
                "  {}  [{}]{} {}{}",
                &task.id[..8.min(task.id.len())],
                task.priority,
                review,
                task.title,
                tags
            );
            println!(
                "      owner: {}  origin: {}  coordinate: {}",
                task.owner,
                task.origin.as_deref().unwrap_or("legacy"),
                task.coordinate
            );
            if task.review_state.as_deref() == Some("proposed") {
                let issues = proposal_quality_issues(task);
                println!(
                    "      approval: required  requested: {}",
                    task.requested_lane.as_deref().unwrap_or("review")
                );
                println!(
                    "      definition: {}",
                    if issues.is_empty() {
                        "ready".to_string()
                    } else {
                        format!("needs {}", issues.join(" "))
                    }
                );
            }
            for criterion in &task.acceptance_criteria {
                println!("      done when: {criterion}");
            }
            if let Some(run_status) = &task.run_status {
                println!(
                    "      run: {}  id: {}  receipt: {}",
                    run_status,
                    task.run_id.as_deref().unwrap_or("pending"),
                    if task.receipt_ref.is_some() {
                        "linked"
                    } else {
                        "pending"
                    }
                );
            }
            if !task.notes.is_empty() {
                let notes: String = task.notes.chars().take(180).collect();
                println!("      notes: {notes}");
            }
        }
        println!();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env, process,
        sync::atomic::{AtomicU64, Ordering},
        time::SystemTime,
        time::UNIX_EPOCH,
    };

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempRuntime(PathBuf);

    impl TempRuntime {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after the Unix epoch")
                .as_nanos();
            let count = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path =
                env::temp_dir().join(format!("hii-board-test-{}-{nonce}-{count}", process::id()));
            fs::create_dir_all(&path).expect("create temp runtime dir");
            Self(path)
        }
    }

    impl Drop for TempRuntime {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn add_defaults_to_backlog_and_normal_priority() {
        let runtime = TempRuntime::new();
        let board = Board::open(&runtime.0);
        let task = board
            .add(
                Path::new("/tmp/root"),
                AddOptions {
                    title: "write the parity tests".into(),
                    lane: None,
                    priority: None,
                    owner: None,
                    coordinate: None,
                    notes: None,
                    tags: None,
                },
            )
            .expect("add should succeed");
        assert_eq!(task.lane, "backlog");
        assert_eq!(task.priority, "normal");
        assert_eq!(task.owner, "main agent");
    }

    #[test]
    fn add_rejects_titles_under_two_characters() {
        let runtime = TempRuntime::new();
        let board = Board::open(&runtime.0);
        let error = board
            .add(
                Path::new("/tmp/root"),
                AddOptions {
                    title: "x".into(),
                    lane: None,
                    priority: None,
                    owner: None,
                    coordinate: None,
                    notes: None,
                    tags: None,
                },
            )
            .unwrap_err();
        assert!(error.starts_with("usage: hii board add"));
    }

    #[test]
    fn move_updates_lane_and_stamps_completed_at() {
        let runtime = TempRuntime::new();
        let board = Board::open(&runtime.0);
        let task = board
            .add(
                Path::new("/tmp/root"),
                AddOptions {
                    title: "ship the migration".into(),
                    lane: None,
                    priority: None,
                    owner: None,
                    coordinate: None,
                    notes: None,
                    tags: None,
                },
            )
            .unwrap();
        let moved = board
            .update(
                &task.id,
                EditPatch {
                    lane: Some("done".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(moved.lane, "done");
        assert!(moved.completed_at.is_some());
    }

    #[test]
    fn repeated_move_is_an_idempotent_ledger_noop() {
        let runtime = TempRuntime::new();
        let board = Board::open(&runtime.0);
        let task = board
            .add(
                Path::new("/tmp/root"),
                AddOptions {
                    title: "keep one board event".into(),
                    lane: None,
                    priority: None,
                    owner: None,
                    coordinate: None,
                    notes: None,
                    tags: None,
                },
            )
            .unwrap();
        let unchanged = board
            .update(
                &task.id,
                EditPatch {
                    lane: Some("backlog".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(unchanged.updated_at, task.updated_at);
        assert_eq!(board.events().unwrap().len(), 1);
    }

    #[test]
    fn run_linked_task_requires_completed_receipt_before_done() {
        let runtime = TempRuntime::new();
        let board = Board::open(&runtime.0);
        let task = board
            .add(
                Path::new("/tmp/root"),
                AddOptions {
                    title: "verify before done".into(),
                    lane: Some("doing".into()),
                    priority: None,
                    owner: None,
                    coordinate: None,
                    notes: None,
                    tags: None,
                },
            )
            .unwrap();
        board
            .append(serde_json::json!({
                "type": "updated",
                "id": task.id,
                "patch": {
                    "runId": "run-one",
                    "runStatus": "running",
                    "updatedAt": iso_now()
                },
                "ts": iso_now()
            }))
            .unwrap();

        let error = board
            .update(
                &task.id,
                EditPatch {
                    lane: Some("done".into()),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(error.contains("completed status and a receipt"));

        board
            .append(serde_json::json!({
                "type": "updated",
                "id": task.id,
                "patch": {
                    "runStatus": "completed",
                    "receiptRef": "/tmp/receipt.json",
                    "updatedAt": iso_now()
                },
                "ts": iso_now()
            }))
            .unwrap();
        let completed = board
            .update(
                &task.id,
                EditPatch {
                    lane: Some("done".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(completed.lane, "done");
    }

    #[test]
    fn list_excludes_done_lane_by_default() {
        let runtime = TempRuntime::new();
        let board = Board::open(&runtime.0);
        let task = board
            .add(
                Path::new("/tmp/root"),
                AddOptions {
                    title: "finish this".into(),
                    lane: None,
                    priority: None,
                    owner: None,
                    coordinate: None,
                    notes: None,
                    tags: None,
                },
            )
            .unwrap();
        board
            .update(
                &task.id,
                EditPatch {
                    lane: Some("done".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(board.tasks(false).unwrap().is_empty());
        assert_eq!(board.tasks(true).unwrap().len(), 1);
    }

    #[test]
    fn dedupe_keeps_first_and_marks_later_duplicates_done() {
        let runtime = TempRuntime::new();
        let board = Board::open(&runtime.0);
        let first = board
            .add(
                Path::new("/tmp/root"),
                AddOptions {
                    title: "dedupe me".into(),
                    lane: None,
                    priority: None,
                    owner: None,
                    coordinate: Some("/tmp/root".into()),
                    notes: None,
                    tags: None,
                },
            )
            .unwrap();
        let mut second = first.clone();
        second.id = Uuid::new_v4().to_string();
        second.updated_at = iso_now();
        board
            .append(serde_json::json!({
                "type": "created",
                "task": second,
                "ts": iso_now()
            }))
            .unwrap();
        let reconciled = board.dedupe(false).unwrap();
        assert_eq!(reconciled.len(), 1);
        // The most recently updated task in a duplicate group is kept, matching
        // the legacy Node CLI's `dedupeBoardTasks` ordering.
        let (duplicate, keep) = &reconciled[0];
        assert!(keep.updated_at >= duplicate.updated_at);
        assert!([first.id.clone(), second.id.clone()].contains(&keep.id));
        assert!([first.id, second.id].contains(&duplicate.id));
        assert_eq!(board.tasks(false).unwrap().len(), 1);
    }

    #[test]
    fn add_rejects_open_duplicates_before_append() {
        let runtime = TempRuntime::new();
        let board = Board::open(&runtime.0);
        let options = |owner: &str| AddOptions {
            title: "Verify the launch receipt".into(),
            lane: None,
            priority: None,
            owner: Some(owner.into()),
            coordinate: Some("/tmp/root".into()),
            notes: None,
            tags: None,
        };
        board
            .add(Path::new("/tmp/root"), options("operator"))
            .unwrap();
        let error = board
            .add(Path::new("/tmp/root"), options("another agent"))
            .unwrap_err();
        assert!(error.starts_with("An open task already covers this outcome:"));
        assert_eq!(board.tasks(false).unwrap().len(), 1);
    }

    #[test]
    fn proposal_requires_approval_before_active_lane() {
        let runtime = TempRuntime::new();
        let board = Board::open(&runtime.0);
        let task = Task {
            id: Uuid::new_v4().to_string(),
            title: "Compare launch clip variants".into(),
            lane: "backlog".into(),
            priority: "normal".into(),
            owner: "Opus".into(),
            coordinate: "/tmp/root".into(),
            notes: "Compare two launch variants against the verified product boundary.".into(),
            acceptance_criteria: vec![
                "One variant is selected with a receipt-linked rationale.".into()
            ],
            tags: Vec::new(),
            source: "api.board.tasks".into(),
            origin: Some("system".into()),
            review_state: Some("proposed".into()),
            requested_lane: Some("doing".into()),
            approved_at: None,
            approved_by: None,
            run_id: None,
            run_status: None,
            receipt_ref: None,
            created_at: iso_now(),
            updated_at: iso_now(),
            completed_at: None,
        };
        board
            .append(serde_json::json!({ "type": "created", "task": task, "ts": iso_now() }))
            .unwrap();

        let error = board
            .update(
                &task.id,
                EditPatch {
                    lane: Some("doing".into()),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert_eq!(
            error,
            "Approve this proposal before moving it into active work."
        );

        let approved = board.approve(&task.id, None).unwrap();
        assert_eq!(approved.lane, "doing");
        assert_eq!(approved.review_state.as_deref(), Some("approved"));
        assert!(approved.approved_at.is_some());
    }

    #[test]
    fn underdefined_proposal_requires_definition_before_approval() {
        let runtime = TempRuntime::new();
        let board = Board::open(&runtime.0);
        let task = Task {
            id: Uuid::new_v4().to_string(),
            title: "Improve launch receipt review".into(),
            lane: "backlog".into(),
            priority: "normal".into(),
            owner: "Agent".into(),
            coordinate: "/tmp/root".into(),
            notes: String::new(),
            acceptance_criteria: Vec::new(),
            tags: Vec::new(),
            source: "api.board.tasks".into(),
            origin: Some("agent".into()),
            review_state: Some("proposed".into()),
            requested_lane: Some("doing".into()),
            approved_at: None,
            approved_by: None,
            run_id: None,
            run_status: None,
            receipt_ref: None,
            created_at: iso_now(),
            updated_at: iso_now(),
            completed_at: None,
        };
        board
            .append(serde_json::json!({ "type": "created", "task": task, "ts": iso_now() }))
            .unwrap();

        let error = board.approve(&task.id, None).unwrap_err();
        assert!(error.starts_with("Define this proposal before approval:"));

        board
            .update(
                &task.id,
                EditPatch {
                    notes: Some("Make the receipt legible before this enters active work.".into()),
                    acceptance_criteria: Some(vec![
                        "The receipt names the artifact and one passing check.".into(),
                    ]),
                    ..Default::default()
                },
            )
            .unwrap();
        let approved = board.approve(&task.id, None).unwrap();
        assert_eq!(approved.lane, "doing");
        assert_eq!(approved.review_state.as_deref(), Some("approved"));
    }

    #[test]
    fn tags_are_parsed_from_csv_and_capped_at_twelve() {
        let runtime = TempRuntime::new();
        let board = Board::open(&runtime.0);
        let many_tags = (0..20)
            .map(|n| format!("t{n}"))
            .collect::<Vec<_>>()
            .join(",");
        let task = board
            .add(
                Path::new("/tmp/root"),
                AddOptions {
                    title: "tag test".into(),
                    lane: None,
                    priority: None,
                    owner: None,
                    coordinate: None,
                    notes: None,
                    tags: Some(many_tags),
                },
            )
            .unwrap();
        assert_eq!(task.tags.len(), 12);
        assert_eq!(task.tags[0], "t0");
    }
}
