//! The one thing loopback cannot prove: that .NET and Rust agree on the wire.
//!
//! Checkpoint C writes the Rhino plug-in in C#. If the framing assumption is
//! wrong, that is discovered after a plug-in exists, inside Rhino, where
//! debugging costs an order of magnitude more. So the framing is proved here
//! first, against a real `NamedPipeServerStream` driven by PowerShell — the
//! same .NET type and the same options the plug-in will use.
//!
//! Skipped, loudly, if no PowerShell is available rather than passing quietly.

#![cfg(windows)]

use hii_rhino_ipc::{connection::PipeConnection, BridgeClient};
use hii_rhino_protocol::{
    framing::{read_frame, write_frame},
    transport::{self, Advertisement},
    ApplicationInstance, BridgeMessage, ClientMessage, ErrorCode, EventEnvelope, EventKind,
    HandshakeRequest, HandshakeResponse, MutationSummary, ResponseEnvelope, ResponseStatus,
    RhinoInstanceId, RhinoSessionRef, PROTOCOL_VERSION,
};
use serde_json::json;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

fn powershell() -> Option<&'static str> {
    for candidate in ["pwsh", "powershell"] {
        let found = Command::new(candidate)
            .args(["-NoProfile", "-Command", "exit 0"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if matches!(found, Ok(status) if status.success()) {
            return Some(candidate);
        }
    }
    None
}

struct Stub {
    child: Child,
    dir: PathBuf,
}

impl Stub {
    /// Whatever the stub complained about. A PowerShell error would otherwise
    /// surface only as an unexplained closed pipe.
    fn log(&self) -> String {
        let read = |name: &str| fs::read_to_string(self.dir.join(name)).unwrap_or_default();
        let trace = read("ready.log");
        format!(
            "stdout:
{}
stderr:
{}",
            read("stub.out"),
            read("stub.err")
        ) + &format!(
            "
trace:
{trace}"
        )
    }
}

impl Drop for Stub {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn instance() -> RhinoInstanceId {
    RhinoInstanceId(Uuid::from_u128(0x1111_2222_3333_4444_5555_6666_7777_8888))
}

fn write_json(dir: &Path, name: &str, value: &BridgeMessage) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, serde_json::to_string(value).expect("serialize")).expect("write");
    path
}

/// Start the stub on a pipe named by the same rule the bridge will use, and
/// wait until the pipe actually exists.
fn start_stub(shell: &str, pid: u32, mute: bool) -> (Stub, Advertisement) {
    let dir = std::env::temp_dir().join(format!("hii-rhino-pipe-{pid}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");

    let handshake = write_json(
        &dir,
        "handshake.json",
        &BridgeMessage::Handshake(HandshakeResponse {
            protocol_version: PROTOCOL_VERSION,
            application: ApplicationInstance {
                application: "rhino".into(),
                application_version: "8.0.0.0".into(),
                adapter_version: "0.1.0".into(),
                process_id: pid,
                rhino_instance_id: instance(),
            },
            features: vec!["rhino.document".into()],
        }),
    );
    let event = write_json(
        &dir,
        "event.json",
        &BridgeMessage::Event(EventEnvelope {
            protocol_version: PROTOCOL_VERSION,
            event_id: "evt-pipe".into(),
            kind: EventKind::ObjectAdded,
            session: RhinoSessionRef {
                rhino_instance_id: instance(),
                process_id: pid,
                session_id: 1,
                document_runtime_serial: Some(17),
            },
            emitted_at_unix_ms: 1_700_000_000_000,
            data: json!({ "source": "stub" }),
            dropped_before: None,
        }),
    );
    let template = write_json(
        &dir,
        "response.json",
        &BridgeMessage::Response(ResponseEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: "__REQUEST_ID__".into(),
            status: ResponseStatus::Ok,
            // Non-ASCII on purpose: a bridge that measures the prefix in
            // characters instead of bytes desynchronises here and nowhere else.
            result: json!({ "note": "40 mm × 40 mm × 40 mm" }),
            mutation: MutationSummary::default(),
            warnings: Vec::new(),
            duration_ms: 3,
        }),
    );
    let ready = dir.join("ready");

    // The name is derived from `pid` only to keep concurrent tests apart. The
    // advertisement's `process_id` is filled in below from the stub's real
    // process id, because the facade now checks it against the pipe's actual
    // server before it writes anything.
    let pipe_name = transport::pipe_name(1, pid);

    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("support")
        .join("bridge_stub.ps1");

    let child = Command::new(shell)
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .arg("-PipeName")
        .arg(&pipe_name)
        .arg("-HandshakePath")
        .arg(&handshake)
        .arg("-EventPath")
        .arg(&event)
        .arg("-ResponseTemplatePath")
        .arg(&template)
        .arg("-ReadyPath")
        .arg(&ready)
        .args(if mute { &["-Mute"][..] } else { &[][..] })
        // To files, not pipes: nothing here drains a pipe, and a stub that
        // wrote enough to fill one would block instead of failing.
        .stdout(Stdio::from(
            fs::File::create(dir.join("stub.out")).expect("stub log"),
        ))
        .stderr(Stdio::from(
            fs::File::create(dir.join("stub.err")).expect("stub log"),
        ))
        .spawn()
        .expect("spawn the bridge stub");

    let advertisement = Advertisement {
        protocol_version: PROTOCOL_VERSION,
        rhino_instance_id: instance(),
        // The shell hosting the stub *is* the pipe server, so this is what
        // `GetNamedPipeServerProcessId` will report.
        process_id: child.id(),
        session_id: 1,
        pipe_name,
        application_version: "8.0.0.0".into(),
        adapter_version: "0.1.0".into(),
        started_at_unix_ms: 1_700_000_000_000,
    };

    let stub = Stub { child, dir };

    let deadline = Instant::now() + Duration::from_secs(20);
    while !ready.exists() {
        assert!(
            Instant::now() < deadline,
            "the bridge stub never created the pipe"
        );
        thread::sleep(Duration::from_millis(50));
    }

    (stub, advertisement)
}

