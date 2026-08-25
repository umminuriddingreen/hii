//! Client behaviour, proved over a loopback socket.
//!
//! Everything hard about this client is transport-independent: routing frames
//! to the right waiter, keeping unsolicited events out of the response path,
//! bounding a caller's wait, and reporting a lost connection in a way that does
//! not invite a duplicate mutation. None of that needs a pipe or Rhino, and
//! testing it here means it is covered on any machine and in CI.
//!
//! The pipe itself is proved separately, against a real .NET server, in
//! `named_pipe.rs`.

use hii_rhino_ipc::{BridgeClient, Duplex};
use hii_rhino_protocol::{
    framing::{encode_frame, read_frame, write_frame},
    transport::{self, Advertisement},
    ApplicationInstance, BridgeMessage, ClientMessage, ErrorCode, ErrorEnvelope, EventEnvelope,
    EventKind, HandshakeResponse, MutationSummary, ResponseEnvelope, ResponseStatus,
    RetryDisposition, RhinoInstanceId, RhinoSessionRef, PROTOCOL_VERSION,
};
use serde_json::json;
use std::{
    io::Write,
    net::{TcpListener, TcpStream},
    sync::mpsc,
    thread,
    time::Duration,
};
use uuid::Uuid;

const INSTANCE: u128 = 0x1111_2222_3333_4444_5555_6666_7777_8888;

fn instance() -> RhinoInstanceId {
    RhinoInstanceId(Uuid::from_u128(INSTANCE))
}

fn advertisement() -> Advertisement {
    Advertisement {
        protocol_version: PROTOCOL_VERSION,
        rhino_instance_id: instance(),
        process_id: 4242,
        session_id: 1,
        pipe_name: transport::pipe_name(1, 4242),
        application_version: "8.0.0.0".into(),
        adapter_version: "0.1.0".into(),
        started_at_unix_ms: 1_700_000_000_000,
    }
}

fn handshake_response(protocol_version: u32, id: RhinoInstanceId) -> BridgeMessage {
    BridgeMessage::Handshake(HandshakeResponse {
        protocol_version,
        application: ApplicationInstance {
            application: "rhino".into(),
            application_version: "8.0.0.0".into(),
            adapter_version: "0.1.0".into(),
            process_id: 4242,
            rhino_instance_id: id,
        },
        features: vec!["rhino.document".into()],
    })
}

fn response_for(request_id: &str) -> BridgeMessage {
    BridgeMessage::Response(ResponseEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: request_id.to_string(),
        status: ResponseStatus::Ok,
        result: json!({ "echo": request_id }),
        mutation: MutationSummary::default(),
        warnings: Vec::new(),
        duration_ms: 1,
    })
}

fn event(event_id: &str) -> BridgeMessage {
    BridgeMessage::Event(EventEnvelope {
        protocol_version: PROTOCOL_VERSION,
        event_id: event_id.to_string(),
        kind: EventKind::ObjectAdded,
        session: RhinoSessionRef {
            rhino_instance_id: instance(),
            process_id: 4242,
            session_id: 1,
            document_runtime_serial: Some(17),
        },
        emitted_at_unix_ms: 1_700_000_000_000,
        data: json!({}),
        dropped_before: None,
    })
}

/// A scripted stand-in for the bridge. `handler` gets the accepted socket and
/// decides what the "bridge" does; the client never knows the difference.
fn serve<F>(handler: F) -> BridgeClient
where
    F: FnOnce(TcpStream) + Send + 'static,
{
    serve_with(handler).expect("connect")
}

fn serve_with<F>(handler: F) -> Result<BridgeClient, ErrorEnvelope>
where
    F: FnOnce(TcpStream) + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("addr").port();
    thread::spawn(move || {
        if let Ok((socket, _)) = listener.accept() {
            handler(socket);
        }
    });

    let socket = TcpStream::connect(("127.0.0.1", port)).expect("connect loopback");
    let halves = Duplex::split(socket).expect("split");
    BridgeClient::handshake_over(advertisement(), halves)
}

