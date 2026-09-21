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
    collections::HashSet,
    env,
    ffi::OsString,
    fs,
    net::IpAddr,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen_port: Option<u16>,
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
    pub peers: Vec<VpnDevice>,
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
pub struct PeerBootstrapProfile {
    pub schema_version: u16,
    pub kind: String,
    pub account_id: String,
    pub mesh_id: String,
    pub owner_signing_public_key: String,
    pub target_device: VpnDevice,
    pub mesh_peer: VpnDevice,
    pub issued_at: DateTime<Utc>,
    pub account_signature: String,
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
                endpoint_source: None,
                listen_port: None,
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
                peers: Vec::new(),
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
        let active_peers = state
            .peers
            .iter()
            .filter(|peer| peer.status != DeviceStatus::Revoked)
            .cloned()
            .collect::<Vec<_>>();
        let data_plane_live = native_wireguard.active
            && native_wireguard.latest_handshake_at.is_some()
            && !active_peers.is_empty();
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
        if active_peers.is_empty() {
            reasons.push("No WireGuard peer has been enrolled in this HII mesh.".into());
        }
        if active_peers.iter().any(|peer| {
            peer.endpoint_source
                .as_deref()
                .is_some_and(|source| source != "direct")
        }) {
            reasons.push(
                "At least one peer uses a bootstrap endpoint; the mesh is not transport-independent yet."
                    .into(),
            );
        }
        let next = if !native_wireguard.available {
            native_install_hint().into()
        } else if !native_wireguard.config_ready {
            "hii link prepare".into()
        } else if active_peers.is_empty() {
            "Enroll a second HII device before activating the tunnel.".into()
        } else if !native_wireguard.active {
            native_activation_hint().into()
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
            peers: active_peers.clone(),
            peer_count: active_peers.len(),
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

    #[allow(clippy::too_many_arguments)]
    pub fn add_peer(
        &self,
        identity: &IdentityStore,
        device_id: &str,
        display_name: &str,
        platform: &str,
        public_key: &str,
        endpoint: Option<&str>,
        endpoint_source: Option<&str>,
        listen_port: Option<u16>,
    ) -> Result<VpnMeshState, String> {
        validate_device_id(device_id)?;
        validate_display_name(display_name)?;
        validate_platform(platform)?;
        validate_wireguard_public_key(public_key)?;
        if let Some(endpoint) = endpoint {
            validate_endpoint(endpoint)?;
        }
        if let Some(source) = endpoint_source {
            validate_endpoint_source(source)?;
        }
        if listen_port == Some(0) {
            return Err("WireGuard listen ports must be between 1 and 65535.".into());
        }
        let mut state = self.load(identity)?;
        if state.local_device.device_id == device_id
            || state.local_device.wireguard_public_key == public_key
        {
            return Err("The peer conflicts with the local HII WireGuard device.".into());
        }
        if let Some(existing) = state
            .peers
            .iter_mut()
            .find(|peer| peer.device_id == device_id)
        {
            if existing.wireguard_public_key == public_key
                && existing.endpoint.as_deref() == endpoint
                && existing.endpoint_source.as_deref() == endpoint_source
                && existing.listen_port == listen_port
                && existing.status != DeviceStatus::Revoked
            {
                return Ok(state);
            }
            if existing.status == DeviceStatus::Revoked {
                existing.display_name = display_name.trim().into();
                existing.platform = platform.into();
                existing.wireguard_public_key = public_key.into();
                existing.endpoint = endpoint.map(str::to_string);
                existing.endpoint_source = endpoint_source.map(str::to_string);
                existing.listen_port = listen_port;
                existing.status = DeviceStatus::Pending;
                existing.last_verified_handshake_at = None;
                state.phase = if endpoint.is_some() {
                    MeshPhase::EndpointConfigured
                } else {
                    MeshPhase::LocalReady
                };
                state.trust_epoch = state.trust_epoch.saturating_add(1);
                state.updated_at = Utc::now();
                sign_state(identity, &mut state)?;
                write_private_json(&self.state_path(), &state)?;
                self.prepare_native(identity)?;
                return self.load(identity);
            }
            return Err("A different WireGuard peer already uses that HII device ID.".into());
        }
        if state
            .peers
            .iter()
            .any(|peer| peer.wireguard_public_key == public_key)
        {
            return Err("That WireGuard public key is already enrolled.".into());
        }
        let (ipv4, ipv6) = allocate_peer_addresses(&state)?;
        state.peers.push(VpnDevice {
            device_id: device_id.into(),
            display_name: display_name.trim().into(),
            platform: platform.into(),
            ipv4,
            ipv6,
            wireguard_public_key: public_key.into(),
            endpoint: endpoint.map(str::to_string),
            endpoint_source: endpoint_source.map(str::to_string),
            listen_port,
            status: DeviceStatus::Pending,
            last_verified_handshake_at: None,
        });
        state.phase = if endpoint.is_some() {
            MeshPhase::EndpointConfigured
        } else {
            MeshPhase::LocalReady
        };
        state.trust_epoch = state.trust_epoch.saturating_add(1);
        state.updated_at = Utc::now();
        sign_state(identity, &mut state)?;
        write_private_json(&self.state_path(), &state)?;
        self.prepare_native(identity)?;
        self.load(identity)
    }

    pub fn revoke_peer(
        &self,
        identity: &IdentityStore,
        device_id: &str,
    ) -> Result<VpnMeshState, String> {
        let mut state = self.load(identity)?;
        let peer = state
            .peers
            .iter_mut()
            .find(|peer| peer.device_id == device_id)
            .ok_or_else(|| format!("No HII WireGuard peer named `{device_id}` is enrolled."))?;
        peer.status = DeviceStatus::Revoked;
        peer.endpoint = None;
        peer.endpoint_source = None;
        state.trust_epoch = state.trust_epoch.saturating_add(1);
        state.phase = MeshPhase::LocalReady;
        state.updated_at = Utc::now();
        sign_state(identity, &mut state)?;
        write_private_json(&self.state_path(), &state)?;
        self.prepare_native(identity)?;
        self.load(identity)
    }

    pub fn configure_local_endpoint(
        &self,
        identity: &IdentityStore,
        endpoint: Option<&str>,
        listen_port: u16,
    ) -> Result<VpnMeshState, String> {
        if listen_port == 0 {
            return Err("WireGuard listen ports must be between 1 and 65535.".into());
        }
        if let Some(endpoint) = endpoint {
            validate_endpoint(endpoint)?;
        }
        let mut state = self.load(identity)?;
        state.local_device.endpoint = endpoint.map(str::to_string);
        state.local_device.endpoint_source = endpoint.map(|_| "direct".into());
        state.local_device.listen_port = Some(listen_port);
        state.trust_epoch = state.trust_epoch.saturating_add(1);
        state.updated_at = Utc::now();
        sign_state(identity, &mut state)?;
        write_private_json(&self.state_path(), &state)?;
        self.prepare_native(identity)?;
        self.load(identity)
    }

    pub fn peer_bootstrap_profile(
        &self,
        identity: &IdentityStore,
        device_id: &str,
    ) -> Result<PeerBootstrapProfile, String> {
        let state = self.load(identity)?;
        let target_device = state
            .peers
            .iter()
            .find(|peer| peer.device_id == device_id && peer.status != DeviceStatus::Revoked)
            .cloned()
            .ok_or_else(|| {
                format!("No active HII WireGuard peer named `{device_id}` is enrolled.")
            })?;
        let mut profile = PeerBootstrapProfile {
            schema_version: SCHEMA_VERSION,
            kind: "hii.vpn.peer-bootstrap/1".into(),
            account_id: state.account_id,
            mesh_id: state.mesh_id,
            owner_signing_public_key: state.owner_signing_public_key,
            target_device,
            mesh_peer: state.local_device,
            issued_at: Utc::now(),
            account_signature: String::new(),
        };
        let payload = serde_json::to_vec(&profile).map_err(|error| error.to_string())?;
        profile.account_signature = identity.sign_bytes(&payload)?.signature;
        Ok(profile)
    }

    pub fn native_up(&self, identity: &IdentityStore) -> Result<NativeWireGuardStatus, String> {
        let state = self.load(identity)?;
        if !state
            .peers
            .iter()
            .any(|peer| peer.status != DeviceStatus::Revoked)
        {
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
        if detail.contains("password is required") || detail.contains("must be root") {
            return Err(
                "native WireGuard activation requires platform administrator approval.".into(),
            );
        }
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
    #[cfg(any(not(windows), test))]
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
        #[cfg(any(not(windows), test))]
        (NativePlatform::WgQuick, true) => vec!["up".into(), config.as_os_str().into()],
        #[cfg(any(not(windows), test))]
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

fn native_activation_hint() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Approve the official WireGuard macOS VPN configuration, then activate hii0."
    }
    #[cfg(windows)]
    {
        "Run `hii link up` from an administrator-approved HII session."
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "Run `hii link up` with network-administration authority."
    }
}

fn render_native_config(state: &VpnMeshState, private_key: &str) -> String {
    let mut config = format!(
        "# Managed locally by HII for account {}\n[Interface]\nPrivateKey = {}\nAddress = {}, {}\n",
        state.account_id, private_key, state.local_device.ipv4, state.local_device.ipv6
    );
    if let Some(port) = state.local_device.listen_port {
        config.push_str(&format!("ListenPort = {port}\n"));
    }
    for peer in state
        .peers
        .iter()
        .filter(|peer| peer.status != DeviceStatus::Revoked)
    {
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
    validate_device(&state.local_device)?;
    let mut device_ids = HashSet::from([state.local_device.device_id.as_str()]);
    let mut public_keys = HashSet::from([state.local_device.wireguard_public_key.as_str()]);
    let mut addresses = HashSet::from([
        state.local_device.ipv4.as_str(),
        state.local_device.ipv6.as_str(),
    ]);
    for peer in &state.peers {
        validate_device(peer)?;
        if !device_ids.insert(&peer.device_id) {
            return Err("The HII VPN state contains a duplicate device ID.".into());
        }
        if !public_keys.insert(&peer.wireguard_public_key) {
            return Err("The HII VPN state contains a duplicate WireGuard public key.".into());
        }
        if !addresses.insert(&peer.ipv4) || !addresses.insert(&peer.ipv6) {
            return Err("The HII VPN state contains a duplicate tunnel address.".into());
        }
    }
    Ok(())
}

fn validate_device(device: &VpnDevice) -> Result<(), String> {
    validate_device_id(&device.device_id)?;
    validate_display_name(&device.display_name)?;
    validate_platform(&device.platform)?;
    validate_wireguard_public_key(&device.wireguard_public_key)?;
    validate_tunnel_address(&device.ipv4, false)?;
    validate_tunnel_address(&device.ipv6, true)?;
    if let Some(endpoint) = &device.endpoint {
        validate_endpoint(endpoint)?;
    }
    if let Some(source) = &device.endpoint_source {
        validate_endpoint_source(source)?;
    }
    if device.listen_port == Some(0) {
        return Err("WireGuard listen ports must be between 1 and 65535.".into());
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

fn validate_display_name(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.chars().count() < 2
        || value.chars().count() > 80
        || value.chars().any(char::is_control)
    {
        return Err("HII VPN device names must contain 2 to 80 printable characters.".into());
    }
    Ok(())
}

fn validate_platform(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 32
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(
            "HII VPN platforms use 1 to 32 letters, digits, hyphens, or underscores.".into(),
        );
    }
    Ok(())
}

fn validate_wireguard_public_key(value: &str) -> Result<(), String> {
    if BASE64.decode(value).map_or(true, |key| key.len() != 32) {
        return Err("The HII VPN WireGuard public key is invalid.".into());
    }
    Ok(())
}

fn validate_tunnel_address(value: &str, ipv6: bool) -> Result<(), String> {
    let (address, prefix) = value
        .split_once('/')
        .ok_or("HII VPN tunnel addresses require a prefix length.")?;
    let address = address
        .parse::<IpAddr>()
        .map_err(|_| "The HII VPN tunnel address is invalid.")?;
    let prefix = prefix
        .parse::<u8>()
        .map_err(|_| "The HII VPN tunnel prefix is invalid.")?;
    if address.is_ipv6() != ipv6 || prefix > if ipv6 { 128 } else { 32 } {
        return Err("The HII VPN tunnel address family or prefix is invalid.".into());
    }
    Ok(())
}

fn validate_endpoint(value: &str) -> Result<(), String> {
    if value.len() > 260
        || value.chars().any(char::is_whitespace)
        || value.contains(['=', '#', ';'])
    {
        return Err("The WireGuard endpoint contains unsupported characters.".into());
    }
    let (host, port) = value
        .rsplit_once(':')
        .ok_or("WireGuard endpoints use host:port.")?;
    if host.is_empty() || port.parse::<u16>().map_or(true, |port| port == 0) {
        return Err("WireGuard endpoints require a host and port from 1 to 65535.".into());
    }
    Ok(())
}

fn validate_endpoint_source(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 40
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(
            "WireGuard endpoint sources use lowercase letters, digits, and hyphens.".into(),
        );
    }
    Ok(())
}

fn allocate_peer_addresses(state: &VpnMeshState) -> Result<(String, String), String> {
    let network = state
        .ipv4_pool
        .strip_suffix(".0/24")
        .ok_or("HII VPN IPv4 pool is not a supported /24.")?;
    let used = state
        .peers
        .iter()
        .filter_map(|peer| {
            peer.ipv4
                .strip_prefix(&format!("{network}."))
                .and_then(|value| value.strip_suffix("/32"))
                .and_then(|value| value.parse::<u8>().ok())
        })
        .collect::<HashSet<_>>();
    let host = (2_u8..=254)
        .find(|host| !used.contains(host))
        .ok_or("The HII VPN mesh has no free peer addresses.")?;
    let prefix = state
        .ipv6_pool
        .strip_suffix("::/48")
        .ok_or("HII VPN IPv6 pool is not a supported /48.")?;
    Ok((
        format!("{network}.{host}/32"),
        format!("{prefix}::{host:x}/128"),
    ))
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
    path.parent()
        .ok_or("HII VPN path has no parent directory.")?;
    crate::store::write_private_atomic(path, bytes)
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
    fn peer_enrollment_updates_the_signed_mesh_and_native_configuration() {
        let (_temp, _paths, identity, vpn) = fixture("peer-add");
        let initial = vpn.init(&identity, "ummi-mac", "Ummi Mac").unwrap();
        let peer_key = BASE64.encode([9_u8; 32]);
        let state = vpn
            .add_peer(
                &identity,
                "windows-pc",
                "Windows PC",
                "windows",
                &peer_key,
                Some("100.81.69.126:51820"),
                Some("tailscale-bootstrap"),
                Some(51820),
            )
            .unwrap();
        assert_eq!(state.trust_epoch, initial.trust_epoch + 1);
        assert_ne!(state.account_signature, initial.account_signature);
        assert!(state.peers[0].ipv4.ends_with(".2/32"));
        assert_eq!(state.peers[0].status, DeviceStatus::Pending);
        assert_eq!(
            state.peers[0].endpoint_source.as_deref(),
            Some("tailscale-bootstrap")
        );
        let config = fs::read_to_string(vpn.native_config_path()).unwrap();
        assert!(config.contains(&peer_key));
        assert!(config.contains("Endpoint = 100.81.69.126:51820"));
        assert!(vpn
            .status(&identity)
            .unwrap()
            .reasons
            .iter()
            .any(|reason| reason.contains("bootstrap endpoint")));
    }

    #[test]
    fn peer_bootstrap_is_public_and_signed_by_the_hii_account() {
        let (_temp, _paths, identity, vpn) = fixture("peer-bootstrap");
        vpn.init(&identity, "ummi-mac", "Ummi Mac").unwrap();
        vpn.add_peer(
            &identity,
            "windows-pc",
            "Windows PC",
            "windows",
            &BASE64.encode([10_u8; 32]),
            None,
            None,
            Some(51820),
        )
        .unwrap();
        let profile = vpn.peer_bootstrap_profile(&identity, "windows-pc").unwrap();
        let signature = BASE64.decode(&profile.account_signature).unwrap();
        let public_key = BASE64.decode(&profile.owner_signing_public_key).unwrap();
        let mut unsigned = profile.clone();
        unsigned.account_signature.clear();
        let payload = serde_json::to_vec(&unsigned).unwrap();
        UnparsedPublicKey::new(&ED25519, public_key)
            .verify(&payload, &signature)
            .unwrap();
        let raw = serde_json::to_string(&profile).unwrap();
        assert!(!raw.contains("privateKey"));
        assert_eq!(profile.target_device.device_id, "windows-pc");
    }

    #[test]
    fn revoking_a_peer_removes_it_from_the_native_configuration() {
        let (_temp, _paths, identity, vpn) = fixture("peer-revoke");
        vpn.init(&identity, "ummi-mac", "Ummi Mac").unwrap();
        let peer_key = BASE64.encode([11_u8; 32]);
        vpn.add_peer(
            &identity,
            "windows-pc",
            "Windows PC",
            "windows",
            &peer_key,
            None,
            None,
            None,
        )
        .unwrap();
        let state = vpn.revoke_peer(&identity, "windows-pc").unwrap();
        assert_eq!(state.peers[0].status, DeviceStatus::Revoked);
        assert!(!fs::read_to_string(vpn.native_config_path())
            .unwrap()
            .contains(&peer_key));
        assert_eq!(vpn.status(&identity).unwrap().peer_count, 0);
    }

    #[test]
    fn a_revoked_device_can_be_reenrolled_with_a_rotated_key() {
        let (_temp, _paths, identity, vpn) = fixture("peer-rotate");
        vpn.init(&identity, "ummi-mac", "Ummi Mac").unwrap();
        vpn.add_peer(
            &identity,
            "windows-pc",
            "Windows PC",
            "windows",
            &BASE64.encode([12_u8; 32]),
            None,
            None,
            Some(51820),
        )
        .unwrap();
        let revoked = vpn.revoke_peer(&identity, "windows-pc").unwrap();
        let rotated = BASE64.encode([13_u8; 32]);
        let state = vpn
            .add_peer(
                &identity,
                "windows-pc",
                "Windows PC",
                "windows",
                &rotated,
                Some("100.81.69.126:51820"),
                Some("tailscale-bootstrap"),
                Some(51820),
            )
            .unwrap();
        assert_eq!(state.peers.len(), 1);
        assert_eq!(state.peers[0].wireguard_public_key, rotated);
        assert_eq!(state.peers[0].status, DeviceStatus::Pending);
        assert_eq!(state.trust_epoch, revoked.trust_epoch + 1);
    }

    #[test]
    fn endpoint_validation_blocks_configuration_injection() {
        assert!(validate_endpoint("vpn.example.com:51820").is_ok());
        assert!(validate_endpoint("vpn.example.com:51820\nPostUp = bad").is_err());
        assert!(validate_endpoint("vpn.example.com").is_err());
        assert!(validate_endpoint("vpn.example.com:0").is_err());
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
