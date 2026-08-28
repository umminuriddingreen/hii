use crate::{clock::unix_ms, config::AppPaths};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

const CRON_MARKER: &str = "# HII_SCHEDULE_DISPATCHER";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LocalSchedule {
    pub id: String,
    pub cron: String,
    pub task: String,
    pub enabled: bool,
    #[serde(default)]
    pub workspace: Option<PathBuf>,
    pub created_at: DateTime<Local>,
}

pub struct ScheduleService {
    paths: AppPaths,
    state: PathBuf,
    events: PathBuf,
}

impl ScheduleService {
    pub fn new(paths: &AppPaths) -> Result<Self, String> {
        let dir = paths.runtime.join("schedules");
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        Ok(Self {
            paths: paths.clone(),
            state: dir.join("schedules.json"),
            events: dir.join("events.jsonl"),
        })
    }

    pub fn add(&self, cron: &str, task: &str, workspace: &Path) -> Result<String, String> {
        Cron::parse(cron)?;
        if task.trim().is_empty() {
            return Err("schedule task cannot be empty".into());
        }
        let mut schedules = self.read()?;
        let item = LocalSchedule {
            id: format!("sched-{:x}", unix_ms()),
            cron: cron.trim().into(),
            task: task.trim().into(),
            enabled: true,
            workspace: Some(workspace.to_path_buf()),
            created_at: Local::now(),
        };
        schedules.push(item.clone());
        self.write(&schedules)?;
        self.install_dispatcher()?;
        self.event("schedule.created", json!({"schedule": item}))?;
        let next = next_run(&item.cron, Local::now())?;
        Ok(format!(
            "Created {}\n{}\nNext run: {}",
            item.id,
            item.task,
            next.format("%a %b %-d at %-I:%M %p")
        ))
    }

    pub fn list(&self) -> Result<String, String> {
        let schedules = self.read()?;
        if schedules.is_empty() {
            return Ok("No HII schedules yet.".into());
        }
        schedules
            .iter()
            .map(|item| {
                let next = next_run(&item.cron, Local::now())
                    .map(|date| date.format("%b %-d %-I:%M %p").to_string())
                    .unwrap_or_else(|_| "invalid".into());
                format!(
                    "{}  {}  {}  [{}]  next {}",
                    item.id,
                    if item.enabled {
                        item.cron.as_str()
                    } else {
                        "disabled"
                    },
                    item.task,
                    item.workspace
                        .as_deref()
                        .unwrap_or(&self.paths.repo)
                        .display(),
                    next
                )
            })
            .collect::<Vec<_>>()
            .pipe(|rows| Ok(rows.join("\n")))
    }

