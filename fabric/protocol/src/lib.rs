//! Transport-independent control messages for HII's private machine fabric.
//!
//! This crate deliberately does not implement transport security, pairing
//! cryptography, remote execution, or any OS integration. Authentication facts
//! in messages are reports that a transport adapter must independently verify.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::{self, Read, Write};
use std::num::NonZeroU16;
use thiserror::Error;

/// Current wire format version.
pub const WIRE_VERSION: u16 = 1;
/// Hard upper bound for any control frame, including file-transfer chunks.
pub const HARD_MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// Conservative default bound suitable for the control plane.
pub const DEFAULT_MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// Individual file chunks are bounded below the overall control-frame limit.
pub const MAX_FILE_CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// Maximum declared data-plane payload for one display frame.
pub const MAX_FRAME_PAYLOAD_BYTES: u32 = 256 * 1024 * 1024;
/// Maximum negotiated frame dimension.
pub const MAX_FRAME_DIMENSION: u32 = 16_384;
/// Dirty rectangles are bounded to prevent small control frames from creating
/// unbounded downstream work.
pub const MAX_DIRTY_RECTS: usize = 256;

const MAGIC: [u8; 4] = *b"HIIF";
const HEADER_LEN: usize = 12;

/// Stable opaque identifier assigned by HII, not a hostname or network address.
pub type DeviceId = String;
pub type MessageId = String;
pub type ChannelId = u64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub message_id: MessageId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<MessageId>,
    pub sent_at_unix_ms: u64,
    pub message: Message,
}

impl Envelope {
    pub fn validate(&self) -> Result<(), MessageValidationError> {
        self.message.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "body", rename_all = "snake_case")]
pub enum Message {
    DeviceHello(DeviceHello),
    CapabilityAdvertisement(CapabilityAdvertisement),
    PairingState(PairingState),
    ChannelOpen(ChannelOpen),
    ChannelClose(ChannelClose),
    Ping(Ping),
    Pong(Pong),
    FrameMetadata(FrameMetadata),
    InputEvent(InputEvent),
    FileOffer(FileOffer),
    FileChunk(FileChunk),
    FileAck(FileAck),
    ServiceExposeRequest(ServiceExposeRequest),
    ServiceExposureState(ServiceExposureState),
    ServiceUnexpose(ServiceUnexpose),
    JobRequest(JobRequest),
    JobResult(JobResult),
    Error(ProtocolErrorMessage),
    ReceiptReference(ReceiptReference),
}

