//! Authoritative capability decisions for the HII intent pipe.
//!
//! Search results are suggestions. A resolution adds the runtime facts an
//! executor needs before it can claim an action is possible: availability,
//! direct invocation, minimum authority, and evidence.

use serde::Serialize;

use crate::{
    capability_index::{self, Entry, Match},
    config::AppPaths,
    contract::{Authority, Decision},
};

const CANDIDATE_LIMIT: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Availability {
    Ready,
    Partial,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResolutionStatus {
    Resolved,
    Ambiguous,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
pub struct Candidate {
    pub id: String,
    pub name: String,
    pub score: u32,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct CapabilityResolution {
    pub query: String,
    pub status: ResolutionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub availability: Option<Availability>,
    pub directly_invocable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invoke: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_authority: Option<Authority>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_decision: Option<String>,
    pub reason: String,
    pub evidence: Vec<String>,
    pub candidates: Vec<Candidate>,
}

pub fn resolve(paths: &AppPaths, query: &str, authority: Authority) -> CapabilityResolution {
    resolve_entries(&capability_index::load_all(paths), query, authority)
}

pub fn resolve_entries(
    entries: &[Entry],
    query: &str,
    authority: Authority,
) -> CapabilityResolution {
    let query = query.trim();
    let matches = capability_index::search(entries, query, CANDIDATE_LIMIT);
    let candidates = matches.iter().map(candidate).collect::<Vec<_>>();
    let Some(best) = matches.first() else {
        return CapabilityResolution {
            query: query.into(),
            status: ResolutionStatus::Unavailable,
            capability_id: None,
            capability_name: None,
            availability: None,
            directly_invocable: false,
            invoke: None,
            required_authority: None,
            authority_decision: None,
            reason: "no local capability matched the intent".into(),
            evidence: Vec::new(),
            candidates,
        };
    };

    if is_ambiguous(best, matches.get(1), query) {
        return CapabilityResolution {
            query: query.into(),
            status: ResolutionStatus::Ambiguous,
            capability_id: None,
            capability_name: None,
            availability: None,
            directly_invocable: false,
            invoke: None,
            required_authority: None,
            authority_decision: None,
            reason:
                "multiple capabilities match too closely; execution requires an explicit choice"
                    .into(),
            evidence: Vec::new(),
            candidates,
        };
    }

    resolved(best, query, authority, candidates)
}

fn resolved(
    hit: &Match,
    query: &str,
    authority: Authority,
    candidates: Vec<Candidate>,
) -> CapabilityResolution {
    let entry = &hit.entry;
    let availability = availability(entry);
    let required_authority = minimum_authority(entry);
    let decision = authority.decide(
        required_authority != Authority::ReadOnly,
        matches!(
            required_authority,
            Authority::ExternalPreview | Authority::ExternalCommit
        ),
    );
    let invoke = entry
        .invoke
        .as_deref()
        .filter(|value| is_executable_invoke(value));
    let directly_invocable = availability == Availability::Ready && invoke.is_some();
    let status = if availability == Availability::Unavailable {
        ResolutionStatus::Unavailable
    } else {
        ResolutionStatus::Resolved
    };
    let reason = match (availability, directly_invocable, decision) {
        (Availability::Unavailable, _, _) => {
            format!("capability is registered with status '{}'", entry.status)
        }
        (Availability::Partial, _, _) => "capability is present but only partially ready".into(),
        (_, false, _) => "capability is ready but has no direct HII invocation adapter".into(),
        (_, _, Decision::Deny) => format!(
            "capability requires {} authority; current authority is {}",
            required_authority.label(),
            authority.label()
        ),
        (_, _, Decision::Prompt) => "capability requires operator approval before execution".into(),
        _ => "capability is ready within the current authority envelope".into(),
    };

    CapabilityResolution {
        query: query.into(),
        status,
        capability_id: Some(entry.id.clone()),
        capability_name: Some(entry.name.clone()),
        availability: Some(availability),
        directly_invocable,
        invoke: invoke.map(str::to_string),
        required_authority: Some(required_authority),
        authority_decision: Some(decision_label(decision).into()),
        reason,
        evidence: entry.examples.clone(),
        candidates,
    }
}

fn availability(entry: &Entry) -> Availability {
    let status = entry.status.to_ascii_lowercase();
    if matches!(status.as_str(), "ready" | "verified" | "trusted") {
        Availability::Ready
    } else if status == "partial" || status == "observed" {
        Availability::Partial
    } else {
        Availability::Unavailable
    }
}

/// Until every registry entry carries a typed authority field, derive the
/// minimum conservatively from its declared permission language. The result is
/// deterministic and inspectable; unknown action capabilities default to the
/// workspace envelope, never external authority.
fn minimum_authority(entry: &Entry) -> Authority {
    let permissions = entry
        .tags
        .iter()
        .map(|permission| permission.trim().to_ascii_lowercase())
        .filter(|permission| is_affirmative_permission(permission))
        .collect::<Vec<_>>()
        .join(" ");
    if contains_any(
        &permissions,
        &[
            "publish",
            "message",
            "spend",
            "payment",
            "deploy",
            "external action",
        ],
    ) {
        Authority::ExternalCommit
    } else if contains_any(&permissions, &["external", "network", "preview"]) {
        Authority::ExternalPreview
    } else if contains_any(
        &permissions,
        &[
            "write", "mutat", "control", "append", "create", "edit", "run",
        ],
    ) {
        Authority::Workspace
    } else {
        Authority::ReadOnly
    }
}

fn is_affirmative_permission(permission: &str) -> bool {
    !permission.starts_with("no ")
        && !permission.starts_with("approval required")
        && !permission.contains("without separate explicit authority")
        && !permission.contains("only after approval")
}

fn is_executable_invoke(value: &str) -> bool {
    let value = value.trim();
    value.starts_with("hii ")
        || value.starts_with("./")
        || value.starts_with('/')
        || value.contains(" --")
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

fn is_ambiguous(best: &Match, runner_up: Option<&Match>, query: &str) -> bool {
    if best.entry.id.eq_ignore_ascii_case(query) {
        return false;
    }
    runner_up
        .map(|next| best.score.saturating_sub(next.score) < 25)
        .unwrap_or(false)
}

fn candidate(hit: &Match) -> Candidate {
    Candidate {
        id: hit.entry.id.clone(),
        name: hit.entry.name.clone(),
        score: hit.score,
        status: hit.entry.status.clone(),
    }
}

fn decision_label(decision: Decision) -> &'static str {
    match decision {
        Decision::Allow => "allow",
        Decision::Prompt => "prompt",
        Decision::Deny => "deny",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, status: &str, invoke: Option<&str>, permissions: &[&str]) -> Entry {
        Entry {
            id: id.into(),
            name: id.replace('.', " "),
            description: format!("perform {id}"),
            source: "capability",
            category: "test".into(),
            tags: permissions.iter().map(|value| (*value).into()).collect(),
            invoke: invoke.map(str::to_string),
            status: status.into(),
            examples: vec!["test proof".into()],
        }
    }

    #[test]
    fn resolves_ready_invocable_capability_and_authority() {
        let entries = vec![entry(
            "messaging.imessage.send",
            "ready",
            Some("hii message send"),
            &["message known contacts"],
        )];
        let result = resolve_entries(&entries, "messaging.imessage.send", Authority::Workspace);
        assert_eq!(result.status, ResolutionStatus::Resolved);
        assert_eq!(result.availability, Some(Availability::Ready));
        assert!(result.directly_invocable);
        assert_eq!(result.required_authority, Some(Authority::ExternalCommit));
        assert_eq!(result.authority_decision.as_deref(), Some("deny"));
    }

    #[test]
    fn ready_declaration_without_adapter_is_not_directly_invocable() {
        let entries = vec![entry("hii.browser.capture", "ready", None, &["read-only"])];
        let result = resolve_entries(&entries, "hii.browser.capture", Authority::ReadOnly);
        assert_eq!(result.status, ResolutionStatus::Resolved);
        assert!(!result.directly_invocable);
        assert!(result.reason.contains("no direct HII invocation"));
    }

    #[test]
    fn runtime_class_is_not_mistaken_for_an_invocation() {
        let entries = vec![entry(
            "hii.workspace.run",
            "ready",
            Some("local-cli"),
            &["selected workspace only"],
        )];
        let result = resolve_entries(&entries, "hii.workspace.run", Authority::Workspace);
        assert!(!result.directly_invocable);
        assert!(result.invoke.is_none());
    }

    #[test]
    fn prohibition_does_not_escalate_required_authority() {
        let entries = vec![entry(
            "hii.workspace.run",
            "ready",
            Some("hii run"),
            &[
                "write selected workspace",
                "no messaging without separate explicit authority",
            ],
        )];
        let result = resolve_entries(&entries, "hii.workspace.run", Authority::Workspace);
        assert_eq!(result.required_authority, Some(Authority::Workspace));
        assert_eq!(result.authority_decision.as_deref(), Some("allow"));
    }

    #[test]
    fn close_matches_are_ambiguous() {
        let entries = vec![
            entry("mail.send", "ready", Some("hii mail send"), &[]),
            entry("message.send", "ready", Some("hii message send"), &[]),
        ];
        let result = resolve_entries(&entries, "send", Authority::ExternalCommit);
        assert_eq!(result.status, ResolutionStatus::Ambiguous);
        assert_eq!(result.candidates.len(), 2);
    }

    #[test]
    fn missing_match_is_unavailable() {
        let entries = vec![entry("code.test", "ready", Some("hii test"), &[])];
        let result = resolve_entries(&entries, "send email", Authority::Workspace);
        assert_eq!(result.status, ResolutionStatus::Unavailable);
        assert!(result.capability_id.is_none());
    }
}
