//! Compile human intent into an inspectable HII execution preflight.

use serde::Serialize;

use crate::{
    capability_resolver::{self, Availability, CapabilityResolution, ResolutionStatus},
    config::AppPaths,
    contract::Authority,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PipeStatus {
    Ready,
    NeedsApproval,
    NeedsAdapter,
    Partial,
    Ambiguous,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
pub struct PipeStage {
    pub name: &'static str,
    pub status: &'static str,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct PipePlan {
    pub schema_version: u8,
    pub intent: String,
    pub authority: Authority,
    pub status: PipeStatus,
    pub stages: Vec<PipeStage>,
    pub capability: CapabilityResolution,
    pub proof_required: String,
    pub next: String,
}

pub fn compile_for(
    paths: &AppPaths,
    intent: &str,
    capability_query: &str,
    authority: Authority,
) -> PipePlan {
    let intent = intent.trim();
    let capability = capability_resolver::resolve(paths, capability_query, authority);
    compile_resolution(intent, authority, capability)
}

fn compile_resolution(
    intent: &str,
    authority: Authority,
    capability: CapabilityResolution,
) -> PipePlan {
    let status = pipe_status(&capability);
    let capability_detail = capability
        .capability_id
        .as_deref()
        .map(|id| format!("resolved {id}"))
        .unwrap_or_else(|| capability.reason.clone());
    let authority_detail = match capability.authority_decision.as_deref() {
        Some("allow") => "current authority allows this capability".into(),
        Some("prompt") => "operator approval is required".into(),
        Some("deny") => capability.reason.clone(),
        _ => "authority cannot be decided until a capability is selected".into(),
    };
    let execution_status = match status {
        PipeStatus::Ready => "ready",
        PipeStatus::NeedsApproval => "blocked",
        PipeStatus::NeedsAdapter => "blocked",
        PipeStatus::Partial => "blocked",
        PipeStatus::Ambiguous => "blocked",
        PipeStatus::Unavailable => "blocked",
    };
    let proof_required = proof_requirement(&capability);
    let next = next_action(status, &capability);

    PipePlan {
        schema_version: 1,
        intent: intent.into(),
        authority,
        status,
        stages: vec![
            PipeStage {
                name: "parse-intent",
                status: "complete",
                detail: "intent normalized without model execution".into(),
            },
            PipeStage {
                name: "resolve-capability",
                status: if capability.status == ResolutionStatus::Resolved {
                    "complete"
                } else {
                    "blocked"
                },
                detail: capability_detail,
            },
            PipeStage {
                name: "check-authority",
                status: if capability.authority_decision.as_deref() == Some("allow") {
                    "complete"
                } else {
                    "blocked"
                },
                detail: authority_detail,
            },
            PipeStage {
                name: "execute",
                status: execution_status,
                detail: next.clone(),
            },
            PipeStage {
                name: "verify",
                status: "required",
                detail: proof_required.clone(),
            },
            PipeStage {
                name: "record",
                status: "required",
                detail: "write a receipt carrying the resolution, execution result, and proof"
                    .into(),
            },
        ],
        capability,
        proof_required,
        next,
    }
}

fn pipe_status(capability: &CapabilityResolution) -> PipeStatus {
    match capability.status {
        ResolutionStatus::Ambiguous => PipeStatus::Ambiguous,
        ResolutionStatus::Unavailable => PipeStatus::Unavailable,
        ResolutionStatus::Resolved => match capability.availability {
            Some(Availability::Partial) => PipeStatus::Partial,
            Some(Availability::Unavailable) | None => PipeStatus::Unavailable,
            Some(Availability::Ready) if !capability.directly_invocable => PipeStatus::NeedsAdapter,
            Some(Availability::Ready)
                if capability.authority_decision.as_deref() != Some("allow") =>
            {
                PipeStatus::NeedsApproval
            }
            Some(Availability::Ready) => PipeStatus::Ready,
        },
    }
}

fn proof_requirement(capability: &CapabilityResolution) -> String {
    if capability.evidence.is_empty() {
        "a capability-specific deterministic check plus a saved HII receipt".into()
    } else {
        format!(
            "verify against declared evidence ({}) and save the result in a HII receipt",
            capability.evidence.join(", ")
        )
    }
}

fn next_action(status: PipeStatus, capability: &CapabilityResolution) -> String {
    match status {
        PipeStatus::Ready => format!(
            "execute {} through the governed HII runner",
            capability
                .invoke
                .as_deref()
                .unwrap_or("the selected capability")
        ),
        PipeStatus::NeedsApproval => "obtain the authority named by the resolution".into(),
        PipeStatus::NeedsAdapter => "add a typed HII invocation adapter for this capability".into(),
        PipeStatus::Partial => "repair or complete the selected capability before execution".into(),
        PipeStatus::Ambiguous => "select one candidate explicitly by capability id".into(),
        PipeStatus::Unavailable => {
            "install or register a reviewed capability, then resolve again".into()
        }
    }
}

pub fn render(plan: &PipePlan, json: bool) -> Result<String, String> {
    if json {
        return serde_json::to_string_pretty(plan).map_err(|error| error.to_string());
    }
    let mut output = format!(
        "HII pipe: {}\nstatus     {:?}\nauthority  {}\n",
        plan.intent,
        plan.status,
        plan.authority.label()
    );
    for stage in &plan.stages {
        output.push_str(&format!(
            "{:<12} {:<8} {}\n",
            stage.name, stage.status, stage.detail
        ));
    }
    output.push_str(&format!("next       {}", plan.next));
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolution(
        availability: Availability,
        invocable: bool,
        authority_decision: &str,
    ) -> CapabilityResolution {
        CapabilityResolution {
            query: "test".into(),
            status: ResolutionStatus::Resolved,
            capability_id: Some("hii.test".into()),
            capability_name: Some("Test".into()),
            availability: Some(availability),
            directly_invocable: invocable,
            adapter: invocable
                .then_some(crate::capability_resolver::InvocationAdapter::WorkspaceRun),
            invoke: invocable.then(|| "hii test".into()),
            required_authority: Some(Authority::Workspace),
            authority_decision: Some(authority_decision.into()),
            reason: "test".into(),
            evidence: Vec::new(),
            candidates: Vec::new(),
        }
    }

    #[test]
    fn ready_requires_availability_adapter_and_authority() {
        assert_eq!(
            pipe_status(&resolution(Availability::Ready, true, "allow")),
            PipeStatus::Ready
        );
        assert_eq!(
            pipe_status(&resolution(Availability::Ready, false, "allow")),
            PipeStatus::NeedsAdapter
        );
        assert_eq!(
            pipe_status(&resolution(Availability::Ready, true, "deny")),
            PipeStatus::NeedsApproval
        );
    }

    #[test]
    fn partial_capability_cannot_enter_execution() {
        assert_eq!(
            pipe_status(&resolution(Availability::Partial, true, "allow")),
            PipeStatus::Partial
        );
    }
}
