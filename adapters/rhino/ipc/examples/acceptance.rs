//! Checkpoint C through F acceptance, run against a real Rhino.
//!
//! Everything else in this crate can be proved without Rhino, and is. This
//! cannot: plug-in load, the identity Rhino actually reports, and what happens
//! when the host goes away are properties of the host, and a test suite that
//! agreed with itself about them would prove nothing.
//!
//! Three modes, matching the three states a person can put Rhino into:
//!
//! ```text
//! cargo run -p hii-rhino-ipc --example acceptance -- running
//!     after StartHiiRhinoBridge
//! cargo run -p hii-rhino-ipc --example acceptance -- stopped
//!     after StopHiiRhinoBridge
//! cargo run -p hii-rhino-ipc --example acceptance -- watch
//!     leave it running, then close Rhino
//! ```
//!
//! Every check prints its own verdict and the process exits non-zero if any
//! failed, so a partial pass cannot be mistaken for a pass.

use hii_rhino_ipc::{advertisement_dir, discovery, BridgeClient};
use hii_rhino_protocol::{
    transport::Advertisement, DocumentRef, ErrorCode, EventKind, RhinoInstanceId, TargetRef,
    PROTOCOL_VERSION,
};
use serde_json::Value;
use std::{
    process::ExitCode,
    time::{Duration, Instant},
};

struct Report {
    failures: usize,
    checks: usize,
}

impl Report {
    fn new() -> Self {
        Self {
            failures: 0,
            checks: 0,
        }
    }

    fn check(&mut self, label: &str, ok: bool, detail: impl AsRef<str>) {
        self.checks += 1;
        if ok {
            println!("  PASS  {label} — {}", detail.as_ref());
        } else {
            self.failures += 1;
            println!("  FAIL  {label} — {}", detail.as_ref());
        }
    }

    fn note(&self, message: impl AsRef<str>) {
        println!("        {}", message.as_ref());
    }

    fn finish(self, mode: &str) -> ExitCode {
        println!();
        if self.failures == 0 {
            println!("{mode}: all {} checks passed", self.checks);
            ExitCode::SUCCESS
        } else {
            println!("{mode}: {} of {} checks FAILED", self.failures, self.checks);
            ExitCode::FAILURE
        }
    }
}

fn main() -> ExitCode {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "running".into());
    match mode.as_str() {
        "running" => expect_running(),
        "stopped" => expect_stopped(),
        "watch" => watch(),
        other => {
            eprintln!("unknown mode '{other}'; expected running, stopped or watch");
            ExitCode::FAILURE
        }
    }
}

fn instances() -> Vec<discovery::DiscoveredBridge> {
    // Printed because the commonest way for this to go wrong is invisible:
    // `HII_RUNTIME_DIR` set in the shell that runs this but not in the
    // environment Rhino was started from. The two then resolve different
    // directories and it presents as "the bridge never started".
    match std::env::var("HII_RUNTIME_DIR") {
        Ok(value) => println!("HII_RUNTIME_DIR = {value} (Rhino must see the same value)"),
        Err(_) => println!("HII_RUNTIME_DIR is unset; both sides default to ~/.hii"),
    }

    match advertisement_dir() {
        Ok(dir) => {
            println!("advertisement directory: {}", dir.display());
            discovery::scan(&dir)
        }
        Err(error) => {
            eprintln!("could not resolve the advertisement directory: {error:?}");
            Vec::new()
        }
    }
}

