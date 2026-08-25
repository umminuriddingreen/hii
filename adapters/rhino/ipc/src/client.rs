//! The demultiplexing bridge client.
//!
//! The shape of this file is forced by one fact about the protocol: the bridge
//! sends **unsolicited** messages. A Rhino `ObjectAdded` event can land between
//! a request going out and its response coming back, including for the very
//! request that caused it. A client that writes a request and then reads the
//! next frame expecting the response works in every simple test and breaks the
//! first time it meets a real document.
//!
//! So: one reader thread does all the reading, and every frame it sees is
//! routed by `request_id` to whoever is waiting, or to the event sink if it is
//! an observation. Callers never read from the stream.
//!
//! # Events are queued, bounded, and may be dropped
//!
//! See [`crate::events`] for the queue itself and why it is not a channel. In
//! short: the reader thread is the only thing that can deliver a response, so
//! it must never block feeding an observation to a consumer that is not
//! draining. It therefore bounds and discards, oldest first, and counts what it
//! discarded — because verification reasons from event evidence, and "no event
//! arrived" must stay distinguishable from "the evidence was thrown away".

use crate::events::EventQueue;
use hii_rhino_protocol::{
    check_version,
    framing::{read_frame, write_frame, FrameError},
    transport::Advertisement,
    BridgeMessage, ClientMessage, ErrorCode, ErrorEnvelope, EventEnvelope, HandshakeRequest,
    HandshakeResponse, RequestEnvelope, ResponseEnvelope, TargetRef, PROTOCOL_VERSION,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

/// How long to wait for a handshake before giving up on a connection.
///
/// The handshake is answered off Rhino's UI thread by design, so it should be
/// immediate; a bridge that cannot manage it in this window is one we do not
/// want to be blocked on.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Default per-request wait when a caller does not set one.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Why a connection ended. Recorded once, then reported to every waiter.
#[derive(Debug, Clone)]
struct Loss {
    code: ErrorCode,
    message: String,
}

#[derive(Default)]
struct Shared {
    pending: Mutex<HashMap<String, Sender<BridgeMessage>>>,
    loss: Mutex<Option<Loss>>,
    /// Responses that arrived for a `request_id` nobody was waiting on: a
    /// duplicate, or a reply to a request that already timed out. Counted
    /// rather than ignored so a bridge bug shows up as a number instead of as
    /// mysteriously absent behaviour.
    stray_responses: AtomicU64,
}

impl Shared {
    fn record_loss(&self, loss: Loss) {
        let mut slot = self.loss.lock().expect("loss mutex");
        if slot.is_none() {
            *slot = Some(loss);
        }
        // Dropping every sender wakes all waiters with `Disconnected`.
        self.pending.lock().expect("pending mutex").clear();
    }

    fn deliver(&self, request_id: &str, message: BridgeMessage) {
        let waiter = self
            .pending
            .lock()
            .expect("pending mutex")
            .remove(request_id);
        match waiter {
            Some(sender) => {
                let _ = sender.send(message);
            }
            None => {
                self.stray_responses.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn loss_envelope(&self, request_id: Option<String>, sent: bool) -> ErrorEnvelope {
        let loss = self.loss.lock().expect("loss mutex").clone();
        let (code, message) = match loss {
            Some(loss) => (loss.code, loss.message),
            None => (
                ErrorCode::BridgeUnavailable,
                "the connection to Rhino ended".to_string(),
            ),
        };
        // A request that was already on the wire may have mutated the
        // document before the connection died. Reporting the underlying
        // transport code here would tell the harness the retry is safe, and it
        // is not.
        let code = if sent {
            ErrorCode::RequestOutcomeUnknown
        } else {
            code
        };
        ErrorEnvelope::new(request_id, code, message)
    }
}

/// A live, handshaken connection to one Rhino bridge.
pub struct BridgeClient {
    handshake: HandshakeResponse,
    advertisement: Advertisement,
    writer: Mutex<Box<dyn Write + Send>>,
    shared: Arc<Shared>,
    events: Arc<EventQueue>,
    next_request: AtomicU64,
    reader: Option<JoinHandle<()>>,
    /// Present only for a real pipe. Cancels the reader thread's pending read
    /// so dropping the client does not leave a thread parked until Rhino
    /// exits.
    canceller: Option<crate::connection::Canceller>,
}

impl BridgeClient {
    /// Connect over an already-opened stream.
    ///
    /// The handshake happens here, before any request can be made, and a
    /// version mismatch refuses the connection outright rather than letting a
    /// half-understood peer make document changes.
    pub fn handshake_over(
        advertisement: Advertisement,
        stream: (Box<dyn Read + Send>, Box<dyn Write + Send>),
    ) -> Result<Self, ErrorEnvelope> {
        let (reader, mut writer) = stream;
        let shared = Arc::new(Shared::default());
        let events = Arc::new(EventQueue::default());
        let (handshake_tx, handshake_rx) = mpsc::channel();

        let worker = {
            let shared = Arc::clone(&shared);
            thread::Builder::new()
                .name("hii-rhino-reader".into())
                .spawn({
                    let events = Arc::clone(&events);
                    move || read_loop(reader, shared, events, handshake_tx)
                })
                .map_err(|error| {
                    ErrorEnvelope::new(
                        None,
                        ErrorCode::BridgeUnavailable,
                        format!("could not start the bridge reader thread: {error}"),
                    )
                })?
        };

        let request = ClientMessage::Handshake(HandshakeRequest {
            protocol_version: PROTOCOL_VERSION,
            client: "hii-cli".into(),
            client_version: env!("CARGO_PKG_VERSION").into(),
        });
        write_frame(&mut writer, &request).map_err(|error| {
            ErrorEnvelope::new(None, error.code(), format!("handshake not sent: {error}"))
        })?;

        let handshake = match handshake_rx.recv_timeout(HANDSHAKE_TIMEOUT) {
            Ok(handshake) => handshake,
            Err(RecvTimeoutError::Timeout) => {
                return Err(ErrorEnvelope::new(
                    None,
                    ErrorCode::Timeout,
                    "the bridge did not answer the handshake".to_string(),
                ))
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(shared.loss_envelope(None, false));
            }
        };

        check_version(handshake.protocol_version)?;

        // The advertisement told us which Rhino this is; the handshake is the
        // authority. If they disagree, the file is stale and the pipe name has
        // been taken over by a different process — the one case where acting on
        // the reference we were given would touch the wrong document.
        if handshake.application.rhino_instance_id != advertisement.rhino_instance_id {
            return Err(ErrorEnvelope::new(
                None,
                ErrorCode::RhinoInstanceNotFound,
                format!(
                    "pipe {} is now served by Rhino instance {}, not the advertised {}",
                    advertisement.pipe_name,
                    handshake.application.rhino_instance_id,
                    advertisement.rhino_instance_id
                ),
            ));
        }

        Ok(Self {
            handshake,
            advertisement,
            writer: Mutex::new(writer),
            shared,
            events,
            next_request: AtomicU64::new(1),
            reader: Some(worker),
            canceller: None,
        })
    }

    /// Connect to the bridge an advertisement points at.
    pub fn connect(advertisement: Advertisement) -> Result<Self, ErrorEnvelope> {
        let pipe = crate::connection::open_pipe(&advertisement)?;
        let canceller = pipe.canceller();
        let halves = crate::connection::Duplex::split(pipe).map_err(|error| {
            ErrorEnvelope::new(
                None,
                ErrorCode::BridgeUnavailable,
                format!("could not prepare the pipe for reading and writing: {error}"),
            )
        })?;
        let mut client = Self::handshake_over(advertisement, halves)?;
        client.canceller = Some(canceller);
        Ok(client)
    }

    pub fn handshake(&self) -> &HandshakeResponse {
        &self.handshake
    }

    pub fn advertisement(&self) -> &Advertisement {
        &self.advertisement
    }

    /// Whether the bridge advertised a named feature at handshake time. This is
    /// one of the inputs to tool visibility: a bridge too old to perform an
    /// operation must not have that operation offered to the model.
    pub fn supports(&self, feature: &str) -> bool {
        self.handshake.features.iter().any(|have| have == feature)
    }

    /// Whether the reader thread is still alive and the stream still usable.
    pub fn is_connected(&self) -> bool {
        self.shared.loss.lock().expect("loss mutex").is_none()
    }

    /// Responses delivered for a `request_id` nobody was waiting on.
    pub fn stray_response_count(&self) -> u64 {
        self.shared.stray_responses.load(Ordering::Relaxed)
    }

    /// Take any events the bridge has pushed since the last call.
    ///
    /// Events are observations — cache invalidation and verification evidence —
    /// so they are queued rather than dispatched, and the reader thread is
    /// never blocked by a caller that is slow to drain them.
    pub fn drain_events(&self) -> Vec<EventEnvelope> {
        self.events.drain()
    }

    /// How many observations this connection discarded because the queue was
    /// full.
    ///
    /// Non-zero means the event stream is incomplete, and a verdict that would
    /// otherwise be reasoned from the absence of an event has to be downgraded
    /// rather than trusted.
    pub fn dropped_event_count(&self) -> u64 {
        self.events.dropped()
    }

    /// Wait for one event, for tests and for operations that need to observe a
    /// specific native change before verifying it.
    ///
    /// Returns `None` on timeout and also as soon as the connection is known to
    /// be gone, rather than making every caller sit out its full wait.
    pub fn next_event(&self, timeout: Duration) -> Option<EventEnvelope> {
        self.events.next(timeout)
    }

    /// Send one request and wait for its response.
    ///
    /// `timeout` bounds the caller's wait. It does not tell you what happened
    /// in Rhino: the request reached the bridge and the operation may have
    /// completed, be running, or have failed. That is why a timeout here is
    /// `RequestOutcomeUnknown` and not `Timeout` — the harness must re-read
    /// state rather than repeat a mutation that may already have landed.
    ///
    /// The reader thread itself keeps waiting, which is deliberate: a late
    /// response is still evidence, and the stream stays usable for the requests
    /// that follow.
    pub fn request(
        &self,
        operation: &str,
        target: Option<TargetRef>,
        arguments: Value,
        timeout: Option<Duration>,
    ) -> Result<ResponseEnvelope, ErrorEnvelope> {
        let timeout = timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT);
        self.request_with_bridge_deadline(operation, target, arguments, timeout, timeout)
    }

    /// Send one request, giving the caller's wait and the bridge's own deadline
    /// separate budgets.
    ///
    /// They are different questions. `wait` is how long *this process* is
    /// prepared to block; `bridge_deadline` is how long Rhino should keep
    /// working before abandoning the attempt. [`request`] sets them equal
    /// because that is almost always what is wanted, and it means whichever
    /// timer happens to fire first decides which side reports the failure.
    ///
    /// Making them independent is not a tuning knob. It is the only way to
    /// exercise the bridge's own abandonment path from outside: with equal
    /// budgets the facade always wins the race, because its clock starts first,
    /// and the bridge's answer is never seen.
    pub fn request_with_bridge_deadline(
        &self,
        operation: &str,
        target: Option<TargetRef>,
        arguments: Value,
        wait: Duration,
        bridge_deadline: Duration,
    ) -> Result<ResponseEnvelope, ErrorEnvelope> {
        let timeout = wait;
        let request_id = format!(
            "req-{:08}",
            self.next_request.fetch_add(1, Ordering::Relaxed)
        );
        let envelope = RequestEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            operation: operation.to_string(),
            target,
            arguments,
            // The bridge gets its own budget so it can abandon work nobody is
            // listening for any more, rather than finishing it into a void.
            timeout_ms: Some(bridge_deadline.as_millis().min(u64::MAX as u128) as u64),
        };

        // Checked before the pending map is locked: `record_loss` takes `loss`
        // and then `pending`, so acquiring them the other way round here would
        // be a lock-order inversion.
        if !self.is_connected() {
            return Err(self.shared.loss_envelope(Some(request_id), false));
        }

        let (tx, rx) = mpsc::channel();
        self.shared
            .pending
            .lock()
            .expect("pending mutex")
            .insert(request_id.clone(), tx);

        // Registered before it is written, so a response cannot arrive before
        // there is somewhere to put it.
        let sent = {
            let mut writer = self.writer.lock().expect("writer mutex");
            write_frame(&mut *writer, &ClientMessage::Request(envelope))
        };
        if let Err(error) = sent {
            self.shared
                .pending
                .lock()
                .expect("pending mutex")
                .remove(&request_id);
            // Nothing left this process, so nothing can have happened in Rhino.
            return Err(ErrorEnvelope::new(
                Some(request_id),
                error.code(),
                format!("request not sent: {error}"),
            ));
        }

        match rx.recv_timeout(timeout) {
            Ok(BridgeMessage::Response(response)) => {
                if response.request_id != request_id {
                    return Err(ErrorEnvelope::new(
                        Some(request_id),
                        ErrorCode::MalformedMessage,
                        format!("bridge answered with request_id {}", response.request_id),
                    ));
                }
                Ok(response)
            }
            Ok(BridgeMessage::Error(error)) => Err(error),
            Ok(other) => Err(ErrorEnvelope::new(
                Some(request_id),
                ErrorCode::MalformedMessage,
                format!("bridge answered a request with {other:?}"),
            )),
            Err(RecvTimeoutError::Timeout) => {
                self.shared
                    .pending
                    .lock()
                    .expect("pending mutex")
                    .remove(&request_id);
                Err(ErrorEnvelope::new(
                    Some(request_id),
                    ErrorCode::RequestOutcomeUnknown,
                    format!(
                        "no response within {timeout:?}; the operation may still be running in Rhino"
                    ),
                ))
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err(self.shared.loss_envelope(Some(request_id), true))
            }
        }
    }
}

impl std::fmt::Debug for BridgeClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Hand-written because the stream halves are trait objects; this is
        // also the shape worth seeing in a test failure.
        f.debug_struct("BridgeClient")
            .field("rhino_instance_id", &self.advertisement.rhino_instance_id)
            .field("pipe_name", &self.advertisement.pipe_name)
            .field("connected", &self.is_connected())
            .finish()
    }
}

