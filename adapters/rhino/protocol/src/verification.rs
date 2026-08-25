//! Postcondition verdicts.
//!
//! A native API returning without throwing is not success. Every mutation
//! class declares postconditions that are checked by re-reading the document
//! through independent operations, and the outcome is recorded as one of four
//! distinct verdicts. Collapsing them into a boolean is what lets "the tool
//! returned ok" masquerade as "the user got what they asked for".

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationVerdict {
    /// Every declared postcondition was checked and held.
    Verified,
    /// Some postconditions held; at least one could not be checked.
    PartiallyVerified,
    /// Nothing could be checked (no independent read was possible).
    Unverified,
    /// A postcondition was checked and did not hold.
    Failed,
}

impl VerificationVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::PartiallyVerified => "partially_verified",
            Self::Unverified => "unverified",
            Self::Failed => "failed",
        }
    }
}

/// One postcondition and what re-reading the document said about it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VerificationCheck {
    /// What was asserted, in words a receipt reader can follow.
    pub description: String,
    /// The read operation used to check it, so the evidence is reproducible.
    pub via_operation: String,
    pub ok: bool,
    /// What the check expected and what it actually saw.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VerificationEvidence {
    pub verdict: VerificationVerdict,
    pub checks: Vec<VerificationCheck>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

impl VerificationEvidence {
    /// Derive the verdict from the checks rather than letting a caller assert
    /// one. `unchecked` counts postconditions that were declared but could not
    /// be evaluated.
    pub fn from_checks(checks: Vec<VerificationCheck>, unchecked: usize) -> Self {
        let verdict = if checks.iter().any(|check| !check.ok) {
            VerificationVerdict::Failed
        } else if checks.is_empty() {
            VerificationVerdict::Unverified
        } else if unchecked > 0 {
            VerificationVerdict::PartiallyVerified
        } else {
            VerificationVerdict::Verified
        };
        Self {
            verdict,
            checks,
            notes: Vec::new(),
        }
    }

    pub fn unverified(reason: impl Into<String>) -> Self {
        Self {
            verdict: VerificationVerdict::Unverified,
            checks: Vec::new(),
            notes: vec![reason.into()],
        }
    }
}