/// C, D, E and G: the bridge is running and should behave.
fn expect_running() -> ExitCode {
    let mut report = Report::new();
    println!("checkpoint C-F acceptance — bridge expected to be RUNNING\n");

    let found = instances();
    // Not "exactly one". Several Rhinos may legitimately be open, and a Rhino
    // that was closed without stopping its bridge leaves a file behind on
    // purpose — that is checkpoint H's whole point. Discovery finding the live
    // one among them is the property under test.
    report.check(
        "C  discovery finds a Rhino instance",
        !found.is_empty(),
        format!(
            "{} advertisement(s) found; using the most recent",
            found.len()
        ),
    );
    let Some(bridge) = found.first() else {
        return report.finish("running");
    };

    let advertisement = bridge.advertisement.clone();
    report.note(format!("file: {}", bridge.path.display()));
    report.note(format!(
        "advertised: pid {} session {} instance {}",
        advertisement.process_id, advertisement.session_id, advertisement.rhino_instance_id
    ));
    report.note(format!("pipe: {}", advertisement.pipe_name));

    report.check(
        "B  the advertised name is the one this build would derive",
        advertisement.pipe_name
            == hii_rhino_protocol::transport::pipe_name(
                advertisement.session_id,
                advertisement.process_id,
            ),
        &advertisement.pipe_name,
    );

    // The pid cross-check runs inside `connect`, before a byte is written, so a
    // successful connection already proves the advertised pid is the pipe's
    // real server. It is called out here because it is otherwise invisible.
    let started = Instant::now();
    let client = match BridgeClient::connect(advertisement.clone()) {
        Ok(client) => {
            report.check(
                "D  a real handshake completes against the C# plug-in",
                true,
                format!("connected in {:?}", started.elapsed()),
            );
            client
        }
        Err(error) => {
            report.check(
                "D  a real handshake completes against the C# plug-in",
                false,
                format!("{:?}: {}", error.code, error.message),
            );
            return report.finish("running");
        }
    };

    let handshake = client.handshake();
    report.check(
        "E  advertised pid == handshake pid",
        handshake.application.process_id == advertisement.process_id,
        format!(
            "{} vs {}",
            handshake.application.process_id, advertisement.process_id
        ),
    );
    report.check(
        "E  advertised instance id == handshake instance id",
        handshake.application.rhino_instance_id == advertisement.rhino_instance_id,
        format!(
            "{} vs {}",
            handshake.application.rhino_instance_id, advertisement.rhino_instance_id
        ),
    );
    report.check(
        "E  the protocol version is accepted",
        handshake.protocol_version == PROTOCOL_VERSION,
        format!("bridge speaks {}", handshake.protocol_version),
    );
    report.check(
        "E  Rhino reports a plausible version",
        handshake.application.application_version.starts_with("8."),
        format!(
            "{} (adapter {})",
            handshake.application.application_version, handshake.application.adapter_version
        ),
    );
    report.check(
        "E  the pipe's server process is the advertised one",
        true,
        "checked against GetNamedPipeServerProcessId before the handshake was sent",
    );

    // The catalogue invariant. A feature flag is what the facade turns into a
    // tool a model may call, so every one of these has to have operations
    // behind it — and nothing may be advertised that does not.
    let expected_features = [
        "rhino.session",
        "rhino.document",
        "rhino.geometry",
        "rhino.mutate",
        "rhino.undo",
    ];
    report.check(
        "E  exactly the implemented capabilities are advertised",
        handshake.features.len() == expected_features.len()
            && expected_features
                .iter()
                .all(|wanted| handshake.features.iter().any(|have| have == wanted)),
        format!("features: {:?}", handshake.features),
    );
    report.check(
        "C  nothing Grasshopper is advertised, because none of it exists",
        !handshake
            .features
            .iter()
            .any(|feature| feature.starts_with("grasshopper")),
        "no grasshopper capability claimed",
    );

    // Proves request routing, correlation by request id, and typed errors,
    // without any operation existing to be called.
    match client.request(
        "rhino.document.describe",
        None,
        serde_json::Value::Null,
        None,
    ) {
        Ok(response) => report.check(
            "C  an unimplemented operation is refused, not faked",
            false,
            format!("the bridge answered with {:?}", response.status),
        ),
        Err(error) => {
            report.check(
                "C  an unimplemented operation is refused with a typed error",
                error.code == ErrorCode::OperationNotSupported,
                format!("{:?}: {}", error.code, error.message),
            );
            report.check(
                "C  the refusal is correlated to the request that caused it",
                error.request_id.is_some(),
                format!("request_id {:?}", error.request_id),
            );
        }
    }

    // Checked before the dispatcher section, which deliberately abandons a
    // request and therefore expects exactly the late answer this forbids.
    report.check(
        "C  no response arrived that nobody asked for",
        client.stray_response_count() == 0,
        format!("{} stray responses", client.stray_response_count()),
    );

    check_dispatcher(&mut report, &client);

    if let Some(document) = check_reads(&mut report, &client, &advertisement) {
        check_mutation(&mut report, &client, &advertisement, document);
    }

    report.check(
        "C  no unsolicited events are emitted in this checkpoint",
        client.drain_events().is_empty(),
        "event queue empty",
    );

    // G: drop the client the way a killed CLI would, then come back.
    drop(client);
    match BridgeClient::connect(advertisement) {
        Ok(second) => report.check(
            "G  a dropped client does not take the bridge with it",
            second.is_connected(),
            "reconnected after the first client was dropped",
        ),
        Err(error) => report.check(
            "G  a dropped client does not take the bridge with it",
            false,
            format!("{:?}: {}", error.code, error.message),
        ),
    }

    report.finish("running")
}

