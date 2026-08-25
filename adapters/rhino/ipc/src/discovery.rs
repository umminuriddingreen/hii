//! Finding the Rhino instances that are running right now.
//!
//! Each live bridge writes one small file describing itself. Discovery is a
//! directory listing, not a scan of every process on the machine, and never
//! identifies a session by window title or document filename.

use hii_rhino_protocol::{transport::Advertisement, ErrorCode, ErrorEnvelope, PROTOCOL_VERSION};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Where bridges publish themselves, under HII's own runtime root.
///
/// `HII_RUNTIME_DIR` overrides the root, exactly as it does everywhere else in
/// HII. The C# bridge has to resolve the same rule; it is stated in one place
/// here so there is something for it to be checked against.
pub fn advertisement_dir() -> Result<PathBuf, ErrorEnvelope> {
    hii_core::runtime_root()
        .map(|root| root.join("rhino").join("instances"))
        .map_err(|error| ErrorEnvelope::new(None, ErrorCode::BridgeUnavailable, error))
}

/// One advertisement found on disk, with the path it came from so a stale file
/// can be pruned by whoever notices.
#[derive(Debug, Clone)]
pub struct DiscoveredBridge {
    pub path: PathBuf,
    pub advertisement: Advertisement,
}

/// Read every advertisement in `dir`.
///
/// Unreadable and unparseable files are skipped rather than failing the scan:
/// one bridge writing a half-finished file must not hide the three that are
/// working. A missing directory means no Rhino has ever run the bridge here,
/// which is an empty list and not an error.
pub fn scan(dir: &Path) -> Vec<DiscoveredBridge> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };

    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(advertisement) = serde_json::from_str::<Advertisement>(&text) else {
            continue;
        };
        // A pre-filter only. The handshake decides whether we can actually
        // speak to this bridge; if this check were treated as authoritative
        // there would be two version gates able to disagree.
        if advertisement.protocol_version != PROTOCOL_VERSION {
            continue;
        }
        found.push(DiscoveredBridge {
            path,
            advertisement,
        });
    }

    // Newest first: with several Rhino instances open, the most recently
    // started is the likeliest one the user is talking about. It is a tie-break
    // for presentation, never an automatic target choice.
    found.sort_by(|a, b| {
        b.advertisement
            .started_at_unix_ms
            .cmp(&a.advertisement.started_at_unix_ms)
    });
    found
}

/// Delete an advertisement whose bridge is gone.
///
/// A crashed Rhino leaves its file behind pointing at a pipe nobody serves.
/// That is ordinary housekeeping, not a failure worth surfacing, so the result
/// is deliberately ignorable.
pub fn prune(discovered: &DiscoveredBridge) -> bool {
    fs::remove_file(&discovered.path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hii_rhino_protocol::{transport, RhinoInstanceId};
    use uuid::Uuid;

    fn advertisement(pid: u32, started: u64) -> Advertisement {
        Advertisement {
            protocol_version: PROTOCOL_VERSION,
            rhino_instance_id: RhinoInstanceId(Uuid::from_u128(pid as u128)),
            process_id: pid,
            session_id: 1,
            pipe_name: transport::pipe_name(1, pid),
            application_version: "8.0.0.0".into(),
            adapter_version: "0.1.0".into(),
            started_at_unix_ms: started,
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hii-rhino-discovery-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write(dir: &Path, advertisement: &Advertisement) -> PathBuf {
        let path = dir.join(transport::advertisement_file_name(
            advertisement.process_id,
            &advertisement.rhino_instance_id,
        ));
        fs::write(&path, serde_json::to_string(advertisement).unwrap()).expect("write");
        path
    }

    #[test]
    fn a_missing_directory_is_no_instances_not_an_error() {
        assert!(scan(&std::env::temp_dir().join("hii-rhino-does-not-exist")).is_empty());
    }

    #[test]
    fn junk_alongside_a_valid_advertisement_does_not_hide_it() {
        let dir = temp_dir("junk");
        write(&dir, &advertisement(1000, 10));
        fs::write(dir.join("half-written.json"), "{\"protocol_ver").unwrap();
        fs::write(dir.join("notes.txt"), "ignore me").unwrap();

        let found = scan(&dir);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].advertisement.process_id, 1000);
    }

    #[test]
    fn a_wrong_version_advertisement_is_filtered_before_we_try_to_speak_to_it() {
        let dir = temp_dir("version");
        let mut old = advertisement(1001, 10);
        old.protocol_version = PROTOCOL_VERSION + 1;
        write(&dir, &old);
        assert!(scan(&dir).is_empty());
    }

    #[test]
    fn instances_come_back_newest_first() {
        let dir = temp_dir("order");
        write(&dir, &advertisement(1002, 10));
        write(&dir, &advertisement(1003, 30));
        write(&dir, &advertisement(1004, 20));

        let order: Vec<u32> = scan(&dir)
            .iter()
            .map(|found| found.advertisement.process_id)
            .collect();
        assert_eq!(order, vec![1003, 1004, 1002]);
    }

    #[test]
    fn a_stale_advertisement_can_be_pruned() {
        let dir = temp_dir("prune");
        write(&dir, &advertisement(1005, 10));
        let found = scan(&dir);
        assert_eq!(found.len(), 1);
        assert!(prune(&found[0]));
        assert!(scan(&dir).is_empty());
    }
}
