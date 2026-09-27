//! Local service protocol between human needs and HII-hosted capabilities.
//!
//! A capability says what HII can do. A service offer makes the capability
//! discoverable as something a user or agent can request. A service request
//! binds one need to a success condition, authority envelope, provider/host,
//! and proof contract before execution. The actual work still runs through
//! HII's governed agent runner and canonical receipt.

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Reverse,
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

use crate::{
    capability_index::{self, Entry},
    capability_resolver::{self, Availability, InvocationAdapter},
    config::AppPaths,
    contract::Authority,
    identity::IdentityStore,
    pipe::{self, PipeStatus},
    receipt::Receipt,
};

const SCHEMA_VERSION: u8 = 1;
const DEFAULT_OFFER_LIMIT: usize = 20;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHost {
    pub id: String,
    pub kind: String,
    pub local: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceOffer {
    pub schema_version: u8,
    pub kind: String,
    pub id: String,
    pub provider_ref: String,
    pub host: ServiceHost,
    pub capability_id: String,
    pub name: String,
    pub description: String,
    pub availability: Availability,
    pub status: String,
    pub minimum_authority: Authority,
    pub directly_invocable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invoke: Option<String>,
    pub proof: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Requester {
    pub id: String,
    pub kind: String,
    pub label: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceRequestStatus {
    Ready,
    NeedsApproval,
    NeedsAdapter,
    Partial,
    Ambiguous,
    Unavailable,
    Fulfilled,
    Incomplete,
}

impl ServiceRequestStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::NeedsApproval => "needs-approval",
            Self::NeedsAdapter => "needs-adapter",
            Self::Partial => "partial",
            Self::Ambiguous => "ambiguous",
            Self::Unavailable => "unavailable",
            Self::Fulfilled => "fulfilled",
            Self::Incomplete => "incomplete",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FulfillmentRecord {
    pub receipt_id: String,
    pub status: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proof_strength: Option<String>,
    pub finished_at_unix_ms: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRequest {
    pub schema_version: u8,
    pub kind: String,
    pub id: String,
    pub created_at: DateTime<Local>,
    pub requester: Requester,
    pub need: String,
    pub success_condition: String,
    pub authority: Authority,
    pub status: ServiceRequestStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<ServiceOffer>,
    pub proof_required: Vec<String>,
    pub next: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fulfillment: Option<FulfillmentRecord>,
}

#[derive(Clone, Debug)]
pub struct ExecutionSpec {
    pub goal: String,
    pub authority: Authority,
    pub done_when: String,
    pub skill_ids: Vec<String>,
}

pub fn offers(paths: &AppPaths, query: &str, limit: Option<usize>) -> Vec<ServiceOffer> {
    let entries = capability_index::load_all(paths);
    let limit = limit.unwrap_or(DEFAULT_OFFER_LIMIT).max(1);
    let selected = if query.trim().is_empty() {
        entries.iter().take(limit).cloned().collect::<Vec<_>>()
    } else {
        capability_index::search(&entries, query, limit)
            .into_iter()
            .map(|hit| hit.entry)
            .collect()
    };
    selected
        .into_iter()
        .filter_map(|entry| offer_from_entry(&entries, entry))
        .collect()
}

pub fn create_request(
    paths: &AppPaths,
    need: &str,
    capability_query: Option<&str>,
    authority: Authority,
    done_when: &str,
    proof_required: &[String],
) -> Result<ServiceRequest, String> {
    let need = required_text("service request need", need)?;
    let done_when = required_text("--done-when", done_when)?;
    let query = capability_query.unwrap_or(need);
    let plan = pipe::compile_for(paths, need, query, authority);
    let service = plan
        .capability
        .capability_id
        .as_deref()
        .and_then(|id| offer_by_id(paths, id));
    let status = request_status(plan.status);
    let id = format!("req-{}", Uuid::new_v4());
    let proof_required = normalized_proof(proof_required, &plan.proof_required);
    let request = ServiceRequest {
        schema_version: SCHEMA_VERSION,
        kind: "hii.service.request".into(),
        id: id.clone(),
        created_at: Local::now(),
        requester: current_requester(paths)?,
        need: need.into(),
        success_condition: done_when.into(),
        authority,
        status,
        service,
        proof_required,
        next: request_next(status, &id, &plan.next),
        fulfillment: None,
    };
    write_request(paths, &request)?;
    Ok(request)
}

pub fn list_requests(paths: &AppPaths) -> Result<Vec<ServiceRequest>, String> {
    let dir = request_dir(paths);
    let Ok(read) = fs::read_dir(dir) else {
        return Ok(Vec::new());
    };
    let mut requests = read
        .flatten()
        .filter_map(|entry| read_request_path(&entry.path()).ok())
        .collect::<Vec<_>>();
    requests.sort_by_key(|request| Reverse(request.created_at));
    Ok(requests)
}

pub fn read_request(paths: &AppPaths, id: &str) -> Result<ServiceRequest, String> {
    validate_request_id(id)?;
    read_request_path(&request_path(paths, id))
}

pub fn prepare_fulfillment(
    paths: &AppPaths,
    request: &ServiceRequest,
) -> Result<ExecutionSpec, String> {
    if request.status == ServiceRequestStatus::Fulfilled {
        return Err(format!(
            "service request {} is already fulfilled",
            request.id
        ));
    }
    let service = request
        .service
        .as_ref()
        .ok_or_else(|| format!("service request {} has no selected service", request.id))?;
    let plan = pipe::compile_for(
        paths,
        &request.need,
        &service.capability_id,
        request.authority,
    );
    if plan.status != PipeStatus::Ready {
        return Err(format!(
            "service request {} is {}: {}",
            request.id,
            request_status(plan.status).label(),
            plan.next
        ));
    }
    let skill_ids = match plan.capability.adapter {
        Some(InvocationAdapter::WorkspaceRun) => Vec::new(),
        Some(InvocationAdapter::SkillRun { skill_id }) => vec![skill_id],
        None => return Err("selected service has no typed invocation adapter".into()),
    };
    let proof = request.proof_required.join("; ");
    Ok(ExecutionSpec {
        goal: format!(
            "Fulfill HII service request {}.\nNeed: {}\nRequired proof: {}",
            request.id, request.need, proof
        ),
        authority: request.authority,
        done_when: request.success_condition.clone(),
        skill_ids,
    })
}

pub fn record_fulfillment(
    paths: &AppPaths,
    request_id: &str,
    receipt: &Receipt,
) -> Result<ServiceRequest, String> {
    let mut request = read_request(paths, request_id)?;
    let satisfied = receipt
        .completion
        .as_ref()
        .is_some_and(|assessment| assessment.satisfied);
    request.status = if satisfied {
        ServiceRequestStatus::Fulfilled
    } else {
        ServiceRequestStatus::Incomplete
    };
    request.next = if satisfied {
        "inspect the receipt and use the fulfilled result".into()
    } else {
        receipt
            .next
            .clone()
            .unwrap_or_else(|| "inspect the receipt, resolve missing proof, and retry".into())
    };
    request.fulfillment = Some(FulfillmentRecord {
        receipt_id: receipt.id.clone(),
        status: receipt.status.clone(),
        summary: receipt.summary.clone(),
        proof_strength: receipt
            .completion
            .as_ref()
            .map(|assessment| assessment.proof_strength.label().to_string()),
        finished_at_unix_ms: receipt.finished_at_unix_ms,
    });
    write_request(paths, &request)?;
    Ok(request)
}

pub fn render_offers(offers: &[ServiceOffer], json: bool) -> Result<String, String> {
    if json {
        return serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "kind": "hii.service.catalog",
            "offers": offers,
        }))
        .map_err(|error| error.to_string());
    }
    if offers.is_empty() {
        return Ok("No HII service offers matched.".into());
    }
    let mut output = String::from("HII services\n");
    for offer in offers {
        output.push_str(&format!(
            "{:<44} {:<11} {:<17} {}\n",
            offer.capability_id,
            availability_label(offer.availability),
            offer.minimum_authority.label(),
            offer.name
        ));
    }
    Ok(output.trim_end().into())
}

pub fn render_request(request: &ServiceRequest, json: bool) -> Result<String, String> {
    if json {
        return serde_json::to_string_pretty(request).map_err(|error| error.to_string());
    }
    let service = request
        .service
        .as_ref()
        .map(|offer| format!("{} · {}", offer.provider_ref, offer.capability_id))
        .unwrap_or_else(|| "unresolved".into());
    let proof = request.proof_required.join("; ");
    let mut output = format!(
        "HII service request {}\nneed       {}\nrequester  {}\nservice    {}\nstatus     {}\nauthority  {}\nsuccess    {}\nproof      {}\nnext       {}",
        request.id,
        request.need,
        request.requester.label,
        service,
        request.status.label(),
        request.authority.label(),
        request.success_condition,
        proof,
        request.next
    );
    if let Some(fulfillment) = &request.fulfillment {
        output.push_str(&format!("\nreceipt    {}", fulfillment.receipt_id));
    }
    Ok(output)
}

pub fn render_requests(requests: &[ServiceRequest], json: bool) -> Result<String, String> {
    if json {
        return serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "kind": "hii.service.requests",
            "requests": requests,
        }))
        .map_err(|error| error.to_string());
    }
    if requests.is_empty() {
        return Ok("No HII service requests recorded.".into());
    }
    let mut output = String::from("HII service requests\n");
    for request in requests {
        output.push_str(&format!(
            "{:<41} {:<16} {}\n",
            request.id,
            request.status.label(),
            request.need
        ));
    }
    Ok(output.trim_end().into())
}