/// Checkpoint D: work reaches Rhino's UI thread, and what comes back when it
/// does not is typed correctly.
///
/// The diagnostics used here read nothing and change nothing. They exist only
/// so the dispatcher can be shown to work before any operation depends on it.
fn check_dispatcher(report: &mut Report, client: &BridgeClient) {
    // 1. It really is Rhino's UI thread, according to Rhino.
    match client.request(
        "bridge.diagnostics.thread",
        None,
        serde_json::Value::Null,
        Some(Duration::from_secs(10)),
    ) {
        Ok(response) => {
            let on_ui = response
                .result
                .get("on_ui_thread")
                .and_then(|v| v.as_bool());
            let pooled = response
                .result
                .get("is_thread_pool_thread")
                .and_then(|v| v.as_bool());
            report.check(
                "D  the operation body runs on Rhino's UI thread",
                on_ui == Some(true) && pooled == Some(false),
                format!("{}", response.result),
            );
        }
        Err(error) => report.check(
            "D  the operation body runs on Rhino's UI thread",
            false,
            format!("{:?}: {}", error.code, error.message),
        ),
    }

    // 2. An exception on the UI thread arrives as a typed native failure,
    //    carrying enough to act on and no stack trace.
    match client.request(
        "bridge.diagnostics.fail",
        None,
        serde_json::json!({ "message": "a deliberate acceptance failure" }),
        Some(Duration::from_secs(10)),
    ) {
        Ok(response) => report.check(
            "D  an exception on the UI thread propagates as a typed failure",
            false,
            format!("the bridge reported success: {:?}", response.status),
        ),
        Err(error) => report.check(
            "D  an exception on the UI thread propagates as a typed failure",
            error.code == ErrorCode::NativeOperationFailed
                && error.message.contains("a deliberate acceptance failure")
                && !error.message.contains("   at "),
            format!("{:?}: {}", error.code, error.message),
        ),
    }

    // 3. The bridge gives up on its own overrunning work.
    //
    //    The UI thread must be idle first. An earlier long operation still
    //    holding it would mean this one never starts, and the bridge would
    //    correctly answer `Cancelled` — a true statement about a different
    //    situation than the one being tested.
    wait_for_idle_ui(report, client, "before the bridge-deadline check");

    match client.request_with_bridge_deadline(
        "bridge.diagnostics.block",
        None,
        serde_json::json!({ "hold_ms": 4000 }),
        // The caller is patient; Rhino is not given long. That forces the
        // bridge to be the one that gives up. With equal budgets the facade
        // always wins, because its clock starts first, and the bridge's own
        // mapping is never exercised.
        Duration::from_secs(20),
        Duration::from_millis(400),
    ) {
        Ok(response) => report.check(
            "D  the bridge abandons work that overruns its own deadline",
            false,
            format!("the bridge reported success: {:?}", response.status),
        ),
        Err(error) => {
            // Started, and unstoppable once started, so the honest answer is
            // that the outcome is unknown — never `Timeout`, which is Safe and
            // would license repeating a half-finished mutation.
            report.check(
                "D  the bridge abandons work that overruns its own deadline",
                error.code == ErrorCode::RequestOutcomeUnknown,
                format!("{:?}: {}", error.code, error.message),
            );
            report.check(
                "D  and that outcome is not marked safe to retry",
                error.retry == hii_rhino_protocol::RetryDisposition::Unsafe,
                format!("{:?}", error.retry),
            );
            report.check(
                "D  and the answer is the bridge's, not the facade's own timer",
                error.message.contains("UI thread"),
                error.message.clone(),
            );
        }
    }

    // 4. The facade's deadline expiring first, which is the ordinary case.
    wait_for_idle_ui(report, client, "before the facade-deadline check");

    let strays_before = client.stray_response_count();
    match client.request_with_bridge_deadline(
        "bridge.diagnostics.block",
        None,
        serde_json::json!({ "hold_ms": 2000 }),
        Duration::from_millis(400),
        // Rhino is told to finish. The point is what the *facade* does when it
        // stops waiting on work that is still legitimately running.
        Duration::from_secs(30),
    ) {
        Ok(response) => report.check(
            "D  the facade stops waiting without claiming to know the outcome",
            false,
            format!("the bridge answered within the wait: {:?}", response.status),
        ),
        Err(error) => report.check(
            "D  the facade stops waiting without claiming to know the outcome",
            error.code == ErrorCode::RequestOutcomeUnknown
                && error.retry == hii_rhino_protocol::RetryDisposition::Unsafe,
            format!("{:?} / {:?}: {}", error.code, error.retry, error.message),
        ),
    }

    // 5. That operation is still running, and will answer into a caller that is
    //    no longer there. The answer must be counted rather than handed to
    //    whoever asks next — mistaking it for another request's response is the
    //    failure mode the demultiplexer exists to prevent.
    wait_for_idle_ui(report, client, "after the abandoned request");

    // Polled, not sampled once. The late answer arrives on its own schedule,
    // and reading the counter the instant the settling request returns is a
    // race that reports "no late answer" when it simply has not landed yet.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut late = client.stray_response_count() - strays_before;
    while late == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
        late = client.stray_response_count() - strays_before;
    }

    report.check(
        "D  a late answer is counted, not mistaken for another request's",
        late >= 1,
        format!("{late} late answer(s) recorded"),
    );

    // 6. And the connection is entirely usable afterwards.
    match client.request(
        "bridge.diagnostics.thread",
        None,
        serde_json::Value::Null,
        Some(Duration::from_secs(30)),
    ) {
        Ok(_) => report.check(
            "D  the connection still works after an abandoned request",
            true,
            "a later request was answered normally",
        ),
        Err(error) => report.check(
            "D  the connection still works after an abandoned request",
            false,
            format!("{:?}: {}", error.code, error.message),
        ),
    }
}

