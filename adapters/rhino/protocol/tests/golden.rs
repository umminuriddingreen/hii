//! Golden fixtures shared with the C# bridge.
//!
//! The contract is written once in Rust and mirrored by hand in C# inside the
//! Rhino plug-in. The two ship separately — a user installs the plug-in, HII
//! updates on its own schedule — so hand-mirrored types drifting apart is the
//! most likely way this protocol breaks. These fixtures are the shared oracle:
//! Rust proves it still produces them, and the bridge's own test project proves
//! it can still read them.
//!
//! Regenerate deliberately, never casually:
//!
//! ```text
//! HII_RHINO_UPDATE_GOLDEN=1 cargo test -p hii-rhino-protocol --test golden
//! ```
//!
//! A regenerated fixture means the wire format changed, which means
//! `PROTOCOL_VERSION` should change too.

use hii_rhino_protocol::{
    framing, transport, ApplicationInstance, BridgeMessage, ClientMessage, DocumentRef, ErrorCode,
    ErrorEnvelope, EventEnvelope, EventKind, GrasshopperDocumentRef, GrasshopperObjectRef,
    HandshakeRequest, HandshakeResponse, MutationSummary, RequestEnvelope, ResponseEnvelope,
    ResponseStatus, RhinoInstanceId, RhinoObjectRef, RhinoSessionRef, TargetRef, VerificationCheck,
    VerificationEvidence, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::json;
use std::{fs, path::PathBuf};
use uuid::Uuid;

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/golden")
}

fn instance() -> RhinoInstanceId {
    // Fixed so fixtures are byte-stable across runs.
    RhinoInstanceId(Uuid::from_u128(0x1111_2222_3333_4444_5555_6666_7777_8888))
}

fn object_id() -> Uuid {
    Uuid::from_u128(0x9999_aaaa_bbbb_cccc_dddd_eeee_ffff_0000)
}

fn gh_runtime_id() -> Uuid {
    Uuid::from_u128(0x0102_0304_0506_0708_090a_0b0c_0d0e_0f10)
}

/// Round-trip `value` against its committed fixture.
fn check<T>(name: &str, value: &T)
where
    T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let path = golden_dir().join(format!("{name}.json"));
    let serialized = serde_json::to_string_pretty(value).expect("serialize");

    if std::env::var_os("HII_RHINO_UPDATE_GOLDEN").is_some() {
        fs::create_dir_all(golden_dir()).expect("create golden dir");
        fs::write(
            &path,
            format!(
                "{serialized}
"
            ),
        )
        .expect("write fixture");
        return;
    }

    let committed = fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "missing fixture {}: {error}. Regenerate with HII_RHINO_UPDATE_GOLDEN=1",
            path.display()
        )
    });

    // Deserializing proves the committed bytes still parse; comparing the value
    // proves they still mean the same thing. Both matter: a field that silently
    // stopped being emitted would still parse.
    let parsed: T = serde_json::from_str(&committed)
        .unwrap_or_else(|error| panic!("fixture {name} no longer parses: {error}"));
    assert_eq!(&parsed, value, "fixture {name} drifted from the Rust types");
    assert_eq!(
        committed.trim_end(),
        serialized.trim_end(),
        "fixture {name} is stale; regenerate with HII_RHINO_UPDATE_GOLDEN=1"
    );
}

