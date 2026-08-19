// SPDX-License-Identifier: LicenseRef-BSL-1.1

//! Evaluates browser action authority without delegating policy to the worker.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebAuthorityV1 {
    Observe,
    Interact,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebAuthorityDecisionV1 {
    Allow,
    AwaitingAuthority,
    Deny,
}

pub fn decide(
    authority: WebAuthorityV1,
    mutates_browser: bool,
    requires_approval: bool,
    approval_granted: bool,
) -> WebAuthorityDecisionV1 {
    if mutates_browser && authority == WebAuthorityV1::Observe {
        return WebAuthorityDecisionV1::Deny;
    }
    if requires_approval && !approval_granted {
        return WebAuthorityDecisionV1::AwaitingAuthority;
    }
    WebAuthorityDecisionV1::Allow
}