/// Address a request to one document, by identity rather than by "the active one".
fn document_target(advertisement: &Advertisement, serial: u32) -> TargetRef {
    TargetRef::Document(DocumentRef {
        rhino_instance_id: advertisement.rhino_instance_id.clone(),
        document_runtime_serial: serial,
    })
}

/// Checkpoint E: everything HII can learn without changing anything.
///
/// Returns the document runtime serial the mutation checks should use, so that
/// the serial comes from discovery rather than from a guess.
fn check_reads(
    report: &mut Report,
    client: &BridgeClient,
    advertisement: &Advertisement,
) -> Option<u32> {
    let session = match client.request(
        "rhino.session.describe",
        None,
        Value::Null,
        Some(Duration::from_secs(15)),
    ) {
        Ok(response) => response.result,
        Err(error) => {
            report.check(
                "E  the session can be described",
                false,
                format!("{:?}: {}", error.code, error.message),
            );
            return None;
        }
    };

    report.check(
        "E  the session reports this instance",
        session.get("rhino_instance_id").and_then(|v| v.as_str())
            == Some(advertisement.rhino_instance_id.to_string().as_str()),
        format!(
            "{}",
            session.get("rhino_instance_id").unwrap_or(&Value::Null)
        ),
    );

    let documents = session
        .get("documents")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    report.check(
        "E  at least one open document is listed",
        !documents.is_empty(),
        format!("{} document(s)", documents.len()),
    );

    let first = documents.first()?;
    let serial = first.get("document_runtime_serial")?.as_u64()? as u32;
    report.note(format!(
        "document {serial}: {} in {}, {} object(s)",
        first
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("(unsaved)"),
        first
            .get("unit_system")
            .and_then(|v| v.as_str())
            .unwrap_or("?"),
        first
            .get("object_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
    ));

    // The identity rule, tested rather than trusted. A document operation with
    // no target must be refused, not quietly resolved to whatever document the
    // user happens to have in front of them.
    match client.request(
        "rhino.document.describe",
        None,
        Value::Null,
        Some(Duration::from_secs(10)),
    ) {
        Ok(_) => report.check(
            "E  a document request with no target is refused, not guessed",
            false,
            "the bridge answered without being told which document",
        ),
        Err(error) => report.check(
            "E  a document request with no target is refused, not guessed",
            error.code == ErrorCode::InvalidArguments,
            format!("{:?}: {}", error.code, error.message),
        ),
    }

    // A runtime serial minted by a different Rhino means nothing here, and
    // acting on it would touch whatever document happens to hold that serial.
    let foreign = TargetRef::Document(DocumentRef {
        rhino_instance_id: RhinoInstanceId(uuid::Uuid::from_u128(0xDEAD_BEEF)),
        document_runtime_serial: serial,
    });
    match client.request(
        "rhino.document.describe",
        Some(foreign),
        Value::Null,
        Some(Duration::from_secs(10)),
    ) {
        Ok(_) => report.check(
            "E  a reference from another Rhino instance is refused",
            false,
            "the bridge acted on a reference belonging to a different instance",
        ),
        Err(error) => report.check(
            "E  a reference from another Rhino instance is refused",
            error.code == ErrorCode::StaleReference,
            format!("{:?}: {}", error.code, error.message),
        ),
    }

    let target = document_target(advertisement, serial);
    match client.request(
        "rhino.document.describe",
        Some(target.clone()),
        Value::Null,
        Some(Duration::from_secs(15)),
    ) {
        Ok(response) => {
            let millimetres = response
                .result
                .get("document")
                .and_then(|d| d.get("millimetres_per_unit"))
                .and_then(|v| v.as_f64());
            let layers = response
                .result
                .get("layers")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);

            report.check(
                "E  the document reports its units and a usable scale to millimetres",
                millimetres.is_some_and(|scale| scale > 0.0),
                format!(
                    "{} @ {:?} mm per unit, {layers} layer(s)",
                    response
                        .result
                        .get("document")
                        .and_then(|d| d.get("unit_system"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("?"),
                    millimetres
                ),
            );
        }
        Err(error) => report.check(
            "E  the document reports its units and a usable scale to millimetres",
            false,
            format!("{:?}: {}", error.code, error.message),
        ),
    }

    match client.request(
        "rhino.document.objects",
        Some(target.clone()),
        serde_json::json!({ "limit": 5 }),
        Some(Duration::from_secs(15)),
    ) {
        Ok(response) => report.check(
            "E  objects can be enumerated, a page at a time",
            response.result.get("total").is_some() && response.result.get("objects").is_some(),
            format!(
                "total {}, page of {}",
                response.result["total"],
                response.result["objects"].as_array().map_or(0, |a| a.len())
            ),
        ),
        Err(error) => report.check(
            "E  objects can be enumerated, a page at a time",
            false,
            format!("{:?}: {}", error.code, error.message),
        ),
    }

    // A lookup that finds nothing is a typed answer, not a fault and not an
    // empty success.
    match client.request(
        "rhino.object.get",
        Some(target),
        serde_json::json!({ "object_id": "00000000-0000-0000-0000-0000000000ff" }),
        Some(Duration::from_secs(10)),
    ) {
        Ok(_) => report.check(
            "E  a missing object is reported as missing",
            false,
            "the bridge described an object that does not exist",
        ),
        Err(error) => report.check(
            "E  a missing object is reported as missing",
            error.code == ErrorCode::ObjectNotFound,
            format!("{:?}: {}", error.code, error.message),
        ),
    }

    Some(serial)
}

/// Checkpoint F: create a 40 mm box, prove it, then undo it.
///
/// The point is not that the call returns a GUID. It is that the box is
/// independently re-read afterwards and measured, that the observation Rhino
/// emitted is seen, and that the whole thing reverses with one undo.
fn check_mutation(
    report: &mut Report,
    client: &BridgeClient,
    advertisement: &Advertisement,
    serial: u32,
) {
    let target = document_target(advertisement, serial);
    let before = object_count(client, &target);

    // Drain first, so any ObjectAdded seen afterwards belongs to this box.
    let _ = client.drain_events();

    let created = match client.request(
        "rhino.object.create",
        Some(target.clone()),
        serde_json::json!({
            "kind": "box",
            "size_mm": 40.0,
            "origin": [0.0, 0.0, 0.0],
            "anchor": "corner",
        }),
        Some(Duration::from_secs(30)),
    ) {
        Ok(response) => {
            report.check(
                "F  a 40 mm box is created",
                response.result.get("object_id").is_some(),
                format!("{}", response.result),
            );
            response.result
        }
        Err(error) => {
            report.check(
                "F  a 40 mm box is created",
                false,
                format!("{:?}: {}", error.code, error.message),
            );
            return;
        }
    };

    let Some(object_id) = created.get("object_id").and_then(|v| v.as_str()) else {
        return;
    };

    // --- verification: an independent read, not the mutation's own word -----

    let mut checks: Vec<(String, bool, String)> = Vec::new();

    match client.request(
        "rhino.object.get",
        Some(target.clone()),
        serde_json::json!({ "object_id": object_id, "include_bounding_box": true }),
        Some(Duration::from_secs(15)),
    ) {
        Ok(response) => {
            let found = &response.result;
            checks.push((
                "the object exists when the document is read back".into(),
                found.get("object_id").and_then(|v| v.as_str()) == Some(object_id),
                format!("{}", found.get("object_id").unwrap_or(&Value::Null)),
            ));
            checks.push((
                "it is a solid, not a curve or a surface".into(),
                found.get("geometry_type").and_then(|v| v.as_str()) == Some("Brep"),
                format!("{}", found.get("geometry_type").unwrap_or(&Value::Null)),
            ));

            let size = found
                .get("bounding_box")
                .and_then(|b| b.get("size_mm"))
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_f64()).collect::<Vec<_>>())
                .unwrap_or_default();
            checks.push((
                "it measures 40 mm on every axis".into(),
                size.len() == 3 && size.iter().all(|value| (value - 40.0).abs() < 1e-6),
                format!("{size:?} mm"),
            ));

            let min = found
                .get("bounding_box")
                .and_then(|b| b.get("min"))
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_f64()).collect::<Vec<_>>())
                .unwrap_or_default();
            checks.push((
                "its near corner is at the origin, as asked".into(),
                min.len() == 3 && min.iter().all(|value| value.abs() < 1e-9),
                format!("{min:?}"),
            ));
        }
        Err(error) => checks.push((
            "the object exists when the document is read back".into(),
            false,
            format!("{:?}: {}", error.code, error.message),
        )),
    }

    // A second, differently-shaped read. Two independent operations agreeing is
    // worth more than one operation asserting.
    match client.request(
        "rhino.geometry.bounding_box",
        Some(target.clone()),
        serde_json::json!({ "object_ids": [object_id] }),
        Some(Duration::from_secs(15)),
    ) {
        Ok(response) => {
            let size = response.result["boxes"][object_id]["size_mm"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_f64()).collect::<Vec<_>>())
                .unwrap_or_default();
            checks.push((
                "a second independent read agrees on the size".into(),
                size.len() == 3 && size.iter().all(|value| (value - 40.0).abs() < 1e-6),
                format!("{size:?} mm"),
            ));
        }
        Err(error) => checks.push((
            "a second independent read agrees on the size".into(),
            false,
            format!("{:?}: {}", error.code, error.message),
        )),
    }

    checks.push((
        "the document gained exactly one object".into(),
        matches!((before, object_count(client, &target)), (Some(a), Some(b)) if b == a + 1),
        format!("{before:?} then {:?}", object_count(client, &target)),
    ));

    for (description, ok, detail) in &checks {
        report.check(&format!("F  {description}"), *ok, detail);
    }

    // The four-state verdict. "Could not check" is not a success, and this is
    // the number that would go into the receipt.
    let failed = checks.iter().filter(|(_, ok, _)| !ok).count();
    let verdict = if failed > 0 {
        "failed"
    } else if checks.is_empty() {
        "unverified"
    } else {
        "verified"
    };
    report.note(format!(
        "verification verdict: {verdict} ({} of {} postconditions held)",
        checks.len() - failed,
        checks.len()
    ));

    // --- the observation Rhino emitted -------------------------------------

    let mut observed = None;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && observed.is_none() {
        if let Some(event) = client.next_event(Duration::from_millis(500)) {
            if event.data.get("object_id").and_then(|v| v.as_str()) == Some(object_id) {
                observed = Some(event);
            }
        }
    }
    report.check(
        "F  Rhino's own event confirms the object was added",
        observed
            .as_ref()
            .is_some_and(|event| event.kind == EventKind::ObjectAdded),
        match &observed {
            Some(event) => format!("{:?} {}", event.kind, event.event_id),
            None => "no matching ObjectAdded arrived".into(),
        },
    );
    report.check(
        "F  no observation was dropped, so absence of evidence means something",
        client.dropped_event_count() == 0,
        format!("{} dropped", client.dropped_event_count()),
    );

    // --- and it all reverses with one undo ---------------------------------

    match client.request(
        "rhino.undo",
        Some(target.clone()),
        Value::Null,
        Some(Duration::from_secs(30)),
    ) {
        Ok(response) => report.check(
            "F  one undo is accepted",
            true,
            format!("{}", response.result),
        ),
        Err(error) => report.check(
            "F  one undo is accepted",
            false,
            format!("{:?}: {}", error.code, error.message),
        ),
    }

    match client.request(
        "rhino.object.get",
        Some(target.clone()),
        serde_json::json!({ "object_id": object_id }),
        Some(Duration::from_secs(15)),
    ) {
        Ok(_) => report.check(
            "F  the box is gone after the undo",
            false,
            "the object is still there",
        ),
        Err(error) => report.check(
            "F  the box is gone after the undo",
            error.code == ErrorCode::ObjectNotFound,
            format!("{:?}: {}", error.code, error.message),
        ),
    }

    report.check(
        "F  the document is back to the object count it started with",
        object_count(client, &target) == before,
        format!("{:?} vs {before:?}", object_count(client, &target)),
    );
}

