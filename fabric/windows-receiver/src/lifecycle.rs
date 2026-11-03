use std::sync::Mutex;

use crate::{ReceiverError, ReceiverResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiverState {
    Stopped,
    Starting,
    Ready,
    Degraded,
    Stopping,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleSnapshot {
    pub state: ReceiverState,
    pub last_error: Option<String>,
    pub transitions: u64,
}

#[derive(Debug)]
pub struct Lifecycle {
    inner: Mutex<LifecycleSnapshot>,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self::new()
    }
}

impl Lifecycle {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(LifecycleSnapshot {
                state: ReceiverState::Stopped,
                last_error: None,
                transitions: 0,
            }),
        }
    }

    pub fn snapshot(&self) -> ReceiverResult<LifecycleSnapshot> {
        self.inner
            .lock()
            .map(|snapshot| snapshot.clone())
            .map_err(|_| ReceiverError::StatePoisoned("lifecycle"))
    }

    pub fn transition(&self, to: ReceiverState) -> ReceiverResult<LifecycleSnapshot> {
        let mut snapshot = self
            .inner
            .lock()
            .map_err(|_| ReceiverError::StatePoisoned("lifecycle"))?;
        if !is_allowed(snapshot.state, to) {
            return Err(ReceiverError::InvalidTransition {
                from: snapshot.state,
                to,
            });
        }
        snapshot.state = to;
        snapshot.transitions += 1;
        if to != ReceiverState::Failed {
            snapshot.last_error = None;
        }
        Ok(snapshot.clone())
    }

    pub fn fail(&self, message: impl Into<String>) -> ReceiverResult<LifecycleSnapshot> {
        let mut snapshot = self
            .inner
            .lock()
            .map_err(|_| ReceiverError::StatePoisoned("lifecycle"))?;
        if !is_allowed(snapshot.state, ReceiverState::Failed) {
            return Err(ReceiverError::InvalidTransition {
                from: snapshot.state,
                to: ReceiverState::Failed,
            });
        }
        snapshot.state = ReceiverState::Failed;
        snapshot.last_error = Some(message.into());
        snapshot.transitions += 1;
        Ok(snapshot.clone())
    }
}

fn is_allowed(from: ReceiverState, to: ReceiverState) -> bool {
    use ReceiverState::{Degraded, Failed, Ready, Starting, Stopped, Stopping};
    matches!(
        (from, to),
        (Stopped, Starting)
            | (Starting, Ready | Degraded | Stopping | Failed)
            | (Ready, Degraded | Stopping | Failed)
            | (Degraded, Ready | Stopping | Failed)
            | (Stopping, Stopped | Failed)
            | (Failed, Starting | Stopped)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_valid_lifecycle() {
        let lifecycle = Lifecycle::new();
        lifecycle.transition(ReceiverState::Starting).unwrap();
        lifecycle.transition(ReceiverState::Ready).unwrap();
        lifecycle.transition(ReceiverState::Stopping).unwrap();
        let stopped = lifecycle.transition(ReceiverState::Stopped).unwrap();
        assert_eq!(stopped.state, ReceiverState::Stopped);
        assert_eq!(stopped.transitions, 4);
    }

    #[test]
    fn rejects_invalid_transition_without_mutating_state() {
        let lifecycle = Lifecycle::new();
        let error = lifecycle.transition(ReceiverState::Ready).unwrap_err();
        assert_eq!(
            error,
            ReceiverError::InvalidTransition {
                from: ReceiverState::Stopped,
                to: ReceiverState::Ready
            }
        );
        assert_eq!(lifecycle.snapshot().unwrap().state, ReceiverState::Stopped);
    }

    #[test]
    fn preserves_failure_reason() {
        let lifecycle = Lifecycle::new();
        lifecycle.transition(ReceiverState::Starting).unwrap();
        let failed = lifecycle.fail("renderer unavailable").unwrap();
        assert_eq!(failed.state, ReceiverState::Failed);
        assert_eq!(failed.last_error.as_deref(), Some("renderer unavailable"));
    }
}