#[test]
fn golden_fixtures_match_the_rust_types() {
    check(
        "client_handshake",
        &ClientMessage::Handshake(HandshakeRequest {
            protocol_version: PROTOCOL_VERSION,
            client: "hii-cli".into(),
            client_version: "0.1.0".into(),
        }),
    );

    check(
        "bridge_handshake",
        &BridgeMessage::Handshake(HandshakeResponse {
            protocol_version: PROTOCOL_VERSION,
            application: ApplicationInstance {
                application: "rhino".into(),
                application_version: "8.0.0.0".into(),
                adapter_version: "0.1.0".into(),
                process_id: 14324,
                rhino_instance_id: instance(),
            },
            features: vec!["rhino.document".into(), "rhino.geometry".into()],
        }),
    );

    check(
        "client_request",
        &ClientMessage::Request(RequestEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: "req-0001".into(),
            operation: "rhino.object.create".into(),
            target: Some(TargetRef::Document(DocumentRef {
                rhino_instance_id: instance(),
                document_runtime_serial: 17,
            })),
            arguments: json!({ "kind": "box", "size_mm": 40.0 }),
            timeout_ms: Some(5_000),
        }),
    );

    check(
        "bridge_response",
        &BridgeMessage::Response(ResponseEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: "req-0001".into(),
            status: ResponseStatus::Ok,
            result: json!({ "object_count": 1 }),
            mutation: MutationSummary {
                created: vec![RhinoObjectRef {
                    rhino_instance_id: instance(),
                    document_runtime_serial: 17,
                    object_id: object_id(),
                    runtime_serial: Some(42),
                }],
                modified: Vec::new(),
                deleted: Vec::new(),
                native_undo_record: Some(9),
            },
            warnings: Vec::new(),
            duration_ms: 12,
        }),
    );

    check(
        "bridge_error",
        &BridgeMessage::Error(ErrorEnvelope::new(
            Some("req-0002".into()),
            ErrorCode::StaleReference,
            "object 9999aaaa-... is no longer present in document 17",
        )),
    );

    check(
        "bridge_event",
        &BridgeMessage::Event(EventEnvelope {
            protocol_version: PROTOCOL_VERSION,
            event_id: "evt-0001".into(),
            kind: EventKind::ObjectAdded,
            session: RhinoSessionRef {
                rhino_instance_id: instance(),
                process_id: 14324,
                session_id: 1,
                document_runtime_serial: Some(17),
            },
            emitted_at_unix_ms: 1_700_000_000_000,
            data: json!({ "object_id": object_id() }),
            dropped_before: None,
        }),
    );

    check(
        "advertisement",
        &transport::Advertisement {
            protocol_version: PROTOCOL_VERSION,
            rhino_instance_id: instance(),
            process_id: 14324,
            session_id: 1,
            pipe_name: transport::pipe_name(1, 14324),
            application_version: "8.0.0.0".into(),
            adapter_version: "0.1.0".into(),
            started_at_unix_ms: 1_700_000_000_000,
        },
    );

    check(
        "verification_evidence",
        &VerificationEvidence::from_checks(
            vec![VerificationCheck {
                description: "bounding box is 40x40x40 mm".into(),
                via_operation: "rhino.geometry.bounding_box".into(),
                ok: true,
                expected: Some(json!([40.0, 40.0, 40.0])),
                actual: Some(json!([40.0, 40.0, 40.0])),
            }],
            0,
        ),
    );

    check(
        "grasshopper_refs",
        &(
            GrasshopperDocumentRef {
                rhino_instance_id: instance(),
                rhino_document_runtime_serial: Some(17),
                gh_runtime_id: gh_runtime_id(),
            },
            GrasshopperObjectRef {
                gh_runtime_id: gh_runtime_id(),
                instance_guid: object_id(),
            },
        ),
    );
}

/// The framing fixture is bytes, not JSON, because that is the layer the JSON
/// fixtures cannot reach: a C# bridge that emits perfect JSON behind a
/// big-endian prefix, or in Windows message mode, produces exactly zero JSON
/// drift and still cannot talk to us.
#[test]
fn the_frame_layout_is_pinned_to_bytes() {
    let message = ClientMessage::Handshake(HandshakeRequest {
        protocol_version: PROTOCOL_VERSION,
        client: "hii-cli".into(),
        client_version: "0.1.0".into(),
    });
    let frame = framing::encode_frame(&message).expect("encode");
    let hex: String = frame.iter().map(|byte| format!("{byte:02x}")).collect();

    let path = golden_dir().join("handshake_frame.hex");
    if std::env::var_os("HII_RHINO_UPDATE_GOLDEN").is_some() {
        fs::create_dir_all(golden_dir()).expect("create golden dir");
        fs::write(
            &path,
            format!(
                "{hex}
"
            ),
        )
        .expect("write fixture");
        return;
    }

    let committed = fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "missing fixture {}: {error}. Regenerate with HII_RHINO_UPDATE_GOLDEN=1",
            path.display()
        )
    });
    assert_eq!(
        committed.trim(),
        hex,
        "frame layout changed; regenerate with HII_RHINO_UPDATE_GOLDEN=1"
    );

    // Spelled out so the requirement survives someone regenerating the fixture
    // without reading it: little-endian length, then the body, nothing else.
    let declared = u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize;
    assert_eq!(declared, frame.len() - 4);
    assert_eq!(
        serde_json::from_slice::<ClientMessage>(&frame[4..]).unwrap(),
        message
    );
}

/// `NamedPipeServerStream` takes the bare name and prepends `\\.\pipe\`
/// itself, while the client opens the full path. The two are derived from the
/// same rule here; this pins them together so a change to one cannot silently
/// strand the other. The JSON fixtures do not cover it.
#[test]
fn the_advertised_name_resolves_to_the_path_the_client_opens() {
    let advertisement = transport::Advertisement {
        protocol_version: PROTOCOL_VERSION,
        rhino_instance_id: instance(),
        process_id: 14324,
        session_id: 1,
        pipe_name: transport::pipe_name(1, 14324),
        application_version: "8.0.0.0".into(),
        adapter_version: "0.1.0".into(),
        started_at_unix_ms: 1_700_000_000_000,
    };
    assert_eq!(advertisement.pipe_path(), transport::pipe_path(1, 14324));
    // The bridge is handed the name, never the path: prepending twice yields a
    // pipe nobody can open.
    assert!(!advertisement.pipe_name.starts_with(r"\\"));
}