fn object_count(client: &BridgeClient, target: &TargetRef) -> Option<u64> {
    client
        .request(
            "rhino.document.objects",
            Some(target.clone()),
            serde_json::json!({ "limit": 1 }),
            Some(Duration::from_secs(15)),
        )
        .ok()
        .and_then(|response| response.result.get("total").and_then(|v| v.as_u64()))
}

/// Block until Rhino's UI thread is free.
///
/// A request only completes once the UI thread runs it, so a plain round trip
/// with a generous wait is itself the wait. This exists because the timing
/// checks above are meaningless if a previous operation is still holding the
/// thread: the bridge would answer `Cancelled` — correctly, about a different
/// situation.
fn wait_for_idle_ui(report: &mut Report, client: &BridgeClient, when: &str) {
    if let Err(error) = client.request(
        "bridge.diagnostics.thread",
        None,
        serde_json::Value::Null,
        Some(Duration::from_secs(30)),
    ) {
        report.note(format!(
            "could not settle the UI thread {when}: {:?}: {}",
            error.code, error.message
        ));
    }
}

/// F: the bridge was stopped and should have left nothing behind.
fn expect_stopped() -> ExitCode {
    let mut report = Report::new();
    println!("checkpoint C acceptance — bridge expected to be STOPPED\n");

    let found = instances();
    report.check(
        "F  the advertisement was retracted",
        found.is_empty(),
        format!("{} advertisement(s) remain", found.len()),
    );

    for bridge in &found {
        // A file that outlived its bridge must at least be unreachable, so the
        // facade prunes it rather than hanging on it.
        report.note(format!("stale: {}", bridge.path.display()));
        match BridgeClient::connect(bridge.advertisement.clone()) {
            Ok(_) => report.check(
                "F  nothing is still serving the pipe",
                false,
                "the bridge is still answering after being stopped",
            ),
            Err(error) => report.check(
                "F  a leftover advertisement is unreachable, not a fault",
                error.code == ErrorCode::BridgeUnavailable,
                format!("{:?}: {}", error.code, error.message),
            ),
        }
    }

    report.finish("stopped")
}