fn offer_by_id(paths: &AppPaths, id: &str) -> Option<ServiceOffer> {
    let entries = capability_index::load_all(paths);
    let entry = entries.iter().find(|entry| entry.id == id)?.clone();
    offer_from_entry(&entries, entry)
}

fn offer_from_entry(entries: &[Entry], entry: Entry) -> Option<ServiceOffer> {
    if entry.source == "draft" {
        return None;
    }
    let resolution = capability_resolver::resolve_entries(entries, &entry.id, Authority::Yolo);
    let availability = resolution.availability?;
    Some(ServiceOffer {
        schema_version: SCHEMA_VERSION,
        kind: "hii.service.offer".into(),
        id: format!("service:{}", entry.id),
        provider_ref: provider_ref(&entry),
        host: ServiceHost {
            id: "hii.local-runtime".into(),
            kind: "user-owned-system".into(),
            local: true,
        },
        capability_id: entry.id,
        name: entry.name,
        description: entry.description,
        availability,
        status: entry.status,
        minimum_authority: resolution.required_authority.unwrap_or(Authority::ReadOnly),
        directly_invocable: resolution.directly_invocable,
        invoke: resolution.invoke,
        proof: resolution.evidence,
    })
}

fn provider_ref(entry: &Entry) -> String {
    match (entry.source, entry.category.trim()) {
        ("capability", "") => "hii.runtime".into(),
        ("capability", owner)
            if owner.eq_ignore_ascii_case("aii")
                || owner == "hii-core-loop"
                || owner == "hii.runtime" =>
        {
            "hii.runtime".into()
        }
        ("capability", owner) => format!("hii.capability:{owner}"),
        ("skill", "") => "hii.skill-registry".into(),
        ("skill", category) => format!("hii.skill-registry:{category}"),
        (source, "") => format!("hii.registry:{source}"),
        (source, category) => format!("hii.registry:{source}:{category}"),
    }
}

