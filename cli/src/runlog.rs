//! One place where anything that happens during a run is recorded.
//!
//! Before this module the loop wrote to three uncoordinated channels — the run
//! store (`events.jsonl`), the machine stream (`--jsonl` on stdout), and the
//! terminal (`crate::tui`) — and every call site had to remember all three. It
//! did not: the protocol-retry path emitted to stdout but never to the store, so
//! a malformed model action was invisible in the very artifact meant to explain
//! the run.
//!
//! [`Journal`] replaces all three. The store write happens inside `emit`, before
//! any presenter runs, so a recorded event cannot be skipped by construction.
//!
//! The stronger guarantee is [`Feedback`]: text handed back to the model can only
//! be produced by [`Journal::feedback`], which journals it on the way out. A
//! string the model saw is therefore always in `events.jsonl`.

use crate::receipt::{unix_ms, Receipt, RunStore};
use serde_json::{json, Value};
use std::{
    io::{self, IsTerminal, Write},
    path::Path,
};

/// How the run reports itself to the operator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputMode {
    Human { verbose: bool },
    Json,
    Jsonl,
    Quiet,
}

/// Whether step-by-step progress is shown while the run is still going.
///
/// `Auto` preserves the historical behavior: progress appears on a terminal and
/// nowhere else, which meant a piped run printed nothing at all until it ended —
/// eight minutes of silence before an abort, in the case that motivated this work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamPolicy {
    Auto,
    Always,
    Never,
}

/// Incremental model output. Deltas are presentation-only.
#[derive(Clone, Debug)]
pub enum Delta {
    Thinking(String),
    Content(String),
}

/// How a terminal should draw an event.
#[derive(Clone, Debug, Default)]
pub enum Human {
    /// Recorded, but nothing to show.
    #[default]
    Silent,
    /// A detail line, shown only under `--verbose`.
    Line(String),
    ToolStart {
        step: usize,
        tool: String,
        target: String,
    },
    ToolResult {
        ok: bool,
        verification: bool,
        detail: Option<String>,
    },
    Recovery(String),
}

/// One thing that happened, built once and dispatched to every sink.
#[derive(Clone, Debug)]
pub struct Event {
    pub kind: &'static str,
    pub data: Value,
    pub human: Human,
}

impl Event {
    pub fn new(kind: &'static str) -> Self {
        Self {
            kind,
            data: Value::Null,
            human: Human::Silent,
        }
    }

    pub fn data(mut self, data: Value) -> Self {
        self.data = data;
        self
    }

    pub fn human(mut self, human: Human) -> Self {
        self.human = human;
        self
    }
}

/// Text destined for the model's next turn.
///
/// The inner field is private to this module and the only constructor is
/// [`Journal::feedback`], so a message cannot reach the model without being
/// journaled first. Callers unwrap it via [`Feedback::into_inner`].
#[must_use = "feedback must be handed to the model or it is lost"]
#[derive(Clone, Debug)]
pub struct Feedback(String);

impl Feedback {
    #[cfg(test)]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

/// A presentation sink. The run store is deliberately not one of these — it is
/// written by [`Journal::emit`] itself so it can never be omitted or reordered.
pub trait Presenter: Send {
    fn present(&mut self, event: &Event);
    fn delta(&mut self, _delta: &Delta) {}
    fn finish(&mut self, _receipt: &Receipt, _proof: &Path) {}
}

pub struct Journal {
    store: RunStore,
    presenters: Vec<Box<dyn Presenter>>,
    mode: OutputMode,
    streaming: bool,
}

impl Journal {
    pub fn new(store: RunStore, mode: OutputMode, stream: StreamPolicy) -> Self {
        let on_terminal = io::stdout().is_terminal();
        let streaming = match stream {
            StreamPolicy::Always => true,
            StreamPolicy::Never => false,
            StreamPolicy::Auto => on_terminal && matches!(mode, OutputMode::Human { .. }),
        };
        let mut presenters: Vec<Box<dyn Presenter>> = Vec::new();
        match mode {
            OutputMode::Human { verbose } => {
                presenters.push(Box::new(HumanPresenter {
                    verbose,
                    enabled: on_terminal || streaming,
                }));
            }
            OutputMode::Jsonl => presenters.push(Box::new(JsonlPresenter)),
            OutputMode::Json | OutputMode::Quiet => {}
        }
        Self {
            store,
            presenters,
            mode,
            streaming,
        }
    }