/// H: hold a connection open, then watch Rhino go away.
fn watch() -> ExitCode {
    let mut report = Report::new();
    println!("checkpoint C acceptance — connect, then CLOSE RHINO\n");

    let found = instances();
    let Some(bridge) = found.first() else {
        report.check("H  a running bridge to watch", false, "none found");
        return report.finish("watch");
    };

    let client = match BridgeClient::connect(bridge.advertisement.clone()) {
        Ok(client) => client,
        Err(error) => {
            report.check(
                "H  a running bridge to watch",
                false,
                format!("{:?}: {}", error.code, error.message),
            );
            return report.finish("watch");
        }
    };

    println!("connected. Now run StopHiiRhinoBridge, or close or kill Rhino —");
    println!("whenever you like. Waiting up to ten minutes, talking to the");
    println!("bridge the whole time so a request is in flight when it dies.\n");

    // Idle waiting would only prove that a *silent* connection notices a
    // shutdown. Keeping traffic on the wire is the harder and more honest
    // case: one of these requests is the one that was in flight when Rhino
    // went away, and it is exactly the request that must not come back
    // looking like it worked.
    let deadline = Instant::now() + Duration::from_secs(600);
    let mut answered = 0u32;
    let mut succeeded = 0u32;
    let mut last: Option<(ErrorCode, String)> = None;

    while client.is_connected() && Instant::now() < deadline {
        match client.request(
            "rhino.document.describe",
            None,
            serde_json::Value::Null,
            Some(Duration::from_secs(5)),
        ) {
            Ok(response) => {
                // Nothing is implemented, so nothing can legitimately succeed.
                succeeded += 1;
                last = Some((
                    ErrorCode::OperationNotSupported,
                    format!("{:?}", response.status),
                ));
            }
            Err(error) => {
                answered += 1;
                last = Some((error.code, error.message.clone()));
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }

    report.check(
        "H  the loss of the bridge is detected, not waited out",
        !client.is_connected(),
        format!("the connection ended after {answered} exchanges"),
    );
    report.check(
        "H  no request was ever reported as having succeeded",
        succeeded == 0,
        format!("{succeeded} successful responses from a bridge with no operations"),
    );
    if let Some((code, message)) = &last {
        report.note(format!(
            "last exchange before the loss: {code:?}: {message}"
        ));
    }

    // The point of the check. A request made after the connection died was
    // never written, so it must come back as a transport failure — never as a
    // success, and never as anything the harness would treat as "it worked".
    match client.request(
        "rhino.document.describe",
        None,
        serde_json::Value::Null,
        None,
    ) {
        Ok(response) => report.check(
            "H  no request is reported as having succeeded",
            false,
            format!(
                "a response arrived from a dead bridge: {:?}",
                response.status
            ),
        ),
        Err(error) => {
            report.check(
                "H  a request after the loss is reported as a transport failure",
                matches!(
                    error.code,
                    ErrorCode::BridgeUnavailable | ErrorCode::RequestOutcomeUnknown
                ),
                format!("{:?}: {}", error.code, error.message),
            );
            report.note(format!("retry disposition: {:?}", error.retry));

            // A clean shutdown ends the stream at a frame boundary, which
            // reads back as BridgeUnavailable. A stop that cut a frame in half
            // would surface as MalformedMessage instead, so this distinguishes
            // "the bridge let go tidily" from "the bridge was torn out".
            report.check(
                "F/H  the connection ended cleanly, not mid-frame",
                error.code != ErrorCode::MalformedMessage,
                format!("{:?}", error.code),
            );
        }
    }

    let remaining = instances();
    report.note(format!(
        "{} advertisement(s) left behind by the closed Rhino (stale files are a prune candidate, not a fault)",
        remaining.len()
    ));

    report.finish("watch")
}
