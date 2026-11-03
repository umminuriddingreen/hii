//! Pre-registration: what a run committed to prove, fixed before it began.
//!
//! `completion` already grades a run against declared checks, and grades a run
//! with nothing declared as `incidental` — real evidence about a command that
//! exited zero, but not a satisfied claim. That standard is right, and until now
//! it was unreachable: declaring was opt-in via `--verify` and
//! `--require-artifact`, and across 345 real receipts nobody ever opted in. Zero
//! runs qualified as declared, so no skill could ever be verified.
//!
//! The obvious fix — let the agent declare its own checks — is how the standard
//! collapses. An agent that writes its acceptance check after seeing the result
//! is grading its own homework, and one that declares `true` has proven nothing
//! while satisfying every rule.
//!
//! So a declaration is only worth anything under three conditions, all enforced
//! here:
//!
//! 1. **Pre-registered.** Fixed before the work runs, like a study protocol
//!    filed before the data is collected. Declaring afterwards is rationalizing.
//! 2. **Immutable.** Fingerprinted at declaration time and checked at
//!    completion. A declaration edited mid-run proves nothing about the claim it
//!    started as.
//! 3. **Non-trivial.** A check that cannot fail is not evidence. `true`, `:`,
//!    and a bare `echo` are rejected outright.
//!
//! Origin is recorded but does not change the standard: an operator's check and
//! an agent's check are both pre-registered claims, and both are void if edited
//! or trivial. What origin records is *who* committed, which matters when
//! reading a receipt long afterwards.

use serde::{Deserialize, Serialize};

use crate::run_context::WriteOrigin;

