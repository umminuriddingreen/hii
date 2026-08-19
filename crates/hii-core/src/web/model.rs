// SPDX-License-Identifier: LicenseRef-BSL-1.1

//! Defines the typed protocol shared by HII and browser mechanics.

use serde::{Deserialize, Serialize};

macro_rules! identifier {
    ($name:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.into())
            }
        }
    };
}

identifier!(BrowserSessionId);
identifier!(PageId);
identifier!(ElementRef);
identifier!(RequestId);
identifier!(ObservationId);
identifier!(ActionId);

pub type PageRevision = u64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolRequestV1 {
    pub id: RequestId,
    #[serde(flatten)]
    pub command: BrowserCommandV1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum BrowserCommandV1 {
    #[serde(rename = "web.session.open")]
    SessionOpen { isolated: bool },
    #[serde(rename = "web.navigate")]
    Navigate {
        session_id: BrowserSessionId,
        page_id: PageId,
        url: String,
    },
    #[serde(rename = "web.observe")]
    Observe {
        session_id: BrowserSessionId,
        page_id: PageId,
    },
    #[serde(rename = "web.click")]
    Click {
        session_id: BrowserSessionId,
        page_id: PageId,
        target: ElementRef,
        expected_page_revision: PageRevision,
    },
    #[serde(rename = "web.type")]
    Type {
        session_id: BrowserSessionId,
        page_id: PageId,
        target: ElementRef,
        text: String,
        expected_page_revision: PageRevision,
    },
    #[serde(rename = "web.select")]
    Select {
        session_id: BrowserSessionId,
        page_id: PageId,
        target: ElementRef,
        value: String,
        expected_page_revision: PageRevision,
    },
    #[serde(rename = "web.back")]
    Back {
        session_id: BrowserSessionId,
        page_id: PageId,
        expected_page_revision: PageRevision,
    },
    #[serde(rename = "web.tabs")]
    Tabs { session_id: BrowserSessionId },
    #[serde(rename = "web.extract")]
    Extract {
        session_id: BrowserSessionId,
        page_id: PageId,
        max_chars: usize,
    },
    #[serde(rename = "web.wait")]
    Wait {
        session_id: BrowserSessionId,
        page_id: PageId,
        milliseconds: u64,
    },
    #[serde(rename = "web.network.observe")]
    NetworkObserve {
        session_id: BrowserSessionId,
        page_id: PageId,
    },
    #[serde(rename = "web.network.body")]
    NetworkBody {
        session_id: BrowserSessionId,
        page_id: PageId,
        network_request_id: RequestId,
        max_bytes: usize,
    },
}

impl BrowserCommandV1 {
    pub fn capability_id(&self) -> &'static str {
        match self {
            Self::SessionOpen { .. } => "web.session.open",
            Self::Navigate { .. } => "web.navigate",
            Self::Observe { .. } => "web.observe",
            Self::Click { .. } => "web.click",
            Self::Type { .. } => "web.type",
            Self::Select { .. } => "web.select",
            Self::Back { .. } => "web.back",
            Self::Tabs { .. } => "web.tabs",
            Self::Extract { .. } => "web.extract",
            Self::Wait { .. } => "web.wait",
            Self::NetworkObserve { .. } => "web.network.observe",
            Self::NetworkBody { .. } => "web.network.body",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolResponseV1 {
    pub id: RequestId,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<BrowserResultV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BrowserErrorV1>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum BrowserResultV1 {
    SessionOpened {
        session_id: BrowserSessionId,
        page_id: PageId,
    },
    Observation {
        observation: super::observation::BrowserObservationV1,
    },
    Action {
        evidence: super::observation::BrowserActionEvidenceV1,
        observation: super::observation::BrowserObservationV1,
    },
    Tabs {
        pages: Vec<BrowserPageSummaryV1>,
    },
    Extracted {
        text: String,
        observation_id: ObservationId,
    },
    Network {
        requests: Vec<super::observation::BrowserNetworkObservationV1>,
    },
    NetworkBody {
        request_id: RequestId,
        content_type: String,
        body: String,
        truncated: bool,
    },
    Waited,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageSummaryV1 {
    pub page_id: PageId,
    pub url: String,
    pub title: String,
    pub revision: PageRevision,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserErrorV1 {
    pub code: BrowserErrorCodeV1,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<PageRevision>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserErrorCodeV1 {
    StaleObservation,
    UnknownElement,
    NotActionable,
    CapabilityNotRegistered,
    AwaitingAuthority,
    UnsupportedContentType,
    InvalidRequest,
    BrowserFailure,
    VerificationFailed,
}