/// Read one client message; used by handlers that need to see the handshake or
/// a request before replying.
fn expect_request(socket: &mut TcpStream) -> String {
    match read_frame::<_, ClientMessage>(socket).expect("read client message") {
        ClientMessage::Request(request) => request.request_id,
        other => panic!("expected a request, got {other:?}"),
    }
}

fn expect_handshake(socket: &mut TcpStream) {
    match read_frame::<_, ClientMessage>(socket).expect("read client message") {
        ClientMessage::Handshake(_) => {}
        other => panic!("expected a handshake, got {other:?}"),
    }
}

#[test]
fn an_event_arriving_mid_request_does_not_become_the_response() {
    // The failure this exists to catch: a client that reads the next frame
    // after writing a request. Creating a box in Rhino fires ObjectAdded, so
    // this ordering is the normal case, not an edge case.
    let client = serve(|mut socket| {
        expect_handshake(&mut socket);
        write_frame(
            &mut socket,
            &handshake_response(PROTOCOL_VERSION, instance()),
        )
        .unwrap();

        let id = expect_request(&mut socket);
        write_frame(&mut socket, &event("evt-before")).unwrap();
        write_frame(&mut socket, &response_for(&id)).unwrap();
        write_frame(&mut socket, &event("evt-after")).unwrap();
        thread::sleep(Duration::from_millis(200));
    });

    let response = client
        .request("rhino.object.create", None, json!({}), None)
        .expect("response");
    assert_eq!(response.result["echo"], response.request_id);

    // And the events were kept, not discarded: they are verification evidence.
    let mut seen = Vec::new();
    while seen.len() < 2 {
        match client.next_event(Duration::from_secs(2)) {
            Some(event) => seen.push(event.event_id),
            None => break,
        }
    }
    assert_eq!(seen, vec!["evt-before", "evt-after"]);
}

#[test]
fn concurrent_requests_are_answered_out_of_order_without_crossing_wires() {
    let client = serve(|mut socket| {
        expect_handshake(&mut socket);
        write_frame(
            &mut socket,
            &handshake_response(PROTOCOL_VERSION, instance()),
        )
        .unwrap();

        let first = expect_request(&mut socket);
        let second = expect_request(&mut socket);
        // Deliberately reversed: a slow read behind a fast one is exactly what
        // a UI-thread dispatcher produces.
        write_frame(&mut socket, &response_for(&second)).unwrap();
        write_frame(&mut socket, &response_for(&first)).unwrap();
        thread::sleep(Duration::from_millis(200));
    });

    let client = std::sync::Arc::new(client);
    let (tx, rx) = mpsc::channel();

    let mut handles = Vec::new();
    for _ in 0..2 {
        let client = std::sync::Arc::clone(&client);
        let tx = tx.clone();
        handles.push(thread::spawn(move || {
            let response = client
                .request("rhino.document.describe", None, json!({}), None)
                .expect("response");
            // The echo is the id the bridge answered; it must match the id this
            // caller was given.
            tx.send((response.request_id.clone(), response.result["echo"].clone()))
                .unwrap();
        }));
    }
    drop(tx);

    for handle in handles {
        handle.join().unwrap();
    }
    let mut pairs: Vec<_> = rx.iter().collect();
    pairs.sort_by(|left, right| left.0.cmp(&right.0));
    assert_eq!(pairs.len(), 2);
    for (request_id, echo) in pairs {
        assert_eq!(echo, json!(request_id));
    }
}

#[test]
fn a_request_that_is_never_answered_reports_an_unknown_outcome() {
    // Not `Timeout`, which the taxonomy marks safe to retry. The request
    // reached Rhino; the box may already exist.
    let client = serve(|mut socket| {
        expect_handshake(&mut socket);
        write_frame(
            &mut socket,
            &handshake_response(PROTOCOL_VERSION, instance()),
        )
        .unwrap();
        let _ = expect_request(&mut socket);
        thread::sleep(Duration::from_millis(600));
    });

    let error = client
        .request(
            "rhino.object.create",
            None,
            json!({}),
            Some(Duration::from_millis(120)),
        )
        .expect_err("should time out");
    assert_eq!(error.code, ErrorCode::RequestOutcomeUnknown);
    assert_eq!(
        error.retry,
        hii_rhino_protocol::RetryDisposition::Unsafe,
        "a possibly-applied mutation must never be advertised as safe to repeat"
    );
}