    /// Attach an extra sink, such as an ACP notifier bridging events to a client.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn subscribe(&mut self, presenter: Box<dyn Presenter>) {
        self.presenters.push(presenter);
    }

    pub fn mode(&self) -> OutputMode {
        self.mode
    }

    pub fn verbose(&self) -> bool {
        matches!(self.mode, OutputMode::Human { verbose: true })
    }

    /// True when incremental model output should be shown as it arrives.
    pub fn streaming(&self) -> bool {
        self.streaming
    }

    pub fn emit(&mut self, event: Event) -> Result<(), String> {
        // The durable record is written first and unconditionally. Presenters
        // cannot suppress it, and a presenter panic cannot lose it.
        self.store.event(event.kind, event.data.clone())?;
        for presenter in &mut self.presenters {
            presenter.present(&event);
        }
        Ok(())
    }

    /// Record an event and return the exact text the model will be shown next.
    ///
    /// `message` is stored under `feedback` in the event payload, so every
    /// instruction, refusal, and error the model receives is reconstructable from
    /// `events.jsonl` alone.
    pub fn feedback(
        &mut self,
        event: Event,
        message: impl Into<String>,
    ) -> Result<Feedback, String> {
        let message = message.into();
        let mut payload = match event.data {
            Value::Object(map) => map,
            Value::Null => serde_json::Map::new(),
            other => {
                let mut map = serde_json::Map::new();
                map.insert("detail".into(), other);
                map
            }
        };
        payload.insert("feedback".into(), json!(message));
        self.emit(Event {
            data: Value::Object(payload),
            ..event
        })?;
        Ok(Feedback(message))
    }

    /// Incremental model output.
    ///
    /// Deltas intentionally bypass the store: the full text is already recorded
    /// as `model.response` once the turn completes, so per-token records would
    /// multiply the log size without adding information.
    pub fn delta(&mut self, delta: Delta) {
        if !self.streaming {
            return;
        }
        for presenter in &mut self.presenters {
            presenter.delta(&delta);
        }
    }

    pub fn finish(&mut self, receipt: &Receipt, proof: &Path) {
        for presenter in &mut self.presenters {
            presenter.finish(receipt, proof);
        }
    }

    #[cfg(test)]
    pub fn store(&self) -> &RunStore {
        &self.store
    }
}

struct HumanPresenter {
    verbose: bool,
    /// Progress is drawn on a terminal, or anywhere when `--stream` is set.
    enabled: bool,
}

impl Presenter for HumanPresenter {
    fn present(&mut self, event: &Event) {
        if !self.enabled {
            return;
        }
        match &event.human {
            Human::Silent => {}
            Human::Line(message) => {
                if self.verbose {
                    println!("{message}");
                }
            }
            Human::ToolStart { step, tool, target } => crate::tui::tool_start(*step, tool, target),
            Human::ToolResult {
                ok,
                verification,
                detail,
            } => {
                crate::tui::tool_result(*ok, *verification);
                if let Some(detail) = detail {
                    crate::tui::tool_failure_detail(detail);
                }
            }
            Human::Recovery(message) => crate::tui::recovery(message),
        }
    }

    fn delta(&mut self, delta: &Delta) {
        if !self.enabled {
            return;
        }
        match delta {
            Delta::Thinking(text) | Delta::Content(text) => {
                print!("{text}");
                let _ = io::stdout().flush();
            }
        }
    }
}

/// The `--jsonl` line envelope. Stable at version 1; consumers key off `event`.
fn jsonl_envelope(kind: &str, data: Value) -> Value {
    json!({
        "schemaVersion": 1,
        "event": kind,
        "atUnixMs": unix_ms(),
        "data": data
    })
}

struct JsonlPresenter;

impl JsonlPresenter {
    fn write(value: Value) {
        println!("{value}");
        let _ = io::stdout().flush();
    }
}

impl Presenter for JsonlPresenter {
    fn present(&mut self, event: &Event) {
        Self::write(jsonl_envelope(event.kind, event.data.clone()));
    }

