use hii_fabric_protocol::*;
use std::collections::BTreeSet;
use std::io::{Cursor, ErrorKind};
use std::num::NonZeroU16;

fn envelope(message: Message) -> Envelope {
    Envelope {
        message_id: "message-1".into(),
        correlation_id: None,
        sent_at_unix_ms: 1_700_000_000_000,
        message,
    }
}

#[test]
fn hello_round_trips_through_stream_codec() {
    let original = envelope(Message::DeviceHello(DeviceHello {
        device_id: "mac-1".into(),
        display_name: "Ummi's Mac".into(),
        platform: Platform::Macos,
        agent_version: "0.1.0".into(),
        supported_wire_versions: vec![WIRE_VERSION],
        hello_nonce: "connection-scoped-nonce".into(),
    }));
    let codec = FrameCodec::default();
    let mut bytes = Vec::new();
    codec.write_to(&mut bytes, &original).unwrap();

    let decoded = codec.read_from(&mut Cursor::new(bytes)).unwrap().unwrap();
    assert_eq!(decoded, original);
}

#[test]
fn representative_data_messages_round_trip() {
    let authority = AuthorityContext {
        grant_id: Some("grant-1".into()),
        actions: BTreeSet::from([AuthorityAction::TransferFiles]),
        user_confirmed: true,
    };
    let messages = [
        Message::FrameMetadata(FrameMetadata {
            channel_id: 7,
            frame_id: 42,
            width: 3840,
            height: 2160,
            pixel_format: PixelFormat::Hevc,
            captured_at_ns: 5,
            timestamp_clock: TimestampClock::SenderMonotonic,
            payload_bytes: 12_345,
            keyframe: true,
            planes: vec![],
            color_range: None,
            dirty_rects: vec![Rect {
                x: 1,
                y: 2,
                width: 3,
                height: 4,
            }],
        }),
        Message::FileOffer(FileOffer {
            transfer_id: "transfer-1".into(),
            file_name: "model.glb".into(),
            byte_len: 3,
            modified_at_unix_ms: 10,
            digest: ContentDigest {
                algorithm: "sha256".into(),
                value: "abc".into(),
            },
            authority,
        }),
        Message::JobResult(JobResult {
            job_id: "job-1".into(),
            status: JobStatus::Succeeded,
            output: Some(serde_json::json!({"result": 3})),
            artifacts: vec![],
            receipt_ref: Some("receipt-1".into()),
        }),
    ];
    let codec = FrameCodec::default();
    for message in messages {
        let original = envelope(message);
        assert_eq!(
            codec.decode(&codec.encode(&original).unwrap()).unwrap(),
            original
        );
    }
}

#[test]
fn terminal_channel_requires_explicit_authority() {
    let denied = ChannelOpen {
        channel_id: 9,
        kind: ChannelKind::Terminal,
        authority: AuthorityContext::default(),
        options: vec![],
    };
    assert!(!denied.authority_claim_is_sufficient());

    let allowed = ChannelOpen {
        authority: AuthorityContext {
            grant_id: Some("terminal-grant-1".into()),
            actions: BTreeSet::from([AuthorityAction::OpenTerminal]),
            user_confirmed: true,
        },
        ..denied
    };
    assert!(allowed.authority_claim_is_sufficient());
}

#[test]
fn terminal_messages_round_trip_and_enforce_bounds() {
    let authority = AuthorityContext {
        grant_id: Some("terminal-grant-1".into()),
        actions: BTreeSet::from([AuthorityAction::OpenTerminal]),
        user_confirmed: true,
    };
    let request = TerminalOpenRequest {
        channel_id: 9,
        session_id: "terminal-session-1".into(),
        device_id: "mac-1".into(),
        cwd: "/Users/ummi/hii".into(),
        cols: 120,
        rows: 36,
        expires_at_unix_ms: 1_700_000_600_000,
        authority,
    };
    let codec = FrameCodec::default();
    let original = envelope(Message::TerminalOpenRequest(request.clone()));
    assert_eq!(
        codec.decode(&codec.encode(&original).unwrap()).unwrap(),
        original
    );
    assert_eq!(request.validate(), Ok(()));

    let invalid_size = TerminalResize {
        channel_id: 9,
        session_id: request.session_id.clone(),
        cols: MAX_TERMINAL_COLS + 1,
        rows: 36,
    };
    assert_eq!(
        invalid_size.validate(),
        Err(MessageValidationError::InvalidTerminalSize {
            cols: MAX_TERMINAL_COLS + 1,
            rows: 36,
        })
    );

    let oversized_input = TerminalData {
        channel_id: 9,
        session_id: request.session_id,
        sequence: 1,
        stream: TerminalStream::Input,
        data: vec![0; MAX_TERMINAL_INPUT_BYTES + 1],
    };
    assert_eq!(
        oversized_input.validate(),
        Err(MessageValidationError::TerminalDataTooLarge {
            actual: MAX_TERMINAL_INPUT_BYTES + 1,
            max: MAX_TERMINAL_INPUT_BYTES,
        })
    );
}

