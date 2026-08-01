//! What bounds a run: steps, wall clock, and the ability to stop mid-generation.
//!
//! The step ceiling used to be the only bound, and it defaulted to unlimited. A
//! run could therefore sit for minutes producing nothing observable and nothing
//! stoppable: Ctrl-C was only checked between steps, and the provider's read
//! timeout reset on every streamed chunk, so a model dribbling one token at a
//! time was effectively unbounded.
//!
//! [`Deadline`] answers "should this stop?" and [`Cancel`] carries "stop now" to
//! everything holding a clone — the signal handler, the budget checks, and later
//! an ACP client's `session/cancel`.

use std::{
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

/// Default wall-clock ceiling for one `hii run`.
pub const DEFAULT_WALL_CLOCK_SECS: u64 = 900;
/// Default ceiling for a single model call.
pub const DEFAULT_MODEL_CALL_SECS: u64 = 180;
/// Default gap tolerated between two pieces of streamed output.
pub const DEFAULT_STREAM_IDLE_SECS: u64 = 60;

#[derive(Clone, Copy, Debug)]
pub struct Budgets {
    /// 0 means unlimited, preserving the historical meaning of `--max-steps 0`.
    pub max_steps: usize,
    pub wall_clock: Option<Duration>,
    pub model_call: Option<Duration>,
    pub stream_idle: Option<Duration>,
}

impl Default for Budgets {
    fn default() -> Self {
        Self {
            max_steps: 0,
            wall_clock: Some(Duration::from_secs(DEFAULT_WALL_CLOCK_SECS)),
            model_call: Some(Duration::from_secs(DEFAULT_MODEL_CALL_SECS)),
            stream_idle: Some(Duration::from_secs(DEFAULT_STREAM_IDLE_SECS)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BudgetKind {
    Steps,
    WallClock,
    ModelCall,
    StreamIdle,
}

impl BudgetKind {
    pub fn label(self) -> &'static str {
        match self {
            BudgetKind::Steps => "step ceiling",
            BudgetKind::WallClock => "wall-clock budget",
            BudgetKind::ModelCall => "model-call budget",
            BudgetKind::StreamIdle => "stream-idle budget",
        }
    }
}

/// Tracks how much of each budget is left.
#[derive(Clone, Debug)]
pub struct Deadline {
    started: Instant,
    budgets: Budgets,
}

impl Deadline {
    pub fn new(budgets: Budgets) -> Self {
        Self {
            started: Instant::now(),
            budgets,
        }
    }

    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    /// Which budget, if any, has been exhausted.
    pub fn exceeded(&self, steps: usize) -> Option<BudgetKind> {
        if self.budgets.max_steps > 0 && steps >= self.budgets.max_steps {
            return Some(BudgetKind::Steps);
        }
        match self.budgets.wall_clock {
            Some(limit) if self.started.elapsed() >= limit => Some(BudgetKind::WallClock),
            _ => None,
        }
    }

    pub fn remaining_wall(&self) -> Option<Duration> {
        self.budgets
            .wall_clock
            .map(|limit| limit.saturating_sub(self.started.elapsed()))
    }

    /// How long a single model call may take: its own budget, but never longer
    /// than the whole run has left.
    pub fn model_call_budget(&self) -> Option<Duration> {
        match (self.budgets.model_call, self.remaining_wall()) {
            (Some(call), Some(wall)) => Some(call.min(wall)),
            (Some(call), None) => Some(call),
            (None, wall) => wall,
        }
    }

    pub fn stream_idle(&self) -> Option<Duration> {
        self.budgets.stream_idle
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelReason {
    /// Operator pressed Ctrl-C.
    Interrupt,
    /// A budget was exhausted.
    Budget(BudgetKind),
    /// A client asked the run to stop.
    Client,
}

/// One cancellation signal shared by every party that can stop a run.
///
/// Cloning shares the flag, so the signal handler, the loop, and the provider's
/// streaming thread all observe the same decision.
#[derive(Clone, Debug, Default)]
pub struct Cancel {
    flag: Arc<AtomicBool>,
    reason: Arc<AtomicU8>,
}

const REASON_NONE: u8 = 0;
const REASON_INTERRUPT: u8 = 1;
const REASON_CLIENT: u8 = 2;
const REASON_STEPS: u8 = 3;
const REASON_WALL: u8 = 4;
const REASON_MODEL_CALL: u8 = 5;
const REASON_STREAM_IDLE: u8 = 6;

fn encode(reason: CancelReason) -> u8 {
    match reason {
        CancelReason::Interrupt => REASON_INTERRUPT,
        CancelReason::Client => REASON_CLIENT,
        CancelReason::Budget(BudgetKind::Steps) => REASON_STEPS,
        CancelReason::Budget(BudgetKind::WallClock) => REASON_WALL,
        CancelReason::Budget(BudgetKind::ModelCall) => REASON_MODEL_CALL,
        CancelReason::Budget(BudgetKind::StreamIdle) => REASON_STREAM_IDLE,
    }
}

fn decode(raw: u8) -> Option<CancelReason> {
    match raw {
        REASON_INTERRUPT => Some(CancelReason::Interrupt),
        REASON_CLIENT => Some(CancelReason::Client),
        REASON_STEPS => Some(CancelReason::Budget(BudgetKind::Steps)),
        REASON_WALL => Some(CancelReason::Budget(BudgetKind::WallClock)),
        REASON_MODEL_CALL => Some(CancelReason::Budget(BudgetKind::ModelCall)),
        REASON_STREAM_IDLE => Some(CancelReason::Budget(BudgetKind::StreamIdle)),
        _ => None,
    }
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Request cancellation. The first reason wins, so a Ctrl-C during a budget
    /// trip does not rewrite why the run stopped.
    pub fn cancel(&self, reason: CancelReason) {
        if self
            .reason
            .compare_exchange(
                REASON_NONE,
                encode(reason),
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
        {
            self.flag.store(true, Ordering::SeqCst);
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    pub fn reason(&self) -> Option<CancelReason> {
        decode(self.reason.load(Ordering::SeqCst))
    }

    /// Clear the signal so a long-lived process can start a fresh run.
    pub fn reset(&self) {
        self.flag.store(false, Ordering::SeqCst);
        self.reason.store(REASON_NONE, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_ceiling_reports_its_kind() {
        let deadline = Deadline::new(Budgets {
            max_steps: 3,
            wall_clock: None,
            ..Budgets::default()
        });
        assert_eq!(deadline.exceeded(2), None);
        assert_eq!(deadline.exceeded(3), Some(BudgetKind::Steps));
    }

    #[test]
    fn zero_steps_still_means_unlimited() {
        let deadline = Deadline::new(Budgets {
            max_steps: 0,
            wall_clock: None,
            ..Budgets::default()
        });
        assert_eq!(deadline.exceeded(10_000), None);
    }

    #[test]
    fn wall_clock_expires() {
        let deadline = Deadline::new(Budgets {
            max_steps: 0,
            wall_clock: Some(Duration::ZERO),
            ..Budgets::default()
        });
        assert_eq!(deadline.exceeded(1), Some(BudgetKind::WallClock));
    }

    /// A model call may not outlive the run it belongs to.
    #[test]
    fn model_call_budget_is_clamped_by_remaining_wall_clock() {
        let deadline = Deadline::new(Budgets {
            max_steps: 0,
            wall_clock: Some(Duration::from_secs(5)),
            model_call: Some(Duration::from_secs(600)),
            stream_idle: None,
        });
        let budget = deadline.model_call_budget().expect("a budget");
        assert!(budget <= Duration::from_secs(5), "got {budget:?}");
    }

    #[test]
    fn the_first_cancellation_reason_wins() {
        let cancel = Cancel::new();
        assert!(!cancel.is_cancelled());
        cancel.cancel(CancelReason::Budget(BudgetKind::WallClock));
        cancel.cancel(CancelReason::Interrupt);
        assert!(cancel.is_cancelled());
        assert_eq!(
            cancel.reason(),
            Some(CancelReason::Budget(BudgetKind::WallClock))
        );
    }

    #[test]
    fn clones_share_one_signal() {
        let cancel = Cancel::new();
        let clone = cancel.clone();
        cancel.cancel(CancelReason::Client);
        assert!(clone.is_cancelled());
        assert_eq!(clone.reason(), Some(CancelReason::Client));
        clone.reset();
        assert!(!cancel.is_cancelled());
    }
}
