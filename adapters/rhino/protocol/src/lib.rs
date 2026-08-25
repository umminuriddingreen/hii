//! Typed wire protocol for the HII Rhino adapter.
//!
//! HII owns intelligence; the Rhino plug-in owns native execution. This crate
//! is the contract between them, and nothing else: no transport, no tool
//! semantics, no model concerns. It is shared by the Rust facade inside the HII
//! CLI and mirrored by the C# bridge that runs inside Rhino.

pub mod envelope;
pub mod error;
pub mod framing;
pub mod identity;
pub mod transport;
pub mod verification;

pub use envelope::{
    ApplicationInstance, BridgeMessage, ClientMessage, ErrorEnvelope, EventEnvelope, EventKind,
    HandshakeRequest, HandshakeResponse, MutationSummary, RequestEnvelope, ResponseEnvelope,
    ResponseStatus, MAX_MESSAGE_BYTES, PROTOCOL_VERSION,
};
pub use error::{ErrorCode, RetryDisposition};
pub use framing::{
    decode_len, encode_frame, read_frame, write_frame, FrameError, FRAME_HEADER_BYTES,
};
pub use identity::{
    DocumentRef, DocumentRuntimeSerial, GrasshopperDocumentRef, GrasshopperObjectRef,
    RhinoInstanceId, RhinoObjectRef, RhinoSessionRef, TargetRef,
};
pub use verification::{VerificationCheck, VerificationEvidence, VerificationVerdict};