fn current_requester(paths: &AppPaths) -> Result<Requester, String> {
    Ok(match IdentityStore::open(paths).current()? {
        Some(identity) => Requester {
            id: identity.id,
            kind: "human".into(),
            label: identity.name,
        },
        None => Requester {
            id: "hii-user:local".into(),
            kind: "human".into(),
            label: "Local HII user".into(),
        },
    })
}

fn request_status(status: PipeStatus) -> ServiceRequestStatus {
    match status {
        PipeStatus::Ready => ServiceRequestStatus::Ready,
        PipeStatus::NeedsApproval => ServiceRequestStatus::NeedsApproval,
        PipeStatus::NeedsAdapter => ServiceRequestStatus::NeedsAdapter,
        PipeStatus::Partial => ServiceRequestStatus::Partial,
        PipeStatus::Ambiguous => ServiceRequestStatus::Ambiguous,
        PipeStatus::Unavailable => ServiceRequestStatus::Unavailable,
    }
}

fn request_next(status: ServiceRequestStatus, id: &str, blocked_next: &str) -> String {
    if status == ServiceRequestStatus::Ready {
        format!("hii service fulfill {id}")
    } else {
        blocked_next.into()
    }
}

fn normalized_proof(values: &[String], fallback: &str) -> Vec<String> {
    let mut proof = values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    proof.sort();
    proof.dedup();
    if proof.is_empty() {
        proof.push(fallback.into());
    }
    proof
}

