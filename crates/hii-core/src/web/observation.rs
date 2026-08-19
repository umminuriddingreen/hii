// SPDX-License-Identifier: LicenseRef-BSL-1.1

//! Defines revisioned browser reality and action evidence.

use super::{authority::WebAuthorityDecisionV1, model::*};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementStateV1 {
    pub enabled: bool,
    pub visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveElementV1 {
    pub element_ref: ElementRef,
    pub role: String,
    pub name: String,
    pub state: ElementStateV1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEvidenceV1 {
    pub source: String,
    pub observed_at: String,
    pub page_revision: PageRevision,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserObservationV1 {
    pub observation_id: ObservationId,
    pub session_id: BrowserSessionId,
    pub page_id: PageId,
    pub url: String,
    pub title: String,
    pub revision: PageRevision,
    pub interactive_elements: Vec<InteractiveElementV1>,
    pub visible_text: String,
    pub aria_snapshot: String,
    pub navigation_state: String,
    pub evidence: BrowserEvidenceV1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionEvidenceV1 {
    pub action_id: ActionId,
    pub capability_id: String,
    pub page_id: PageId,
    pub expected_page_revision: PageRevision,
    pub resulting_page_revision: PageRevision,
    pub target: Option<ElementRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_decision: Option<WebAuthorityDecisionV1>,
    pub mechanical_success: bool,
    pub observed_at: String,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNetworkObservationV1 {
    pub request_id: RequestId,
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub content_type: Option<String>,
    pub resource_type: String,
    pub observed_at: String,
}