    pub fn tick(&self) -> Result<String, String> {
        let now = Local::now();
        let minute_key = now.format("%Y-%m-%dT%H:%M").to_string();
        let mut fired = 0usize;
        for item in self.read()?.into_iter().filter(|item| item.enabled) {
            if !Cron::parse(&item.cron)?.matches(now)
                || self.already_fired(&item.id, &minute_key)?
            {
                continue;
            }
            let workspace = item.workspace.as_deref().unwrap_or(&self.paths.repo);
            let output = Command::new(std::env::current_exe().map_err(|error| error.to_string())?)
                .args(["--cwd", &workspace.display().to_string(), "run", &item.task])
                .current_dir(workspace)
                .output()
                .map_err(|error| error.to_string())?;
            self.event(
                "schedule.fired",
                json!({
                    "id": item.id,
                    "minute": minute_key,
                    "ok": output.status.success(),
                    "workspace": workspace,
                    "output": String::from_utf8_lossy(&output.stdout).trim(),
                    "error": String::from_utf8_lossy(&output.stderr).trim()
                }),
            )?;
            fired += 1;
        }
        Ok(format!("{fired} schedule(s) fired"))
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<String, String> {
        let mut schedules = self.read()?;
        let item = schedules
            .iter_mut()
            .find(|item| item.id.starts_with(id))
            .ok_or_else(|| format!("schedule not found: {id}"))?;
        item.enabled = enabled;
        let item = item.clone();
        self.write(&schedules)?;
        self.event(
            if enabled {
                "schedule.resumed"
            } else {
                "schedule.paused"
            },
            json!({"schedule": item}),
        )?;
        Ok(format!(
            "{} {}",
            if enabled { "Resumed" } else { "Paused" },
            item.id
        ))
    }

    pub fn remove(&self, id: &str) -> Result<String, String> {
        let mut schedules = self.read()?;
        let matches = schedules
            .iter()
            .filter(|item| item.id.starts_with(id))
            .count();
        if matches != 1 {
            return Err(if matches == 0 {
                format!("schedule not found: {id}")
            } else {
                format!("schedule id is ambiguous: {id}")
            });
        }
        let index = schedules
            .iter()
            .position(|item| item.id.starts_with(id))
            .expect("one matching schedule");
        let item = schedules.remove(index);
        self.write(&schedules)?;
        self.event("schedule.removed", json!({"schedule": item}))?;
        Ok(format!("Removed {}", item.id))
    }

    pub fn calendar_list(&self, days: i64) -> Result<String, String> {
        let script =
            Path::new("/Users/ummi/.codex/skills/apple-notes-calendar/scripts/calendar_events.py");
        if !script.is_file() {
            return Err("Apple Calendar reader is not installed".into());
        }
        let start = Local::now().date_naive();
        let end = start + Duration::days(days.max(1));
        let output = Command::new("python3")
            .arg(script)
            .args([
                "--start",
                &start.to_string(),
                "--end",
                &end.to_string(),
                "--pretty",
            ])
            .output()
            .map_err(|error| format!("could not read Apple Calendar: {error}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let value: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("invalid Calendar output: {error}"))?;
        let events = value
            .as_array()
            .cloned()
            .or_else(|| value.get("events").and_then(|v| v.as_array()).cloned())
            .unwrap_or_default();
        if events.is_empty() {
            return Ok(format!("No Apple Calendar events in the next {days} days."));
        }
        Ok(events
            .iter()
            .take(40)
            .map(|event| {
                let title = event
                    .get("title")
                    .or_else(|| event.get("summary"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Untitled");
                let start = event
                    .get("start")
                    .or_else(|| event.get("start_date"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let calendar = event
                    .get("calendar")
                    .or_else(|| event.get("calendar_name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                format!("{start}  {title}  {calendar}").trim().to_string()
            })
            .collect::<Vec<_>>()
            .join("\n"))
    }

    pub fn calendar_add(
        &self,
        date: &str,
        time: Option<&str>,
        title: &str,
    ) -> Result<String, String> {
        let (start, end, all_day) = event_times(date, time)?;
        self.write_calendar_event(title, start, end, all_day, None)?;
        self.event(
            "calendar.created",
            json!({"title": title, "start": start, "all_day": all_day}),
        )?;
        Ok(format!(
            "Added to Apple Calendar: {title}\n{}",
            if all_day {
                date.to_string()
            } else {
                start.format("%a %b %-d at %-I:%M %p").to_string()
            }
        ))
    }

    pub fn sync_calendar(&self) -> Result<String, String> {
        let mut count = 0usize;
        for item in self.read()?.into_iter().filter(|item| item.enabled) {
            let start = next_run(&item.cron, Local::now())?;
            let end = start + Duration::minutes(30);
            self.write_calendar_event(
                &item.task,
                start,
                end,
                false,
                Some(&format!("hii://schedule/{}", item.id)),
            )?;
            count += 1;
        }
        self.event("calendar.synced", json!({"schedules": count}))?;
        Ok(format!(
            "Synced {count} next HII schedule event(s) to Apple Calendar."
        ))
    }

    fn write_calendar_event(
        &self,
        title: &str,
        start: DateTime<Local>,
        end: DateTime<Local>,
        all_day: bool,
        url: Option<&str>,
    ) -> Result<(), String> {
        let script = r#"
ObjC.import('stdlib');
const title = ObjC.unwrap($.getenv('HII_CAL_TITLE'));
const start = ObjC.unwrap($.getenv('HII_CAL_START'));
const end = ObjC.unwrap($.getenv('HII_CAL_END'));
const url = ObjC.unwrap($.getenv('HII_CAL_URL'));
const allDay = ObjC.unwrap($.getenv('HII_CAL_ALL_DAY')) === '1';
const app = Application('Calendar');
const calendars = app.calendars();
const calendar = calendars.find((item) => { try { return item.writable(); } catch (_) { return false; } });
if (!calendar) throw new Error('No writable Apple Calendar is available');
let event = null;
if (url) {
  const matches = calendar.events.whose({url: {_eq: url}})();
  if (matches.length) event = matches[0];
}
if (!event) {
  event = app.Event({summary: title, startDate: new Date(start), endDate: new Date(end), alldayEvent: allDay, url: url});
  calendar.events.push(event);
} else {
  event.summary = title;
  event.startDate = new Date(start);
  event.endDate = new Date(end);
  event.alldayEvent = allDay;
}
JSON.stringify({ok: true, id: event.uid()});
"#;
        let output = Command::new("osascript")
            .args(["-l", "JavaScript", "-e", script])
            .env("HII_CAL_TITLE", title)
            .env("HII_CAL_START", start.to_rfc3339())
            .env("HII_CAL_END", end.to_rfc3339())
            .env("HII_CAL_URL", url.unwrap_or(""))
            .env("HII_CAL_ALL_DAY", if all_day { "1" } else { "0" })
            .output()
            .map_err(|error| format!("could not open Apple Calendar: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }

    fn read(&self) -> Result<Vec<LocalSchedule>, String> {
        if !self.state.is_file() {
            return Ok(Vec::new());
        }
        serde_json::from_slice(&fs::read(&self.state).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())
    }

    fn write(&self, schedules: &[LocalSchedule]) -> Result<(), String> {
        fs::write(
            &self.state,
            serde_json::to_vec_pretty(schedules).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())
    }

    fn event(&self, kind: &str, data: serde_json::Value) -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.events)
            .map_err(|error| error.to_string())?;
        serde_json::to_writer(
            &mut file,
            &json!({"ts": Local::now(), "kind": kind, "data": data}),
        )
        .map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())
    }

    fn already_fired(&self, id: &str, minute: &str) -> Result<bool, String> {
        let raw = fs::read_to_string(&self.events).unwrap_or_default();
        Ok(raw.lines().rev().take(500).any(|line| {
            line.contains(id) && line.contains(minute) && line.contains("schedule.fired")
        }))
    }

    fn install_dispatcher(&self) -> Result<(), String> {
        let current = Command::new("crontab")
            .arg("-l")
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).to_string())
            .unwrap_or_default();
        if current.lines().any(|line| line.contains(CRON_MARKER)) {
            return Ok(());
        }
        let line = format!("* * * * * /Users/ummi/bin/hii schedule tick >> {}/schedules/cron.log 2>&1 {CRON_MARKER}", self.paths.runtime.display());
        let content = format!(
            "{}{}\n",
            current.trim_end(),
            if current.trim().is_empty() {
                line
            } else {
                format!("\n{line}")
            }
        );
        let mut child = Command::new("crontab")
            .arg("-")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?;
        child
            .stdin
            .as_mut()
            .ok_or("could not open crontab input")?
            .write_all(content.as_bytes())
            .map_err(|error| error.to_string())?;
        let status = child.wait().map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("crontab rejected the HII dispatcher".into())
        }
    }
}

fn event_times(
    date: &str,
    time: Option<&str>,
) -> Result<(DateTime<Local>, DateTime<Local>, bool), String> {
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| "date must be YYYY-MM-DD".to_string())?;
    let (naive, all_day) = match time {
        Some(time) => (
            NaiveDateTime::parse_from_str(&format!("{date} {time}"), "%Y-%m-%d %H:%M")
                .map_err(|_| "time must be HH:MM".to_string())?,
            false,
        ),
        None => (date.and_hms_opt(0, 0, 0).unwrap(), true),
    };
    let start = Local
        .from_local_datetime(&naive)
        .single()
        .ok_or("that local time is ambiguous")?;
    Ok((
        start,
        start
            + if all_day {
                Duration::days(1)
            } else {
                Duration::hours(1)
            },
        all_day,
    ))
}

fn next_run(expression: &str, after: DateTime<Local>) -> Result<DateTime<Local>, String> {
    let cron = Cron::parse(expression)?;
    let mut candidate = after + Duration::minutes(1);
    candidate = candidate
        .with_second(0)
        .unwrap()
        .with_nanosecond(0)
        .unwrap();
    for _ in 0..527_040 {
        if cron.matches(candidate) {
            return Ok(candidate);
        }
        candidate += Duration::minutes(1);
    }
    Err("schedule has no run in the next year".into())
}

struct Cron {
    fields: [HashSet<u32>; 5],
}

impl Cron {
    fn parse(input: &str) -> Result<Self, String> {
        let parts = input.split_whitespace().collect::<Vec<_>>();
        if parts.len() != 5 {
            return Err("cron must have five fields: minute hour day month weekday".into());
        }
        Ok(Self {
            fields: [
                parse_field(parts[0], 0, 59)?,
                parse_field(parts[1], 0, 23)?,
                parse_field(parts[2], 1, 31)?,
                parse_field(parts[3], 1, 12)?,
                parse_field(parts[4], 0, 6)?,
            ],
        })
    }
    fn matches(&self, at: DateTime<Local>) -> bool {
        self.fields[0].contains(&at.minute())
            && self.fields[1].contains(&at.hour())
            && self.fields[2].contains(&at.day())
            && self.fields[3].contains(&at.month())
            && self.fields[4].contains(&at.weekday().num_days_from_sunday())
    }
}

fn parse_field(input: &str, min: u32, max: u32) -> Result<HashSet<u32>, String> {
    let mut values = HashSet::new();
    for part in input.split(',') {
        let (base, step) = part
            .split_once('/')
            .map(|(a, b)| (a, b.parse::<u32>().ok()))
            .unwrap_or((part, Some(1)));
        let step = step
            .filter(|v| *v > 0)
            .ok_or_else(|| format!("invalid cron step: {part}"))?;
        let (start, end) = if base == "*" {
            (min, max)
        } else if let Some((a, b)) = base.split_once('-') {
            (
                a.parse()
                    .map_err(|_| format!("invalid cron field: {part}"))?,
                b.parse()
                    .map_err(|_| format!("invalid cron field: {part}"))?,
            )
        } else {
            let value = base
                .parse()
                .map_err(|_| format!("invalid cron field: {part}"))?;
            (value, value)
        };
        if start < min || end > max || start > end {
            return Err(format!("cron field out of range: {part}"));
        }
        values.extend((start..=end).step_by(step as usize));
    }
    Ok(values)
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    #[test]
    fn parses_standard_cron() {
        assert!(Cron::parse("*/15 9-17 * * 1-5").is_ok());
    }
    #[test]
    fn rejects_bad_cron() {
        assert!(Cron::parse("every day").is_err());
    }

    #[test]
    fn recurring_tasks_keep_workspace_and_support_pause_resume_remove() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("hii-schedule-{}-{nonce}", std::process::id()));
        let runtime = root.join("runtime");
        let repo = root.join("repo");
        fs::create_dir_all(&repo).expect("repo");
        let service = ScheduleService::new(&AppPaths {
            repo: repo.clone(),
            runtime: runtime.clone(),
        })
        .expect("service");
        service
            .write(&[LocalSchedule {
                id: "sched-test".into(),
                cron: "0 9 * * *".into(),
                task: "review goals".into(),
                enabled: true,
                workspace: Some(repo.clone()),
                created_at: Local::now(),
            }])
            .expect("seed");

        service.set_enabled("sched-t", false).expect("pause");
        let paused = service.read().expect("read paused");
        assert!(!paused[0].enabled);
        assert_eq!(paused[0].workspace.as_deref(), Some(repo.as_path()));
        service.set_enabled("sched-t", true).expect("resume");
        service.remove("sched-t").expect("remove");
        assert!(service.read().expect("read removed").is_empty());
        fs::remove_dir_all(root).expect("cleanup");
    }
}
