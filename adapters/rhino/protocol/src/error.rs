//! Typed failures.
//!
//! The harness has to decide what to do next after a failure: retry as-is,
//! refresh its view of Rhino first, ask the user, or give up and reformulate.
//! A free-text `"error"` string forces that decision to be made by parsing
//! prose, so every failure carries a code and an explicit retry disposition.

use serde::{Deserialize, Serialize};

/// What the caller may reasonably do next.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryDisposition {
    /// The same request may be retried unchanged.
    Safe,
    /// Retrying unchanged risks a duplicate or partial mutation.
    Unsafe,
    /// Re-read Rhino state, mint fresh references, then retry.
    RequiresRefreshedState,
    /// A human must act (open Rhino, open a document, grant authority).
    RequiresUserAction,
    /// The request itself was wrong; different arguments are needed.
    RequiresDifferentArguments,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    // -- transport / session ------------------------------------------------
    BridgeUnavailable,
    ProtocolVersionMismatch,
    /// A frame violated the framing rules: zero length, over
    /// `MAX_MESSAGE_BYTES`, truncated, not JSON, or not a message this side
    /// knows. The stream is desynchronised after one of these; the connection
    /// must be dropped rather than resynchronised.
    MalformedMessage,
    RhinoInstanceNotFound,
    /// The request never left this process, so nothing can have happened.
    Timeout,
    /// The request was written to the pipe but no response was ever observed —
    /// the deadline passed or the connection dropped while it was in flight.
    ///
    /// This is deliberately distinct from `BridgeUnavailable`: there, the
    /// request was never sent and replaying it is merely futile; here, Rhino
    /// may already have mutated the document and replaying could duplicate the
    /// mutation. The harness must re-read state, not retry.
    RequestOutcomeUnknown,
    Cancelled,

    // -- document / object --------------------------------------------------
    DocumentNotFound,
    DocumentChanged,
    ObjectNotFound,
    StaleReference,

    // -- request ------------------------------------------------------------
    InvalidArguments,
    OperationNotSupported,
    PermissionDenied,

    // -- native execution ---------------------------------------------------
    InvalidNativeState,
    UiDispatchFailed,
    NativeOperationFailed,
    UndoFailed,
    VerificationFailed,

    // -- grasshopper --------------------------------------------------------
    GrasshopperUnavailable,
    GrasshopperDocumentNotFound,
    ComponentNotFound,
    ComponentAmbiguous,
    ParameterNotFound,
    ParameterAmbiguous,
    ConnectionInvalid,
    SolutionFailed,

    // -- model provider -----------------------------------------------------
    ProviderUnavailable,
    ProviderToolCallInvalid,
}

impl ErrorCode {
    /// The disposition that fits this code on its own. A handler with more
    /// context may override it in the envelope; this is the sane default.
    pub fn default_retry(self) -> RetryDisposition {
        use ErrorCode::*;
        use RetryDisposition::*;
        match self {
            // Something outside the process must change first.
            BridgeUnavailable
            | RhinoInstanceNotFound
            | GrasshopperUnavailable
            | ProviderUnavailable
            | PermissionDenied
            | ProtocolVersionMismatch => RequiresUserAction,

            // The caller's view of Rhino is out of date.
            DocumentNotFound
            | DocumentChanged
            | ObjectNotFound
            | StaleReference
            | InvalidNativeState
            | GrasshopperDocumentNotFound => RequiresRefreshedState,

            // The request was malformed or under-specified.
            InvalidArguments
            | OperationNotSupported
            | ComponentNotFound
            | ComponentAmbiguous
            | ParameterNotFound
            | ParameterAmbiguous
            | ConnectionInvalid
            | ProviderToolCallInvalid => RequiresDifferentArguments,

            // Nothing was dispatched, so nothing was committed.
            Timeout | Cancelled | UiDispatchFailed => Safe,

            // Dispatched, outcome unknown, or the stream desynchronised
            // mid-conversation. Either way a blind replay can duplicate a
            // mutation that already landed.
            RequestOutcomeUnknown | MalformedMessage => Unsafe,

            // A mutation may have partially landed; a blind retry could
            // duplicate it.
            NativeOperationFailed | UndoFailed | SolutionFailed => Unsafe,

            // The mutation happened but did not satisfy its postconditions.
            // Repeating it would compound the problem.
            VerificationFailed => Unsafe,
        }
    }

    /// Stable snake_case name, identical to the serde representation.
    /// `serde_repr_matches_as_str` keeps the two from drifting.
    pub fn as_str(self) -> &'static str {
        use ErrorCode::*;
        match self {
            BridgeUnavailable => "bridge_unavailable",
            ProtocolVersionMismatch => "protocol_version_mismatch",
            MalformedMessage => "malformed_message",
            RhinoInstanceNotFound => "rhino_instance_not_found",
            Timeout => "timeout",
            RequestOutcomeUnknown => "request_outcome_unknown",
            Cancelled => "cancelled",
            DocumentNotFound => "document_not_found",
            DocumentChanged => "document_changed",
            ObjectNotFound => "object_not_found",
            StaleReference => "stale_reference",
            InvalidArguments => "invalid_arguments",
            OperationNotSupported => "operation_not_supported",
            PermissionDenied => "permission_denied",
            InvalidNativeState => "invalid_native_state",
            UiDispatchFailed => "ui_dispatch_failed",
            NativeOperationFailed => "native_operation_failed",
            UndoFailed => "undo_failed",
            VerificationFailed => "verification_failed",
            GrasshopperUnavailable => "grasshopper_unavailable",
            GrasshopperDocumentNotFound => "grasshopper_document_not_found",
            ComponentNotFound => "component_not_found",
            ComponentAmbiguous => "component_ambiguous",
            ParameterNotFound => "parameter_not_found",
            ParameterAmbiguous => "parameter_ambiguous",
            ConnectionInvalid => "connection_invalid",
            SolutionFailed => "solution_failed",
            ProviderUnavailable => "provider_unavailable",
            ProviderToolCallInvalid => "provider_tool_call_invalid",
        }
    }

    /// Every code, so exhaustiveness tests do not have to be hand-maintained.
    pub const ALL: &'static [ErrorCode] = {
        use ErrorCode::*;
        &[
            BridgeUnavailable,
            ProtocolVersionMismatch,
            MalformedMessage,
            RhinoInstanceNotFound,
            Timeout,
            RequestOutcomeUnknown,
            Cancelled,
            DocumentNotFound,
            DocumentChanged,
            ObjectNotFound,
            StaleReference,
            InvalidArguments,
            OperationNotSupported,
            PermissionDenied,
            InvalidNativeState,
            UiDispatchFailed,
            NativeOperationFailed,
            UndoFailed,
            VerificationFailed,
            GrasshopperUnavailable,
            GrasshopperDocumentNotFound,
            ComponentNotFound,
            ComponentAmbiguous,
            ParameterNotFound,
            ParameterAmbiguous,
            ConnectionInvalid,
            SolutionFailed,
            ProviderUnavailable,
            ProviderToolCallInvalid,
        ]
    };
}
