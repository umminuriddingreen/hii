// SPDX-License-Identifier: LicenseRef-BSL-1.1

//! Advances browser-backed intent cases through proposal, authority, action, and verification.

use super::{authority, capability, model::*, observation::*, receipt::*};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub trait BrowserPortV1 {
    fn execute(&mut self, command: BrowserCommandV1) -> Result<BrowserResultV1, BrowserErrorV1>;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebIntentStatusV1 {
    Declared,
    Observing,
    Planned,
    AwaitingAuthority,
    Acting,
    Verifying,
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSuccessCriterionV1 {
    pub id: String,
    pub description: String,
    pub verified: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionProposalV1 {
    pub capability_id: String,
    pub target: ElementRef,
    pub expected_page_revision: PageRevision,
    pub expected_effect: String,
    pub selected_item: String,
    pub requires_approval: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebIntentCaseV1 {
    pub schema_version: u8,
    pub id: String,
    pub intent: String,
    pub status: WebIntentStatusV1,
    pub success_contract: Vec<WebSuccessCriterionV1>,
    pub observations: Vec<BrowserObservationV1>,
    pub proposal: Option<BrowserActionProposalV1>,
    pub authority_decision: Option<authority::WebAuthorityDecisionV1>,
    pub actions: Vec<BrowserActionEvidenceV1>,
    pub verification: Vec<WebVerificationV1>,
    pub outcome: Option<String>,
    pub receipt: Option<WebReceiptV1>,
}

pub fn new_least_expensive_case(intent: &str) -> WebIntentCaseV1 {
    WebIntentCaseV1 {
        schema_version: 1,
        id: format!("intent-case:{}", Uuid::new_v4()),
        intent: intent.trim().into(),
        status: WebIntentStatusV1::Declared,
        success_contract: vec![
            WebSuccessCriterionV1 {
                id: "least_expensive_available_item_selected".into(),
                description: "The least expensive available item is selected".into(),
                verified: false,
            },
            WebSuccessCriterionV1 {
                id: "selected_item_details_open".into(),
                description: "The selected item's details page is open".into(),
                verified: false,
            },
        ],
        observations: Vec::new(),
        proposal: None,
        authority_decision: None,
        actions: Vec::new(),
        verification: Vec::new(),
        outcome: None,
        receipt: None,
    }
}

pub fn propose_least_expensive(
    case: &mut WebIntentCaseV1,
    requires_approval: bool,
) -> Result<(), BrowserErrorV1> {
    let observation = case.observations.last().ok_or_else(|| {
        error(
            BrowserErrorCodeV1::InvalidRequest,
            "cannot plan without a browser observation",
        )
    })?;
    let selected = observation
        .interactive_elements
        .iter()
        .filter_map(item_candidate)
        .filter(|candidate| candidate.available)
        .min_by_key(|candidate| candidate.price_cents)
        .ok_or_else(|| {
            error(
                BrowserErrorCodeV1::VerificationFailed,
                "no available item was observed",
            )
        })?;
    case.proposal = Some(BrowserActionProposalV1 {
        capability_id: "web.click".into(),
        target: selected.element_ref,
        expected_page_revision: observation.revision,
        expected_effect: format!("open {} details", selected.name),
        selected_item: selected.name,
        requires_approval,
    });
    case.status = WebIntentStatusV1::Planned;
    Ok(())
}

pub fn execute_proposal<P: BrowserPortV1>(
    case: &mut WebIntentCaseV1,
    port: &mut P,
    session_id: &BrowserSessionId,
    page_id: &PageId,
    web_authority: authority::WebAuthorityV1,
    approval_granted: bool,
) -> Result<(), BrowserErrorV1> {
    let proposal = case.proposal.clone().ok_or_else(|| {
        error(
            BrowserErrorCodeV1::InvalidRequest,
            "intent case has no action proposal",
        )
    })?;
    let registered = capability::capability(&proposal.capability_id).ok_or_else(|| {
        error(
            BrowserErrorCodeV1::CapabilityNotRegistered,
            "proposal references an unregistered capability",
        )
    })?;
    let observation = case.observations.last().ok_or_else(|| {
        error(
            BrowserErrorCodeV1::InvalidRequest,
            "intent case has no current browser observation",
        )
    })?;
    if observation.revision != proposal.expected_page_revision {
        return Err(BrowserErrorV1 {
            code: BrowserErrorCodeV1::StaleObservation,
            message: "proposal page revision is stale".into(),
            current_revision: Some(observation.revision),
        });
    }
    if !observation
        .interactive_elements
        .iter()
        .any(|element| element.element_ref == proposal.target)
    {
        return Err(error(
            BrowserErrorCodeV1::UnknownElement,
            "proposal target does not exist in the current observation",
        ));
    }
    let decision = authority::decide(
        web_authority,
        registered.mutates_browser,
        proposal.requires_approval,
        approval_granted,
    );
    case.authority_decision = Some(decision);
    match decision {
        authority::WebAuthorityDecisionV1::AwaitingAuthority => {
            case.status = WebIntentStatusV1::AwaitingAuthority;
            return Err(error(
                BrowserErrorCodeV1::AwaitingAuthority,
                "browser action requires approval",
            ));
        }
        authority::WebAuthorityDecisionV1::Deny => {
            return Err(error(
                BrowserErrorCodeV1::AwaitingAuthority,
                "browser authority does not permit interaction",
            ));
        }
        authority::WebAuthorityDecisionV1::Allow => {}
    }
    case.status = WebIntentStatusV1::Acting;
    let result = port.execute(BrowserCommandV1::Click {
        session_id: session_id.clone(),
        page_id: page_id.clone(),
        target: proposal.target,
        expected_page_revision: proposal.expected_page_revision,
    })?;
    let BrowserResultV1::Action {
        mut evidence,
        observation,
    } = result
    else {
        return Err(error(
            BrowserErrorCodeV1::BrowserFailure,
            "browser worker returned an invalid click result",
        ));
    };
    evidence.authority_decision = Some(decision);
    case.actions.push(evidence);
    case.observations.push(observation);
    case.status = WebIntentStatusV1::Verifying;
    verify_selected_item(case)
}

pub fn run_least_expensive_available<P: BrowserPortV1>(
    port: &mut P,
    url: &str,
    requires_approval: bool,
    approval_granted: bool,
) -> Result<WebIntentCaseV1, BrowserErrorV1> {
    let mut case =
        new_least_expensive_case("Find the least expensive available item and open its details.");
    case.status = WebIntentStatusV1::Observing;
    let opened = port.execute(BrowserCommandV1::SessionOpen { isolated: true })?;
    let BrowserResultV1::SessionOpened {
        session_id,
        page_id,
    } = opened
    else {
        return Err(error(
            BrowserErrorCodeV1::BrowserFailure,
            "browser worker did not open a session",
        ));
    };
    port.execute(BrowserCommandV1::Navigate {
        session_id: session_id.clone(),
        page_id: page_id.clone(),
        url: url.into(),
    })?;
    observe(&mut case, port, &session_id, &page_id)?;
    propose_least_expensive(&mut case, requires_approval)?;
    match execute_proposal(
        &mut case,
        port,
        &session_id,
        &page_id,
        authority::WebAuthorityV1::Interact,
        approval_granted,
    ) {
        Err(error) if error.code == BrowserErrorCodeV1::StaleObservation => {
            observe(&mut case, port, &session_id, &page_id)?;
            propose_least_expensive(&mut case, requires_approval)?;
            execute_proposal(
                &mut case,
                port,
                &session_id,
                &page_id,
                authority::WebAuthorityV1::Interact,
                approval_granted,
            )?;
        }
        Err(error) if error.code == BrowserErrorCodeV1::AwaitingAuthority => return Ok(case),
        Err(error) => return Err(error),
        Ok(()) => {}
    }
    Ok(case)
}

fn observe<P: BrowserPortV1>(
    case: &mut WebIntentCaseV1,
    port: &mut P,
    session_id: &BrowserSessionId,
    page_id: &PageId,
) -> Result<(), BrowserErrorV1> {
    let result = port.execute(BrowserCommandV1::Observe {
        session_id: session_id.clone(),
        page_id: page_id.clone(),
    })?;
    let BrowserResultV1::Observation { observation } = result else {
        return Err(error(
            BrowserErrorCodeV1::BrowserFailure,
            "browser worker returned an invalid observation",
        ));
    };
    case.observations.push(observation);
    Ok(())
}

fn verify_selected_item(case: &mut WebIntentCaseV1) -> Result<(), BrowserErrorV1> {
    let proposal = case.proposal.as_ref().ok_or_else(|| {
        error(
            BrowserErrorCodeV1::VerificationFailed,
            "verification has no proposal",
        )
    })?;
    let observation = case.observations.last().ok_or_else(|| {
        error(
            BrowserErrorCodeV1::VerificationFailed,
            "verification has no resulting observation",
        )
    })?;
    let selected_matches = observation
        .visible_text
        .to_ascii_lowercase()
        .contains(&proposal.selected_item.to_ascii_lowercase());
    let details_open = observation
        .visible_text
        .to_ascii_lowercase()
        .contains("item details");
    let evidence_ids = vec![observation.observation_id.0.clone()];
    case.verification = vec![
        WebVerificationV1 {
            criterion: "least_expensive_available_item_selected".into(),
            passed: selected_matches,
            evidence_ids: evidence_ids.clone(),
            detail: format!("resulting page identifies {}", proposal.selected_item),
        },
        WebVerificationV1 {
            criterion: "selected_item_details_open".into(),
            passed: details_open,
            evidence_ids,
            detail: "resulting page exposes item details".into(),
        },
    ];
    for criterion in &mut case.success_contract {
        criterion.verified = case
            .verification
            .iter()
            .find(|verification| verification.criterion == criterion.id)
            .is_some_and(|verification| verification.passed);
    }
    let passed = case
        .success_contract
        .iter()
        .all(|criterion| criterion.verified);
    case.status = if passed {
        WebIntentStatusV1::Succeeded
    } else {
        WebIntentStatusV1::Failed
    };
    case.outcome = passed.then(|| format!("{} details opened", proposal.selected_item));
    case.receipt = Some(WebReceiptV1 {
        schema_version: 1,
        intent_case_id: case.id.clone(),
        intent: case.intent.clone(),
        status: if passed { "succeeded" } else { "failed" }.into(),
        observations: case
            .observations
            .iter()
            .map(|observation| observation.observation_id.clone())
            .collect(),
        actions: case.actions.clone(),
        verification: case.verification.clone(),
        outcome: case.outcome.clone(),
        created_at: Utc::now().to_rfc3339(),
    });
    if passed {
        Ok(())
    } else {
        Err(error(
            BrowserErrorCodeV1::VerificationFailed,
            "browser action executed but the intent success contract failed",
        ))
    }
}

struct ItemCandidate {
    element_ref: ElementRef,
    name: String,
    price_cents: u64,
    available: bool,
}

fn item_candidate(element: &InteractiveElementV1) -> Option<ItemCandidate> {
    if element.role != "button" || !element.state.enabled || !element.state.visible {
        return None;
    }
    let parts = element.name.split('|').map(str::trim).collect::<Vec<_>>();
    if parts.len() != 3 {
        return None;
    }
    let name = parts[0]
        .strip_prefix("Open ")?
        .strip_suffix(" details")?
        .to_string();
    let price_cents = parse_price(parts[1])?;
    Some(ItemCandidate {
        element_ref: element.element_ref.clone(),
        name,
        price_cents,
        available: parts[2].eq_ignore_ascii_case("available"),
    })
}

fn parse_price(value: &str) -> Option<u64> {
    let value = value.trim().strip_prefix('$')?;
    let mut parts = value.split('.');
    let dollars = parts.next()?.parse::<u64>().ok()?;
    let cents = parts.next().unwrap_or("0");
    if parts.next().is_some() || cents.len() > 2 {
        return None;
    }
    let cents = match cents.len() {
        0 => 0,
        1 => cents.parse::<u64>().ok()? * 10,
        _ => cents.parse::<u64>().ok()?,
    };
    Some(dollars * 100 + cents)
}

fn error(code: BrowserErrorCodeV1, message: &str) -> BrowserErrorV1 {
    BrowserErrorV1 {
        code,
        message: message.into(),
        current_revision: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct FakePort {
        results: VecDeque<Result<BrowserResultV1, BrowserErrorV1>>,
        mutations: usize,
    }

    impl BrowserPortV1 for FakePort {
        fn execute(
            &mut self,
            command: BrowserCommandV1,
        ) -> Result<BrowserResultV1, BrowserErrorV1> {
            if matches!(command, BrowserCommandV1::Click { .. }) {
                self.mutations += 1;
            }
            self.results.pop_front().expect("fake result")
        }
    }

    fn element(reference: &str, name: &str) -> InteractiveElementV1 {
        InteractiveElementV1 {
            element_ref: reference.into(),
            role: "button".into(),
            name: name.into(),
            state: ElementStateV1 {
                enabled: true,
                visible: true,
                checked: None,
                selected: None,
            },
        }
    }

    fn observation(
        revision: u64,
        elements: Vec<InteractiveElementV1>,
        text: &str,
    ) -> BrowserObservationV1 {
        BrowserObservationV1 {
            observation_id: ObservationId(format!("obs_{revision}")),
            session_id: "browser_1".into(),
            page_id: "page_1".into(),
            url: "http://127.0.0.1/items".into(),
            title: "Items".into(),
            revision,
            interactive_elements: elements,
            visible_text: text.into(),
            aria_snapshot: String::new(),
            navigation_state: "complete".into(),
            evidence: BrowserEvidenceV1 {
                source: "browser".into(),
                observed_at: "now".into(),
                page_revision: revision,
                digest: format!("digest_{revision}"),
            },
        }
    }

    fn action_result(item: &str, revision: u64) -> BrowserResultV1 {
        BrowserResultV1::Action {
            evidence: BrowserActionEvidenceV1 {
                action_id: "action_1".into(),
                capability_id: "web.click".into(),
                page_id: "page_1".into(),
                expected_page_revision: revision - 1,
                resulting_page_revision: revision,
                target: Some("e_2".into()),
                authority_decision: None,
                mechanical_success: true,
                observed_at: "now".into(),
                digest: "action_digest".into(),
            },
            observation: observation(revision, vec![], &format!("Item details {item}")),
        }
    }

    fn base_results(
        observation: BrowserObservationV1,
    ) -> VecDeque<Result<BrowserResultV1, BrowserErrorV1>> {
        VecDeque::from([
            Ok(BrowserResultV1::SessionOpened {
                session_id: "browser_1".into(),
                page_id: "page_1".into(),
            }),
            Ok(BrowserResultV1::Waited),
            Ok(BrowserResultV1::Observation { observation }),
        ])
    }

    #[test]
    fn deterministic_vertical_slice_completes_with_causal_receipt() {
        let observed = observation(
            1,
            vec![
                element("e_1", "Open Alpha details | $12.00 | available"),
                element("e_2", "Open Beta details | $8.00 | available"),
                element("e_3", "Open Gamma details | $5.00 | unavailable"),
            ],
            "Items",
        );
        let mut results = base_results(observed);
        results.push_back(Ok(action_result("Beta", 2)));
        let mut port = FakePort {
            results,
            mutations: 0,
        };
        let case = run_least_expensive_available(&mut port, "http://127.0.0.1/items", false, false)
            .unwrap();
        assert_eq!(case.status, WebIntentStatusV1::Succeeded);
        assert_eq!(case.outcome.as_deref(), Some("Beta details opened"));
        assert_eq!(port.mutations, 1);
        let receipt = case.receipt.unwrap();
        assert!(receipt.verification.iter().all(|item| item.passed));
        assert!(receipt.actions.iter().all(|action| {
            action.authority_decision == Some(authority::WebAuthorityDecisionV1::Allow)
        }));
    }

    #[test]
    fn stale_observation_reobserves_and_replans() {
        let initial = observation(
            1,
            vec![element("e_1", "Open Alpha details | $9.00 | available")],
            "Items",
        );
        let changed = observation(
            2,
            vec![element("e_2", "Open Beta details | $7.00 | available")],
            "Items changed",
        );
        let mut results = base_results(initial);
        results.push_back(Err(BrowserErrorV1 {
            code: BrowserErrorCodeV1::StaleObservation,
            message: "changed".into(),
            current_revision: Some(2),
        }));
        results.push_back(Ok(BrowserResultV1::Observation {
            observation: changed,
        }));
        results.push_back(Ok(action_result("Beta", 3)));
        let mut port = FakePort {
            results,
            mutations: 0,
        };
        let case = run_least_expensive_available(&mut port, "http://127.0.0.1/items", false, false)
            .unwrap();
        assert_eq!(case.status, WebIntentStatusV1::Succeeded);
        assert_eq!(port.mutations, 2);
    }

    #[test]
    fn nonexistent_element_is_rejected_before_browser_mutation() {
        let mut case = new_least_expensive_case("test");
        case.observations.push(observation(1, vec![], "Items"));
        case.proposal = Some(BrowserActionProposalV1 {
            capability_id: "web.click".into(),
            target: "e_missing".into(),
            expected_page_revision: 1,
            expected_effect: "none".into(),
            selected_item: "Missing".into(),
            requires_approval: false,
        });
        let mut port = FakePort {
            results: VecDeque::new(),
            mutations: 0,
        };
        let error = execute_proposal(
            &mut case,
            &mut port,
            &"browser_1".into(),
            &"page_1".into(),
            authority::WebAuthorityV1::Interact,
            false,
        )
        .unwrap_err();
        assert_eq!(error.code, BrowserErrorCodeV1::UnknownElement);
        assert_eq!(port.mutations, 0);
    }

    #[test]
    fn unregistered_capability_is_rejected_before_browser_mutation() {
        let mut case = new_least_expensive_case("test");
        case.observations.push(observation(
            1,
            vec![element("e_1", "Open Alpha details | $9.00 | available")],
            "Items",
        ));
        case.proposal = Some(BrowserActionProposalV1 {
            capability_id: "playwright.evaluate".into(),
            target: "e_1".into(),
            expected_page_revision: 1,
            expected_effect: "none".into(),
            selected_item: "Alpha".into(),
            requires_approval: false,
        });
        let mut port = FakePort {
            results: VecDeque::new(),
            mutations: 0,
        };
        let error = execute_proposal(
            &mut case,
            &mut port,
            &"browser_1".into(),
            &"page_1".into(),
            authority::WebAuthorityV1::Interact,
            false,
        )
        .unwrap_err();
        assert_eq!(error.code, BrowserErrorCodeV1::CapabilityNotRegistered);
        assert_eq!(port.mutations, 0);
    }

    #[test]
    fn consequential_action_waits_for_authority_without_mutation() {
        let observed = observation(
            1,
            vec![element("e_1", "Open Alpha details | $9.00 | available")],
            "Items",
        );
        let results = base_results(observed);
        let mut port = FakePort {
            results,
            mutations: 0,
        };
        let case = run_least_expensive_available(&mut port, "http://127.0.0.1/items", true, false)
            .unwrap();
        assert_eq!(case.status, WebIntentStatusV1::AwaitingAuthority);
        assert_eq!(port.mutations, 0);
    }

    #[test]
    fn mechanical_action_success_does_not_equal_intent_success() {
        let observed = observation(
            1,
            vec![element("e_1", "Open Alpha details | $9.00 | available")],
            "Items",
        );
        let mut results = base_results(observed);
        results.push_back(Ok(action_result("Wrong item", 2)));
        let mut port = FakePort {
            results,
            mutations: 0,
        };
        let error =
            run_least_expensive_available(&mut port, "http://127.0.0.1/items", false, false)
                .unwrap_err();
        assert_eq!(error.code, BrowserErrorCodeV1::VerificationFailed);
        assert_eq!(port.mutations, 1);
    }

    #[test]
    fn deterministic_control_requires_no_model() {
        let observed = observation(
            1,
            vec![element("e_1", "Open Alpha details | $9.00 | available")],
            "Items",
        );
        let mut case = new_least_expensive_case("test");
        case.observations.push(observed);
        propose_least_expensive(&mut case, false).unwrap();
        assert_eq!(case.proposal.unwrap().selected_item, "Alpha");
    }
}