/// Commands that cannot fail, and so cannot be evidence.
///
/// This is a floor against the degenerate case, not a judge of whether a check
/// is a *good* one — that is not decidable here. It rejects what is definitionally
/// vacuous: builtins that always exit zero, and pure output statements.
const VACUOUS: &[&str] = &[
    "true", ":", "echo", "printf", "pwd", "cd", "exit 0", "return 0",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Declaration {
    /// The acceptance checks, exactly as pre-registered.
    pub checks: Vec<String>,
    /// Who committed to them.
    pub origin: WriteOrigin,
    /// Fingerprint of `checks` at declaration time.
    pub fingerprint: String,
    pub declared_at_unix_ms: u128,
}

impl Declaration {
    /// Pre-register a set of acceptance checks.
    ///
    /// Rejects the declaration outright when nothing substantive is being
    /// claimed, rather than accepting it and quietly grading it as weak: a run
    /// that believes it declared something, and did not, is worse than one that
    /// never claimed to.
    pub fn register(checks: &[String], origin: WriteOrigin) -> Result<Self, String> {
        let checks: Vec<String> = checks
            .iter()
            .map(|check| check.trim().to_string())
            .filter(|check| !check.is_empty())
            .collect();
        if checks.is_empty() {
            return Err("a declaration needs at least one acceptance check".into());
        }
        if let Some(vacuous) = checks.iter().find(|check| is_vacuous(check)) {
            return Err(format!(
                "`{vacuous}` cannot fail, so it cannot be evidence. Declare a check that would \
                 actually fail if the goal were not met."
            ));
        }
        Ok(Declaration {
            fingerprint: fingerprint(&checks),
            checks,
            origin,
            declared_at_unix_ms: crate::clock::unix_ms(),
        })
    }

    /// Whether the checks still match what was pre-registered.
    pub fn is_intact(&self) -> bool {
        self.fingerprint == fingerprint(&self.checks)
    }

    /// Whether this declaration may support a verified outcome.
    ///
    /// Called at completion, after the run has had every opportunity to tamper
    /// with what it committed to.
    pub fn supports_verification(&self) -> bool {
        self.is_intact() && !self.checks.is_empty() && !self.checks.iter().any(|c| is_vacuous(c))
    }
}

/// Whether a command is incapable of failing.
///
/// Compares the leading word so `echo done && false` is not mistaken for a real
/// check by a naive prefix test — a compound command is only vacuous if every
/// stage of it is.
pub fn is_vacuous(command: &str) -> bool {
    let command = command.trim();
    if command.is_empty() {
        return true;
    }
    command
        .split("&&")
        .flat_map(|stage| stage.split(';'))
        .flat_map(|stage| stage.split('|'))
        .all(|stage| {
            let stage = stage.trim();
            if stage.is_empty() {
                return true;
            }
            let head = stage.split_whitespace().next().unwrap_or("");
            VACUOUS.contains(&stage) || VACUOUS.contains(&head)
        })
}

/// A stable fingerprint of the declared checks.
///
/// FNV-1a rather than a cryptographic hash: this defends against a declaration
/// being edited during a run, not against an adversary who already controls the
/// receipt and could rewrite the fingerprint alongside it.
fn fingerprint(checks: &[String]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for check in checks {
        for byte in check.as_bytes() {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x1000_0000_01b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checks(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn registers_a_real_check() {
        let declaration =
            Declaration::register(&checks(&["cargo test"]), WriteOrigin::Operator).unwrap();
        assert!(declaration.supports_verification());
        assert_eq!(declaration.origin, WriteOrigin::Operator);
    }

    #[test]
    fn rejects_checks_that_cannot_fail() {
        for vacuous in ["true", ":", "echo done", "  true  ", "exit 0"] {
            let result = Declaration::register(&checks(&[vacuous]), WriteOrigin::Agent);
            assert!(
                result.is_err(),
                "`{vacuous}` cannot fail and must not be accepted as a declaration"
            );
        }
    }

    #[test]
    fn rejects_an_empty_declaration() {
        assert!(Declaration::register(&[], WriteOrigin::Operator).is_err());
        assert!(Declaration::register(&checks(&["  "]), WriteOrigin::Operator).is_err());
    }

    #[test]
    fn a_compound_command_is_vacuous_only_if_every_stage_is() {
        assert!(is_vacuous("echo a && true"));
        assert!(is_vacuous("echo a; echo b"));
        // The failing stage is what makes this real evidence.
        assert!(!is_vacuous("echo running && cargo test"));
        assert!(!is_vacuous("true && false"));
    }

    #[test]
    fn editing_the_declaration_voids_it() {
        let mut declaration =
            Declaration::register(&checks(&["cargo test --lib"]), WriteOrigin::Agent).unwrap();
        assert!(declaration.is_intact());

        // A run that quietly relaxes its own acceptance check after the fact.
        declaration.checks = checks(&["cargo test --lib || true"]);
        assert!(!declaration.is_intact());
        assert!(
            !declaration.supports_verification(),
            "a declaration edited mid-run cannot support a verified outcome"
        );
    }

    #[test]
    fn an_agent_declaration_is_held_to_the_same_standard_as_an_operators() {
        // Origin records who committed; it must not change what counts.
        let agent = Declaration::register(&checks(&["make check"]), WriteOrigin::Agent).unwrap();
        let operator =
            Declaration::register(&checks(&["make check"]), WriteOrigin::Operator).unwrap();
        assert_eq!(agent.fingerprint, operator.fingerprint);
        assert_eq!(
            agent.supports_verification(),
            operator.supports_verification()
        );
        assert!(Declaration::register(&checks(&["true"]), WriteOrigin::Operator).is_err());
    }

    #[test]
    fn fingerprint_is_order_sensitive_and_stable() {
        let one =
            Declaration::register(&checks(&["a-cmd", "b-cmd"]), WriteOrigin::Operator).unwrap();
        let same =
            Declaration::register(&checks(&["a-cmd", "b-cmd"]), WriteOrigin::Operator).unwrap();
        let swapped =
            Declaration::register(&checks(&["b-cmd", "a-cmd"]), WriteOrigin::Operator).unwrap();
        assert_eq!(one.fingerprint, same.fingerprint);
        assert_ne!(one.fingerprint, swapped.fingerprint);
    }

    /// Concatenation must not collide with a differently-split declaration.
    #[test]
    fn check_boundaries_are_part_of_the_fingerprint() {
        let split = Declaration::register(&checks(&["ab", "c"]), WriteOrigin::Operator).unwrap();
        let joined = Declaration::register(&checks(&["a", "bc"]), WriteOrigin::Operator).unwrap();
        assert_ne!(split.fingerprint, joined.fingerprint);
    }
}