    fn delta(&mut self, delta: &Delta) {
        let (channel, text) = match delta {
            Delta::Thinking(text) => ("thinking", text),
            Delta::Content(text) => ("content", text),
        };
        Self::write(jsonl_envelope(
            "model.delta",
            json!({ "channel": channel, "text": text }),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Recorder(Arc<Mutex<Vec<String>>>);

    impl Presenter for Recorder {
        fn present(&mut self, event: &Event) {
            self.0
                .lock()
                .expect("recorder lock")
                .push(event.kind.into());
        }
    }

    fn journal(dir: &Path) -> Journal {
        let store = RunStore::create(dir).expect("create run store");
        Journal::new(store, OutputMode::Quiet, StreamPolicy::Never)
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "hii-runlog-{tag}-{}-{}",
            std::process::id(),
            unix_ms()
        ));
        std::fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn events(journal: &Journal) -> Vec<Value> {
        let raw = std::fs::read_to_string(journal.store().events_path()).unwrap_or_default();
        raw.lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    /// The guarantee the `Feedback` newtype exists to provide: anything the model
    /// is told is also in the durable log.
    #[test]
    fn feedback_is_always_journaled() {
        let dir = temp_dir("feedback");
        let mut journal = journal(&dir);
        let feedback = journal
            .feedback(
                Event::new("protocol.retry").data(json!({ "step": 2 })),
                "Protocol error: expected one JSON object.",
            )
            .expect("emit feedback");

        assert_eq!(
            feedback.as_str(),
            "Protocol error: expected one JSON object."
        );
        let recorded = events(&journal);
        let entry = recorded
            .iter()
            .find(|event| event["kind"] == "protocol.retry")
            .expect("protocol.retry reached events.jsonl");
        assert_eq!(entry["data"]["feedback"], json!(feedback.as_str()));
        assert_eq!(entry["data"]["step"], json!(2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Quiet suppresses stdout but must never suppress the record.
    #[test]
    fn quiet_still_records_every_event() {
        let dir = temp_dir("quiet");
        let mut journal = journal(&dir);
        journal
            .emit(Event::new("run.started").data(json!({ "goal": "fix" })))
            .expect("emit");
        assert_eq!(events(&journal).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn presenters_see_every_emitted_event() {
        let dir = temp_dir("presenters");
        let mut journal = journal(&dir);
        let seen = Arc::new(Mutex::new(Vec::new()));
        journal.subscribe(Box::new(Recorder(Arc::clone(&seen))));
        journal.emit(Event::new("run.started")).expect("emit");
        let _ = journal
            .feedback(Event::new("authority.block"), "PAUSED")
            .expect("emit feedback");
        assert_eq!(
            *seen.lock().expect("recorder lock"),
            vec!["run.started".to_string(), "authority.block".to_string()]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn jsonl_events_have_a_stable_envelope() {
        let event = jsonl_envelope("tool.started", json!({ "tool": "read" }));
        assert_eq!(event["schemaVersion"], 1);
        assert_eq!(event["event"], "tool.started");
        assert_eq!(event["data"]["tool"], "read");
        assert!(event["atUnixMs"].as_u64().is_some());
    }

    /// `events.jsonl` is a published contract. Renaming or dropping any of these
    /// breaks external consumers, so a change here must be deliberate.
    #[test]
    fn recorded_event_kinds_are_frozen() {
        const FROZEN: &[&str] = &[
            "pipe.preflight",
            "run.started",
            "run.blocked",
            "run.interrupted",
            "run.finished",
            "contract",
            "model.response",
            "model.loop_detected",
            "model.message",
            "model.empty_response",
            "protocol.retry",
            "tool.started",
            "tool.result",
            "authority.block",
            "hook.result",
            "hook.block",
            "mcp.block",
            "mcp.result",
            "acceptance.result",
            "output.written",
            "convergence.repeated_action",
            "convergence.repeated_verification_completed",
            "convergence.pending_final_completed",
            "convergence.verified_loop_recovered",
            "convergence.proof_required",
        ];
        let source = include_str!("agent.rs");
        for kind in FROZEN {
            assert!(
                source.contains(&format!("\"{kind}\"")),
                "{kind} is no longer emitted by the run loop"
            );
        }
    }

    /// Deltas are presentation-only; the aggregate lands as `model.response`.
    #[test]
    fn deltas_do_not_reach_the_store() {
        let dir = temp_dir("delta");
        let mut journal = journal(&dir);
        journal.delta(Delta::Content("partial".into()));
        assert!(events(&journal).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
