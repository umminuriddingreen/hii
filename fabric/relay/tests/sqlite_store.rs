use hii_fabric_relay::*;
use rusqlite::Connection;
use std::collections::{BTreeMap, BTreeSet};

const NOW: u64 = 1_700_000_000_000;
const EPOCH: u64 = 7;

fn device(id: &str) -> DevicePublicRecord {
    DevicePublicRecord {
        device_id: id.into(),
        display_name: id.into(),
        signing_public_key: vec![1, 2, 3],
        encryption_public_key: vec![4, 5, 6],
        enrolled_at_unix_ms: NOW - 1,
        key_epoch: EPOCH,
        status: DeviceStatus::Active,
    }
}

fn account() -> SingleOwnerAccount {
    SingleOwnerAccount {
        account_id: "owner-1".into(),
        owner_label: "Owner".into(),
        trust_epoch: EPOCH,
        devices: BTreeMap::from([
            ("mac".into(), device("mac")),
            ("phone".into(), device("phone")),
        ]),
        passkey_credentials: BTreeMap::from([(
            "credential-1".into(),
            PasskeyCredentialRecord {
                credential_id: "credential-1".into(),
                public_key_cose: vec![0xa5, 1, 2],
                signature_counter: 0,
                transports: BTreeSet::from([PasskeyTransport::Internal]),
                created_at_unix_ms: NOW - 1,
                last_used_at_unix_ms: None,
            },
        )]),
    }
}

fn envelope(id: &str, sequence: u64, ciphertext: Vec<u8>) -> CiphertextEnvelope {
    CiphertextEnvelope {
        envelope_id: id.into(),
        account_id: "owner-1".into(),
        sender_device_id: "mac".into(),
        recipient_device_id: "phone".into(),
        trust_epoch: EPOCH,
        sender_sequence: sequence,
        created_at_unix_ms: NOW,
        expires_at_unix_ms: NOW + 60_000,
        ciphertext,
    }
}

fn signal() -> RendezvousSignal {
    RendezvousSignal {
        signal_id: "signal-1".into(),
        account_id: "owner-1".into(),
        sender_device_id: "mac".into(),
        recipient_device_id: "phone".into(),
        trust_epoch: EPOCH,
        created_at_unix_ms: NOW,
        expires_at_unix_ms: NOW + 30_000,
        ciphertext: vec![0, 255, 17, 81],
    }
}

#[test]
fn account_mailbox_signal_and_ciphertext_survive_separate_open() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("relay.sqlite3");
    let ciphertext = vec![0, 255, 12, 99, 4, 0];

    {
        let store = SqliteRelayStore::open(&path).unwrap();
        let mut relay = Relay::new(RelayConfig::default(), store).unwrap();
        relay.bootstrap_account(account()).unwrap();
        relay
            .enqueue(envelope("e1", 1, ciphertext.clone()), NOW)
            .unwrap();
        relay.publish_signal(signal(), NOW).unwrap();
    }

    let store = SqliteRelayStore::open(&path).unwrap();
    let mut relay = Relay::new(RelayConfig::default(), store).unwrap();
    assert_eq!(relay.account().unwrap(), Some(account()));
    assert_eq!(
        relay.mailbox("owner-1", "phone", EPOCH, NOW).unwrap()[0].ciphertext,
        ciphertext
    );
    assert_eq!(
        relay.take_signals("owner-1", "phone", EPOCH, NOW).unwrap()[0].ciphertext,
        vec![0, 255, 17, 81]
    );
}