#[test]
fn validates_frame_clock_layout_and_dirty_rect_bounds() {
    let raw = FrameMetadata {
        channel_id: 7,
        frame_id: 42,
        width: 4,
        height: 4,
        pixel_format: PixelFormat::Bgra8,
        captured_at_ns: 5,
        timestamp_clock: TimestampClock::MediaPresentation,
        payload_bytes: 80,
        keyframe: true,
        planes: vec![FramePlaneLayout {
            index: 0,
            width: 4,
            height: 4,
            bytes_per_row: 20,
            offset_bytes: 0,
            byte_len: 80,
        }],
        color_range: Some(ColorRange::Full),
        dirty_rects: vec![Rect {
            x: 0,
            y: 0,
            width: 4,
            height: 4,
        }],
    };
    assert_eq!(raw.validate(), Ok(()));

    let mut invalid = raw.clone();
    invalid.dirty_rects[0].x = 1;
    assert_eq!(
        invalid.validate(),
        Err(MessageValidationError::DirtyRectOutOfBounds)
    );

    let mut missing_stride = raw;
    missing_stride.planes.clear();
    assert_eq!(
        missing_stride.validate(),
        Err(MessageValidationError::InvalidFramePlaneLayout)
    );

    let mut impossible_stride = missing_stride;
    impossible_stride.planes = vec![FramePlaneLayout {
        index: 0,
        width: 4,
        height: 4,
        bytes_per_row: 1,
        offset_bytes: 0,
        byte_len: 4,
    }];
    impossible_stride.payload_bytes = 4;
    assert_eq!(
        impossible_stride.validate(),
        Err(MessageValidationError::InvalidFramePlaneLayout)
    );
}

#[test]
fn reads_multiple_length_delimited_frames_without_overread() {
    let codec = FrameCodec::default();
    let first = envelope(Message::Ping(Ping {
        sequence: 1,
        sent_at_unix_ms: 10,
    }));
    let second = envelope(Message::Pong(Pong {
        sequence: 1,
        ping_sent_at_unix_ms: 10,
        pong_sent_at_unix_ms: 11,
    }));
    let mut stream = codec.encode(&first).unwrap();
    stream.extend(codec.encode(&second).unwrap());
    let mut cursor = Cursor::new(stream);

    assert_eq!(codec.read_from(&mut cursor).unwrap(), Some(first));
    assert_eq!(codec.read_from(&mut cursor).unwrap(), Some(second));
    assert_eq!(codec.read_from(&mut cursor).unwrap(), None);
}

#[test]
fn rejects_oversized_length_before_allocating_payload() {
    let codec = FrameCodec::new(32).unwrap();
    let mut frame = Vec::from(*b"HIIF");
    frame.extend(WIRE_VERSION.to_be_bytes());
    frame.extend(0_u16.to_be_bytes());
    frame.extend(33_u32.to_be_bytes());

    let error = codec.read_from(&mut Cursor::new(frame)).unwrap_err();
    assert!(matches!(
        error,
        FrameError::FrameTooLarge {
            actual: 33,
            max: 32
        }
    ));
}

#[test]
fn rejects_configured_limit_above_hard_limit() {
    let error = FrameCodec::new(HARD_MAX_FRAME_BYTES + 1).unwrap_err();
    assert!(matches!(error, FrameError::FrameTooLarge { .. }));
}

#[test]
fn rejects_unknown_wire_version() {
    let codec = FrameCodec::default();
    let mut frame = Vec::from(*b"HIIF");
    frame.extend((WIRE_VERSION + 1).to_be_bytes());
    frame.extend(0_u16.to_be_bytes());
    frame.extend(0_u32.to_be_bytes());

    let error = codec.read_from(&mut Cursor::new(frame)).unwrap_err();
    assert!(matches!(
        error,
        FrameError::UnsupportedVersion {
            actual: 2,
            supported: 1
        }
    ));
}

#[test]
fn rejects_bad_magic_reserved_flags_and_malformed_payload() {
    let codec = FrameCodec::default();
    let valid = codec
        .encode(&envelope(Message::Ping(Ping {
            sequence: 1,
            sent_at_unix_ms: 1,
        })))
        .unwrap();

    let mut bad_magic = valid.clone();
    bad_magic[0] = b'X';
    assert!(matches!(
        codec.decode(&bad_magic).unwrap_err(),
        FrameError::InvalidMagic
    ));

    let mut bad_flags = valid.clone();
    bad_flags[7] = 1;
    assert!(matches!(
        codec.decode(&bad_flags).unwrap_err(),
        FrameError::UnsupportedFlags(1)
    ));

    let mut malformed = Vec::from(*b"HIIF");
    malformed.extend(WIRE_VERSION.to_be_bytes());
    malformed.extend(0_u16.to_be_bytes());
    malformed.extend(1_u32.to_be_bytes());
    malformed.push(0xc1); // Reserved/invalid MessagePack byte.
    assert!(matches!(
        codec.decode(&malformed).unwrap_err(),
        FrameError::Decode(_)
    ));
}

