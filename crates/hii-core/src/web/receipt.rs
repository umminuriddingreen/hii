// SPDX-License-Identifier: LicenseRef-BSL-1.1

//! Records the causal proof chain for governed browser outcomes.

use super::{model::*, observation::*};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebVerificationV1 {
    pub criterion: String,
    pub passed: bool,
    pub evidence_ids: Vec<String>,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebReceiptV1 {
    pub schema_version: u8,
    pub intent_case_id: String,
    pub intent: String,
    pub status: String,
    pub observations: Vec<ObservationId>,
    pub actions: Vec<BrowserActionEvidenceV1>,
    pub verification: Vec<WebVerificationV1>,
    pub outcome: Option<String>,
    pub created_at: String,
}