/// Reject a peer whose protocol version we cannot speak.
///
/// There is deliberately no compatibility window: the bridge and the facade are
/// installed separately and a silent partial mismatch is far more expensive to
/// diagnose than a refused handshake.
pub fn check_version(peer: u32) -> Result<(), ErrorEnvelope> {
    if peer == PROTOCOL_VERSION {
        return Ok(());
    }
    Err(ErrorEnvelope::new(
        None,
        ErrorCode::ProtocolVersionMismatch,
        format!("peer speaks protocol {peer}; this build speaks {PROTOCOL_VERSION}"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

    fn instance() -> RhinoInstanceId {
        RhinoInstanceId(Uuid::from_u128(7))
    }

    #[test]
    fn request_round_trips() {
        let request = RequestEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: "r-1".into(),
            operation: "rhino.object.create".into(),
            target: Some(TargetRef::Document(DocumentRef {
                rhino_instance_id: instance(),
                document_runtime_serial: 17,
            })),
            arguments: json!({ "kind": "box", "size_mm": 40.0 }),
            timeout_ms: Some(5_000),
        };
        let text = serde_json::to_string(&request).unwrap();
        assert_eq!(request, serde_json::from_str(&text).unwrap());
    }

    #[test]
    fn client_and_bridge_messages_are_tagged() {
        let message = ClientMessage::Handshake(HandshakeRequest {
            protocol_version: PROTOCOL_VERSION,
            client: "hii-cli".into(),
            client_version: "0.1.0".into(),
        });
        let text = serde_json::to_string(&message).unwrap();
        assert!(text.contains("\"envelope\":\"handshake\""), "{text}");
        assert_eq!(message, serde_json::from_str(&text).unwrap());
    }

    #[test]
    fn error_envelope_survives_the_message_tag() {
        // The tag name must not collide with a field on any variant: an
        // internally tagged enum writes both at the same level, and a
        // duplicate key makes the message unparseable rather than merely ugly.
        let message = BridgeMessage::Error(ErrorEnvelope::new(
            Some("r-9".into()),
            ErrorCode::ObjectNotFound,
            "no such object",
        ));
        let text = serde_json::to_string(&message).unwrap();
        assert_eq!(message, serde_json::from_str(&text).unwrap(), "{text}");

        // Same hazard for the event variant, whose payload has its own `kind`.
        let event = BridgeMessage::Event(EventEnvelope {
            protocol_version: PROTOCOL_VERSION,
            event_id: "e-1".into(),
            kind: EventKind::ObjectAdded,
            session: RhinoSessionRef {
                rhino_instance_id: instance(),
                process_id: 1,
                session_id: 1,
                document_runtime_serial: None,
            },
            emitted_at_unix_ms: 0,
            data: json!({}),
            dropped_before: None,
        });
        let text = serde_json::to_string(&event).unwrap();
        assert_eq!(event, serde_json::from_str(&text).unwrap(), "{text}");
    }

    #[test]
    fn version_mismatch_is_refused_with_a_typed_code() {
        let error = check_version(PROTOCOL_VERSION + 1).unwrap_err();
        assert_eq!(error.code, ErrorCode::ProtocolVersionMismatch);
        assert_eq!(error.retry, RetryDisposition::RequiresUserAction);
        assert!(check_version(PROTOCOL_VERSION).is_ok());
    }

    #[test]
    fn object_identity_ignores_the_advisory_runtime_serial() {
        let object_id = Uuid::from_u128(99);
        let minted = RhinoObjectRef {
            rhino_instance_id: instance(),
            document_runtime_serial: 3,
            object_id,
            runtime_serial: Some(11),
        };
        let after_replace = RhinoObjectRef {
            runtime_serial: Some(12),
            ..minted.clone()
        };
        // Same GUID, so the same object; the serial only says it changed.
        assert!(minted.same_object(&after_replace));
        assert_ne!(minted, after_replace);
        assert_eq!(minted.document().document_runtime_serial, 3);
    }

    #[test]
    fn a_different_document_is_a_different_object() {
        let object_id = Uuid::from_u128(99);
        let base = RhinoObjectRef {
            rhino_instance_id: instance(),
            document_runtime_serial: 3,
            object_id,
            runtime_serial: None,
        };
        let elsewhere = RhinoObjectRef {
            document_runtime_serial: 4,
            ..base.clone()
        };
        assert!(!base.same_object(&elsewhere));
    }

    #[test]
    fn error_codes_carry_a_usable_retry_disposition() {
        // A stale reference is fixable by re-reading, not by asking the user.
        assert_eq!(
            ErrorCode::StaleReference.default_retry(),
            RetryDisposition::RequiresRefreshedState
        );
        // A half-applied mutation must not be blindly repeated.
        assert_eq!(
            ErrorCode::NativeOperationFailed.default_retry(),
            RetryDisposition::Unsafe
        );
        // Nothing ran, so retrying costs nothing.
        assert_eq!(ErrorCode::Timeout.default_retry(), RetryDisposition::Safe);
    }

    #[test]
    fn serde_repr_matches_as_str() {
        for code in ErrorCode::ALL {
            let text = serde_json::to_value(code).unwrap();
            assert_eq!(text, json!(code.as_str()), "drift for {code:?}");
        }
    }

    #[test]
    fn verdict_is_derived_from_checks_not_asserted() {
        let ok = VerificationCheck {
            description: "object exists".into(),
            via_operation: "rhino.object.get".into(),
            ok: true,
            expected: None,
            actual: None,
        };
        let bad = VerificationCheck {
            ok: false,
            ..ok.clone()
        };

        assert_eq!(
            VerificationEvidence::from_checks(vec![ok.clone()], 0).verdict,
            VerificationVerdict::Verified
        );
        assert_eq!(
            VerificationEvidence::from_checks(vec![ok.clone()], 1).verdict,
            VerificationVerdict::PartiallyVerified
        );
        assert_eq!(
            VerificationEvidence::from_checks(Vec::new(), 0).verdict,
            VerificationVerdict::Unverified
        );
        // One failed check outweighs any number of passing ones.
        assert_eq!(
            VerificationEvidence::from_checks(vec![ok, bad], 0).verdict,
            VerificationVerdict::Failed
        );
    }

    #[test]
    fn pipe_naming_is_session_scoped_and_per_process() {
        assert_eq!(transport::pipe_name(1, 1234), r"LOCAL\hii.rhino.1.1234");
        assert_eq!(
            transport::pipe_path(1, 1234),
            r"\\.\pipe\LOCAL\hii.rhino.1.1234"
        );
        // Different Rhino processes, and different logon sessions, never share a pipe.
        assert_ne!(transport::pipe_name(1, 1234), transport::pipe_name(1, 1235));
        assert_ne!(transport::pipe_name(1, 1234), transport::pipe_name(2, 1234));
    }

    #[test]
    fn empty_mutation_summaries_stay_off_the_wire() {
        let response = ResponseEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: "r-2".into(),
            status: ResponseStatus::Ok,
            result: json!({ "count": 0 }),
            mutation: MutationSummary::default(),
            warnings: Vec::new(),
            duration_ms: 4,
        };
        let text = serde_json::to_string(&response).unwrap();
        assert!(!text.contains("mutation"), "{text}");
        assert_eq!(response, serde_json::from_str(&text).unwrap());
    }
}
