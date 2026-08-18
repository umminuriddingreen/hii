use std::fmt;

use crate::{FrameValidationError, ReceiverState};

pub type ReceiverResult<T> = Result<T, ReceiverError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiverError {
    InvalidTransition {
        from: ReceiverState,
        to: ReceiverState,
    },
    InvalidFrame(FrameValidationError),
    ComponentFailure {
        component: &'static str,
        message: String,
    },
    Unsupported {
        capability: &'static str,
        detail: &'static str,
    },
    StatePoisoned(&'static str),
}

impl fmt::Display for ReceiverError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTransition { from, to } => {
                write!(f, "invalid receiver transition from {from:?} to {to:?}")
            }
            Self::InvalidFrame(error) => write!(f, "invalid frame: {error}"),
            Self::ComponentFailure { component, message } => {
                write!(f, "{component} failed: {message}")
            }
            Self::Unsupported { capability, detail } => {
                write!(f, "{capability} is unsupported: {detail}")
            }
            Self::StatePoisoned(name) => write!(f, "receiver state lock poisoned: {name}"),
        }
    }
}

impl std::error::Error for ReceiverError {}

impl From<FrameValidationError> for ReceiverError {
    fn from(value: FrameValidationError) -> Self {
        Self::InvalidFrame(value)
    }
}
