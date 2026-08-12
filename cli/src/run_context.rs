//! Ambient identity for the work happening right now.
//!
//! Two subsystems need to know things about the current run that are impractical
//! to thread through every call site: the model-call tracer, buried under the
//! provider client, and skill attribution, which fires wherever a skill is
//! invoked. Before this, `~/.hii/traces/llm_requests.jsonl` recorded 630KB of
//! model calls with no run identity at all, so no trace could ever be joined to
//! the receipt it belonged to.
//!
//! A run is one process invocation, so the context is process-global rather
//! than task-local. It is set once when the run store is created and read
//! best-effort everywhere else — an absent context degrades a record to what it
//! would have carried anyway, and never fails a run.
//!
//! # Write origin
//!
//! Not everything HII does is something the operator asked for. A skill written
//! by a background review is the agent's own sediment; a skill the operator
//! asked for belongs to the operator. Recording which is which lets automatic
//! curation touch its own output and leave the operator's alone. The default is
//! deliberately `Operator`: work is attributed to the human unless something
//! explicitly claims otherwise, so unmarked work is never auto-curated.

use serde::{Deserialize, Serialize};
use std::sync::RwLock;

/// Who caused the work being recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WriteOrigin {
    /// The operator asked for this, directly or through a command they ran.
    Operator,
    /// The agent produced this on its own initiative during a run.
    Agent,
    /// A background self-review, not attached to anything the operator asked
    /// for. The only origin automatic curation may act on.
    BackgroundReview,
}

impl WriteOrigin {
    pub fn label(self) -> &'static str {
        match self {
            WriteOrigin::Operator => "operator",
            WriteOrigin::Agent => "agent",
            WriteOrigin::BackgroundReview => "background-review",
        }
    }

    /// Whether automatic curation may modify or retire what was written under
    /// this origin. Only the agent's own unprompted output qualifies.
    pub fn is_auto_curatable(self) -> bool {
        matches!(self, WriteOrigin::BackgroundReview)
    }
}

#[derive(Debug, Clone, Default)]
struct Context {
    run_id: Option<String>,
    conversation_id: Option<String>,
    origin: Option<WriteOrigin>,
}

fn context() -> &'static RwLock<Context> {
    static CONTEXT: RwLock<Context> = RwLock::new(Context {
        run_id: None,
        conversation_id: None,
        origin: None,
    });
    &CONTEXT
}

/// Bind the current run. Called once, where the run id is minted.
pub fn set_run_id(run_id: &str) {
    if let Ok(mut context) = context().write() {
        context.run_id = Some(run_id.to_string());
    }
}

#[allow(dead_code)] // Reserved for the interactive conversation receipt bridge.
pub fn set_conversation_id(conversation_id: &str) {
    if let Ok(mut context) = context().write() {
        context.conversation_id = Some(conversation_id.to_string());
    }
}

pub fn set_origin(origin: WriteOrigin) {
    if let Ok(mut context) = context().write() {
        context.origin = Some(origin);
    }
}

pub fn run_id() -> Option<String> {
    context()
        .read()
        .ok()
        .and_then(|context| context.run_id.clone())
}

pub fn conversation_id() -> Option<String> {
    context()
        .read()
        .ok()
        .and_then(|context| context.conversation_id.clone())
}

/// The active origin, defaulting to `Operator`.
///
/// Defaulting to the operator is the safe direction: an unmarked write is
/// treated as the human's and left alone, rather than being swept up by
/// automatic curation because nobody claimed it.
pub fn origin() -> WriteOrigin {
    context()
        .read()
        .ok()
        .and_then(|context| context.origin)
        .unwrap_or(WriteOrigin::Operator)
}

/// Clear the context. Exists for tests, which share one process.
#[cfg(test)]
pub fn reset() {
    if let Ok(mut context) = context().write() {
        *context = Context::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    /// The context is process-global, so tests that touch it must not interleave.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn serial() -> MutexGuard<'static, ()> {
        SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn run_id_round_trips() {
        let _guard = serial();
        reset();
        assert_eq!(run_id(), None);
        set_run_id("19ff-abc");
        assert_eq!(run_id().as_deref(), Some("19ff-abc"));
        reset();
    }

    #[test]
    fn origin_defaults_to_operator() {
        let _guard = serial();
        reset();
        // An unclaimed write must never be treated as the agent's own sediment,
        // because that is what makes it eligible for automatic curation.
        assert_eq!(origin(), WriteOrigin::Operator);
        assert!(!origin().is_auto_curatable());
        reset();
    }

    #[test]
    fn only_background_review_is_auto_curatable() {
        assert!(!WriteOrigin::Operator.is_auto_curatable());
        assert!(!WriteOrigin::Agent.is_auto_curatable());
        assert!(WriteOrigin::BackgroundReview.is_auto_curatable());
    }

    #[test]
    fn origin_can_be_claimed_explicitly() {
        let _guard = serial();
        reset();
        set_origin(WriteOrigin::BackgroundReview);
        assert_eq!(origin(), WriteOrigin::BackgroundReview);
        reset();
    }
}
