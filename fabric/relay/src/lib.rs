//! Non-authoritative coordination primitives for HII Fabric.
//!
//! This crate stores public identity metadata and opaque ciphertext. It does
//! not authenticate passkeys, decrypt messages, execute jobs, or grant HII
//! authority. Those responsibilities remain with trusted HII runtimes.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

mod sqlite_store;

pub use sqlite_store::SqliteRelayStore;

pub type AccountId = String;
pub type DeviceId = String;
pub type EnvelopeId = String;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayConfig {
    pub max_devices: usize,
    pub max_credentials: usize,
    pub max_ciphertext_bytes: usize,
    pub max_mailbox_bytes_per_device: u64,
    pub max_retention_seconds: u64,
    pub max_pending_signals_per_device: usize,
    pub max_signal_ciphertext_bytes: usize,
    pub max_signal_lifetime_seconds: u64,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            max_devices: 32,
            max_credentials: 16,
            max_ciphertext_bytes: 1_048_576,
            max_mailbox_bytes_per_device: 512 * 1_048_576,
            max_retention_seconds: 90 * 24 * 60 * 60,
            max_pending_signals_per_device: 128,
            max_signal_ciphertext_bytes: 64 * 1024,
            max_signal_lifetime_seconds: 10 * 60,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SingleOwnerAccount {
    pub account_id: AccountId,
    pub owner_label: String,
    pub trust_epoch: u64,
    pub devices: BTreeMap<DeviceId, DevicePublicRecord>,
    pub passkey_credentials: BTreeMap<String, PasskeyCredentialRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePublicRecord {
    pub device_id: DeviceId,
    pub display_name: String,
    pub signing_public_key: Vec<u8>,
    pub encryption_public_key: Vec<u8>,
    pub enrolled_at_unix_ms: u64,
    pub key_epoch: u64,
    pub status: DeviceStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceStatus {
    Active,
    Revoked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyCredentialRecord {
    pub credential_id: String,
    /// COSE public key bytes. Private credential material is never stored.
    pub public_key_cose: Vec<u8>,
    pub signature_counter: u32,
    pub transports: BTreeSet<PasskeyTransport>,
    pub created_at_unix_ms: u64,
    pub last_used_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PasskeyTransport {
    Internal,
    Usb,
    Nfc,
    Ble,
    Hybrid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiphertextEnvelope {
    pub envelope_id: EnvelopeId,
    pub account_id: AccountId,
    pub sender_device_id: DeviceId,
    pub recipient_device_id: DeviceId,
    pub trust_epoch: u64,
    pub sender_sequence: u64,
    pub created_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    /// Opaque authenticated ciphertext. The relay has no plaintext field or key.
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendezvousSignal {
    pub signal_id: String,
    pub account_id: AccountId,
    pub sender_device_id: DeviceId,
    pub recipient_device_id: DeviceId,
    pub trust_epoch: u64,
    pub created_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    /// An end-to-end encrypted offer, answer, or candidate envelope.
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnqueueOutcome {
    Stored,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgementFrontier {
    pub recipient_device_id: DeviceId,
    pub through_sequence_by_sender: BTreeMap<DeviceId, u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcknowledgeOutcome {
    pub removed_envelopes: usize,
    pub frontier: AcknowledgementFrontier,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RelayError {
    #[error("account does not exist")]
    AccountNotFound,
    #[error("this relay store already contains its single owner account")]
    SingleOwnerBoundary,
    #[error("device does not exist")]
    DeviceNotFound,
    #[error("device is revoked")]
    DeviceRevoked,
    #[error("trust epoch does not match the current account epoch")]
    TrustEpochMismatch,
    #[error("record is invalid: {0}")]
    InvalidRecord(&'static str),
    #[error("configured bound exceeded: {0}")]
    BoundExceeded(&'static str),
    #[error("mailbox quota exceeded")]
    MailboxQuotaExceeded,
    #[error("an identifier or sender sequence was reused with different ciphertext")]
    ReplayConflict,
    #[error("store operation failed: {0}")]
    Store(String),
}

/// Persistence boundary for a future SQLite or other local adapter.
///
/// Implementations must preserve ciphertext bytes exactly and must not add a
/// plaintext payload index. The included `InMemoryStore` is deterministic and
/// suitable for local development and conformance tests.
pub trait RelayStore {
    fn account(&self) -> Result<Option<SingleOwnerAccount>, RelayError>;
    fn put_account(&mut self, account: SingleOwnerAccount) -> Result<(), RelayError>;
    fn mailbox_bytes(&self, recipient: &str) -> Result<u64, RelayError>;
    fn envelope_by_id(&self, envelope_id: &str) -> Result<Option<CiphertextEnvelope>, RelayError>;
    fn was_envelope_id_seen(&self, envelope_id: &str) -> Result<bool, RelayError>;
    fn envelope_by_sender_sequence(
        &self,
        sender: &str,
        sequence: u64,
    ) -> Result<Option<CiphertextEnvelope>, RelayError>;
    fn was_sender_sequence_seen(&self, sender: &str, sequence: u64) -> Result<bool, RelayError>;
    fn insert_envelope(&mut self, envelope: CiphertextEnvelope) -> Result<(), RelayError>;
    fn mailbox(
        &mut self,
        recipient: &str,
        trust_epoch: u64,
        now_unix_ms: u64,
    ) -> Result<Vec<CiphertextEnvelope>, RelayError>;
    fn acknowledge(
        &mut self,
        recipient: &str,
        sender: &str,
        through_sequence: u64,
    ) -> Result<usize, RelayError>;
    fn frontier(&self, recipient: &str) -> Result<AcknowledgementFrontier, RelayError>;
    fn purge_expired(&mut self, now_unix_ms: u64) -> Result<usize, RelayError>;
    fn insert_signal(&mut self, signal: RendezvousSignal) -> Result<(), RelayError>;
    fn signal_by_id(&self, signal_id: &str) -> Result<Option<RendezvousSignal>, RelayError>;
    fn was_signal_id_seen(&self, signal_id: &str) -> Result<bool, RelayError>;
    fn take_signals(
        &mut self,
        recipient: &str,
        trust_epoch: u64,
        now_unix_ms: u64,
    ) -> Result<Vec<RendezvousSignal>, RelayError>;
    fn pending_signal_count(&self, recipient: &str) -> Result<usize, RelayError>;
}

#[derive(Debug, Default)]
pub struct InMemoryStore {
    account: Option<SingleOwnerAccount>,
    envelopes: BTreeMap<EnvelopeId, CiphertextEnvelope>,
    seen_envelope_ids: BTreeSet<EnvelopeId>,
    sequence_index: BTreeMap<(DeviceId, u64), EnvelopeId>,
    frontiers: BTreeMap<DeviceId, BTreeMap<DeviceId, u64>>,
    delivered_envelopes: BTreeSet<EnvelopeId>,
    signals: BTreeMap<String, RendezvousSignal>,
    seen_signal_ids: BTreeSet<String>,
}

impl RelayStore for InMemoryStore {
    fn account(&self) -> Result<Option<SingleOwnerAccount>, RelayError> {
        Ok(self.account.clone())
    }

    fn put_account(&mut self, account: SingleOwnerAccount) -> Result<(), RelayError> {
        self.account = Some(account);
        Ok(())
    }

    fn mailbox_bytes(&self, recipient: &str) -> Result<u64, RelayError> {
        Ok(self
            .envelopes
            .values()
            .filter(|item| item.recipient_device_id == recipient)
            .map(|item| item.ciphertext.len() as u64)
            .sum())
    }

    fn envelope_by_id(&self, envelope_id: &str) -> Result<Option<CiphertextEnvelope>, RelayError> {
        Ok(self.envelopes.get(envelope_id).cloned())
    }

    fn was_envelope_id_seen(&self, envelope_id: &str) -> Result<bool, RelayError> {
        Ok(self.seen_envelope_ids.contains(envelope_id))
    }

    fn envelope_by_sender_sequence(
        &self,
        sender: &str,
        sequence: u64,
    ) -> Result<Option<CiphertextEnvelope>, RelayError> {
        Ok(self
            .sequence_index
            .get(&(sender.to_owned(), sequence))
            .and_then(|id| self.envelopes.get(id))
            .cloned())
    }

    fn was_sender_sequence_seen(&self, sender: &str, sequence: u64) -> Result<bool, RelayError> {
        Ok(self
            .sequence_index
            .contains_key(&(sender.to_owned(), sequence)))
    }

    fn insert_envelope(&mut self, envelope: CiphertextEnvelope) -> Result<(), RelayError> {
        if self
            .frontiers
            .get(&envelope.recipient_device_id)
            .and_then(|senders| senders.get(&envelope.sender_device_id))
            .is_some_and(|frontier| envelope.sender_sequence <= *frontier)
        {
            return Err(RelayError::ReplayConflict);
        }
        self.seen_envelope_ids.insert(envelope.envelope_id.clone());
        self.sequence_index.insert(
            (envelope.sender_device_id.clone(), envelope.sender_sequence),
            envelope.envelope_id.clone(),
        );
        self.envelopes
            .insert(envelope.envelope_id.clone(), envelope);
        Ok(())
    }

    fn mailbox(
        &mut self,
        recipient: &str,
        trust_epoch: u64,
        now_unix_ms: u64,
    ) -> Result<Vec<CiphertextEnvelope>, RelayError> {
        let mut items: Vec<_> = self
            .envelopes
            .values()
            .filter(|item| {
                item.recipient_device_id == recipient
                    && item.trust_epoch == trust_epoch
                    && item.expires_at_unix_ms > now_unix_ms
            })
            .cloned()
            .collect();
        items.sort_by_key(|item| (item.sender_device_id.clone(), item.sender_sequence));
        self.delivered_envelopes
            .extend(items.iter().map(|item| item.envelope_id.clone()));
        Ok(items)
    }

    fn acknowledge(
        &mut self,
        recipient: &str,
        sender: &str,
        through_sequence: u64,
    ) -> Result<usize, RelayError> {
        let current = self
            .frontiers
            .entry(recipient.to_owned())
            .or_default()
            .entry(sender.to_owned())
            .or_default();
        if through_sequence <= *current {
            return Ok(0);
        }
        let candidates: Vec<_> = self
            .envelopes
            .values()
            .filter(|item| {
                item.recipient_device_id == recipient
                    && item.sender_device_id == sender
                    && item.sender_sequence <= through_sequence
            })
            .collect();
        if candidates.is_empty()
            || candidates
                .iter()
                .any(|item| !self.delivered_envelopes.contains(&item.envelope_id))
            || candidates.iter().map(|item| item.sender_sequence).max() != Some(through_sequence)
        {
            return Err(RelayError::InvalidRecord(
                "acknowledgement lacks delivered message proof",
            ));
        }
        *current = (*current).max(through_sequence);

        let ids: Vec<_> = self
            .envelopes
            .values()
            .filter(|item| {
                item.recipient_device_id == recipient
                    && item.sender_device_id == sender
                    && item.sender_sequence <= through_sequence
            })
            .map(|item| item.envelope_id.clone())
            .collect();
        for id in &ids {
            self.envelopes.remove(id);
            self.delivered_envelopes.remove(id);
        }
        Ok(ids.len())
    }

    fn frontier(&self, recipient: &str) -> Result<AcknowledgementFrontier, RelayError> {
        Ok(AcknowledgementFrontier {
            recipient_device_id: recipient.to_owned(),
            through_sequence_by_sender: self.frontiers.get(recipient).cloned().unwrap_or_default(),
        })
    }

    fn purge_expired(&mut self, now_unix_ms: u64) -> Result<usize, RelayError> {
        let envelope_ids: Vec<_> = self
            .envelopes
            .values()
            .filter(|item| item.expires_at_unix_ms <= now_unix_ms)
            .map(|item| item.envelope_id.clone())
            .collect();
        for id in &envelope_ids {
            self.envelopes.remove(id);
        }
        let signal_ids: Vec<_> = self
            .signals
            .values()
            .filter(|item| item.expires_at_unix_ms <= now_unix_ms)
            .map(|item| item.signal_id.clone())
            .collect();
        for id in &signal_ids {
            self.signals.remove(id);
        }
        Ok(envelope_ids.len() + signal_ids.len())
    }

    fn insert_signal(&mut self, signal: RendezvousSignal) -> Result<(), RelayError> {
        self.seen_signal_ids.insert(signal.signal_id.clone());
        self.signals.insert(signal.signal_id.clone(), signal);
        Ok(())
    }

    fn signal_by_id(&self, signal_id: &str) -> Result<Option<RendezvousSignal>, RelayError> {
        Ok(self.signals.get(signal_id).cloned())
    }

    fn was_signal_id_seen(&self, signal_id: &str) -> Result<bool, RelayError> {
        Ok(self.seen_signal_ids.contains(signal_id))
    }

    fn take_signals(
        &mut self,
        recipient: &str,
        trust_epoch: u64,
        now_unix_ms: u64,
    ) -> Result<Vec<RendezvousSignal>, RelayError> {
        let mut items: Vec<_> = self
            .signals
            .values()
            .filter(|item| {
                item.recipient_device_id == recipient
                    && item.trust_epoch == trust_epoch
                    && item.expires_at_unix_ms > now_unix_ms
            })
            .cloned()
            .collect();
        items.sort_by_key(|item| item.created_at_unix_ms);
        for signal in &items {
            self.signals.remove(&signal.signal_id);
        }
        Ok(items)
    }

    fn pending_signal_count(&self, recipient: &str) -> Result<usize, RelayError> {
        Ok(self
            .signals
            .values()
            .filter(|signal| signal.recipient_device_id == recipient)
            .count())
    }
}

pub struct Relay<S> {
    config: RelayConfig,
    store: S,
}

impl<S: RelayStore> Relay<S> {
    pub fn new(config: RelayConfig, store: S) -> Result<Self, RelayError> {
        validate_config(&config)?;
        Ok(Self { config, store })
    }

    pub fn bootstrap_account(&mut self, account: SingleOwnerAccount) -> Result<(), RelayError> {
        if self.store.account()?.is_some() {
            return Err(RelayError::SingleOwnerBoundary);
        }
        self.validate_account(&account)?;
        self.store.put_account(account)
    }

    pub fn account(&self) -> Result<Option<SingleOwnerAccount>, RelayError> {
        self.store.account()
    }

    pub fn enroll_device(&mut self, device: DevicePublicRecord) -> Result<(), RelayError> {
        let mut account = self.current_account()?;
        if account.devices.len() >= self.config.max_devices
            && !account.devices.contains_key(&device.device_id)
        {
            return Err(RelayError::BoundExceeded("device count"));
        }
        validate_device(&device, account.trust_epoch)?;
        account.devices.insert(device.device_id.clone(), device);
        self.store.put_account(account)
    }

    pub fn add_passkey(&mut self, credential: PasskeyCredentialRecord) -> Result<(), RelayError> {
        let mut account = self.current_account()?;
        if account.passkey_credentials.len() >= self.config.max_credentials
            && !account
                .passkey_credentials
                .contains_key(&credential.credential_id)
        {
            return Err(RelayError::BoundExceeded("credential count"));
        }
        validate_credential(&credential)?;
        account
            .passkey_credentials
            .insert(credential.credential_id.clone(), credential);
        self.store.put_account(account)
    }

    /// Records a locally authorized revocation and advances the trust epoch.
    /// This does not decide authority: the caller must present a mutation that
    /// the owner's HII security ledger has already authorized.
    pub fn record_revocation(
        &mut self,
        device_id: &str,
        new_trust_epoch: u64,
    ) -> Result<(), RelayError> {
        let mut account = self.current_account()?;
        if new_trust_epoch <= account.trust_epoch {
            return Err(RelayError::InvalidRecord("trust epoch must advance"));
        }
        let device = account
            .devices
            .get_mut(device_id)
            .ok_or(RelayError::DeviceNotFound)?;
        device.status = DeviceStatus::Revoked;
        account.trust_epoch = new_trust_epoch;
        for active in account.devices.values_mut() {
            if active.status == DeviceStatus::Active {
                active.key_epoch = new_trust_epoch;
            }
        }
        self.store.put_account(account)
    }

    pub fn enqueue(
        &mut self,
        envelope: CiphertextEnvelope,
        now_unix_ms: u64,
    ) -> Result<EnqueueOutcome, RelayError> {
        self.validate_envelope(&envelope, now_unix_ms)?;
        if let Some(existing) = self.store.envelope_by_id(&envelope.envelope_id)? {
            return if existing == envelope {
                Ok(EnqueueOutcome::Duplicate)
            } else {
                Err(RelayError::ReplayConflict)
            };
        }
        if let Some(existing) = self
            .store
            .envelope_by_sender_sequence(&envelope.sender_device_id, envelope.sender_sequence)?
        {
            return if existing == envelope {
                Ok(EnqueueOutcome::Duplicate)
            } else {
                Err(RelayError::ReplayConflict)
            };
        }
        if self.store.was_envelope_id_seen(&envelope.envelope_id)?
            || self
                .store
                .was_sender_sequence_seen(&envelope.sender_device_id, envelope.sender_sequence)?
        {
            return Err(RelayError::ReplayConflict);
        }
        let current = self.store.mailbox_bytes(&envelope.recipient_device_id)?;
        let added = envelope.ciphertext.len() as u64;
        if current.saturating_add(added) > self.config.max_mailbox_bytes_per_device {
            return Err(RelayError::MailboxQuotaExceeded);
        }
        self.store.insert_envelope(envelope)?;
        Ok(EnqueueOutcome::Stored)
    }

    pub fn mailbox(
        &mut self,
        account_id: &str,
        recipient: &str,
        trust_epoch: u64,
        now_unix_ms: u64,
    ) -> Result<Vec<CiphertextEnvelope>, RelayError> {
        self.validate_active_device(account_id, recipient, trust_epoch)?;
        self.store.mailbox(recipient, trust_epoch, now_unix_ms)
    }

    pub fn acknowledge(
        &mut self,
        account_id: &str,
        recipient: &str,
        sender: &str,
        trust_epoch: u64,
        through_sequence: u64,
    ) -> Result<AcknowledgeOutcome, RelayError> {
        self.validate_active_device(account_id, recipient, trust_epoch)?;
        self.validate_active_device(account_id, sender, trust_epoch)?;
        let removed = self
            .store
            .acknowledge(recipient, sender, through_sequence)?;
        Ok(AcknowledgeOutcome {
            removed_envelopes: removed,
            frontier: self.store.frontier(recipient)?,
        })
    }

    pub fn publish_signal(
        &mut self,
        signal: RendezvousSignal,
        now_unix_ms: u64,
    ) -> Result<(), RelayError> {
        self.validate_signal(&signal, now_unix_ms)?;
        if let Some(existing) = self.store.signal_by_id(&signal.signal_id)? {
            return if existing == signal {
                Ok(())
            } else {
                Err(RelayError::ReplayConflict)
            };
        }
        if self.store.was_signal_id_seen(&signal.signal_id)? {
            return Err(RelayError::ReplayConflict);
        }
        if self
            .store
            .pending_signal_count(&signal.recipient_device_id)?
            >= self.config.max_pending_signals_per_device
        {
            return Err(RelayError::BoundExceeded("pending signal count"));
        }
        self.store.insert_signal(signal)
    }

    pub fn take_signals(
        &mut self,
        account_id: &str,
        recipient: &str,
        trust_epoch: u64,
        now_unix_ms: u64,
    ) -> Result<Vec<RendezvousSignal>, RelayError> {
        self.validate_active_device(account_id, recipient, trust_epoch)?;
        self.store.take_signals(recipient, trust_epoch, now_unix_ms)
    }

    pub fn purge_expired(&mut self, now_unix_ms: u64) -> Result<usize, RelayError> {
        self.store.purge_expired(now_unix_ms)
    }

    pub fn into_store(self) -> S {
        self.store
    }

    fn current_account(&self) -> Result<SingleOwnerAccount, RelayError> {
        self.store.account()?.ok_or(RelayError::AccountNotFound)
    }

    fn validate_account(&self, account: &SingleOwnerAccount) -> Result<(), RelayError> {
        if account.account_id.is_empty()
            || account.owner_label.is_empty()
            || account.trust_epoch == 0
        {
            return Err(RelayError::InvalidRecord("account identity"));
        }
        if account.devices.len() > self.config.max_devices {
            return Err(RelayError::BoundExceeded("device count"));
        }
        if account.passkey_credentials.len() > self.config.max_credentials {
            return Err(RelayError::BoundExceeded("credential count"));
        }
        for (id, device) in &account.devices {
            if id != &device.device_id {
                return Err(RelayError::InvalidRecord("device map key"));
            }
            validate_device(device, account.trust_epoch)?;
        }
        for (id, credential) in &account.passkey_credentials {
            if id != &credential.credential_id {
                return Err(RelayError::InvalidRecord("credential map key"));
            }
            validate_credential(credential)?;
        }
        Ok(())
    }

    fn validate_active_device(
        &self,
        account_id: &str,
        device_id: &str,
        trust_epoch: u64,
    ) -> Result<(), RelayError> {
        let account = self.current_account()?;
        if account.account_id != account_id {
            return Err(RelayError::AccountNotFound);
        }
        if account.trust_epoch != trust_epoch {
            return Err(RelayError::TrustEpochMismatch);
        }
        let device = account
            .devices
            .get(device_id)
            .ok_or(RelayError::DeviceNotFound)?;
        if device.status != DeviceStatus::Active {
            return Err(RelayError::DeviceRevoked);
        }
        if device.key_epoch != trust_epoch {
            return Err(RelayError::TrustEpochMismatch);
        }
        Ok(())
    }

    fn validate_envelope(
        &self,
        envelope: &CiphertextEnvelope,
        now_unix_ms: u64,
    ) -> Result<(), RelayError> {
        if envelope.envelope_id.is_empty() || envelope.sender_sequence == 0 {
            return Err(RelayError::InvalidRecord("envelope identity"));
        }
        self.validate_active_device(
            &envelope.account_id,
            &envelope.sender_device_id,
            envelope.trust_epoch,
        )?;
        self.validate_active_device(
            &envelope.account_id,
            &envelope.recipient_device_id,
            envelope.trust_epoch,
        )?;
        validate_lifetime(
            envelope.created_at_unix_ms,
            envelope.expires_at_unix_ms,
            now_unix_ms,
            self.config.max_retention_seconds,
        )?;
        if envelope.ciphertext.is_empty()
            || envelope.ciphertext.len() > self.config.max_ciphertext_bytes
        {
            return Err(RelayError::BoundExceeded("ciphertext bytes"));
        }
        Ok(())
    }

    fn validate_signal(
        &self,
        signal: &RendezvousSignal,
        now_unix_ms: u64,
    ) -> Result<(), RelayError> {
        if signal.signal_id.is_empty() {
            return Err(RelayError::InvalidRecord("signal identity"));
        }
        self.validate_active_device(
            &signal.account_id,
            &signal.sender_device_id,
            signal.trust_epoch,
        )?;
        self.validate_active_device(
            &signal.account_id,
            &signal.recipient_device_id,
            signal.trust_epoch,
        )?;
        validate_lifetime(
            signal.created_at_unix_ms,
            signal.expires_at_unix_ms,
            now_unix_ms,
            self.config.max_signal_lifetime_seconds,
        )?;
        if signal.ciphertext.is_empty()
            || signal.ciphertext.len() > self.config.max_signal_ciphertext_bytes
        {
            return Err(RelayError::BoundExceeded("signal ciphertext bytes"));
        }
        Ok(())
    }
}

fn validate_config(config: &RelayConfig) -> Result<(), RelayError> {
    if config.max_devices == 0
        || config.max_credentials == 0
        || config.max_ciphertext_bytes == 0
        || config.max_mailbox_bytes_per_device == 0
        || config.max_retention_seconds == 0
        || config.max_pending_signals_per_device == 0
        || config.max_signal_ciphertext_bytes == 0
        || config.max_signal_lifetime_seconds == 0
    {
        return Err(RelayError::InvalidRecord("zero configuration bound"));
    }
    Ok(())
}

fn validate_device(device: &DevicePublicRecord, trust_epoch: u64) -> Result<(), RelayError> {
    if device.device_id.is_empty()
        || device.display_name.is_empty()
        || device.signing_public_key.is_empty()
        || device.encryption_public_key.is_empty()
    {
        return Err(RelayError::InvalidRecord("device public record"));
    }
    if device.status == DeviceStatus::Active && device.key_epoch != trust_epoch {
        return Err(RelayError::TrustEpochMismatch);
    }
    Ok(())
}

fn validate_credential(credential: &PasskeyCredentialRecord) -> Result<(), RelayError> {
    if credential.credential_id.is_empty() || credential.public_key_cose.is_empty() {
        return Err(RelayError::InvalidRecord("passkey public record"));
    }
    Ok(())
}

fn validate_lifetime(
    created_at_unix_ms: u64,
    expires_at_unix_ms: u64,
    now_unix_ms: u64,
    max_lifetime_seconds: u64,
) -> Result<(), RelayError> {
    if created_at_unix_ms > now_unix_ms || expires_at_unix_ms <= now_unix_ms {
        return Err(RelayError::InvalidRecord("message lifetime"));
    }
    let maximum = created_at_unix_ms.saturating_add(max_lifetime_seconds.saturating_mul(1_000));
    if expires_at_unix_ms > maximum {
        return Err(RelayError::BoundExceeded("message retention"));
    }
    Ok(())
}
