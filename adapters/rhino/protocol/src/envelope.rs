//! The messages that cross the pipe.
//!
//! Every message carries `protocol_version`. The bridge and the facade ship
//! separately (one is a Rhino plug-in a user installs, the other is the HII
//! CLI), so a version skew is normal and must fail loudly at the handshake
//! rather than as a confusing decode error twenty requests later.

use crate::{
    error::{ErrorCode, RetryDisposition},
    identity::{RhinoInstanceId, RhinoObjectRef, RhinoSessionRef, TargetRef},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped on any breaking change to these types.
pub const PROTOCOL_VERSION: u32 = 1;

/// Refuse anything larger, in either direction, before allocating for it.
pub const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

/// Opened by the facade the moment it connects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandshakeRequest {
    pub protocol_version: u32,
    /// Who is connecting, for the bridge's logs.
    pub client: String,
    pub client_version: String,
}

/// The bridge's answer: who it is and what it can do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandshakeResponse {
    pub protocol_version: u32,
    pub application: ApplicationInstance,
    /// Coarse feature flags (`rhino.document`, `rhino.geometry`,
    /// `rhino.viewport`, `grasshopper`, ...). The facade uses these to decide
    /// which tools can be offered at all; per-tool preconditions are checked
    /// separately and more precisely.
    pub features: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationInstance {
    /// Always `"rhino"` today; named so a Blender or Revit adapter can reuse
    /// these envelopes without a schema change.
    pub application: String,
    pub application_version: String,
    pub adapter_version: String,
    pub process_id: u32,
    pub rhino_instance_id: RhinoInstanceId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestEnvelope {
    pub protocol_version: u32,
    pub request_id: String,
    /// Canonical dotted operation name, for example `rhino.object.create`.
    pub operation: String,
    /// Absent for discovery operations that run before any target is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<TargetRef>,
    #[serde(default)]
    pub arguments: Value,
    /// Bridge-side deadline. The facade also times out independently, so a
    /// wedged native call cannot hang the harness.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseStatus {
    Ok,
    /// The operation ran and something was produced, but not everything the
    /// caller asked for. Never used to paper over a failure.
    Partial,
}

/// What a mutation actually did, as reported by the native side.
///
/// This is evidence, not proof: it is what the API said happened. Verification
/// re-queries the document independently before anything is called verified.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MutationSummary {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub created: Vec<RhinoObjectRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modified: Vec<RhinoObjectRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deleted: Vec<RhinoObjectRef>,
    /// Rhino's undo record serial, when the operation opened one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_undo_record: Option<u32>,
}

impl MutationSummary {
    pub fn is_empty(&self) -> bool {
        self.created.is_empty()
            && self.modified.is_empty()
            && self.deleted.is_empty()
            && self.native_undo_record.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponseEnvelope {
    pub protocol_version: u32,
    pub request_id: String,
    pub status: ResponseStatus,
    #[serde(default)]
    pub result: Value,
    #[serde(default, skip_serializing_if = "MutationSummary::is_empty")]
    pub mutation: MutationSummary,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    pub protocol_version: u32,
    /// Absent when the failure happened before a request could be parsed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub code: ErrorCode,
    pub message: String,
    pub retry: RetryDisposition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl ErrorEnvelope {
    pub fn new(request_id: Option<String>, code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            code,
            message: message.into(),
            retry: code.default_retry(),
            details: None,
        }
    }

    pub fn with_retry(mut self, retry: RetryDisposition) -> Self {
        self.retry = retry;
        self
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

/// Native events the bridge observes and publishes.
///
/// These are observations only. A handler may capture evidence, invalidate a
/// cache, or wake a waiting operation; it never mutates the document in
/// response. Any follow-up action comes back through the normal request path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub protocol_version: u32,
    pub event_id: String,
    pub kind: EventKind,
    pub session: RhinoSessionRef,
    pub emitted_at_unix_ms: u64,
    #[serde(default)]
    pub data: Value,
    /// How many observations the bridge discarded between the previous event on
    /// this connection and this one.
    ///
    /// Events are queued, and a queue that may not block the thread feeding it
    /// must be allowed to drop. A silent drop would be far worse than a loud
    /// one: verification reasons from event evidence, and "no `ObjectAdded`
    /// arrived" would otherwise be indistinguishable from "the object was never
    /// created". A non-zero value here means the evidence is incomplete and a
    /// verdict must fall back to an independent query rather than conclude from
    /// absence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropped_before: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    DocumentOpened,
    DocumentClosed,
    ActiveDocumentChanged,
    ObjectAdded,
    ObjectDeleted,
    ObjectReplaced,
    ObjectAttributesChanged,
    SelectionChanged,
    GrasshopperSolutionStart,
    GrasshopperSolutionEnd,
}

/// Anything the bridge may write to the pipe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "envelope", rename_all = "snake_case")]
pub enum BridgeMessage {
    Handshake(HandshakeResponse),
    Response(ResponseEnvelope),
    Error(ErrorEnvelope),
    Event(EventEnvelope),
}

/// Anything the facade may write to the pipe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "envelope", rename_all = "snake_case")]
pub enum ClientMessage {
    Handshake(HandshakeRequest),
    Request(RequestEnvelope),
}
