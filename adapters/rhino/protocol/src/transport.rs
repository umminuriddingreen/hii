//! Naming for the local transport.
//!
//! Kept in the protocol crate so the Rust facade and the C# bridge derive the
//! same name from the same rule, and so naming stays independent of the tool
//! semantics layered on top of it.

use crate::identity::RhinoInstanceId;
use serde::{Deserialize, Serialize};

/// One pipe per Rhino process.
///
/// The session id keeps two logon sessions on one machine (a console user and
/// an RDP user, say) from colliding, and the pid keeps multiple Rhino instances
/// within a session distinct.
///
/// Note what this name does *not* do: unlike mutexes or file mappings, named
/// pipes have no `Local\` session namespace, so the prefix here is
/// organisational only. Actual isolation comes from the pipe's ACL, which the
/// bridge restricts to the owning user. Never rely on the name for security.
pub fn pipe_name(session_id: u32, process_id: u32) -> String {
    format!(r"LOCAL\hii.rhino.{session_id}.{process_id}")
}

/// The Win32 path the same pipe is opened by.
pub fn pipe_path(session_id: u32, process_id: u32) -> String {
    format!(r"\\.\pipe\{}", pipe_name(session_id, process_id))
}

/// Discovery writes one small file per live bridge into HII's runtime
/// directory, so the facade can find running Rhino instances without probing
/// every pid on the machine.
pub fn advertisement_file_name(process_id: u32, instance: &RhinoInstanceId) -> String {
    format!("{process_id}-{instance}.json")
}

/// What a live bridge publishes about itself.
///
/// The facade needs the session id *before* it can open the pipe, so it cannot
/// come from the handshake. It is written here instead, next to everything else
/// required to reach the instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Advertisement {
    pub protocol_version: u32,
    pub rhino_instance_id: RhinoInstanceId,
    pub process_id: u32,
    pub session_id: u32,
    /// Written out rather than re-derived, so a future naming change in the
    /// bridge does not strand facades built against the old rule.
    pub pipe_name: String,
    pub application_version: String,
    pub adapter_version: String,
    pub started_at_unix_ms: u64,
}

impl Advertisement {
    pub fn pipe_path(&self) -> String {
        format!(r"\\.\pipe\{}", self.pipe_name)
    }
}