#[test]
fn a_dotnet_named_pipe_server_and_this_client_agree_on_the_wire() {
    let Some(shell) = powershell() else {
        eprintln!("SKIPPED: no PowerShell available to host the .NET pipe server");
        return;
    };

    let (stub, advertisement) = start_stub(shell, std::process::id(), false);

    let client = BridgeClient::connect(advertisement.clone()).unwrap_or_else(|error| {
        panic!(
            "connect over the named pipe: {error:?}
{}",
            stub.log()
        )
    });

    // The handshake crossed a real pipe, in byte mode, framed by a
    // little-endian length written by .NET and read by Rust.
    assert_eq!(client.handshake().protocol_version, PROTOCOL_VERSION);
    assert_eq!(
        client.handshake().application.rhino_instance_id,
        advertisement.rhino_instance_id
    );
    assert!(client.supports("rhino.document"));
    assert!(!client.supports("grasshopper.solve"));

    let response = client
        .request(
            "rhino.document.describe",
            None,
            json!({ "detail": "summary" }),
            Some(Duration::from_secs(10)),
        )
        .unwrap_or_else(|error| {
            panic!(
                "response over the named pipe: {error:?}
{}",
                stub.log()
            )
        });
    assert_eq!(response.status, ResponseStatus::Ok);
    assert_eq!(response.result["note"], json!("40 mm × 40 mm × 40 mm"));

    // The stub sends the event *before* the response, as Rhino will.
    let event = client
        .next_event(Duration::from_secs(5))
        .expect("the event was kept, not swallowed by the response path");
    assert_eq!(event.event_id, "evt-pipe");
    assert_eq!(event.kind, EventKind::ObjectAdded);
}

#[test]
fn a_pipe_served_by_a_process_the_advertisement_does_not_name_is_refused_before_we_speak() {
    let Some(shell) = powershell() else {
        eprintln!("skipping: no PowerShell on PATH");
        return;
    };

    let (stub, mut advertisement) = start_stub(shell, std::process::id() + 3, false);

    // The pipe is real and answers correctly; only the advertisement is wrong
    // about who serves it. That is what a stale file looks like after the pid
    // was reused, and what a name squatter looks like from here.
    let real = advertisement.process_id;
    advertisement.process_id = real + 1;

    let error = BridgeClient::connect(advertisement).expect_err("the server pid does not match");

    // Not BridgeUnavailable: `connect_to_any` deletes the advertisement on that
    // code, and a squatter must not be able to evict a real bridge from
    // discovery by answering on its name.
    assert_eq!(error.code, ErrorCode::RhinoInstanceNotFound);
    assert!(
        error.message.contains(&real.to_string()),
        "the message should name who actually serves the pipe: {}",
        error.message
    );

    // Asked of the kernel before any byte was written, so the stub never even
    // saw a handshake to answer.
    let log = stub.log();
    assert!(
        !log.contains("handshake sent"),
        "nothing should have been sent to a pipe that failed the pid check: {log}"
    );
}

