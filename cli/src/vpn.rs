// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! HII-account-bound local control state for the private machine fabric.
//!
//! This module owns no public relay and never claims connectivity on the basis
//! of configuration alone. It creates the local WireGuard-compatible device
//! identity and a signed public mesh profile. A later transport adapter must
//! prove handshakes before promoting the mesh to `active`.

use crate::{config::AppPaths, identity::IdentityStore};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{DateTime, Utc};
use ring::{
    digest::{digest, SHA256},
    rand::{SecureRandom, SystemRandom},
    signature::{UnparsedPublicKey, ED25519},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroize;

const SCHEMA_VERSION: u16 = 1;
const KIND: &str = "hii.vpn.mesh/1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeshPhase {
    LocalReady,
    EndpointConfigured,
    Active,
    Revoked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceStatus {
    LocalReady,
    Pending,
    Active,
    Revoked,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnDevice {
    pub device_id: String,
    pub display_name: String,
    pub platform: String,
    pub ipv4: String,
    pub ipv6: String,
    pub wireguard_public_key: String,
    pub endpoint: Option<String>,
    pub status: DeviceStatus,
    pub last_verified_handshake_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnMeshState {
    pub schema_version: u16,
    pub kind: String,
    pub mesh_id: String,
    pub account_id: String,
    pub owner_signing_public_key: String,
    pub trust_epoch: u64,
    pub phase: MeshPhase,
    pub ipv4_pool: String,
    pub ipv6_pool: String,
    pub dns_zone: String,
    pub local_device: VpnDevice,
    pub peers: Vec<VpnDevice>,
    pub relay_endpoint: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub account_signature: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnStatus {
    pub initialized: bool,
    pub account_id: Option<String>,
    pub mesh_id: Option<String>,
    pub phase: Option<MeshPhase>,
    pub local_device: Option<VpnDevice>,
    pub peer_count: usize,
    pub control_plane_ready: bool,
    pub data_plane_live: bool,
    pub relay_configured: bool,
    pub reasons: Vec<String>,
    pub next: String,
}

pub struct VpnStore {
    root: PathBuf,
}

impl VpnStore {
    pub fn open(paths: &AppPaths) -> Self {
        Self {
            root: paths.runtime.join("vpn"),
        }
    }

    pub fn state_path(&self) -> PathBuf {
        self.root.join("mesh.json")
    }

    pub fn private_key_path(&self) -> PathBuf {
        self.root.join("private").join("wireguard.key")
    }

    pub fn init(
        &self,
        identity: &IdentityStore,
        device_id: &str,
        display_name: &str,
    ) -> Result<VpnMeshState, String> {
        let account = identity.current()?.ok_or(
            "No local HII account. Run `hii login local --name <name>` before initializing HII Link.",
        )?;
        if self.state_path().is_file() {
            let existing = self.load(identity)?;
            if existing.account_id != account.id {
                return Err("The existing HII VPN belongs to a different HII account.".into());
            }
            return Ok(existing);
        }
        validate_device_id(device_id)?;
        let display_name = display_name.trim();
        if display_name.chars().count() < 2 || display_name.chars().count() > 80 {
            return Err("HII VPN device names must contain 2 to 80 characters.".into());
        }

        ensure_private_dir(&self.root)?;
        let mut key_bytes = generate_private_key()?;
        let public_key = PublicKey::from(&StaticSecret::from(key_bytes));
        let mut encoded_key = BASE64.encode(key_bytes);
        write_private(
            &self.private_key_path(),
            format!("{encoded_key}\n").as_bytes(),
        )?;
        encoded_key.zeroize();
        key_bytes.zeroize();

        let mesh_id = format!("mesh-{}", Uuid::new_v4());
        let addressing = mesh_addressing(&mesh_id);
        let now = Utc::now();
        let mut state = VpnMeshState {
            schema_version: SCHEMA_VERSION,
            kind: KIND.into(),
            mesh_id,
            account_id: account.id,
            owner_signing_public_key: identity.signing_public_key()?,
            trust_epoch: 1,
            phase: MeshPhase::LocalReady,
            ipv4_pool: addressing.ipv4_pool,
            ipv6_pool: addressing.ipv6_pool,
            dns_zone: "hii.internal".into(),
            local_device: VpnDevice {
                device_id: device_id.into(),
                display_name: display_name.into(),
                platform: std::env::consts::OS.into(),
                ipv4: addressing.local_ipv4,
                ipv6: addressing.local_ipv6,
                wireguard_public_key: BASE64.encode(public_key.as_bytes()),
                endpoint: None,
                status: DeviceStatus::LocalReady,
                last_verified_handshake_at: None,
            },
            peers: Vec::new(),
            relay_endpoint: None,
            created_at: now,
            updated_at: now,
            account_signature: String::new(),
        };
        sign_state(identity, &mut state)?;
        write_private_json(&self.state_path(), &state)?;
        self.load(identity)
    }

    pub fn load(&self, identity: &IdentityStore) -> Result<VpnMeshState, String> {
        let account = identity
            .current()?
            .ok_or("The local HII account is unavailable.")?;
        let raw = fs::read_to_string(self.state_path())
            .map_err(|error| format!("failed to read HII VPN state: {error}"))?;
        let state: VpnMeshState = serde_json::from_str(&raw)
            .map_err(|error| format!("failed to parse HII VPN state: {error}"))?;
        validate_state(&state)?;
        if state.account_id != account.id {
            return Err("The HII VPN state is bound to a different HII account.".into());
        }
        if state.owner_signing_public_key != identity.signing_public_key()? {
            return Err("The HII VPN state is not signed by the current HII account key.".into());
        }
        verify_state_signature(&state)?;
        ensure_owner_only(&self.state_path())?;
        ensure_owner_only(&self.private_key_path())?;
        verify_private_key_binding(&self.private_key_path(), &state.local_device)?;
        Ok(state)
    }

    pub fn status(&self, identity: &IdentityStore) -> Result<VpnStatus, String> {
        if !self.state_path().is_file() {
            return Ok(VpnStatus {
                initialized: false,
                account_id: identity.current()?.map(|value| value.id),
                mesh_id: None,
                phase: None,
                local_device: None,
                peer_count: 0,
                control_plane_ready: false,
                data_plane_live: false,
                relay_configured: false,
                reasons: vec!["No local HII VPN mesh has been initialized.".into()],
                next: "hii link init".into(),
            });
        }
        let state = self.load(identity)?;
        let data_plane_live = state.phase == MeshPhase::Active
            && state.local_device.last_verified_handshake_at.is_some();
        let mut reasons = Vec::new();
        if !data_plane_live {
            reasons.push("No verified WireGuard handshake has been recorded.".into());
        }
        if state.relay_endpoint.is_none() {
            reasons.push("No public coordination or relay endpoint is configured.".into());
        }
        Ok(VpnStatus {
            initialized: true,
            account_id: Some(state.account_id.clone()),
            mesh_id: Some(state.mesh_id.clone()),
            phase: Some(state.phase.clone()),
            local_device: Some(state.local_device.clone()),
            peer_count: state.peers.len(),
            control_plane_ready: state.phase != MeshPhase::Revoked,
            data_plane_live,
            relay_configured: state.relay_endpoint.is_some(),
            reasons,
            next: "Configure a stable HII relay, enroll a second device, then prove a handshake."
                .into(),
        })
    }
}

fn sign_state(identity: &IdentityStore, state: &mut VpnMeshState) -> Result<(), String> {
    state.account_signature.clear();
    let payload = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    let signed = identity.sign_bytes(&payload)?;
    if signed.public_key != state.owner_signing_public_key {
        return Err("The HII account signing key changed during VPN initialization.".into());
    }
    state.account_signature = signed.signature;
    Ok(())
}

fn verify_state_signature(state: &VpnMeshState) -> Result<(), String> {
    let signature = BASE64
        .decode(&state.account_signature)
        .map_err(|_| "The HII VPN account signature is invalid.".to_string())?;
    let public_key = BASE64
        .decode(&state.owner_signing_public_key)
        .map_err(|_| "The HII VPN account public key is invalid.".to_string())?;
    let mut unsigned = state.clone();
    unsigned.account_signature.clear();
    let payload = serde_json::to_vec(&unsigned).map_err(|error| error.to_string())?;
    UnparsedPublicKey::new(&ED25519, public_key)
        .verify(&payload, &signature)
        .map_err(|_| "The HII VPN state failed account-signature verification.".into())
}

fn validate_state(state: &VpnMeshState) -> Result<(), String> {
    if state.schema_version != SCHEMA_VERSION || state.kind != KIND {
        return Err("Unsupported HII VPN state version.".into());
    }
    if !state.mesh_id.starts_with("mesh-") || !state.account_id.starts_with("hii-user-") {
        return Err("The HII VPN account or mesh identifier is invalid.".into());
    }
    validate_device_id(&state.local_device.device_id)?;
    if BASE64
        .decode(&state.local_device.wireguard_public_key)
        .map_or(true, |key| key.len() != 32)
    {
        return Err("The HII VPN WireGuard public key is invalid.".into());
    }
    Ok(())
}

fn verify_private_key_binding(path: &Path, device: &VpnDevice) -> Result<(), String> {
    let encoded = fs::read_to_string(path)
        .map_err(|error| format!("failed to read HII VPN private key: {error}"))?;
    let decoded = BASE64
        .decode(encoded.trim())
        .map_err(|_| "The HII VPN private key is invalid.".to_string())?;
    let mut private_key: [u8; 32] = decoded
        .try_into()
        .map_err(|_| "The HII VPN private key is invalid.".to_string())?;
    let public_key = PublicKey::from(&StaticSecret::from(private_key));
    private_key.zeroize();
    if BASE64.encode(public_key.as_bytes()) != device.wireguard_public_key {
        return Err(
            "The HII VPN private key does not match the account-bound device profile.".into(),
        );
    }
    Ok(())
}

fn validate_device_id(value: &str) -> Result<(), String> {
    if value.len() < 2
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        || value.starts_with('-')
        || value.ends_with('-')
    {
        return Err(
            "HII VPN device IDs use 2 to 64 lowercase letters, digits, or interior hyphens.".into(),
        );
    }
    Ok(())
}

fn generate_private_key() -> Result<[u8; 32], String> {
    let mut key = [0_u8; 32];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "Could not generate the HII VPN device key.".to_string())?;
    Ok(key)
}

struct MeshAddressing {
    ipv4_pool: String,
    ipv6_pool: String,
    local_ipv4: String,
    local_ipv6: String,
}

fn mesh_addressing(mesh_id: &str) -> MeshAddressing {
    let hash = digest(&SHA256, mesh_id.as_bytes());
    let bytes = hash.as_ref();
    let second = 64 + (bytes[0] % 64);
    let third = bytes[1];
    let ula = format!(
        "fd{:02x}:{:02x}{:02x}:{:02x}{:02x}",
        bytes[2], bytes[3], bytes[4], bytes[5], bytes[6]
    );
    MeshAddressing {
        ipv4_pool: format!("10.{second}.{third}.0/24"),
        ipv6_pool: format!("{ula}::/48"),
        local_ipv4: format!("10.{second}.{third}.1/32"),
        local_ipv6: format!("{ula}::1/128"),
    }
}

fn ensure_private_dir(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root.join("private")).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
        fs::set_permissions(root.join("private"), fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("HII VPN path has no parent directory.")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".vpn-{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| error.to_string())?;
    Ok(())
}

fn write_private_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let mut bytes = raw;
    bytes.push(b'\n');
    write_private(path, &bytes)
}

fn ensure_owner_only(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!(
            "Required HII VPN file is missing: {}",
            path.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(path)
            .map_err(|error| error.to_string())?
            .permissions()
            .mode()
            & 0o077
            != 0
        {
            return Err(format!(
                "HII VPN file is not owner-only: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            static COUNT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "hii-vpn-test-{}-{label}-{}",
                std::process::id(),
                COUNT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture(label: &str) -> (TempDir, AppPaths, IdentityStore, VpnStore) {
        let temp = TempDir::new(label);
        let paths = AppPaths {
            repo: temp.0.join("repo"),
            runtime: temp.0.join("runtime"),
        };
        let identity = IdentityStore::open(&paths);
        identity.create_or_update("Ummi", None).unwrap();
        let vpn = VpnStore::open(&paths);
        (temp, paths, identity, vpn)
    }

    #[test]
    fn init_binds_wireguard_identity_to_the_hii_account() {
        let (_temp, _paths, identity, vpn) = fixture("init");
        let account = identity.current().unwrap().unwrap();
        let state = vpn.init(&identity, "ummi-mac", "Ummi Mac").unwrap();
        assert_eq!(state.account_id, account.id);
        assert_eq!(state.phase, MeshPhase::LocalReady);
        assert_eq!(
            BASE64
                .decode(&state.local_device.wireguard_public_key)
                .unwrap()
                .len(),
            32
        );
        assert!(!state.account_signature.is_empty());
        assert!(!serde_json::to_string(&state)
            .unwrap()
            .contains("wireguard.key"));
        assert!(!serde_json::to_string(&state)
            .unwrap()
            .contains("privateKey"));
        assert_eq!(vpn.load(&identity).unwrap().mesh_id, state.mesh_id);
    }

    #[test]
    fn status_refuses_to_claim_a_live_data_plane_without_a_handshake() {
        let (_temp, _paths, identity, vpn) = fixture("status");
        vpn.init(&identity, "ummi-mac", "Ummi Mac").unwrap();
        let status = vpn.status(&identity).unwrap();
        assert!(status.control_plane_ready);
        assert!(!status.data_plane_live);
        assert!(!status.relay_configured);
        assert!(status
            .reasons
            .iter()
            .any(|reason| reason.contains("handshake")));
    }

    #[test]
    fn tampering_with_public_state_breaks_the_hii_account_signature() {
        let (_temp, _paths, identity, vpn) = fixture("tamper");
        let mut state = vpn.init(&identity, "ummi-mac", "Ummi Mac").unwrap();
        state.local_device.display_name = "Mallory Mac".into();
        write_private_json(&vpn.state_path(), &state).unwrap();
        assert!(vpn.load(&identity).unwrap_err().contains("signature"));
    }

    #[test]
    fn state_must_remain_bound_to_the_current_hii_account_key() {
        let (_temp, _paths, identity, vpn) = fixture("account-key");
        vpn.init(&identity, "ummi-mac", "Ummi Mac").unwrap();
        fs::remove_file(identity.path().with_file_name("contact-ed25519.pkcs8")).unwrap();
        assert!(vpn
            .load(&identity)
            .unwrap_err()
            .contains("current HII account key"));
    }

    #[test]
    fn private_key_must_match_the_signed_public_device_profile() {
        let (_temp, _paths, identity, vpn) = fixture("private-key");
        vpn.init(&identity, "ummi-mac", "Ummi Mac").unwrap();
        write_private(
            &vpn.private_key_path(),
            format!("{}\n", BASE64.encode([7_u8; 32])).as_bytes(),
        )
        .unwrap();
        assert!(vpn.load(&identity).unwrap_err().contains("does not match"));
    }

    #[cfg(unix)]
    #[test]
    fn private_material_and_state_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let (_temp, _paths, identity, vpn) = fixture("permissions");
        vpn.init(&identity, "ummi-mac", "Ummi Mac").unwrap();
        assert_eq!(
            fs::metadata(vpn.state_path()).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(vpn.private_key_path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