#[test]
fn losing_the_connection_mid_request_also_reports_an_unknown_outcome() {
    let client = serve(|mut socket| {
        expect_handshake(&mut socket);
        write_frame(
            &mut socket,
            &handshake_response(PROTOCOL_VERSION, instance()),
        )
        .unwrap();
        let _ = expect_request(&mut socket);
        // Rhino crashes, or the user quits it, with our request in flight.
        drop(socket);
    });

    let error = client
        .request(
            "rhino.object.create",
            None,
            json!({}),
            Some(Duration::from_secs(5)),
        )
        .expect_err("connection died");
    assert_eq!(error.code, ErrorCode::RequestOutcomeUnknown);
    assert!(!client.is_connected());
}

#[test]
fn a_request_made_after_a_clean_disconnect_is_reported_as_never_sent() {
    let client = serve(|mut socket| {
        expect_handshake(&mut socket);
        write_frame(
            &mut socket,
            &handshake_response(PROTOCOL_VERSION, instance()),
        )
        .unwrap();
        drop(socket);
    });

    // Let the reader thread observe the close.
    for _ in 0..50 {
        if !client.is_connected() {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    assert!(!client.is_connected());

    let error = client
        .request("rhino.session.list", None, json!({}), None)
        .expect_err("no connection");
    // Nothing was written, so this one really is just an absent bridge.
    assert_eq!(error.code, ErrorCode::BridgeUnavailable);
}

#[test]
fn a_typed_error_for_a_request_is_returned_to_that_caller() {
    let client = serve(|mut socket| {
        expect_handshake(&mut socket);
        write_frame(
            &mut socket,
            &handshake_response(PROTOCOL_VERSION, instance()),
        )
        .unwrap();
        let id = expect_request(&mut socket);
        write_frame(
            &mut socket,
            &BridgeMessage::Error(ErrorEnvelope::new(
                Some(id),
                ErrorCode::ObjectNotFound,
                "no such object",
            )),
        )
        .unwrap();
        thread::sleep(Duration::from_millis(200));
    });

    let error = client
        .request("rhino.object.get", None, json!({}), None)
        .expect_err("bridge refused");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);
    // A refusal is not a lost connection: the session stays usable.
    assert!(client.is_connected());
}

#[test]
fn a_response_nobody_is_waiting_for_is_counted_not_confused_with_another_request() {
    let client = serve(|mut socket| {
        expect_handshake(&mut socket);
        write_frame(
            &mut socket,
            &handshake_response(PROTOCOL_VERSION, instance()),
        )
        .unwrap();
        let id = expect_request(&mut socket);
        write_frame(&mut socket, &response_for(&id)).unwrap();
        // A duplicate. It must not be handed to the next request that comes
        // along, which is precisely what a queue-based client would do.
        write_frame(&mut socket, &response_for(&id)).unwrap();
        thread::sleep(Duration::from_millis(300));
    });

    client
        .request("rhino.document.describe", None, json!({}), None)
        .expect("first response");
    for _ in 0..50 {
        if client.stray_response_count() > 0 {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(client.stray_response_count(), 1);
    assert!(client.is_connected());
}

#[test]
fn a_version_mismatch_refuses_the_connection_before_any_request() {
    let result = serve_with(|mut socket| {
        expect_handshake(&mut socket);
        write_frame(
            &mut socket,
            &handshake_response(PROTOCOL_VERSION + 1, instance()),
        )
        .unwrap();
        thread::sleep(Duration::from_millis(200));
    });
    let error = result.expect_err("mismatch must refuse");
    assert_eq!(error.code, ErrorCode::ProtocolVersionMismatch);
}

#[test]
fn a_bridge_that_refuses_the_handshake_says_why_instead_of_just_hanging_up() {
    // The mirror image of the test above: here it is the *bridge* that decides
    // the versions do not match, and answers with a typed error carrying no
    // request id instead of a handshake.
    //
    // The reader treats an unattributed error as the end of the connection,
    // which is right — but the code has to survive that journey. If it were
    // flattened to `bridge_unavailable` on the way, a user running a stale
    // plug-in would be told Rhino is not reachable, and would go looking in
    // entirely the wrong place.
    let result = serve_with(|mut socket| {
        expect_handshake(&mut socket);
        write_frame(
            &mut socket,
            &BridgeMessage::Error(ErrorEnvelope::new(
                None,
                ErrorCode::ProtocolVersionMismatch,
                "client speaks protocol 2; this bridge speaks 1",
            )),
        )
        .unwrap();
        thread::sleep(Duration::from_millis(200));
    });

    let error = result.expect_err("a refused handshake is not a connection");
    assert_eq!(error.code, ErrorCode::ProtocolVersionMismatch);
    assert_eq!(error.retry, RetryDisposition::RequiresUserAction);
    assert!(
        error.message.contains("protocol 2"),
        "the bridge's own explanation should survive: {}",
        error.message
    );
}

#[test]
fn a_pipe_taken_over_by_a_different_rhino_is_refused() {
    // The advertisement is stale: the pid was reused and something else now
    // answers on that name. Acting on the advertised references would touch the
    // wrong document.
    let other = RhinoInstanceId(Uuid::from_u128(INSTANCE + 1));
    let expected = other.clone();
    let result = serve_with(move |mut socket| {
        expect_handshake(&mut socket);
        write_frame(&mut socket, &handshake_response(PROTOCOL_VERSION, other)).unwrap();
        thread::sleep(Duration::from_millis(200));
    });
    let error = result.expect_err("identity mismatch must refuse");
    assert_eq!(error.code, ErrorCode::RhinoInstanceNotFound);
    assert!(error.message.contains(&expected.to_string()));
}

#[test]
fn an_oversized_frame_from_the_bridge_ends_the_connection_without_allocating_it() {
    // Only a length prefix is ever sent. If the client trusted it, it would try
    // to reserve 4 GiB for a body that does not exist.
    let client = serve(|mut socket| {
        expect_handshake(&mut socket);
        write_frame(
            &mut socket,
            &handshake_response(PROTOCOL_VERSION, instance()),
        )
        .unwrap();
        let _ = expect_request(&mut socket);
        socket.write_all(&u32::MAX.to_le_bytes()).unwrap();
        socket.flush().unwrap();
        thread::sleep(Duration::from_millis(300));
    });

    let error = client
        .request(
            "rhino.document.describe",
            None,
            json!({}),
            Some(Duration::from_secs(5)),
        )
        .expect_err("stream is unusable");
    assert_eq!(error.code, ErrorCode::RequestOutcomeUnknown);
    assert!(
        !client.is_connected(),
        "a framing fault must kill the stream"
    );
}

#[test]
fn a_frame_at_the_size_limit_is_still_accepted() {
    // The cap is a limit, not a suggestion to stay well under: a large
    // `document.objects` result has to fit.
    let big = "x".repeat(64 * 1024);
    let expected = big.clone();
    let client = serve(move |mut socket| {
        expect_handshake(&mut socket);
        write_frame(
            &mut socket,
            &handshake_response(PROTOCOL_VERSION, instance()),
        )
        .unwrap();
        let id = expect_request(&mut socket);
        let response = BridgeMessage::Response(ResponseEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: id,
            status: ResponseStatus::Ok,
            result: json!({ "blob": big }),
            mutation: MutationSummary::default(),
            warnings: Vec::new(),
            duration_ms: 1,
        });
        let frame = encode_frame(&response).expect("under the cap");
        // Written in small pieces, so the client cannot assume one read per
        // frame — a pipe will do this to it.
        for chunk in frame.chunks(1024) {
            socket.write_all(chunk).unwrap();
        }
        socket.flush().unwrap();
        thread::sleep(Duration::from_millis(300));
    });

    let response = client
        .request("rhino.document.objects", None, json!({}), None)
        .expect("large response");
    assert_eq!(response.result["blob"], json!(expected));
}
