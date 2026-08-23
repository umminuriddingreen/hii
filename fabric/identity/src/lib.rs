//! Single-owner authentication and trusted-device authority for HII Fabric.
//!
//! The crate stores public credentials and trust decisions only. Device key
//! generation/storage, durable persistence, HTTP cookies, and authenticated
//! transport bindings belong to adapters outside this crate.

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{distributions::Alphanumeric, rngs::OsRng, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;
use url::Url;
use uuid::Uuid;
use webauthn_rs::prelude::{
    CreationChallengeResponse, Passkey, PasskeyAuthentication, PasskeyRegistration,
    PublicKeyCredential, RegisterPublicKeyCredential, RequestChallengeResponse, Webauthn,
    WebauthnBuilder,
};

pub mod server;
pub mod store;

pub const TRUST_LEDGER_SCHEMA_VERSION: u16 = 1;

pub type AccountId = String;
pub type DeviceId = String;
pub type SessionId = String;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityConfig {
    pub rp_id: String,
    pub rp_origin: Url,
    pub rp_name: String,
    pub challenge_ttl_ms: u64,
    pub enrollment_ttl_ms: u64,
    pub session_ttl_ms: u64,
    pub max_pending_ceremonies: usize,
    pub max_pending_enrollments: usize,
    pub max_devices: usize,
    pub max_passkeys: usize,
    pub max_recovery_codes: usize,
    pub max_public_key_bytes: usize,
}

impl IdentityConfig {
    pub fn new(rp_id: impl Into<String>, rp_origin: Url) -> Self {
        Self {
            rp_id: rp_id.into(),
            rp_origin,
            rp_name: "HII".into(),
            challenge_ttl_ms: 5 * 60 * 1_000,
            enrollment_ttl_ms: 10 * 60 * 1_000,
            session_ttl_ms: 30 * 24 * 60 * 60 * 1_000,
            max_pending_ceremonies: 16,
            max_pending_enrollments: 16,
            max_devices: 32,
            max_passkeys: 16,
            max_recovery_codes: 16,
            max_public_key_bytes: 4_096,
        }
    }

    fn validate(&self) -> Result<(), IdentityError> {
        if self.rp_id.trim().is_empty() || self.rp_name.trim().is_empty() {
            return Err(IdentityError::InvalidConfig("RP identity is empty"));
        }
        if self.rp_origin.scheme() != "https" {
            return Err(IdentityError::InvalidConfig(
                "WebAuthn origin must use HTTPS",
            ));
        }
        let origin_host = self
            .rp_origin
            .host_str()
            .ok_or(IdentityError::InvalidConfig("WebAuthn origin has no host"))?;
        if origin_host != self.rp_id && !origin_host.ends_with(&format!(".{}", self.rp_id)) {
            return Err(IdentityError::InvalidConfig(
                "RP ID is not the origin host or its registrable suffix",
            ));
        }
        if self.challenge_ttl_ms == 0
            || self.enrollment_ttl_ms == 0
            || self.session_ttl_ms == 0
            || self.max_pending_ceremonies == 0
            || self.max_pending_enrollments == 0
            || self.max_devices == 0
            || self.max_passkeys == 0
            || self.max_recovery_codes == 0
            || self.max_public_key_bytes < 32
        {
            return Err(IdentityError::InvalidConfig(
                "identity bounds must be non-zero and key bounds must permit secure keys",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustLedger {
    pub schema_version: u16,
    pub account_id: AccountId,
    pub owner_label: String,
    pub owner_user_handle: Uuid,
    pub trust_epoch: u64,
    pub revision: u64,
    pub devices: BTreeMap<DeviceId, DeviceRecord>,
    pub passkeys: BTreeMap<String, PasskeyRecord>,
    pub sessions: BTreeMap<SessionId, AuthenticationSession>,
    pub grants: BTreeMap<String, StandingCapabilityGrant>,
    pub recovery_codes: Vec<RecoveryCodeRecord>,
    pub passkey_registration_permit: Option<PasskeyRegistrationPermit>,
    pub events: Vec<TrustEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyRegistrationPermit {
    /// SHA-256 of a high-entropy, one-time bootstrap secret.
    pub secret_hash: String,
    pub trust_epoch: u64,
    pub expires_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyRecord {
    /// URL-safe base64 credential identifier used only as a public lookup key.
    pub credential_id: String,
    /// `webauthn-rs` serializes public credential material and counters only.
    pub credential: Passkey,
    pub created_at_unix_ms: u64,
    pub last_used_at_unix_ms: Option<u64>,
    pub trust_epoch: u64,
    pub status: RecordStatus,
    pub revoked_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordStatus {
    Active,
    Revoked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub device_id: DeviceId,
    pub display_name: String,
    pub signing_public_key: Vec<u8>,
    pub encryption_public_key: Vec<u8>,
    pub signing_key_fingerprint: String,
    pub encryption_key_fingerprint: String,
    pub enrolled_at_unix_ms: u64,
    pub key_epoch: u64,
    pub status: RecordStatus,
    pub revoked_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticationSession {
    pub session_id: SessionId,
    pub credential_id: String,
    pub issued_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub trust_epoch: u64,
    pub status: RecordStatus,
    pub revoked_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityScope {
    pub capability_id: String,
    pub target_device_id: DeviceId,
    pub resource_ids: BTreeSet<String>,
    pub allowed_actions: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StandingCapabilityGrant {
    pub grant_id: String,
    pub scope: CapabilityScope,
    pub approved_by_session_id: SessionId,
    pub approved_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub trust_epoch: u64,
    pub status: RecordStatus,
    pub revoked_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCodeRecord {
    pub code_id: String,
    /// Argon2id PHC string. The plaintext code is returned only at generation.
    pub argon2id_hash: String,
    pub created_at_unix_ms: u64,
    pub used_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustEvent {
    pub revision: u64,
    pub trust_epoch: u64,
    pub at_unix_ms: u64,
    pub kind: TrustEventKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "body", rename_all = "snake_case")]
pub enum TrustEventKind {
    DeviceEnrolled { device_id: DeviceId },
    DeviceRevoked { device_id: DeviceId },
    PasskeyRegistered { credential_id: String },
    AuthenticationSucceeded { session_id: SessionId },
    SessionRevoked { session_id: SessionId },
    GrantApproved { grant_id: String },
    GrantRevoked { grant_id: String },
    RecoveryCompleted { previous_epoch: u64 },
    RecoveryCodesRotated,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceKeySubmission {
    pub device_id: DeviceId,
    pub display_name: String,
    pub signing_public_key: Vec<u8>,
    pub encryption_public_key: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentProposal {
    pub proposal_id: String,
    pub device_id: DeviceId,
    pub display_name: String,
    pub signing_key_fingerprint: String,
    pub encryption_key_fingerprint: String,
    pub created_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    #[serde(skip)]
    signing_public_key: Vec<u8>,
    #[serde(skip)]
    encryption_public_key: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ceremony<T> {
    pub ceremony_id: String,
    pub expires_at_unix_ms: u64,
    pub public_options: T,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryOutcome {
    pub new_trust_epoch: u64,
    pub revoked_devices: usize,
    pub revoked_sessions: usize,
    pub revoked_grants: usize,
    pub revoked_passkeys: usize,
    /// One-time secret for registering the replacement epoch's first passkey.
    pub passkey_registration_secret: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapMaterial {
    pub recovery_codes: Vec<String>,
    pub passkey_registration_secret: String,
}

struct PendingRegistration {
    expires_at_unix_ms: u64,
    state: PasskeyRegistration,
}

struct PendingAuthentication {
    expires_at_unix_ms: u64,
    state: PasskeyAuthentication,
}

pub struct IdentityAuthority {
    config: IdentityConfig,
    webauthn: Webauthn,
    ledger: TrustLedger,
    registrations: BTreeMap<String, PendingRegistration>,
    authentications: BTreeMap<String, PendingAuthentication>,
    enrollments: BTreeMap<String, EnrollmentProposal>,
}

impl IdentityAuthority {
    pub fn bootstrap(
        config: IdentityConfig,
        account_id: impl Into<String>,
        owner_label: impl Into<String>,
        initial_device: DeviceKeySubmission,
        recovery_code_count: usize,
        now_unix_ms: u64,
    ) -> Result<(Self, BootstrapMaterial), IdentityError> {
        config.validate()?;
        let account_id = account_id.into();
        validate_identifier(&account_id, "account id")?;
        let owner_label = owner_label.into();
        validate_label(&owner_label, "owner label")?;
        let webauthn = build_webauthn(&config)?;
        let mut authority = Self {
            config,
            webauthn,
            ledger: TrustLedger {
                schema_version: TRUST_LEDGER_SCHEMA_VERSION,
                account_id,
                owner_label,
                owner_user_handle: Uuid::new_v4(),
                trust_epoch: 1,
                revision: 0,
                devices: BTreeMap::new(),
                passkeys: BTreeMap::new(),
                sessions: BTreeMap::new(),
                grants: BTreeMap::new(),
                recovery_codes: Vec::new(),
                passkey_registration_permit: None,
                events: Vec::new(),
            },
            registrations: BTreeMap::new(),
            authentications: BTreeMap::new(),
            enrollments: BTreeMap::new(),
        };
        let record = authority.device_record(initial_device, now_unix_ms)?;
        authority
            .ledger
            .devices
            .insert(record.device_id.clone(), record.clone());
        authority.append_event(
            now_unix_ms,
            TrustEventKind::DeviceEnrolled {
                device_id: record.device_id,
            },
        );
        let codes = authority.generate_recovery_codes(recovery_code_count, now_unix_ms)?;
        let passkey_registration_secret = authority.issue_registration_permit(now_unix_ms)?;
        Ok((
            authority,
            BootstrapMaterial {
                recovery_codes: codes,
                passkey_registration_secret,
            },
        ))
    }

    pub fn from_ledger(config: IdentityConfig, ledger: TrustLedger) -> Result<Self, IdentityError> {
        config.validate()?;
        validate_ledger(&ledger, &config)?;
        Ok(Self {
            webauthn: build_webauthn(&config)?,
            config,
            ledger,
            registrations: BTreeMap::new(),
            authentications: BTreeMap::new(),
            enrollments: BTreeMap::new(),
        })
    }

    pub fn ledger(&self) -> &TrustLedger {
        &self.ledger
    }

    /// Returns only whether a session currently carries owner authority.
    /// Callers do not need access to the ledger's private trust history.
    pub fn session_is_active(&self, session_id: &str, now_unix_ms: u64) -> bool {
        self.ledger.sessions.get(session_id).is_some_and(|session| {
            session.status == RecordStatus::Active
                && session.trust_epoch == self.ledger.trust_epoch
                && session.expires_at_unix_ms > now_unix_ms
        })
    }

    /// Revokes the exact authenticated session presented by the owner.
    pub fn revoke_session(
        &mut self,
        session_id: &str,
        now_unix_ms: u64,
    ) -> Result<(), IdentityError> {
        self.require_session(session_id, now_unix_ms)?;
        let session = self
            .ledger
            .sessions
            .get_mut(session_id)
            .ok_or(IdentityError::AuthenticationRequired)?;
        session.status = RecordStatus::Revoked;
        session.revoked_at_unix_ms = Some(now_unix_ms);
        self.append_event(
            now_unix_ms,
            TrustEventKind::SessionRevoked {
                session_id: session_id.to_owned(),
            },
        );
        Ok(())
    }

    pub fn start_passkey_registration(
        &mut self,
        authorization: Option<&str>,
        user_name: &str,
        now_unix_ms: u64,
    ) -> Result<Ceremony<CreationChallengeResponse>, IdentityError> {
        self.purge_expired(now_unix_ms);
        validate_label(user_name, "WebAuthn user name")?;
        if self
            .ledger
            .passkeys
            .values()
            .any(|record| record.status == RecordStatus::Active)
        {
            self.require_session(
                authorization.ok_or(IdentityError::AuthenticationRequired)?,
                now_unix_ms,
            )?;
        } else {
            self.require_registration_permit(
                authorization.ok_or(IdentityError::AuthenticationRequired)?,
                now_unix_ms,
            )?;
        }
        if self.registrations.len() >= self.config.max_pending_ceremonies {
            return Err(IdentityError::BoundExceeded("pending registrations"));
        }
        if self.ledger.passkeys.len() >= self.config.max_passkeys {
            return Err(IdentityError::BoundExceeded("passkeys"));
        }
        let excluded = self
            .ledger
            .passkeys
            .values()
            .map(|record| record.credential.cred_id().clone())
            .collect::<Vec<_>>();
        let (public_options, state) = self.webauthn.start_passkey_registration(
            self.ledger.owner_user_handle,
            user_name,
            &self.ledger.owner_label,
            (!excluded.is_empty()).then_some(excluded),
        )?;
        let ceremony_id = random_id("reg");
        let expires_at_unix_ms = checked_expiry(now_unix_ms, self.config.challenge_ttl_ms)?;
        self.registrations.insert(
            ceremony_id.clone(),
            PendingRegistration {
                expires_at_unix_ms,
                state,
            },
        );
        Ok(Ceremony {
            ceremony_id,
            expires_at_unix_ms,
            public_options,
        })
    }

    pub fn finish_passkey_registration(
        &mut self,
        ceremony_id: &str,
        response: &RegisterPublicKeyCredential,
        now_unix_ms: u64,
    ) -> Result<String, IdentityError> {
        let pending = self
            .registrations
            .remove(ceremony_id)
            .ok_or(IdentityError::CeremonyNotFound)?;
        if pending.expires_at_unix_ms <= now_unix_ms {
            return Err(IdentityError::CeremonyExpired);
        }
        let passkey = self
            .webauthn
            .finish_passkey_registration(response, &pending.state)?;
        let credential_id = encode_credential_id(passkey.cred_id().as_ref());
        if self.ledger.passkeys.contains_key(&credential_id) {
            return Err(IdentityError::CredentialAlreadyExists);
        }
        self.ledger.passkeys.insert(
            credential_id.clone(),
            PasskeyRecord {
                credential_id: credential_id.clone(),
                credential: passkey,
                created_at_unix_ms: now_unix_ms,
                last_used_at_unix_ms: None,
                trust_epoch: self.ledger.trust_epoch,
                status: RecordStatus::Active,
                revoked_at_unix_ms: None,
            },
        );
        self.append_event(
            now_unix_ms,
            TrustEventKind::PasskeyRegistered {
                credential_id: credential_id.clone(),
            },
        );
        self.ledger.passkey_registration_permit = None;
        self.registrations.clear();
        Ok(credential_id)
    }

    pub fn start_authentication(
        &mut self,
        now_unix_ms: u64,
    ) -> Result<Ceremony<RequestChallengeResponse>, IdentityError> {
        self.purge_expired(now_unix_ms);
        if self.authentications.len() >= self.config.max_pending_ceremonies {
            return Err(IdentityError::BoundExceeded("pending authentications"));
        }
        let passkeys = self
            .ledger
            .passkeys
            .values()
            .filter(|record| {
                record.status == RecordStatus::Active
                    && record.trust_epoch == self.ledger.trust_epoch
            })
            .map(|record| record.credential.clone())
            .collect::<Vec<_>>();
        if passkeys.is_empty() {
            return Err(IdentityError::NoPasskeys);
        }
        let (public_options, state) = self.webauthn.start_passkey_authentication(&passkeys)?;
        let ceremony_id = random_id("auth");
        let expires_at_unix_ms = checked_expiry(now_unix_ms, self.config.challenge_ttl_ms)?;
        self.authentications.insert(
            ceremony_id.clone(),
            PendingAuthentication {
                expires_at_unix_ms,
                state,
            },
        );
        Ok(Ceremony {
            ceremony_id,
            expires_at_unix_ms,
            public_options,
        })
    }

    pub fn finish_authentication(
        &mut self,
        ceremony_id: &str,
        response: &PublicKeyCredential,
        now_unix_ms: u64,
    ) -> Result<AuthenticationSession, IdentityError> {
        let pending = self
            .authentications
            .remove(ceremony_id)
            .ok_or(IdentityError::CeremonyNotFound)?;
        if pending.expires_at_unix_ms <= now_unix_ms {
            return Err(IdentityError::CeremonyExpired);
        }
        let result = self
            .webauthn
            .finish_passkey_authentication(response, &pending.state)?;
        let credential_id = encode_credential_id(result.cred_id().as_ref());
        let record = self
            .ledger
            .passkeys
            .get_mut(&credential_id)
            .ok_or(IdentityError::CredentialNotFound)?;
        if record.status != RecordStatus::Active || record.trust_epoch != self.ledger.trust_epoch {
            return Err(IdentityError::CredentialNotFound);
        }
        if record.credential.update_credential(&result).is_none() {
            return Err(IdentityError::CredentialNotFound);
        }
        record.last_used_at_unix_ms = Some(now_unix_ms);
        let session = AuthenticationSession {
            session_id: random_id("session"),
            credential_id,
            issued_at_unix_ms: now_unix_ms,
            expires_at_unix_ms: checked_expiry(now_unix_ms, self.config.session_ttl_ms)?,
            trust_epoch: self.ledger.trust_epoch,
            status: RecordStatus::Active,
            revoked_at_unix_ms: None,
        };
        self.ledger
            .sessions
            .insert(session.session_id.clone(), session.clone());
        self.append_event(
            now_unix_ms,
            TrustEventKind::AuthenticationSucceeded {
                session_id: session.session_id.clone(),
            },
        );
        Ok(session)
    }

    pub fn propose_device(
        &mut self,
        submission: DeviceKeySubmission,
        now_unix_ms: u64,
    ) -> Result<EnrollmentProposal, IdentityError> {
        self.purge_expired(now_unix_ms);
        self.validate_device_submission(&submission)?;
        if self.enrollments.len() >= self.config.max_pending_enrollments {
            return Err(IdentityError::BoundExceeded("pending enrollments"));
        }
        if self.ledger.devices.contains_key(&submission.device_id) {
            return Err(IdentityError::DeviceAlreadyExists);
        }
        let proposal = EnrollmentProposal {
            proposal_id: random_id("enroll"),
            device_id: submission.device_id,
            display_name: submission.display_name,
            signing_key_fingerprint: fingerprint(&submission.signing_public_key),
            encryption_key_fingerprint: fingerprint(&submission.encryption_public_key),
            created_at_unix_ms: now_unix_ms,
            expires_at_unix_ms: checked_expiry(now_unix_ms, self.config.enrollment_ttl_ms)?,
            signing_public_key: submission.signing_public_key,
            encryption_public_key: submission.encryption_public_key,
        };
        self.enrollments
            .insert(proposal.proposal_id.clone(), proposal.clone());
        Ok(proposal)
    }

    pub fn approve_device(
        &mut self,
        proposal_id: &str,
        owner_session_id: &str,
        shown_signing_fingerprint: &str,
        shown_encryption_fingerprint: &str,
        now_unix_ms: u64,
    ) -> Result<DeviceRecord, IdentityError> {
        self.require_session(owner_session_id, now_unix_ms)?;
        let proposal = self
            .enrollments
            .remove(proposal_id)
            .ok_or(IdentityError::EnrollmentNotFound)?;
        if proposal.expires_at_unix_ms <= now_unix_ms {
            return Err(IdentityError::EnrollmentExpired);
        }
        if proposal.signing_key_fingerprint != shown_signing_fingerprint
            || proposal.encryption_key_fingerprint != shown_encryption_fingerprint
        {
            return Err(IdentityError::FingerprintMismatch);
        }
        if self.active_device_count() >= self.config.max_devices {
            return Err(IdentityError::BoundExceeded("active devices"));
        }
        let record = DeviceRecord {
            device_id: proposal.device_id,
            display_name: proposal.display_name,
            signing_public_key: proposal.signing_public_key,
            encryption_public_key: proposal.encryption_public_key,
            signing_key_fingerprint: proposal.signing_key_fingerprint,
            encryption_key_fingerprint: proposal.encryption_key_fingerprint,
            enrolled_at_unix_ms: now_unix_ms,
            key_epoch: self.ledger.trust_epoch,
            status: RecordStatus::Active,
            revoked_at_unix_ms: None,
        };
        if self
            .ledger
            .devices
            .insert(record.device_id.clone(), record.clone())
            .is_some()
        {
            return Err(IdentityError::DeviceAlreadyExists);
        }
        self.append_event(
            now_unix_ms,
            TrustEventKind::DeviceEnrolled {
                device_id: record.device_id.clone(),
            },
        );
        Ok(record)
    }

    pub fn revoke_device(
        &mut self,
        device_id: &str,
        owner_session_id: &str,
        now_unix_ms: u64,
    ) -> Result<(), IdentityError> {
        self.require_session(owner_session_id, now_unix_ms)?;
        let device = self
            .ledger
            .devices
            .get_mut(device_id)
            .ok_or(IdentityError::DeviceNotFound)?;
        if device.status == RecordStatus::Revoked {
            return Ok(());
        }
        device.status = RecordStatus::Revoked;
        device.revoked_at_unix_ms = Some(now_unix_ms);
        for grant in self.ledger.grants.values_mut() {
            if grant.scope.target_device_id == device_id && grant.status == RecordStatus::Active {
                grant.status = RecordStatus::Revoked;
                grant.revoked_at_unix_ms = Some(now_unix_ms);
            }
        }
        self.append_event(
            now_unix_ms,
            TrustEventKind::DeviceRevoked {
                device_id: device_id.into(),
            },
        );
        Ok(())
    }

    pub fn approve_grant(
        &mut self,
        grant_id: impl Into<String>,
        scope: CapabilityScope,
        owner_session_id: &str,
        expires_at_unix_ms: u64,
        now_unix_ms: u64,
    ) -> Result<StandingCapabilityGrant, IdentityError> {
        self.require_session(owner_session_id, now_unix_ms)?;
        let grant_id = grant_id.into();
        validate_identifier(&grant_id, "grant id")?;
        validate_scope(&scope)?;
        let device = self
            .ledger
            .devices
            .get(&scope.target_device_id)
            .ok_or(IdentityError::DeviceNotFound)?;
        if device.status != RecordStatus::Active || device.key_epoch != self.ledger.trust_epoch {
            return Err(IdentityError::DeviceRevoked);
        }
        if expires_at_unix_ms <= now_unix_ms {
            return Err(IdentityError::InvalidGrant(
                "grant must expire in the future",
            ));
        }
        if self.ledger.grants.contains_key(&grant_id) {
            return Err(IdentityError::GrantAlreadyExists);
        }
        let grant = StandingCapabilityGrant {
            grant_id: grant_id.clone(),
            scope,
            approved_by_session_id: owner_session_id.into(),
            approved_at_unix_ms: now_unix_ms,
            expires_at_unix_ms,
            trust_epoch: self.ledger.trust_epoch,
            status: RecordStatus::Active,
            revoked_at_unix_ms: None,
        };
        self.ledger.grants.insert(grant_id.clone(), grant.clone());
        self.append_event(now_unix_ms, TrustEventKind::GrantApproved { grant_id });
        Ok(grant)
    }

    pub fn revoke_grant(
        &mut self,
        grant_id: &str,
        owner_session_id: &str,
        now_unix_ms: u64,
    ) -> Result<(), IdentityError> {
        self.require_session(owner_session_id, now_unix_ms)?;
        let grant = self
            .ledger
            .grants
            .get_mut(grant_id)
            .ok_or(IdentityError::GrantNotFound)?;
        grant.status = RecordStatus::Revoked;
        grant.revoked_at_unix_ms = Some(now_unix_ms);
        self.append_event(
            now_unix_ms,
            TrustEventKind::GrantRevoked {
                grant_id: grant_id.into(),
            },
        );
        Ok(())
    }

    pub fn grant_allows(
        &self,
        grant_id: &str,
        capability_id: &str,
        target_device_id: &str,
        action: &str,
        resource_id: Option<&str>,
        now_unix_ms: u64,
    ) -> bool {
        let Some(grant) = self.ledger.grants.get(grant_id) else {
            return false;
        };
        grant.status == RecordStatus::Active
            && grant.trust_epoch == self.ledger.trust_epoch
            && grant.expires_at_unix_ms > now_unix_ms
            && grant.scope.capability_id == capability_id
            && grant.scope.target_device_id == target_device_id
            && grant.scope.allowed_actions.contains(action)
            && match resource_id {
                Some(resource) => grant.scope.resource_ids.contains(resource),
                None => grant.scope.resource_ids.is_empty(),
            }
    }

    pub fn rotate_recovery_codes(
        &mut self,
        owner_session_id: &str,
        count: usize,
        now_unix_ms: u64,
    ) -> Result<Vec<String>, IdentityError> {
        self.require_session(owner_session_id, now_unix_ms)?;
        let codes = self.generate_recovery_codes(count, now_unix_ms)?;
        self.append_event(now_unix_ms, TrustEventKind::RecoveryCodesRotated);
        Ok(codes)
    }

    fn generate_recovery_codes(
        &mut self,
        count: usize,
        now_unix_ms: u64,
    ) -> Result<Vec<String>, IdentityError> {
        if count == 0 || count > self.config.max_recovery_codes {
            return Err(IdentityError::BoundExceeded("recovery codes"));
        }
        let argon2 = Argon2::default();
        let mut plaintext = Vec::with_capacity(count);
        let mut records = Vec::with_capacity(count);
        for _ in 0..count {
            let code = recovery_code();
            let salt = SaltString::generate(&mut OsRng);
            let hash = argon2.hash_password(code.as_bytes(), &salt)?.to_string();
            records.push(RecoveryCodeRecord {
                code_id: random_id("recovery"),
                argon2id_hash: hash,
                created_at_unix_ms: now_unix_ms,
                used_at_unix_ms: None,
            });
            plaintext.push(code);
        }
        self.ledger.recovery_codes = records;
        Ok(plaintext)
    }

    pub fn recover(
        &mut self,
        plaintext_code: &str,
        replacement_device: DeviceKeySubmission,
        now_unix_ms: u64,
    ) -> Result<RecoveryOutcome, IdentityError> {
        self.validate_device_submission(&replacement_device)?;
        let argon2 = Argon2::default();
        let matching = self
            .ledger
            .recovery_codes
            .iter_mut()
            .find(|record| {
                record.used_at_unix_ms.is_none()
                    && PasswordHash::new(&record.argon2id_hash)
                        .ok()
                        .is_some_and(|hash| {
                            argon2
                                .verify_password(plaintext_code.as_bytes(), &hash)
                                .is_ok()
                        })
            })
            .ok_or(IdentityError::RecoveryCodeInvalid)?;
        matching.used_at_unix_ms = Some(now_unix_ms);

        let previous_epoch = self.ledger.trust_epoch;
        self.ledger.trust_epoch = previous_epoch
            .checked_add(1)
            .ok_or(IdentityError::TrustEpochExhausted)?;
        let revoked_devices = revoke_active_devices(&mut self.ledger.devices, now_unix_ms);
        let revoked_sessions = revoke_active_sessions(&mut self.ledger.sessions, now_unix_ms);
        let revoked_grants = revoke_active_grants(&mut self.ledger.grants, now_unix_ms);
        let revoked_passkeys = revoke_active_passkeys(&mut self.ledger.passkeys, now_unix_ms);
        self.registrations.clear();
        self.authentications.clear();
        self.enrollments.clear();
        let passkey_registration_secret = self.issue_registration_permit(now_unix_ms)?;

        let replacement = self.device_record(replacement_device, now_unix_ms)?;
        self.ledger
            .devices
            .insert(replacement.device_id.clone(), replacement.clone());
        self.append_event(
            now_unix_ms,
            TrustEventKind::RecoveryCompleted { previous_epoch },
        );
        self.append_event(
            now_unix_ms,
            TrustEventKind::DeviceEnrolled {
                device_id: replacement.device_id,
            },
        );
        Ok(RecoveryOutcome {
            new_trust_epoch: self.ledger.trust_epoch,
            revoked_devices,
            revoked_sessions,
            revoked_grants,
            revoked_passkeys,
            passkey_registration_secret,
        })
    }

    pub fn purge_expired(&mut self, now_unix_ms: u64) {
        self.registrations
            .retain(|_, item| item.expires_at_unix_ms > now_unix_ms);
        self.authentications
            .retain(|_, item| item.expires_at_unix_ms > now_unix_ms);
        self.enrollments
            .retain(|_, item| item.expires_at_unix_ms > now_unix_ms);
    }

    fn require_session(
        &self,
        session_id: &str,
        now_unix_ms: u64,
    ) -> Result<&AuthenticationSession, IdentityError> {
        let session = self
            .ledger
            .sessions
            .get(session_id)
            .ok_or(IdentityError::AuthenticationRequired)?;
        if session.status != RecordStatus::Active
            || session.trust_epoch != self.ledger.trust_epoch
            || session.expires_at_unix_ms <= now_unix_ms
        {
            return Err(IdentityError::SessionInactive);
        }
        Ok(session)
    }

    fn require_registration_permit(
        &self,
        secret: &str,
        now_unix_ms: u64,
    ) -> Result<(), IdentityError> {
        let permit = self
            .ledger
            .passkey_registration_permit
            .as_ref()
            .ok_or(IdentityError::AuthenticationRequired)?;
        if permit.trust_epoch != self.ledger.trust_epoch
            || permit.expires_at_unix_ms <= now_unix_ms
            || permit.secret_hash != secret_hash(secret)
        {
            return Err(IdentityError::AuthenticationRequired);
        }
        Ok(())
    }

    fn issue_registration_permit(&mut self, now_unix_ms: u64) -> Result<String, IdentityError> {
        let secret = random_secret();
        self.ledger.passkey_registration_permit = Some(PasskeyRegistrationPermit {
            secret_hash: secret_hash(&secret),
            trust_epoch: self.ledger.trust_epoch,
            expires_at_unix_ms: checked_expiry(now_unix_ms, self.config.challenge_ttl_ms)?,
        });
        Ok(secret)
    }

    fn active_device_count(&self) -> usize {
        self.ledger
            .devices
            .values()
            .filter(|device| device.status == RecordStatus::Active)
            .count()
    }

    fn validate_device_submission(
        &self,
        submission: &DeviceKeySubmission,
    ) -> Result<(), IdentityError> {
        validate_identifier(&submission.device_id, "device id")?;
        validate_label(&submission.display_name, "device name")?;
        for key in [
            &submission.signing_public_key,
            &submission.encryption_public_key,
        ] {
            if key.len() < 32 || key.len() > self.config.max_public_key_bytes {
                return Err(IdentityError::InvalidDeviceKey);
            }
        }
        if submission.signing_public_key == submission.encryption_public_key {
            return Err(IdentityError::InvalidDeviceKey);
        }
        Ok(())
    }

    fn device_record(
        &self,
        submission: DeviceKeySubmission,
        now_unix_ms: u64,
    ) -> Result<DeviceRecord, IdentityError> {
        self.validate_device_submission(&submission)?;
        Ok(DeviceRecord {
            device_id: submission.device_id,
            display_name: submission.display_name,
            signing_key_fingerprint: fingerprint(&submission.signing_public_key),
            encryption_key_fingerprint: fingerprint(&submission.encryption_public_key),
            signing_public_key: submission.signing_public_key,
            encryption_public_key: submission.encryption_public_key,
            enrolled_at_unix_ms: now_unix_ms,
            key_epoch: self.ledger.trust_epoch,
            status: RecordStatus::Active,
            revoked_at_unix_ms: None,
        })
    }

    fn append_event(&mut self, at_unix_ms: u64, kind: TrustEventKind) {
        self.ledger.revision += 1;
        self.ledger.events.push(TrustEvent {
            revision: self.ledger.revision,
            trust_epoch: self.ledger.trust_epoch,
            at_unix_ms,
            kind,
        });
    }

    #[cfg(test)]
    fn insert_verified_session_for_test(&mut self, now_unix_ms: u64) -> AuthenticationSession {
        let session = AuthenticationSession {
            session_id: random_id("test-session"),
            credential_id: "test-only-verified-credential".into(),
            issued_at_unix_ms: now_unix_ms,
            expires_at_unix_ms: now_unix_ms + self.config.session_ttl_ms,
            trust_epoch: self.ledger.trust_epoch,
            status: RecordStatus::Active,
            revoked_at_unix_ms: None,
        };
        self.ledger
            .sessions
            .insert(session.session_id.clone(), session.clone());
        session
    }
}

#[derive(Debug, Error)]
pub enum IdentityError {
    #[error("invalid identity configuration: {0}")]
    InvalidConfig(&'static str),
    #[error("invalid record: {0}")]
    InvalidRecord(&'static str),
    #[error("configured bound exceeded: {0}")]
    BoundExceeded(&'static str),
    #[error("WebAuthn ceremony does not exist or was already consumed")]
    CeremonyNotFound,
    #[error("WebAuthn ceremony expired")]
    CeremonyExpired,
    #[error("owner authentication is required")]
    AuthenticationRequired,
    #[error("authentication session is revoked, expired, or from an old trust epoch")]
    SessionInactive,
    #[error("no passkeys are registered")]
    NoPasskeys,
    #[error("credential already exists")]
    CredentialAlreadyExists,
    #[error("credential does not exist")]
    CredentialNotFound,
    #[error("device already exists")]
    DeviceAlreadyExists,
    #[error("device does not exist")]
    DeviceNotFound,
    #[error("device is revoked or from an old trust epoch")]
    DeviceRevoked,
    #[error("device public keys must be distinct and within configured bounds")]
    InvalidDeviceKey,
    #[error("enrollment proposal does not exist or was already consumed")]
    EnrollmentNotFound,
    #[error("enrollment proposal expired")]
    EnrollmentExpired,
    #[error("approved key fingerprints do not match the enrollment proposal")]
    FingerprintMismatch,
    #[error("invalid grant: {0}")]
    InvalidGrant(&'static str),
    #[error("grant already exists")]
    GrantAlreadyExists,
    #[error("grant does not exist")]
    GrantNotFound,
    #[error("recovery code is invalid or was already used")]
    RecoveryCodeInvalid,
    #[error("trust epoch is exhausted")]
    TrustEpochExhausted,
    #[error("WebAuthn rejected the ceremony: {0}")]
    Webauthn(#[from] webauthn_rs::prelude::WebauthnError),
    #[error("recovery-code hashing failed: {0}")]
    PasswordHash(#[from] argon2::password_hash::Error),
}

fn build_webauthn(config: &IdentityConfig) -> Result<Webauthn, IdentityError> {
    let builder = WebauthnBuilder::new(&config.rp_id, &config.rp_origin)?;
    Ok(builder.rp_name(&config.rp_name).build()?)
}

fn validate_ledger(ledger: &TrustLedger, config: &IdentityConfig) -> Result<(), IdentityError> {
    if ledger.schema_version != TRUST_LEDGER_SCHEMA_VERSION {
        return Err(IdentityError::InvalidRecord("unsupported ledger schema"));
    }
    validate_identifier(&ledger.account_id, "account id")?;
    validate_label(&ledger.owner_label, "owner label")?;
    if ledger.trust_epoch == 0
        || ledger.devices.len() > config.max_devices
        || ledger.passkeys.len() > config.max_passkeys
    {
        return Err(IdentityError::InvalidRecord(
            "ledger bounds or epoch are invalid",
        ));
    }
    if ledger.events.len() as u64 != ledger.revision
        || ledger.events.iter().enumerate().any(|(index, event)| {
            event.revision != index as u64 + 1 || event.trust_epoch > ledger.trust_epoch
        })
    {
        return Err(IdentityError::InvalidRecord(
            "ledger revisions are not monotonic",
        ));
    }
    for (device_id, device) in &ledger.devices {
        if device_id != &device.device_id
            || device.signing_key_fingerprint != fingerprint(&device.signing_public_key)
            || device.encryption_key_fingerprint != fingerprint(&device.encryption_public_key)
            || device.signing_public_key == device.encryption_public_key
            || device.signing_public_key.len() < 32
            || device.encryption_public_key.len() < 32
            || device.signing_public_key.len() > config.max_public_key_bytes
            || device.encryption_public_key.len() > config.max_public_key_bytes
            || (device.status == RecordStatus::Active
                && (device.key_epoch != ledger.trust_epoch || device.revoked_at_unix_ms.is_some()))
            || (device.status == RecordStatus::Revoked && device.revoked_at_unix_ms.is_none())
        {
            return Err(IdentityError::InvalidRecord("invalid device record"));
        }
    }
    for (credential_id, passkey) in &ledger.passkeys {
        if credential_id != &passkey.credential_id
            || credential_id != &encode_credential_id(passkey.credential.cred_id().as_ref())
            || passkey.trust_epoch > ledger.trust_epoch
            || (passkey.status == RecordStatus::Active
                && (passkey.trust_epoch != ledger.trust_epoch
                    || passkey.revoked_at_unix_ms.is_some()))
            || (passkey.status == RecordStatus::Revoked && passkey.revoked_at_unix_ms.is_none())
        {
            return Err(IdentityError::InvalidRecord("invalid passkey record"));
        }
    }
    for (session_id, session) in &ledger.sessions {
        let credential_is_active =
            ledger
                .passkeys
                .get(&session.credential_id)
                .is_some_and(|passkey| {
                    passkey.status == RecordStatus::Active
                        && passkey.trust_epoch == ledger.trust_epoch
                });
        if session_id != &session.session_id
            || session.expires_at_unix_ms <= session.issued_at_unix_ms
            || session.trust_epoch > ledger.trust_epoch
            || (session.status == RecordStatus::Active
                && (session.trust_epoch != ledger.trust_epoch
                    || session.revoked_at_unix_ms.is_some()
                    || !credential_is_active))
            || (session.status == RecordStatus::Revoked && session.revoked_at_unix_ms.is_none())
        {
            return Err(IdentityError::InvalidRecord("invalid session record"));
        }
    }
    for (grant_id, grant) in &ledger.grants {
        validate_scope(&grant.scope)?;
        let target_is_active = ledger
            .devices
            .get(&grant.scope.target_device_id)
            .is_some_and(|device| {
                device.status == RecordStatus::Active && device.key_epoch == ledger.trust_epoch
            });
        if grant_id != &grant.grant_id
            || grant.expires_at_unix_ms <= grant.approved_at_unix_ms
            || grant.trust_epoch > ledger.trust_epoch
            || !ledger.sessions.contains_key(&grant.approved_by_session_id)
            || (grant.status == RecordStatus::Active
                && (grant.trust_epoch != ledger.trust_epoch
                    || grant.revoked_at_unix_ms.is_some()
                    || !target_is_active))
            || (grant.status == RecordStatus::Revoked && grant.revoked_at_unix_ms.is_none())
        {
            return Err(IdentityError::InvalidRecord("invalid grant record"));
        }
    }
    if ledger.recovery_codes.len() > config.max_recovery_codes
        || ledger.recovery_codes.iter().any(|record| {
            record.code_id.is_empty()
                || PasswordHash::new(&record.argon2id_hash)
                    .map_or(true, |hash| hash.algorithm.as_str() != "argon2id")
        })
    {
        return Err(IdentityError::InvalidRecord("invalid recovery-code record"));
    }
    if ledger
        .passkey_registration_permit
        .as_ref()
        .is_some_and(|permit| {
            permit.trust_epoch != ledger.trust_epoch
                || permit.secret_hash.len() != 64
                || !permit
                    .secret_hash
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err(IdentityError::InvalidRecord(
            "invalid passkey registration permit",
        ));
    }
    Ok(())
}

fn validate_scope(scope: &CapabilityScope) -> Result<(), IdentityError> {
    validate_identifier(&scope.capability_id, "capability id")?;
    validate_identifier(&scope.target_device_id, "target device id")?;
    if scope.allowed_actions.is_empty()
        || scope.allowed_actions.len() > 32
        || scope.resource_ids.len() > 256
    {
        return Err(IdentityError::InvalidGrant("scope is empty or too broad"));
    }
    if scope
        .allowed_actions
        .iter()
        .chain(scope.resource_ids.iter())
        .any(|item| item.is_empty() || item.len() > 256 || item == "*" || item.contains('\0'))
    {
        return Err(IdentityError::InvalidGrant(
            "scope contains an invalid value",
        ));
    }
    Ok(())
}

fn validate_identifier(value: &str, field: &'static str) -> Result<(), IdentityError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(IdentityError::InvalidRecord(field));
    }
    Ok(())
}

fn validate_label(value: &str, field: &'static str) -> Result<(), IdentityError> {
    if value.trim().is_empty() || value.len() > 256 || value.contains('\0') {
        return Err(IdentityError::InvalidRecord(field));
    }
    Ok(())
}

fn checked_expiry(now_unix_ms: u64, ttl_ms: u64) -> Result<u64, IdentityError> {
    now_unix_ms
        .checked_add(ttl_ms)
        .ok_or(IdentityError::InvalidRecord("timestamp overflow"))
}

fn random_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4().simple())
}

fn random_secret() -> String {
    OsRng
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

fn secret_hash(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

fn recovery_code() -> String {
    let random = OsRng
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect::<String>()
        .to_ascii_uppercase();
    format!(
        "HII-{}-{}-{}-{}",
        &random[0..8],
        &random[8..16],
        &random[16..24],
        &random[24..32]
    )
}

fn fingerprint(public_key: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(public_key)))
}

fn encode_credential_id(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn revoke_active_devices(devices: &mut BTreeMap<DeviceId, DeviceRecord>, now: u64) -> usize {
    let mut count = 0;
    for record in devices.values_mut() {
        if record.status == RecordStatus::Active {
            record.status = RecordStatus::Revoked;
            record.revoked_at_unix_ms = Some(now);
            count += 1;
        }
    }
    count
}

fn revoke_active_sessions(
    sessions: &mut BTreeMap<SessionId, AuthenticationSession>,
    now: u64,
) -> usize {
    let mut count = 0;
    for record in sessions.values_mut() {
        if record.status == RecordStatus::Active {
            record.status = RecordStatus::Revoked;
            record.revoked_at_unix_ms = Some(now);
            count += 1;
        }
    }
    count
}

fn revoke_active_grants(grants: &mut BTreeMap<String, StandingCapabilityGrant>, now: u64) -> usize {
    let mut count = 0;
    for record in grants.values_mut() {
        if record.status == RecordStatus::Active {
            record.status = RecordStatus::Revoked;
            record.revoked_at_unix_ms = Some(now);
            count += 1;
        }
    }
    count
}

fn revoke_active_passkeys(passkeys: &mut BTreeMap<String, PasskeyRecord>, now: u64) -> usize {
    let mut count = 0;
    for record in passkeys.values_mut() {
        if record.status == RecordStatus::Active {
            record.status = RecordStatus::Revoked;
            record.revoked_at_unix_ms = Some(now);
            count += 1;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_700_000_000_000;

    fn config() -> IdentityConfig {
        let mut config = IdentityConfig::new(
            "humaninformationinterface.com",
            Url::parse("https://app.humaninformationinterface.com").unwrap(),
        );
        config.challenge_ttl_ms = 1_000;
        config.enrollment_ttl_ms = 1_000;
        config.max_pending_ceremonies = 1;
        config
    }

    fn device(id: &str, seed: u8) -> DeviceKeySubmission {
        DeviceKeySubmission {
            device_id: id.into(),
            display_name: id.into(),
            signing_public_key: vec![seed; 32],
            encryption_public_key: vec![seed + 1; 32],
        }
    }

    fn authority() -> (IdentityAuthority, BootstrapMaterial) {
        IdentityAuthority::bootstrap(config(), "owner-1", "Ummi", device("mac", 1), 2, NOW).unwrap()
    }

    #[test]
    fn creates_bounded_registration_ceremony_and_never_authenticates_without_assertion() {
        let (mut authority, material) = authority();
        assert!(matches!(
            authority.start_passkey_registration(None, "ummi", NOW),
            Err(IdentityError::AuthenticationRequired)
        ));
        let ceremony = authority
            .start_passkey_registration(Some(&material.passkey_registration_secret), "ummi", NOW)
            .unwrap();
        assert!(ceremony.expires_at_unix_ms > NOW);
        assert!(matches!(
            authority.start_passkey_registration(
                Some(&material.passkey_registration_secret),
                "ummi",
                NOW
            ),
            Err(IdentityError::BoundExceeded("pending registrations"))
        ));
        assert!(matches!(
            authority.start_authentication(NOW),
            Err(IdentityError::NoPasskeys)
        ));
        authority.purge_expired(NOW + 1_000);
        assert!(authority.registrations.is_empty());
        assert!(authority.ledger.sessions.is_empty());
    }

    #[test]
    fn enrollment_is_bound_to_fingerprints_and_requires_verified_session() {
        let (mut authority, _) = authority();
        let proposal = authority.propose_device(device("pc", 4), NOW).unwrap();
        assert!(matches!(
            authority.approve_device(
                &proposal.proposal_id,
                "missing",
                &proposal.signing_key_fingerprint,
                &proposal.encryption_key_fingerprint,
                NOW
            ),
            Err(IdentityError::AuthenticationRequired)
        ));
        let session = authority.insert_verified_session_for_test(NOW);
        assert!(matches!(
            authority.approve_device(
                &proposal.proposal_id,
                &session.session_id,
                "sha256:substituted",
                &proposal.encryption_key_fingerprint,
                NOW
            ),
            Err(IdentityError::FingerprintMismatch)
        ));
        assert!(!authority.ledger.devices.contains_key("pc"));

        let proposal = authority.propose_device(device("pc", 4), NOW).unwrap();
        let enrolled = authority
            .approve_device(
                &proposal.proposal_id,
                &session.session_id,
                &proposal.signing_key_fingerprint,
                &proposal.encryption_key_fingerprint,
                NOW,
            )
            .unwrap();
        assert_eq!(
            enrolled.signing_key_fingerprint,
            proposal.signing_key_fingerprint
        );
        assert_eq!(enrolled.key_epoch, 1);
    }

    #[test]
    fn grant_scope_is_exact_and_device_revocation_closes_it() {
        let (mut authority, _) = authority();
        let session = authority.insert_verified_session_for_test(NOW);
        let scope = CapabilityScope {
            capability_id: "system.observe".into(),
            target_device_id: "mac".into(),
            resource_ids: BTreeSet::from(["workspace:hii".into()]),
            allowed_actions: BTreeSet::from(["read".into()]),
        };
        authority
            .approve_grant("grant-1", scope, &session.session_id, NOW + 10_000, NOW)
            .unwrap();
        assert!(authority.grant_allows(
            "grant-1",
            "system.observe",
            "mac",
            "read",
            Some("workspace:hii"),
            NOW
        ));
        assert!(!authority.grant_allows(
            "grant-1",
            "system.observe",
            "mac",
            "write",
            Some("workspace:hii"),
            NOW
        ));
        assert!(!authority.grant_allows("grant-1", "system.observe", "mac", "read", None, NOW));
        authority
            .revoke_device("mac", &session.session_id, NOW + 1)
            .unwrap();
        assert!(!authority.grant_allows(
            "grant-1",
            "system.observe",
            "mac",
            "read",
            Some("workspace:hii"),
            NOW + 1
        ));
    }

    #[test]
    fn recovery_is_one_time_and_rotates_all_authority() {
        let (mut authority, material) = authority();
        let session = authority.insert_verified_session_for_test(NOW);
        authority
            .approve_grant(
                "grant-1",
                CapabilityScope {
                    capability_id: "system.observe".into(),
                    target_device_id: "mac".into(),
                    resource_ids: BTreeSet::new(),
                    allowed_actions: BTreeSet::from(["read".into()]),
                },
                &session.session_id,
                NOW + 10_000,
                NOW,
            )
            .unwrap();
        let outcome = authority
            .recover(&material.recovery_codes[0], device("phone", 8), NOW + 2)
            .unwrap();
        assert_eq!(outcome.new_trust_epoch, 2);
        assert_eq!(outcome.revoked_devices, 1);
        assert_eq!(outcome.revoked_sessions, 1);
        assert_eq!(outcome.revoked_grants, 1);
        assert_eq!(outcome.revoked_passkeys, 0);
        assert_eq!(
            authority.ledger.devices["phone"].status,
            RecordStatus::Active
        );
        assert_eq!(authority.ledger.devices["phone"].key_epoch, 2);
        assert!(matches!(
            authority.recover(&material.recovery_codes[0], device("other", 12), NOW + 3),
            Err(IdentityError::RecoveryCodeInvalid)
        ));
        assert!(authority
            .start_passkey_registration(Some(&outcome.passkey_registration_secret), "ummi", NOW + 3)
            .is_ok());
    }

    #[test]
    fn serialized_ledger_contains_hashes_and_public_keys_but_no_plaintext_recovery_code() {
        let (authority, material) = authority();
        let json = serde_json::to_string(authority.ledger()).unwrap();
        assert!(json.contains("argon2id"));
        assert!(json.contains("signingPublicKey"));
        assert!(!json.contains(&material.recovery_codes[0]));
        assert!(!json.contains(&material.passkey_registration_secret));
        assert!(!json.contains("privateKey"));
        let restored: TrustLedger = serde_json::from_str(&json).unwrap();
        IdentityAuthority::from_ledger(config(), restored).unwrap();
    }

    #[test]
    fn recovery_rotation_requires_authentication_and_ledger_restore_fails_closed() {
        let (mut authority, _) = authority();
        assert!(matches!(
            authority.rotate_recovery_codes("missing", 1, NOW),
            Err(IdentityError::AuthenticationRequired)
        ));

        let mut tampered = authority.ledger().clone();
        tampered
            .devices
            .get_mut("mac")
            .unwrap()
            .signing_key_fingerprint = "sha256:fake".into();
        assert!(matches!(
            IdentityAuthority::from_ledger(config(), tampered),
            Err(IdentityError::InvalidRecord("invalid device record"))
        ));

        let mut stale = authority.ledger().clone();
        stale.trust_epoch += 1;
        assert!(matches!(
            IdentityAuthority::from_ledger(config(), stale),
            Err(IdentityError::InvalidRecord(_))
        ));
    }

    #[test]
    fn refuses_insecure_or_cross_site_webauthn_configuration() {
        let insecure = IdentityConfig::new(
            "humaninformationinterface.com",
            Url::parse("http://app.humaninformationinterface.com").unwrap(),
        );
        assert!(matches!(
            insecure.validate(),
            Err(IdentityError::InvalidConfig(_))
        ));
        let cross_site = IdentityConfig::new(
            "example.com",
            Url::parse("https://app.humaninformationinterface.com").unwrap(),
        );
        assert!(matches!(
            cross_site.validate(),
            Err(IdentityError::InvalidConfig(_))
        ));
    }
}