impl Message {
    pub fn validate(&self) -> Result<(), MessageValidationError> {
        match self {
            Self::FileChunk(chunk) => chunk.validate(),
            Self::FrameMetadata(frame) => frame.validate(),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceHello {
    pub device_id: DeviceId,
    pub display_name: String,
    pub platform: Platform,
    pub agent_version: String,
    pub supported_wire_versions: Vec<u16>,
    /// Fresh connection-scoped value used for correlation. This is not proof of
    /// identity and must not be treated as a cryptographic challenge response.
    pub hello_nonce: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Macos,
    Windows,
    Linux,
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityAdvertisement {
    pub device_id: DeviceId,
    pub revision: u64,
    pub capabilities: Vec<Capability>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub id: String,
    pub version: String,
    pub direction: CapabilityDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_authority: Option<AuthorityAction>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityDirection {
    Provide,
    Consume,
    Bidirectional,
}

/// Authentication status as established by the underlying secure transport.
///
/// Receiving `Authenticated` over an unauthenticated connection does not make
/// the connection authenticated. The transport/runtime owns this state.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum LinkAuthentication {
    #[default]
    Unauthenticated,
    PairingPending {
        pairing_id: String,
        expires_at_unix_ms: u64,
    },
    Authenticated {
        peer_device_id: DeviceId,
        session_id: String,
        transport_binding: TransportBinding,
    },
    Revoked {
        reason: String,
        revoked_at_unix_ms: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingState {
    pub authentication: LinkAuthentication,
    /// A runtime-owned proof/receipt identifier, never key material.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportBinding {
    /// Examples: `tls`, `quic`, or an OS-provided authenticated channel.
    pub transport: String,
    /// Opaque identifier supplied and verified by the transport adapter.
    pub binding_id: String,
}

/// Consequential actions that require an explicit, runtime-verified grant.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityAction {
    InjectInput,
    TransferFiles,
    MutateClipboard,
    ExposeService,
    RunJob,
}

/// A reference to authority established outside this protocol crate.
///
/// The default contains no grant and permits no consequential actions.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant_id: Option<String>,
    #[serde(default)]
    pub actions: BTreeSet<AuthorityAction>,
    #[serde(default)]
    pub user_confirmed: bool,
}

impl AuthorityContext {
    /// This is a shape-level convenience check, not grant verification.
    pub fn claims(&self, action: &AuthorityAction) -> bool {
        self.grant_id.is_some() && self.user_confirmed && self.actions.contains(action)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelOpen {
    pub channel_id: ChannelId,
    pub kind: ChannelKind,
    #[serde(default)]
    pub authority: AuthorityContext,
    #[serde(default)]
    pub options: Vec<ChannelOption>,
}

impl ChannelOpen {
    pub fn authority_claim_is_sufficient(&self) -> bool {
        self.kind
            .required_authority()
            .map(|action| self.authority.claims(&action))
            .unwrap_or(true)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelKind {
    Health,
    Receipts,
    DisplayFrames,
    AudioFrames,
    Input,
    FileTransfer,
    ClipboardWrite,
    ServiceProxy,
    Jobs,
}

impl ChannelKind {
    pub fn required_authority(&self) -> Option<AuthorityAction> {
        match self {
            Self::Health | Self::Receipts | Self::DisplayFrames | Self::AudioFrames => None,
            Self::Input => Some(AuthorityAction::InjectInput),
            Self::FileTransfer => Some(AuthorityAction::TransferFiles),
            Self::ClipboardWrite => Some(AuthorityAction::MutateClipboard),
            Self::ServiceProxy => Some(AuthorityAction::ExposeService),
            Self::Jobs => Some(AuthorityAction::RunJob),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelOption {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelClose {
    pub channel_id: ChannelId,
    pub reason: ChannelCloseReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelCloseReason {
    Complete,
    Cancelled,
    Revoked,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ping {
    pub sequence: u64,
    pub sent_at_unix_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pong {
    pub sequence: u64,
    pub ping_sent_at_unix_ms: u64,
    pub pong_sent_at_unix_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameMetadata {
    pub channel_id: ChannelId,
    pub frame_id: u64,
    pub width: u32,
    pub height: u32,
    pub pixel_format: PixelFormat,
    pub captured_at_ns: u64,
    pub timestamp_clock: TimestampClock,
    pub payload_bytes: u32,
    pub keyframe: bool,
    #[serde(default)]
    pub planes: Vec<FramePlaneLayout>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_range: Option<ColorRange>,
    #[serde(default)]
    pub dirty_rects: Vec<Rect>,
}

impl FrameMetadata {
    pub fn validate(&self) -> Result<(), MessageValidationError> {
        if self.width == 0
            || self.height == 0
            || self.width > MAX_FRAME_DIMENSION
            || self.height > MAX_FRAME_DIMENSION
        {
            return Err(MessageValidationError::InvalidFrameDimensions {
                width: self.width,
                height: self.height,
                max: MAX_FRAME_DIMENSION,
            });
        }
        if self.payload_bytes == 0 || self.payload_bytes > MAX_FRAME_PAYLOAD_BYTES {
            return Err(MessageValidationError::InvalidFramePayloadLength {
                actual: self.payload_bytes,
                max: MAX_FRAME_PAYLOAD_BYTES,
            });
        }
        if self.dirty_rects.len() > MAX_DIRTY_RECTS {
            return Err(MessageValidationError::TooManyDirtyRects {
                actual: self.dirty_rects.len(),
                max: MAX_DIRTY_RECTS,
            });
        }
        if self.dirty_rects.iter().any(|rect| {
            rect.width == 0
                || rect.height == 0
                || rect
                    .x
                    .checked_add(rect.width)
                    .is_none_or(|x| x > self.width)
                || rect
                    .y
                    .checked_add(rect.height)
                    .is_none_or(|y| y > self.height)
        }) {
            return Err(MessageValidationError::DirtyRectOutOfBounds);
        }

        let expected_planes = match self.pixel_format {
            PixelFormat::Nv12 => {
                if !self.width.is_multiple_of(2) || !self.height.is_multiple_of(2) {
                    return Err(MessageValidationError::InvalidFramePlaneLayout);
                }
                Some(vec![
                    (self.width, self.height, self.width),
                    (self.width / 2, self.height / 2, self.width),
                ])
            }
            PixelFormat::Bgra8 => Some(vec![(
                self.width,
                self.height,
                self.width
                    .checked_mul(4)
                    .ok_or(MessageValidationError::InvalidFramePlaneLayout)?,
            )]),
            PixelFormat::H264 | PixelFormat::Hevc | PixelFormat::Av1 => None,
        };

        if let Some(expected_planes) = expected_planes {
            if self.planes.len() != expected_planes.len() {
                return Err(MessageValidationError::InvalidFramePlaneLayout);
            }
            let mut next_offset = 0_u32;
            for (index, (plane, (width, height, minimum_stride))) in
                self.planes.iter().zip(expected_planes).enumerate()
            {
                let minimum_len = plane
                    .bytes_per_row
                    .checked_mul(plane.height)
                    .ok_or(MessageValidationError::InvalidFramePlaneLayout)?;
                if plane.index as usize != index
                    || plane.width != width
                    || plane.height != height
                    || plane.bytes_per_row < minimum_stride
                    || plane.offset_bytes != next_offset
                    || plane.byte_len < minimum_len
                {
                    return Err(MessageValidationError::InvalidFramePlaneLayout);
                }
                next_offset = plane
                    .offset_bytes
                    .checked_add(plane.byte_len)
                    .ok_or(MessageValidationError::InvalidFramePlaneLayout)?;
            }
            if next_offset != self.payload_bytes {
                return Err(MessageValidationError::InvalidFramePlaneLayout);
            }
        } else if !self.planes.is_empty() {
            return Err(MessageValidationError::InvalidFramePlaneLayout);
        }
        Ok(())
    }
}

/// The capture timestamp's source clock. Sender-monotonic values are valid for
/// ordering within one authenticated session, not as wall-clock timestamps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimestampClock {
    UnixEpoch,
    SenderMonotonic,
    MediaPresentation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePlaneLayout {
    pub index: u8,
    pub width: u32,
    pub height: u32,
    pub bytes_per_row: u32,
    pub offset_bytes: u32,
    pub byte_len: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColorRange {
    Video,
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PixelFormat {
    Nv12,
    Bgra8,
    H264,
    Hevc,
    Av1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputEvent {
    pub channel_id: ChannelId,
    pub sequence: u64,
    pub occurred_at_unix_ns: u64,
    #[serde(default)]
    pub authority: AuthorityContext,
    pub event: InputEventKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InputEventKind {
    Key {
        physical_code: u32,
        pressed: bool,
        repeat: bool,
        modifiers: u32,
    },
    PointerMove {
        x: f64,
        y: f64,
        absolute: bool,
    },
    PointerButton {
        button: u8,
        pressed: bool,
    },
    Scroll {
        delta_x: f64,
        delta_y: f64,
        precise: bool,
    },
    Text {
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentDigest {
    /// Algorithm name such as `sha256`; verification is an integration concern.
    pub algorithm: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOffer {
    pub transfer_id: String,
    pub file_name: String,
    pub byte_len: u64,
    pub modified_at_unix_ms: u64,
    pub digest: ContentDigest,
    #[serde(default)]
    pub authority: AuthorityContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChunk {
    pub transfer_id: String,
    pub offset: u64,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
    pub digest: ContentDigest,
}

impl FileChunk {
    pub fn validate(&self) -> Result<(), MessageValidationError> {
        if self.data.len() > MAX_FILE_CHUNK_BYTES {
            return Err(MessageValidationError::FileChunkTooLarge {
                actual: self.data.len(),
                max: MAX_FILE_CHUNK_BYTES,
            });
        }
        self.offset
            .checked_add(self.data.len() as u64)
            .ok_or(MessageValidationError::FileChunkOffsetOverflow)?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAck {
    pub transfer_id: String,
    pub contiguous_bytes: u64,
    #[serde(default)]
    pub missing_ranges: Vec<ByteRange>,
    pub status: FileAckStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ByteRange {
    pub start: u64,
    pub end_exclusive: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileAckStatus {
    Receiving,
    CompleteVerified,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceExposeRequest {
    pub exposure_id: String,
    pub source_device_id: DeviceId,
    pub loopback_host: LoopbackHost,
    pub loopback_port: NonZeroU16,
    pub protocol: ServiceProtocol,
    pub requested_name: String,
    #[serde(default)]
    pub authority: AuthorityContext,
}

/// Explicit loopback targets only. Arbitrary host strings and wildcard bind
/// addresses are not representable in a service-exposure request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopbackHost {
    Localhost,
    Ipv4,
    Ipv6,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceProtocol {
    Http,
    Https,
    Tcp,
    Udp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceExposureState {
    pub exposure_id: String,
    pub state: ExposureState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExposureState {
    PendingApproval,
    Active,
    Denied,
    Revoked,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceUnexpose {
    pub exposure_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub job_id: String,
    pub capability_id: String,
    pub idempotency_key: String,
    pub input: serde_json::Value,
    #[serde(default)]
    pub authority: AuthorityContext,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobResult {
    pub job_id: String,
    pub status: JobStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
    #[serde(default)]
    pub artifacts: Vec<ArtifactReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Accepted,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReference {
    pub artifact_id: String,
    pub media_type: String,
    pub byte_len: u64,
    pub digest: ContentDigest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolErrorMessage {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub related_message_id: Option<MessageId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    UnsupportedVersion,
    MalformedMessage,
    AuthenticationRequired,
    AuthorityDenied,
    CapabilityUnavailable,
    ChannelClosed,
    IntegrityFailed,
    ResourceLimit,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptReference {
    pub receipt_id: String,
    pub issuer_device_id: DeviceId,
    pub kind: String,
    pub digest: ContentDigest,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MessageValidationError {
    #[error("file chunk is {actual} bytes; maximum is {max}")]
    FileChunkTooLarge { actual: usize, max: usize },
    #[error("file chunk offset overflows u64")]
    FileChunkOffsetOverflow,
    #[error("frame dimensions {width}x{height} must be within 1...{max}")]
    InvalidFrameDimensions { width: u32, height: u32, max: u32 },
    #[error("frame payload is {actual} bytes; expected 1...{max}")]
    InvalidFramePayloadLength { actual: u32, max: u32 },
    #[error("frame has {actual} dirty rectangles; maximum is {max}")]
    TooManyDirtyRects { actual: usize, max: usize },
    #[error("dirty rectangle lies outside the frame")]
    DirtyRectOutOfBounds,
    #[error("frame plane layout is invalid for its format or payload")]
    InvalidFramePlaneLayout,
}

#[derive(Debug, Error)]
pub enum FrameError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("invalid frame magic")]
    InvalidMagic,
    #[error("unsupported wire version {actual}; expected {supported}")]
    UnsupportedVersion { actual: u16, supported: u16 },
    #[error("unsupported frame flags {0:#06x}")]
    UnsupportedFlags(u16),
    #[error("frame payload is {actual} bytes; configured maximum is {max}")]
    FrameTooLarge { actual: usize, max: usize },
    #[error("frame length cannot be represented on the wire")]
    LengthOverflow,
    #[error("malformed MessagePack payload: {0}")]
    Decode(#[from] rmp_serde::decode::Error),
    #[error("trailing bytes inside declared MessagePack payload")]
    TrailingPayloadBytes,
    #[error("could not encode MessagePack payload: {0}")]
    Encode(#[from] rmp_serde::encode::Error),
    #[error("invalid message: {0}")]
    InvalidMessage(#[from] MessageValidationError),
}

/// Blocking length-delimited codec. Async transports can apply the same
/// 12-byte header contract in their own adapters.
#[derive(Debug, Clone, Copy)]
pub struct FrameCodec {
    max_frame_bytes: usize,
}

impl Default for FrameCodec {
    fn default() -> Self {
        Self {
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
        }
    }
}

impl FrameCodec {
    pub fn new(max_frame_bytes: usize) -> Result<Self, FrameError> {
        if max_frame_bytes > HARD_MAX_FRAME_BYTES {
            return Err(FrameError::FrameTooLarge {
                actual: max_frame_bytes,
                max: HARD_MAX_FRAME_BYTES,
            });
        }
        Ok(Self { max_frame_bytes })
    }

    pub fn max_frame_bytes(&self) -> usize {
        self.max_frame_bytes
    }

    pub fn encode(&self, envelope: &Envelope) -> Result<Vec<u8>, FrameError> {
        envelope.validate()?;
        let payload = rmp_serde::to_vec_named(envelope)?;
        self.validate_payload_len(payload.len())?;
        let payload_len = u32::try_from(payload.len()).map_err(|_| FrameError::LengthOverflow)?;

        let mut frame = Vec::with_capacity(HEADER_LEN + payload.len());
        frame.extend_from_slice(&MAGIC);
        frame.extend_from_slice(&WIRE_VERSION.to_be_bytes());
        frame.extend_from_slice(&0_u16.to_be_bytes());
        frame.extend_from_slice(&payload_len.to_be_bytes());
        frame.extend_from_slice(&payload);
        Ok(frame)
    }

    pub fn decode(&self, frame: &[u8]) -> Result<Envelope, FrameError> {
        let mut cursor = io::Cursor::new(frame);
        let envelope = self
            .read_from(&mut cursor)?
            .ok_or_else(|| unexpected_eof("frame header"))?;
        if cursor.position() != frame.len() as u64 {
            return Err(FrameError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "trailing bytes after one frame",
            )));
        }
        Ok(envelope)
    }

    pub fn write_to<W: Write>(
        &self,
        writer: &mut W,
        envelope: &Envelope,
    ) -> Result<(), FrameError> {
        let frame = self.encode(envelope)?;
        writer.write_all(&frame)?;
        Ok(())
    }

    /// Returns `Ok(None)` only for a clean EOF before the first header byte.
    /// Any partial header or payload is an error.
    pub fn read_from<R: Read>(&self, reader: &mut R) -> Result<Option<Envelope>, FrameError> {
        let mut header = [0_u8; HEADER_LEN];
        match reader.read_exact(&mut header[..1]) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(error) => return Err(FrameError::Io(error)),
        }
        reader
            .read_exact(&mut header[1..])
            .map_err(|error| normalize_eof(error, "frame header"))?;

        if header[..4] != MAGIC {
            return Err(FrameError::InvalidMagic);
        }
        let version = u16::from_be_bytes([header[4], header[5]]);
        if version != WIRE_VERSION {
            return Err(FrameError::UnsupportedVersion {
                actual: version,
                supported: WIRE_VERSION,
            });
        }
        let flags = u16::from_be_bytes([header[6], header[7]]);
        if flags != 0 {
            return Err(FrameError::UnsupportedFlags(flags));
        }
        let payload_len =
            u32::from_be_bytes([header[8], header[9], header[10], header[11]]) as usize;
        self.validate_payload_len(payload_len)?;

        let mut payload = vec![0_u8; payload_len];
        reader
            .read_exact(&mut payload)
            .map_err(|error| normalize_eof(error, "frame payload"))?;
        let mut cursor = io::Cursor::new(&payload);
        let envelope = {
            let mut deserializer = rmp_serde::Deserializer::new(&mut cursor);
            Envelope::deserialize(&mut deserializer)?
        };
        if cursor.position() != payload.len() as u64 {
            return Err(FrameError::TrailingPayloadBytes);
        }
        envelope.validate()?;
        Ok(Some(envelope))
    }

    fn validate_payload_len(&self, payload_len: usize) -> Result<(), FrameError> {
        if payload_len > self.max_frame_bytes {
            return Err(FrameError::FrameTooLarge {
                actual: payload_len,
                max: self.max_frame_bytes,
            });
        }
        Ok(())
    }
}

fn normalize_eof(error: io::Error, context: &'static str) -> FrameError {
    if error.kind() == io::ErrorKind::UnexpectedEof {
        unexpected_eof(context)
    } else {
        FrameError::Io(error)
    }
}

fn unexpected_eof(context: &'static str) -> FrameError {
    FrameError::Io(io::Error::new(
        io::ErrorKind::UnexpectedEof,
        format!("truncated {context}"),
    ))
}