#[test]
fn an_advertisement_pointing_at_a_pipe_nobody_serves_is_unavailable_not_a_fault() {
    // A crashed Rhino leaves exactly this behind. It has to read as "prune
    // this", not as an error worth showing anyone.
    let advertisement = Advertisement {
        protocol_version: PROTOCOL_VERSION,
        rhino_instance_id: instance(),
        process_id: 65_535,
        session_id: 1,
        pipe_name: transport::pipe_name(1, 65_535),
        application_version: "8.0.0.0".into(),
        adapter_version: "0.1.0".into(),
        started_at_unix_ms: 1_700_000_000_000,
    };

    let started = Instant::now();
    let error = BridgeClient::connect(advertisement).expect_err("nothing is serving that pipe");
    assert_eq!(error.code, ErrorCode::BridgeUnavailable);
    // A missing pipe must fail immediately; only a *busy* one is worth waiting
    // for, and this is neither.
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "took {:?}",
        started.elapsed()
    );
}

#[test]
fn pipe_serialisation_regression_a_write_is_not_blocked_by_a_pending_read() {
    // This is the bug that forced overlapped I/O, pinned so it cannot come
    // back. On a synchronous handle the reader thread's pending `ReadFile`
    // holds the handle's I/O queue and this write blocks behind it — measured
    // at 87 seconds before the rewrite, ending in `ERROR_NO_DATA`.
    //
    // The stub reads the request and deliberately never answers it. So the
    // write completing at all is the proof: it happened while this client had
    // a read pending on the same handle.
    //
    // (The stub must keep reading. A pipe whose peer has stopped draining it
    // blocks writers for ordinary flow-control reasons, which would prove
    // nothing either way — and is why `WRITE_TIMEOUT` exists.)
    let Some(shell) = powershell() else {
        eprintln!("SKIPPED: no PowerShell available to host the .NET pipe server");
        return;
    };

    let (stub, advertisement) = start_stub(shell, std::process::id() + 1, true);
    let client = BridgeClient::connect(advertisement).unwrap_or_else(|error| {
        panic!(
            "connect: {error:?}
{}",
            stub.log()
        )
    });

    let started = Instant::now();
    let error = client
        .request(
            "rhino.document.describe",
            None,
            json!({}),
            Some(Duration::from_millis(400)),
        )
        .expect_err("the stub never answers");
    let elapsed = started.elapsed();

    // The request went out and was not answered — which is a *caller* deadline
    // expiring, not a write that could not happen.
    assert_eq!(
        error.code,
        ErrorCode::RequestOutcomeUnknown,
        "{error:?} after {elapsed:?}: the write itself failed, so the handle is          serialised again{}",
        stub.log()
    );
    assert!(
        elapsed < Duration::from_secs(3),
        "the write blocked for {elapsed:?}"
    );
}

#[test]
fn a_timed_out_read_leaves_the_connection_usable() {
    // Exercises the cancel-then-reap path in `run_overlapped`. Getting the
    // order wrong there is memory-unsafe rather than merely wrong — the kernel
    // would keep writing into a buffer that has gone away — and the symptom
    // would be unexplained corruption much later, so it is proved directly.
    let Some(shell) = powershell() else {
        eprintln!("SKIPPED: no PowerShell available to host the .NET pipe server");
        return;
    };

    let (stub, advertisement) = start_stub(shell, std::process::id() + 2, false);
    let connection = PipeConnection::open(&advertisement).expect("open");
    let (mut reader, mut writer) = connection
        .split_typed(Some(Duration::from_millis(200)))
        .expect("split");

    // Nothing has been asked for, so this read must time out and be cancelled.
    let mut buffer = [0u8; 4];
    let error = reader
        .read(&mut buffer)
        .expect_err("nothing to read yet")
        .kind();
    assert_eq!(error, std::io::ErrorKind::TimedOut);

    // The connection has to still work afterwards. A leaked or unreaped
    // operation shows up here.
    write_frame(
        &mut writer,
        &ClientMessage::Handshake(HandshakeRequest {
            protocol_version: PROTOCOL_VERSION,
            client: "hii-cli".into(),
            client_version: "0.1.0".into(),
        }),
    )
    .unwrap_or_else(|error| {
        panic!(
            "write after a cancelled read: {error}
{}",
            stub.log()
        )
    });

    let message: BridgeMessage = read_frame(&mut reader).unwrap_or_else(|error| {
        panic!(
            "read after a cancelled read: {error}
{}",
            stub.log()
        )
    });
    assert!(
        matches!(message, BridgeMessage::Handshake(_)),
        "{message:?}"
    );
}
