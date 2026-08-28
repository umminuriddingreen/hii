// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! HII-account-bound local control state for the private machine fabric.
//!
//! This module owns no public relay and never claims connectivity on the basis
//! of configuration alone. It creates the local WireGuard-compatible device
//! identity, signs the public mesh profile with the HII account, and delegates
//! tunnel activation and observation to the native WireGuard runtime.

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
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use uuid::Uuid;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroize;

const SCHEMA_VERSION: u16 = 1;
const KIND: &str = "hii.vpn.mesh/1";
const NATIVE_INTERFACE: &str = "hii0";

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
    #[serde(rename = "nativeWireGuard")]
    pub native_wireguard: NativeWireGuardStatus,
    pub reasons: Vec<String>,
    pub next: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWireGuardStatus {
    pub backend: String,
    pub available: bool,
    pub config_ready: bool,
    pub active: bool,
    pub interface_name: String,
    pub latest_handshake_at: Option<DateTime<Utc>>,
    pub received_bytes: u64,
    pub sent_bytes: u64,
    pub detail: String,
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

    pub fn native_config_path(&self) -> PathBuf {
        self.root
            .join("private")
            .join(format!("{NATIVE_INTERFACE}.conf"))
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
        let native_wireguard = self.native_status();
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
                native_wireguard,
                reasons: vec!["No local HII VPN mesh has been initialized.".into()],
                next: "hii link init".into(),
            });
        }
        let state = self.load(identity)?;
        let data_plane_live = native_wireguard.active
            && native_wireguard.latest_handshake_at.is_some()
            && !state.peers.is_empty();
        let mut reasons = Vec::new();
        if !native_wireguard.available {
            reasons.push("The native WireGuard runtime is not installed.".into());
        } else if !native_wireguard.config_ready {
            reasons.push("The native WireGuard configuration has not been prepared.".into());
        } else if !native_wireguard.active {
            reasons.push(format!(
                "The native WireGuard interface {NATIVE_INTERFACE} is not active."
            ));
        } else if native_wireguard.latest_handshake_at.is_none() {
            reasons.push("WireGuard is active but no peer handshake has been observed.".into());
        }
        if state.peers.is_empty() {
            reasons.push("No WireGuard peer has been enrolled in this HII mesh.".into());
        }
        let next = if !native_wireguard.available {
            native_install_hint().into()
        } else if !native_wireguard.config_ready {
            "hii link prepare".into()
        } else if state.peers.is_empty() {
            "Enroll a second HII device before activating the tunnel.".into()
        } else if !native_wireguard.active {
            "hii link up".into()
        } else if native_wireguard.latest_handshake_at.is_none() {
            "Verify the peer endpoint and wait for a native WireGuard handshake.".into()
        } else {
            "Native WireGuard is carrying the HII device mesh.".into()
        };
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
            native_wireguard,
            reasons,
            next,
        })
    }

    pub fn prepare_native(
        &self,
        identity: &IdentityStore,
    ) -> Result<NativeWireGuardStatus, String> {
        let state = self.load(identity)?;
        let mut key = fs::read_to_string(self.private_key_path())
            .map_err(|error| format!("failed to read HII VPN private key: {error}"))?;
        let mut config = render_native_config(&state, key.trim());
        write_private(&self.native_config_path(), config.as_bytes())?;
        key.zeroize();
        config.zeroize();
        ensure_owner_only(&self.native_config_path())?;
        Ok(self.native_status())
    }

    pub fn native_up(&self, identity: &IdentityStore) -> Result<NativeWireGuardStatus, String> {
        let state = self.load(identity)?;
        if state.peers.is_empty() {
            return Err("Enroll a second HII device before activating WireGuard.".into());
        }
        if !self.native_config_path().is_file() {
            self.prepare_native(identity)?;
        }
        self.run_native_action(true)?;
        Ok(self.native_status())
    }

    pub fn native_down(&self) -> Result<NativeWireGuardStatus, String> {
        self.run_native_action(false)?;
        Ok(self.native_status())
    }

    pub fn native_status(&self) -> NativeWireGuardStatus {
        let runtime = NativeRuntime::detect();
        let config_ready = self.native_config_path().is_file();
        let Some(wg) = runtime.wg.as_ref() else {
            return NativeWireGuardStatus {
                backend: runtime.backend.into(),
                available: false,
                config_ready,
                active: false,
                interface_name: NATIVE_INTERFACE.into(),
                latest_handshake_at: None,
                received_bytes: 0,
                sent_bytes: 0,
                detail: native_install_hint().into(),
            };
        };
        if runtime.control.is_none() {
            return NativeWireGuardStatus {
                backend: runtime.backend.into(),
                available: false,
                config_ready,
                active: false,
                interface_name: NATIVE_INTERFACE.into(),
                latest_handshake_at: None,
                received_bytes: 0,
                sent_bytes: 0,
                detail: "WireGuard inspection is available, but its native tunnel controller is missing."
                    .into(),
            };
        }
        match Command::new(wg)
            .args(["show", NATIVE_INTERFACE, "dump"])
            .output()
        {
            Ok(output) if output.status.success() => {
                let dump = String::from_utf8_lossy(&output.stdout);
                let observed = parse_wg_dump(&dump);
                NativeWireGuardStatus {
                    backend: runtime.backend.into(),
                    available: true,
                    config_ready,
                    active: true,
                    interface_name: NATIVE_INTERFACE.into(),
                    latest_handshake_at: observed.latest_handshake_at,
                    received_bytes: observed.received_bytes,
                    sent_bytes: observed.sent_bytes,
                    detail: "Native WireGuard interface is active.".into(),
                }
            }
            Ok(_) => NativeWireGuardStatus {
                backend: runtime.backend.into(),
                available: true,
                config_ready,
                active: false,
                interface_name: NATIVE_INTERFACE.into(),
                latest_handshake_at: None,
                received_bytes: 0,
                sent_bytes: 0,
                detail: "Native WireGuard is installed; the HII interface is inactive.".into(),
            },
            Err(error) => NativeWireGuardStatus {
                backend: runtime.backend.into(),
                available: false,
                config_ready,
                active: false,
                interface_name: NATIVE_INTERFACE.into(),
                latest_handshake_at: None,
                received_bytes: 0,
                sent_bytes: 0,
                detail: format!("Could not inspect native WireGuard: {error}"),
            },
        }
    }

    fn run_native_action(&self, up: bool) -> Result<(), String> {
        let runtime = NativeRuntime::detect();
        let control = runtime
            .control
            .ok_or_else(|| native_install_hint().to_string())?;
        let mut command = Command::new(control);
        command.args(native_action_arguments(
            runtime.platform,
            up,
            &self.native_config_path(),
        ));
        let output = command
            .output()
            .map_err(|error| format!("failed to start native WireGuard: {error}"))?;
        if output.status.success() {
            return Ok(());
        }
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail
            .lines()
            .last()
            .unwrap_or("native WireGuard command failed");
        Err(format!("native WireGuard command failed: {detail}"))
    }
}