#[test]
fn acknowledgement_keeps_replay_tombstones_and_quota_tracks_live_bytes() {
    let store = SqliteRelayStore::open_in_memory().unwrap();
    let config = RelayConfig {
        max_mailbox_bytes_per_device: 5,
        ..RelayConfig::default()
    };
    let mut relay = Relay::new(config, store).unwrap();
    relay.bootstrap_account(account()).unwrap();
    relay
        .enqueue(envelope("e1", 1, vec![1, 2, 3]), NOW)
        .unwrap();
    assert_eq!(
        relay.enqueue(envelope("e2", 2, vec![4, 5, 6]), NOW),
        Err(RelayError::MailboxQuotaExceeded)
    );
    assert_eq!(
        relay.acknowledge("owner-1", "phone", "mac", EPOCH, 999),
        Err(RelayError::InvalidRecord(
            "acknowledgement lacks delivered message proof"
        ))
    );
    assert_eq!(
        relay.mailbox("owner-1", "phone", EPOCH, NOW).unwrap().len(),
        1
    );
    assert_eq!(
        relay.acknowledge("owner-1", "phone", "mac", EPOCH, 999),
        Err(RelayError::InvalidRecord(
            "acknowledgement lacks delivered message proof"
        ))
    );
    assert_eq!(
        relay
            .acknowledge("owner-1", "phone", "mac", EPOCH, 1)
            .unwrap()
            .removed_envelopes,
        1
    );
    relay
        .enqueue(envelope("e2", 2, vec![4, 5, 6]), NOW)
        .unwrap();
    assert_eq!(
        relay.enqueue(envelope("e1", 1, vec![1, 2, 3]), NOW),
        Err(RelayError::ReplayConflict)
    );
}

#[test]
fn current_epoch_reads_hide_pre_recovery_mail_and_signals() {
    let store = SqliteRelayStore::open_in_memory().unwrap();
    let mut relay = Relay::new(RelayConfig::default(), store).unwrap();
    relay.bootstrap_account(account()).unwrap();
    let mut stale_mail = envelope("phone-to-mac", 1, vec![3, 1, 4]);
    stale_mail.sender_device_id = "phone".into();
    stale_mail.recipient_device_id = "mac".into();
    relay.enqueue(stale_mail, NOW).unwrap();
    let mut stale_signal = signal();
    stale_signal.sender_device_id = "phone".into();
    stale_signal.recipient_device_id = "mac".into();
    relay.publish_signal(stale_signal, NOW).unwrap();

    relay.record_revocation("phone", EPOCH + 1).unwrap();
    assert!(relay
        .mailbox("owner-1", "mac", EPOCH + 1, NOW)
        .unwrap()
        .is_empty());
    assert!(relay
        .take_signals("owner-1", "mac", EPOCH + 1, NOW)
        .unwrap()
        .is_empty());
}

#[test]
fn signal_take_rolls_back_if_batch_consumption_fails() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("relay.sqlite3");
    {
        let store = SqliteRelayStore::open(&path).unwrap();
        let mut relay = Relay::new(RelayConfig::default(), store).unwrap();
        relay.bootstrap_account(account()).unwrap();
        relay.publish_signal(signal(), NOW).unwrap();
    }
    {
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER fail_signal_delete BEFORE DELETE ON rendezvous_signals \
                 BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END;",
            )
            .unwrap();
    }
    let store = SqliteRelayStore::open(&path).unwrap();
    let mut relay = Relay::new(RelayConfig::default(), store).unwrap();
    assert!(matches!(
        relay.take_signals("owner-1", "phone", EPOCH, NOW),
        Err(RelayError::Store(_))
    ));
    drop(relay);
    let connection = Connection::open(path).unwrap();
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM rendezvous_signals", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn schema_has_no_plaintext_content_columns_or_indexes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("relay.sqlite3");
    drop(SqliteRelayStore::open(&path).unwrap());
    let connection = Connection::open(path).unwrap();
    let schema: String = connection
        .query_row(
            "SELECT lower(group_concat(sql, ' ')) FROM sqlite_schema WHERE sql IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!schema.contains("plaintext"));
    assert!(!schema.contains("payload"));
    assert!(!schema.contains("content"));
    assert!(schema.contains("ciphertext blob"));
}

#[test]
fn corrupted_database_returns_store_error_without_panicking() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("relay.sqlite3");
    std::fs::write(&path, b"not a sqlite database").unwrap();
    assert!(matches!(
        SqliteRelayStore::open(path),
        Err(RelayError::Store(_))
    ));
}

#[cfg(unix)]
#[test]
fn newly_created_database_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("relay.sqlite3");
    drop(SqliteRelayStore::open(&path).unwrap());
    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
