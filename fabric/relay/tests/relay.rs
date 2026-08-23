use hii_fabric_relay::*;
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

fn relay_with(config: RelayConfig) -> Relay<InMemoryStore> {
    let mut relay = Relay::new(config, InMemoryStore::default()).unwrap();
    relay.bootstrap_account(account()).unwrap();
    relay
}

fn envelope(id: &str, sequence: u64, ciphertext: &[u8]) -> CiphertextEnvelope {
    CiphertextEnvelope {
        envelope_id: id.into(),
        account_id: "owner-1".into(),
        sender_device_id: "mac".into(),
        recipient_device_id: "phone".into(),
        trust_epoch: EPOCH,
        sender_sequence: sequence,
        created_at_unix_ms: NOW,
        expires_at_unix_ms: NOW + 60_000,
        ciphertext: ciphertext.to_vec(),
    }
}

#[test]
fn stores_only_opaque_ciphertext_without_a_plaintext_payload_shape() {
    let ciphertext = vec![0, 255, 12, 99, 4];
    let mut relay = relay_with(RelayConfig::default());
    relay.enqueue(envelope("e1", 1, &ciphertext), NOW).unwrap();

    let stored = relay.mailbox("owner-1", "phone", EPOCH, NOW).unwrap();
    assert_eq!(stored[0].ciphertext, ciphertext);
    let json = serde_json::to_value(&stored[0]).unwrap();
    assert!(json.get("ciphertext").is_some());
    assert!(json.get("payload").is_none());
    assert!(json.get("plaintext").is_none());
}

#[test]
fn enforces_ciphertext_retention_and_mailbox_bounds() {
    let config = RelayConfig {
        max_ciphertext_bytes: 4,
        max_mailbox_bytes_per_device: 6,
        max_retention_seconds: 60,
        ..RelayConfig::default()
    };
    let mut relay = relay_with(config);
    assert!(matches!(
        relay.enqueue(envelope("large", 1, &[1; 5]), NOW),
        Err(RelayError::BoundExceeded("ciphertext bytes"))
    ));
    relay.enqueue(envelope("e1", 1, &[1; 4]), NOW).unwrap();
    assert_eq!(
        relay.enqueue(envelope("e2", 2, &[2; 3]), NOW),
        Err(RelayError::MailboxQuotaExceeded)
    );
    let mut long = envelope("long", 3, &[3]);
    long.expires_at_unix_ms = NOW + 60_001;
    assert_eq!(
        relay.enqueue(long, NOW),
        Err(RelayError::BoundExceeded("message retention"))
    );
}

#[test]
fn deduplicates_exact_replay_and_rejects_sequence_or_id_conflicts() {
    let mut relay = relay_with(RelayConfig::default());
    let first = envelope("e1", 1, &[7, 8]);
    assert_eq!(
        relay.enqueue(first.clone(), NOW),
        Ok(EnqueueOutcome::Stored)
    );
    assert_eq!(relay.enqueue(first, NOW), Ok(EnqueueOutcome::Duplicate));
    assert_eq!(
        relay.enqueue(envelope("e1", 2, &[9]), NOW),
        Err(RelayError::ReplayConflict)
    );
    assert_eq!(
        relay.enqueue(envelope("e2", 1, &[9]), NOW),
        Err(RelayError::ReplayConflict)
    );
}

#[test]
fn acknowledgement_advances_frontier_and_removes_only_covered_messages() {
    let mut relay = relay_with(RelayConfig::default());
    relay.enqueue(envelope("e1", 1, &[1]), NOW).unwrap();
    relay.enqueue(envelope("e2", 2, &[2]), NOW).unwrap();
    relay.enqueue(envelope("e3", 3, &[3]), NOW).unwrap();
    relay.mailbox("owner-1", "phone", EPOCH, NOW).unwrap();

    let outcome = relay
        .acknowledge("owner-1", "phone", "mac", EPOCH, 2)
        .unwrap();
    assert_eq!(outcome.removed_envelopes, 2);
    assert_eq!(outcome.frontier.through_sequence_by_sender["mac"], 2);
    assert_eq!(
        relay.mailbox("owner-1", "phone", EPOCH, NOW).unwrap()[0].sender_sequence,
        3
    );

    let repeated = relay
        .acknowledge("owner-1", "phone", "mac", EPOCH, 1)
        .unwrap();
    assert_eq!(repeated.removed_envelopes, 0);
    assert_eq!(repeated.frontier.through_sequence_by_sender["mac"], 2);
    assert_eq!(
        relay.enqueue(envelope("e1", 1, &[1]), NOW),
        Err(RelayError::ReplayConflict)
    );
}