struct NativeRuntime {
    backend: &'static str,
    platform: NativePlatform,
    wg: Option<PathBuf>,
    control: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativePlatform {
    WgQuick,
    #[cfg(any(windows, test))]
    WindowsService,
}

impl NativeRuntime {
    fn detect() -> Self {
        #[cfg(windows)]
        {
            let install = env::var_os("ProgramFiles")
                .map(PathBuf::from)
                .map(|path| path.join("WireGuard"));
            let wg = install
                .as_ref()
                .map(|path| path.join("wg.exe"))
                .filter(|path| path.is_file())
                .or_else(|| find_executable("wg.exe"));
            let control = install
                .map(|path| path.join("wireguard.exe"))
                .filter(|path| path.is_file())
                .or_else(|| find_executable("wireguard.exe"));
            Self {
                backend: "wireguard_windows",
                platform: NativePlatform::WindowsService,
                wg,
                control,
            }
        }
        #[cfg(not(windows))]
        {
            Self {
                backend: "wg_quick",
                platform: NativePlatform::WgQuick,
                wg: find_executable("wg"),
                control: find_executable("wg-quick"),
            }
        }
    }
}

fn native_action_arguments(platform: NativePlatform, up: bool, config: &Path) -> Vec<OsString> {
    match (platform, up) {
        (NativePlatform::WgQuick, true) => vec!["up".into(), config.as_os_str().into()],
        (NativePlatform::WgQuick, false) => vec!["down".into(), config.as_os_str().into()],
        #[cfg(any(windows, test))]
        (NativePlatform::WindowsService, true) => {
            vec!["/installtunnelservice".into(), config.as_os_str().into()]
        }
        #[cfg(any(windows, test))]
        (NativePlatform::WindowsService, false) => {
            vec!["/uninstalltunnelservice".into(), NATIVE_INTERFACE.into()]
        }
    }
}

fn find_executable(name: &str) -> Option<PathBuf> {
    env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
}

fn native_install_hint() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Install native WireGuard with `brew install wireguard-tools`."
    }
    #[cfg(windows)]
    {
        "Install the official WireGuard for Windows application."
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "Install your platform's wireguard-tools package."
    }
}