fn required_text<'a>(label: &str, value: &'a str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{label} cannot be empty"))
    } else {
        Ok(value)
    }
}

fn request_dir(paths: &AppPaths) -> PathBuf {
    paths.runtime.join("services/requests")
}

fn request_path(paths: &AppPaths, id: &str) -> PathBuf {
    request_dir(paths).join(format!("{id}.json"))
}

fn validate_request_id(id: &str) -> Result<(), String> {
    if id.starts_with("req-") && id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-') {
        Ok(())
    } else {
        Err("invalid service request id".into())
    }
}

fn read_request_path(path: &Path) -> Result<ServiceRequest, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("cannot read service request {}: {error}", path.display()))?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("invalid service request {}: {error}", path.display()))
}

fn write_request(paths: &AppPaths, request: &ServiceRequest) -> Result<(), String> {
    validate_request_id(&request.id)?;
    let path = request_path(paths, &request.id);
    crate::store::write_json_private_atomic(&path, request)
}

fn availability_label(value: Availability) -> &'static str {
    match value {
        Availability::Ready => "ready",
        Availability::Partial => "partial",
        Availability::Unavailable => "unavailable",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::completion::{CompletionAssessment, ProofStrength};
    use std::{
        env,
        sync::atomic::{AtomicUsize, Ordering},
    };

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            static COUNT: AtomicUsize = AtomicUsize::new(0);
            let path = env::temp_dir().join(format!(
                "hii-service-test-{}-{label}-{}",
                std::process::id(),
                COUNT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn paths(temp: &TempDir) -> AppPaths {
        AppPaths {
            repo: temp.0.join("workspace"),
            runtime: temp.0.join("runtime"),
        }
    }

    fn seed_workspace_service(paths: &AppPaths) {
        fs::create_dir_all(&paths.runtime).unwrap();
        fs::write(
            paths.runtime.join("capabilities.json"),
            r#"[{"id":"hii.agent.workspace_run","name":"Workspace run","summary":"Fulfill bounded local work","owner":"hii.runtime","permissions":["write selected workspace"],"runtime":"local-cli","status":"ready","evidence":["saved HII receipt"]}]"#,
        )
        .unwrap();
    }

    fn completed_receipt(id: &str) -> Receipt {
        Receipt {
            schema_version: 8,
            id: id.into(),
            created_at_unix_ms: 1,
            finished_at_unix_ms: 2,
            status: "completed".into(),
            goal: "fulfill".into(),
            workspace: "/tmp/workspace".into(),
            model: "test".into(),
            review_model: None,
            steps: 1,
            summary: "fulfilled with proof".into(),
            verification: Vec::new(),
            git_status: String::new(),
            next: None,
            review: None,
            risk: "low".into(),
            authority: Some("workspace".into()),
            done_when: Some("done".into()),
            approvals: Vec::new(),
            artifacts: Vec::new(),
            reversible: Some(true),
            context_sources: Vec::new(),
            preexisting_changes: Vec::new(),
            hooks: Vec::new(),
            outcome: "completed".into(),
            exit_code: 0,
            completion: Some(CompletionAssessment {
                version: 1,
                satisfied: true,
                proof_strength: ProofStrength::Declared,
                outcome_kind: Some("informational".into()),
                unmet_requirements: Vec::new(),
                failed_checks: Vec::new(),
                missing_artifacts: Vec::new(),
                invalid_artifacts: Vec::new(),
                warnings: Vec::new(),
                evidence: Vec::new(),
            }),
            model_source: Some("test".into()),
            autonomy_level: Some("local-full".into()),
            learning_candidates: Vec::new(),
            user_corrections: Vec::new(),
            failure_patterns: Vec::new(),
            skill_draft_ref: None,
            token_usage: None,
            engine: None,
        }
    }

    #[test]
    fn projects_live_capabilities_as_service_offers() {
        let temp = TempDir::new("offers");
        let paths = paths(&temp);
        seed_workspace_service(&paths);

        let offers = offers(&paths, "hii.agent.workspace_run", Some(5));
        assert_eq!(offers.len(), 1);
        assert_eq!(offers[0].host.id, "hii.local-runtime");
        assert_eq!(offers[0].provider_ref, "hii.runtime");
        assert_eq!(offers[0].minimum_authority, Authority::Workspace);
        assert!(offers[0].directly_invocable);
    }

    #[test]
    fn saves_a_need_with_identity_authority_success_and_proof() {
        let temp = TempDir::new("request");
        let paths = paths(&temp);
        seed_workspace_service(&paths);
        IdentityStore::open(&paths)
            .create_or_update("Ummi", None)
            .unwrap();

        let request = create_request(
            &paths,
            "prepare a verified project brief",
            Some("hii.agent.workspace_run"),
            Authority::Workspace,
            "the brief exists and its checks pass",
            &["brief validator passes".into()],
        )
        .unwrap();

        assert_eq!(request.requester.label, "Ummi");
        assert_eq!(request.status, ServiceRequestStatus::Ready);
        assert_eq!(request.proof_required, ["brief validator passes"]);
        assert!(request.next.contains("hii service fulfill"));
        assert_eq!(
            read_request(&paths, &request.id).unwrap().need,
            request.need
        );
    }

    #[test]
    fn unresolved_needs_remain_durable_without_fake_fulfillment() {
        let temp = TempDir::new("unavailable");
        let paths = paths(&temp);
        let request = create_request(
            &paths,
            "teleport the building",
            Some("missing.capability"),
            Authority::ReadOnly,
            "the building is at its destination",
            &[],
        )
        .unwrap();

        assert_eq!(request.status, ServiceRequestStatus::Unavailable);
        assert!(request.service.is_none());
        assert!(prepare_fulfillment(&paths, &request).is_err());
    }

    #[test]
    fn fulfillment_rechecks_live_service_and_links_canonical_receipt() {
        let temp = TempDir::new("fulfill");
        let paths = paths(&temp);
        seed_workspace_service(&paths);
        let request = create_request(
            &paths,
            "prepare a verified project brief",
            Some("hii.agent.workspace_run"),
            Authority::Workspace,
            "the brief exists and its checks pass",
            &[],
        )
        .unwrap();

        let spec = prepare_fulfillment(&paths, &request).unwrap();
        assert!(spec.goal.contains(&request.id));
        assert_eq!(spec.authority, Authority::Workspace);
        assert!(spec.skill_ids.is_empty());

        let updated = record_fulfillment(&paths, &request.id, &completed_receipt("run-1")).unwrap();
        assert_eq!(updated.status, ServiceRequestStatus::Fulfilled);
        assert_eq!(updated.fulfillment.unwrap().receipt_id, "run-1");
    }

    #[test]
    fn request_ids_cannot_escape_the_service_store() {
        let temp = TempDir::new("path-boundary");
        let paths = paths(&temp);
        assert!(read_request(&paths, "../../receipt").is_err());
    }
}