impl Drop for BridgeClient {
    fn drop(&mut self) {
        self.shared.record_loss(Loss {
            code: ErrorCode::BridgeUnavailable,
            message: "the client closed the connection".into(),
        });
        // Cancel first, then join: the reader is parked in a pending read that
        // will not return on its own while Rhino sits idle.
        if let Some(canceller) = &self.canceller {
            canceller.cancel();
        }
        if let Some(reader) = self.reader.take() {
            if self.canceller.is_some() {
                let _ = reader.join();
            }
        }
    }
}

fn read_loop(
    reader: Box<dyn Read + Send>,
    shared: Arc<Shared>,
    events: Arc<EventQueue>,
    handshake: Sender<HandshakeResponse>,
) {
    read_frames(reader, shared, Arc::clone(&events), handshake);

    // However this ended, no further observation is coming. Closing wakes
    // anyone parked in `next_event` immediately instead of leaving them to sit
    // out a timeout waiting on a connection that is already gone.
    events.close();
}

fn read_frames(
    mut reader: Box<dyn Read + Send>,
    shared: Arc<Shared>,
    events: Arc<EventQueue>,
    handshake: Sender<HandshakeResponse>,
) {
    let mut handshake = Some(handshake);
    loop {
        match read_frame::<_, BridgeMessage>(&mut reader) {
            Ok(BridgeMessage::Handshake(response)) => match handshake.take() {
                Some(sender) => {
                    let _ = sender.send(response);
                }
                None => {
                    // A second handshake means the bridge thinks it is starting
                    // a conversation we are already having. There is no safe
                    // way to reconcile that mid-stream.
                    shared.record_loss(Loss {
                        code: ErrorCode::MalformedMessage,
                        message: "the bridge sent a second handshake".into(),
                    });
                    return;
                }
            },
            Ok(BridgeMessage::Event(event)) => {
                // A dropped receiver is not a fault: events are observations
                // and a caller may legitimately stop listening.
                // Never blocks: a slow consumer must not stall the thread
                // that also delivers responses. What overflows is dropped and
                // counted, not waited on.
                events.push(event);
            }
            Ok(BridgeMessage::Response(response)) => {
                let id = response.request_id.clone();
                shared.deliver(&id, BridgeMessage::Response(response));
            }
            Ok(BridgeMessage::Error(error)) => match error.request_id.clone() {
                Some(id) => shared.deliver(&id, BridgeMessage::Error(error)),
                None => {
                    // Unattributable: it is about the connection, not a
                    // request. Every waiter needs to hear about it.
                    shared.record_loss(Loss {
                        code: error.code,
                        message: error.message,
                    });
                    return;
                }
            },
            Err(FrameError::Closed) => {
                shared.record_loss(Loss {
                    code: ErrorCode::BridgeUnavailable,
                    message: "Rhino closed the connection".into(),
                });
                return;
            }
            Err(error) => {
                // Framing faults desynchronise the stream: there is no way to
                // find the next boundary, so the connection has to go. The
                // predicate is consulted rather than assumed — an inbound
                // error that is *not* fatal would otherwise silently take the
                // connection down with it.
                debug_assert!(
                    error.is_fatal_to_connection(),
                    "a non-fatal frame error reached the reader: {error}"
                );
                shared.record_loss(Loss {
                    code: error.code(),
                    message: error.to_string(),
                });
                return;
            }
        }
    }
}