fn render_native_config(state: &VpnMeshState, private_key: &str) -> String {
    let mut config = format!(
        "# Managed locally by HII for account {}\n[Interface]\nPrivateKey = {}\nAddress = {}, {}\n",
        state.account_id, private_key, state.local_device.ipv4, state.local_device.ipv6
    );
    for peer in &state.peers {
        config.push_str("\n[Peer]\n");
        config.push_str(&format!("PublicKey = {}\n", peer.wireguard_public_key));
        config.push_str(&format!("AllowedIPs = {}, {}\n", peer.ipv4, peer.ipv6));
        if let Some(endpoint) = &peer.endpoint {
            config.push_str(&format!(
                "Endpoint = {endpoint}\nPersistentKeepalive = 25\n"
            ));
        }
    }
    config
}

#[derive(Default)]
struct NativeObservation {
    latest_handshake_at: Option<DateTime<Utc>>,
    received_bytes: u64,
    sent_bytes: u64,
}

fn parse_wg_dump(raw: &str) -> NativeObservation {
    let mut observation = NativeObservation::default();
    for line in raw.lines().skip(1) {
        let fields = line.split('\t').collect::<Vec<_>>();
        if fields.len() < 7 {
            continue;
        }
        if let Ok(timestamp) = fields[4].parse::<i64>() {
            if timestamp > 0 {
                let candidate = DateTime::<Utc>::from_timestamp(timestamp, 0);
                if candidate > observation.latest_handshake_at {
                    observation.latest_handshake_at = candidate;
                }
            }
        }
        observation.received_bytes = observation
            .received_bytes
            .saturating_add(fields[5].parse().unwrap_or(0));
        observation.sent_bytes = observation
            .sent_bytes
            .saturating_add(fields[6].parse().unwrap_or(0));
    }
    observation
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
            .any(|reason| reason.contains("peer") || reason.contains("handshake")));
    }

    #[test]
    fn native_config_is_owner_only_and_uses_the_signed_mesh_identity() {
        let (_temp, _paths, identity, vpn) = fixture("native-config");
        let state = vpn.init(&identity, "ummi-mac", "Ummi Mac").unwrap();
        let native = vpn.prepare_native(&identity).unwrap();
        let config = fs::read_to_string(vpn.native_config_path()).unwrap();
        assert!(native.config_ready);
        assert!(config.contains("[Interface]"));
        assert!(config.contains(&format!(
            "Address = {}, {}",
            state.local_device.ipv4, state.local_device.ipv6
        )));
        assert!(!config.contains(&state.owner_signing_public_key));
        assert!(!config.contains(&state.account_signature));
    }

    #[test]
    fn native_activation_requires_an_enrolled_peer() {
        let (_temp, _paths, identity, vpn) = fixture("native-up");
        vpn.init(&identity, "ummi-mac", "Ummi Mac").unwrap();
        assert!(vpn
            .native_up(&identity)
            .unwrap_err()
            .contains("second HII device"));
    }

    #[test]
    fn wireguard_dump_reports_real_handshake_and_transfer_evidence() {
        let observed = parse_wg_dump(
            "private\tpublic\t51820\toff\npeer\tpreshared\t198.51.100.2:51820\t10.80.0.2/32\t1720000000\t4096\t8192\t25\n",
        );
        assert_eq!(
            observed.latest_handshake_at,
            DateTime::<Utc>::from_timestamp(1_720_000_000, 0)
        );
        assert_eq!(observed.received_bytes, 4096);
        assert_eq!(observed.sent_bytes, 8192);
    }

    #[test]
    fn native_command_contract_covers_macos_linux_and_windows() {
        let config = Path::new("mesh/hii0.conf");
        assert_eq!(
            native_action_arguments(NativePlatform::WgQuick, true, config),
            vec![OsString::from("up"), config.as_os_str().into()]
        );
        assert_eq!(
            native_action_arguments(NativePlatform::WindowsService, true, config),
            vec![
                OsString::from("/installtunnelservice"),
                config.as_os_str().into()
            ]
        );
        assert_eq!(
            native_action_arguments(NativePlatform::WindowsService, false, config),
            vec![
                OsString::from("/uninstalltunnelservice"),
                OsString::from(NATIVE_INTERFACE)
            ]
        );
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