#[test]
fn revoked_devices_and_stale_epochs_cannot_use_mailbox_or_rendezvous() {
    let mut relay = relay_with(RelayConfig::default());
    relay.record_revocation("phone", EPOCH + 1).unwrap();

    let mut stale = envelope("stale", 1, &[1]);
    assert_eq!(
        relay.enqueue(stale.clone(), NOW),
        Err(RelayError::TrustEpochMismatch)
    );
    stale.trust_epoch = EPOCH + 1;
    assert_eq!(relay.enqueue(stale, NOW), Err(RelayError::DeviceRevoked));
    assert_eq!(
        relay.mailbox("owner-1", "phone", EPOCH + 1, NOW),
        Err(RelayError::DeviceRevoked)
    );
}

#[test]
fn rendezvous_is_bounded_opaque_and_consumed_once() {
    let config = RelayConfig {
        max_pending_signals_per_device: 1,
        max_signal_ciphertext_bytes: 4,
        max_signal_lifetime_seconds: 10,
        ..RelayConfig::default()
    };
    let mut relay = relay_with(config);
    let signal = RendezvousSignal {
        signal_id: "signal-1".into(),
        account_id: "owner-1".into(),
        sender_device_id: "mac".into(),
        recipient_device_id: "phone".into(),
        trust_epoch: EPOCH,
        created_at_unix_ms: NOW,
        expires_at_unix_ms: NOW + 5_000,
        ciphertext: vec![9, 8, 7],
    };
    relay.publish_signal(signal.clone(), NOW).unwrap();
    assert_eq!(
        relay.publish_signal(
            RendezvousSignal {
                signal_id: "signal-2".into(),
                ..signal
            },
            NOW,
        ),
        Err(RelayError::BoundExceeded("pending signal count"))
    );
    let received = relay.take_signals("owner-1", "phone", EPOCH, NOW).unwrap();
    assert_eq!(received.len(), 1);
    assert_eq!(received[0].ciphertext, vec![9, 8, 7]);
    assert!(relay
        .take_signals("owner-1", "phone", EPOCH, NOW)
        .unwrap()
        .is_empty());
    assert_eq!(
        relay.publish_signal(
            RendezvousSignal {
                signal_id: "signal-1".into(),
                account_id: "owner-1".into(),
                sender_device_id: "mac".into(),
                recipient_device_id: "phone".into(),
                trust_epoch: EPOCH,
                created_at_unix_ms: NOW,
                expires_at_unix_ms: NOW + 5_000,
                ciphertext: vec![9, 8, 7],
            },
            NOW,
        ),
        Err(RelayError::ReplayConflict)
    );
}

#[test]
fn expired_items_are_hidden_and_purged() {
    let mut relay = relay_with(RelayConfig::default());
    relay.enqueue(envelope("e1", 1, &[1]), NOW).unwrap();
    assert!(relay
        .mailbox("owner-1", "phone", EPOCH, NOW + 60_000)
        .unwrap()
        .is_empty());
    assert_eq!(relay.purge_expired(NOW + 60_000).unwrap(), 1);
}

#[test]
fn enforces_single_owner_boundary_and_public_record_limits() {
    let mut relay = relay_with(RelayConfig::default());
    assert_eq!(
        relay.bootstrap_account(account()),
        Err(RelayError::SingleOwnerBoundary)
    );

    let config = RelayConfig {
        max_devices: 1,
        ..RelayConfig::default()
    };
    let mut account = account();
    account.devices.remove("phone");
    let mut limited = Relay::new(config, InMemoryStore::default()).unwrap();
    limited.bootstrap_account(account).unwrap();
    assert_eq!(
        limited.enroll_device(device("pc")),
        Err(RelayError::BoundExceeded("device count"))
    );
}
