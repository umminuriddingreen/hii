//! Local transport for the HII Rhino bridge.
//!
//! This crate owns everything between "HII wants to talk to Rhino" and "a typed
//! response came back": finding running instances, opening the pipe, the
//! handshake, and demultiplexing a stream that carries responses and
//! unsolicited events at the same time. It knows nothing about tools, models,
//! or Rhino semantics — those live above it in the facade.
//!
//! Split out from `hii-rhino-protocol` so the protocol crate stays free of OS
//! and threading concerns and can be mirrored in C# from types alone.
//!
//! # What this layer does not do
//!
//! * **It does not set the pipe ACL.** The DACL belongs to whoever calls
//!   `CreateNamedPipe`, which is the C# bridge; it restricts the pipe to the
//!   current user. The pipe *name* is not a security boundary — see
//!   `hii_rhino_protocol::transport`.
//! * **It cannot cancel work already running in Rhino.** The pipe read is
//!   genuinely cancellable — that is what lets a dropped client free its reader
//!   thread — but cancelling a read says nothing about the operation the bridge
//!   is executing. Cancelling *that* is a bridge capability and belongs to
//!   checkpoint D; until then a timed-out request is reported as
//!   `RequestOutcomeUnknown`.
//!
//! What it *does* verify, before writing a single byte, is that the process
//! serving the pipe is the one the advertisement names — see
//! [`connection::open_pipe`]. That is a kernel answer rather than the peer's
//! own, so it catches a name taken over by something that is not a bridge at
//! all. The handshake's instance-id comparison still runs afterwards; the two
//! checks catch different things and neither replaces the other.

pub mod client;
pub mod connection;
pub mod discovery;
pub mod events;

pub use client::{BridgeClient, DEFAULT_REQUEST_TIMEOUT, HANDSHAKE_TIMEOUT};
pub use connection::Duplex;
pub use discovery::{advertisement_dir, prune, scan, DiscoveredBridge};

use hii_rhino_protocol::{transport::Advertisement, ErrorCode, ErrorEnvelope};

/// A connection to one Rhino instance that can be re-established.
///
/// Reconnecting is deliberately *not* transparent. A new connection may be a
/// different Rhino, or the same Rhino with documents closed and reopened, so
/// every reference minted before the drop is suspect. This type reconnects to
/// the same instance and refuses if the identity changed; callers above it
/// still have to refresh their state, and the typed errors tell them so.
pub struct BridgeSession {
    advertisement: Advertisement,
    client: Option<BridgeClient>,
}

impl BridgeSession {
    pub fn new(advertisement: Advertisement) -> Self {
        Self {
            advertisement,
            client: None,
        }
    }

    /// Whether a usable connection exists right now, without making one.
    pub fn is_connected(&self) -> bool {
        self.client
            .as_ref()
            .is_some_and(|client| client.is_connected())
    }

    /// Return a live client, connecting or reconnecting if needed.
    ///
    /// Returns `Reconnected` when the caller's previous references may no
    /// longer be valid, so a stale reference is never silently reused against a
    /// fresh connection.
    pub fn connect(&mut self) -> Result<(&BridgeClient, ConnectionOutcome), ErrorEnvelope> {
        if self.is_connected() {
            let client = self.client.as_ref().expect("checked above");
            return Ok((client, ConnectionOutcome::AlreadyConnected));
        }

        let had_connection = self.client.is_some();
        self.client = None;

        let client = BridgeClient::connect(self.advertisement.clone())?;
        self.client = Some(client);

        let outcome = if had_connection {
            ConnectionOutcome::Reconnected
        } else {
            ConnectionOutcome::Connected
        };
        Ok((self.client.as_ref().expect("just set"), outcome))
    }

    /// Drop the connection without discarding the session, so the next call
    /// reconnects. Used when a framing fault desynchronises the stream.
    pub fn disconnect(&mut self) {
        self.client = None;
    }

    pub fn advertisement(&self) -> &Advertisement {
        &self.advertisement
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionOutcome {
    /// The existing connection was reused; references are still good.
    AlreadyConnected,
    /// A first connection in this session.
    Connected,
    /// The previous connection was lost and a new one was made. Everything
    /// derived from the old one must be re-read.
    Reconnected,
}

/// The single ready-to-use entry point: find a Rhino, connect to it, prune what
/// is no longer there.
///
/// Prefers the most recently started instance. When there are several, the
/// caller is expected to choose explicitly — this is the convenience path for
/// the common single-instance case, not a policy.
pub fn connect_to_any() -> Result<BridgeSession, ErrorEnvelope> {
    let dir = advertisement_dir()?;
    let found = scan(&dir);
    if found.is_empty() {
        return Err(ErrorEnvelope::new(
            None,
            ErrorCode::RhinoInstanceNotFound,
            format!(
                "no Rhino instance is advertising the HII bridge in {}",
                dir.display()
            ),
        ));
    }

    let mut last: Option<ErrorEnvelope> = None;
    for candidate in &found {
        let mut session = BridgeSession::new(candidate.advertisement.clone());
        match session.connect() {
            Ok(_) => return Ok(session),
            Err(error) => {
                // A file pointing at a pipe nobody serves is a crashed Rhino,
                // not a fault to report. Clear it and try the next one.
                if error.code == ErrorCode::BridgeUnavailable {
                    prune(candidate);
                }
                last = Some(error);
            }
        }
    }

    Err(last.unwrap_or_else(|| {
        ErrorEnvelope::new(
            None,
            ErrorCode::RhinoInstanceNotFound,
            "no advertised Rhino instance could be reached",
        )
    }))
}
