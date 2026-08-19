// SPDX-License-Identifier: LicenseRef-BSL-1.1

//! Defines HII's bounded semantic browser capability registry.

use serde::{Deserialize, Serialize};

pub const WEB_CAPABILITIES: [&str; 12] = [
    "web.session.open",
    "web.navigate",
    "web.observe",
    "web.click",
    "web.type",
    "web.select",
    "web.back",
    "web.tabs",
    "web.extract",
    "web.wait",
    "web.network.observe",
    "web.network.body",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebCapabilityV1 {
    pub id: String,
    pub mutates_browser: bool,
    pub may_be_consequential: bool,
}

pub fn capability(id: &str) -> Option<WebCapabilityV1> {
    WEB_CAPABILITIES.contains(&id).then(|| WebCapabilityV1 {
        id: id.into(),
        mutates_browser: matches!(
            id,
            "web.navigate" | "web.click" | "web.type" | "web.select" | "web.back"
        ),
        may_be_consequential: matches!(id, "web.click" | "web.type" | "web.select"),
    })
}