#[test]
fn rejects_truncated_header_and_payload_but_accepts_clean_eof() {
    let codec = FrameCodec::default();
    assert_eq!(
        codec.read_from(&mut Cursor::new(Vec::<u8>::new())).unwrap(),
        None
    );

    let error = codec
        .read_from(&mut Cursor::new(b"HII".to_vec()))
        .unwrap_err();
    assert_eq!(io_kind(error), Some(ErrorKind::UnexpectedEof));

    let mut frame = codec
        .encode(&envelope(Message::Ping(Ping {
            sequence: 1,
            sent_at_unix_ms: 1,
        })))
        .unwrap();
    frame.pop();
    let error = codec.read_from(&mut Cursor::new(frame)).unwrap_err();
    assert_eq!(io_kind(error), Some(ErrorKind::UnexpectedEof));
}

#[test]
fn rejects_trailing_bytes_inside_declared_messagepack_payload() {
    let codec = FrameCodec::default();
    let mut frame = codec
        .encode(&envelope(Message::Ping(Ping {
            sequence: 1,
            sent_at_unix_ms: 1,
        })))
        .unwrap();
    frame.push(0);
    let declared = u32::from_be_bytes(frame[8..12].try_into().unwrap());
    frame[8..12].copy_from_slice(&(declared + 1).to_be_bytes());
    assert!(matches!(
        codec.decode(&frame).unwrap_err(),
        FrameError::TrailingPayloadBytes
    ));
}

#[test]
fn decode_rejects_trailing_bytes() {
    let codec = FrameCodec::default();
    let mut frame = codec
        .encode(&envelope(Message::Ping(Ping {
            sequence: 1,
            sent_at_unix_ms: 1,
        })))
        .unwrap();
    frame.push(0);
    let error = codec.decode(&frame).unwrap_err();
    assert_eq!(io_kind(error), Some(ErrorKind::InvalidData));
}

#[test]
fn consequential_authority_defaults_to_denied() {
    let input_channel = ChannelOpen {
        channel_id: 1,
        kind: ChannelKind::Input,
        authority: AuthorityContext::default(),
        options: vec![],
    };
    assert!(!input_channel.authority_claim_is_sufficient());
    assert!(!AuthorityContext::default().claims(&AuthorityAction::RunJob));

    let read_only_channel = ChannelOpen {
        channel_id: 2,
        kind: ChannelKind::DisplayFrames,
        authority: AuthorityContext::default(),
        options: vec![],
    };
    assert!(read_only_channel.authority_claim_is_sufficient());
}

#[test]
fn service_exposure_can_only_name_a_nonzero_loopback_endpoint() {
    let request = ServiceExposeRequest {
        exposure_id: "exposure-1".into(),
        source_device_id: "mac-1".into(),
        loopback_host: LoopbackHost::Ipv4,
        loopback_port: NonZeroU16::new(3_000).unwrap(),
        protocol: ServiceProtocol::Http,
        requested_name: "mac.local".into(),
        authority: AuthorityContext::default(),
    };
    let original = envelope(Message::ServiceExposeRequest(request));
    let codec = FrameCodec::default();
    assert_eq!(
        codec.decode(&codec.encode(&original).unwrap()).unwrap(),
        original
    );
}

#[test]
fn grant_reference_requires_confirmation_and_matching_action() {
    let mut authority = AuthorityContext {
        grant_id: Some("grant-1".into()),
        actions: BTreeSet::from([AuthorityAction::ExposeService]),
        user_confirmed: false,
    };
    assert!(!authority.claims(&AuthorityAction::ExposeService));
    authority.user_confirmed = true;
    assert!(authority.claims(&AuthorityAction::ExposeService));
    assert!(!authority.claims(&AuthorityAction::RunJob));
}

#[test]
fn bounds_file_chunks_and_detects_offset_overflow() {
    let digest = ContentDigest {
        algorithm: "sha256".into(),
        value: "abc".into(),
    };
    let too_large = FileChunk {
        transfer_id: "t".into(),
        offset: 0,
        data: vec![0; MAX_FILE_CHUNK_BYTES + 1],
        digest: digest.clone(),
    };
    assert!(matches!(
        too_large.validate(),
        Err(MessageValidationError::FileChunkTooLarge { .. })
    ));
    let error = FrameCodec::default()
        .encode(&envelope(Message::FileChunk(too_large)))
        .unwrap_err();
    assert!(matches!(
        error,
        FrameError::InvalidMessage(MessageValidationError::FileChunkTooLarge { .. })
    ));

    let overflow = FileChunk {
        transfer_id: "t".into(),
        offset: u64::MAX,
        data: vec![1],
        digest,
    };
    assert_eq!(
        overflow.validate(),
        Err(MessageValidationError::FileChunkOffsetOverflow)
    );
}

fn io_kind(error: FrameError) -> Option<ErrorKind> {
    match error {
        FrameError::Io(error) => Some(error.kind()),
        _ => None,
    }
}
