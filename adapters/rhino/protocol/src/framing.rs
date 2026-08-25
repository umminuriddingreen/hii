//! Length-prefixed framing.
//!
//! This is wire contract, not client convenience: the C# bridge mirrors it by
//! hand, so it lives beside `MAX_MESSAGE_BYTES` in the protocol crate and is
//! pinned by a byte-level fixture. Only `std::io` is used here — no OS
//! dependency, so both sides can test framing without a pipe.
//!
//! # Mirroring requirements for the C# bridge
//!
//! * The pipe is created in **byte mode** (`PipeTransmissionMode.Byte`). In
//!   message mode a reader that does not drain a whole message in one call gets
//!   `ERROR_MORE_DATA`, which reaches Rust as an opaque I/O error rather than
//!   anything diagnosable. Message boundaries come from the length prefix here
//!   and from nowhere else.
//! * Each frame is a **little-endian `u32` byte count** followed by exactly
//!   that many bytes of UTF-8 JSON. No trailing newline, no BOM.
//! * The length is validated *before* the body is read or any buffer is
//!   allocated, so a hostile or corrupt prefix cannot make either side reserve
//!   4 GiB.

use crate::{envelope::MAX_MESSAGE_BYTES, error::ErrorCode};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fmt,
    io::{self, Read, Write},
};

/// Bytes of length prefix ahead of every frame body.
pub const FRAME_HEADER_BYTES: usize = 4;

/// Why a frame could not be produced or consumed.
#[derive(Debug)]
pub enum FrameError {
    /// The peer closed cleanly, exactly at a frame boundary. Not a fault.
    Closed,
    /// The peer vanished part-way through a frame.
    Truncated,
    /// A zero-length frame. Legal JSON never encodes to nothing, so this means
    /// the stream is misaligned.
    Empty,
    /// The prefix asks for more than `MAX_MESSAGE_BYTES`.
    TooLarge {
        declared: u32,
    },
    /// The body was not JSON, or not a message this side knows.
    Decode(serde_json::Error),
    /// We could not serialize our own value. A bug on this side.
    Encode(serde_json::Error),
    Io(io::Error),
}

impl FrameError {
    /// The protocol code this maps to, so callers do not classify by matching
    /// on the variant in three different places.
    pub fn code(&self) -> ErrorCode {
        match self {
            // A closed pipe is a missing bridge, not a malformed one.
            FrameError::Closed | FrameError::Io(_) => ErrorCode::BridgeUnavailable,
            FrameError::Truncated
            | FrameError::Empty
            | FrameError::TooLarge { .. }
            | FrameError::Decode(_)
            | FrameError::Encode(_) => ErrorCode::MalformedMessage,
        }
    }

    /// Whether the connection can keep being used. Framing faults desynchronise
    /// the stream: there is no way to find the next boundary, so the only
    /// correct response is to drop the connection.
    pub fn is_fatal_to_connection(&self) -> bool {
        !matches!(self, FrameError::Encode(_))
    }
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FrameError::Closed => write!(f, "the peer closed the connection"),
            FrameError::Truncated => write!(f, "the connection ended part-way through a frame"),
            FrameError::Empty => write!(f, "received a zero-length frame"),
            FrameError::TooLarge { declared } => write!(
                f,
                "frame declares {declared} bytes, over the {MAX_MESSAGE_BYTES} byte limit"
            ),
            FrameError::Decode(error) => write!(f, "frame body did not parse: {error}"),
            FrameError::Encode(error) => write!(f, "could not serialize message: {error}"),
            FrameError::Io(error) => write!(f, "transport error: {error}"),
        }
    }
}

impl std::error::Error for FrameError {}

impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::UnexpectedEof => FrameError::Truncated,
            _ => FrameError::Io(error),
        }
    }
}

/// Validate a length prefix on its own, before a single body byte is read.
pub fn decode_len(header: [u8; FRAME_HEADER_BYTES]) -> Result<usize, FrameError> {
    let declared = u32::from_le_bytes(header);
    if declared == 0 {
        return Err(FrameError::Empty);
    }
    if declared as usize > MAX_MESSAGE_BYTES {
        return Err(FrameError::TooLarge { declared });
    }
    Ok(declared as usize)
}

/// Serialize `value` into a complete frame: prefix followed by body.
pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, FrameError> {
    let body = serde_json::to_vec(value).map_err(FrameError::Encode)?;
    if body.len() > MAX_MESSAGE_BYTES {
        // Refuse to emit what the peer is obliged to reject.
        return Err(FrameError::TooLarge {
            declared: body.len().min(u32::MAX as usize) as u32,
        });
    }
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// Write one frame and flush it.
///
/// Flushing matters: this is a request/response protocol over a buffered
/// handle, and an unflushed request is a request the peer will never answer.
pub fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<(), FrameError> {
    let frame = encode_frame(value)?;
    writer.write_all(&frame)?;
    writer.flush()?;
    Ok(())
}

/// Read exactly one frame, blocking until it arrives.
///
/// A clean end-of-stream *at a boundary* is `Closed`; one part-way through is
/// `Truncated`. Conflating the two would report a normal Rhino shutdown as
/// corruption.
pub fn read_frame<R: Read, T: DeserializeOwned>(reader: &mut R) -> Result<T, FrameError> {
    let mut header = [0u8; FRAME_HEADER_BYTES];
    let mut filled = 0;
    while filled < FRAME_HEADER_BYTES {
        match reader.read(&mut header[filled..])? {
            0 if filled == 0 => return Err(FrameError::Closed),
            0 => return Err(FrameError::Truncated),
            n => filled += n,
        }
    }

    // Validated first: `len` is now known to be within the cap, so the
    // allocation below is bounded by our own constant and not by the peer.
    let len = decode_len(header)?;
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body).map_err(FrameError::Decode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        envelope::{ClientMessage, HandshakeRequest},
        PROTOCOL_VERSION,
    };

    fn handshake() -> ClientMessage {
        ClientMessage::Handshake(HandshakeRequest {
            protocol_version: PROTOCOL_VERSION,
            client: "hii-cli".into(),
            client_version: "0.1.0".into(),
        })
    }

    #[test]
    fn a_frame_is_a_little_endian_length_then_the_body() {
        let frame = encode_frame(&handshake()).unwrap();
        let (header, body) = frame.split_at(FRAME_HEADER_BYTES);
        assert_eq!(
            u32::from_le_bytes(header.try_into().unwrap()) as usize,
            body.len()
        );
        // The prefix counts bytes, not characters, and carries nothing else.
        assert_eq!(decode_len(header.try_into().unwrap()).unwrap(), body.len());
    }

    #[test]
    fn frames_round_trip_back_to_back_on_one_stream() {
        let mut stream = Vec::new();
        write_frame(&mut stream, &handshake()).unwrap();
        write_frame(&mut stream, &handshake()).unwrap();

        let mut reader = stream.as_slice();
        let first: ClientMessage = read_frame(&mut reader).unwrap();
        let second: ClientMessage = read_frame(&mut reader).unwrap();
        assert_eq!(first, handshake());
        assert_eq!(second, handshake());

        // Nothing left, and the end of a complete frame reads as a clean close.
        let end = read_frame::<_, ClientMessage>(&mut reader).unwrap_err();
        assert!(matches!(end, FrameError::Closed), "{end}");
    }

    #[test]
    fn an_oversized_prefix_is_rejected_before_anything_is_allocated() {
        // The whole point: this must fail from the four header bytes alone,
        // with no body present at all.
        let header = (MAX_MESSAGE_BYTES as u32 + 1).to_le_bytes();
        let error = decode_len(header).unwrap_err();
        assert!(matches!(error, FrameError::TooLarge { .. }), "{error}");
        assert_eq!(error.code(), ErrorCode::MalformedMessage);

        let mut reader: &[u8] = &header;
        let error = read_frame::<_, ClientMessage>(&mut reader).unwrap_err();
        assert!(matches!(error, FrameError::TooLarge { .. }), "{error}");

        // The boundary itself is legal.
        assert_eq!(
            decode_len((MAX_MESSAGE_BYTES as u32).to_le_bytes()).unwrap(),
            MAX_MESSAGE_BYTES
        );
    }

    #[test]
    fn a_zero_length_frame_is_rejected() {
        assert!(matches!(
            decode_len(0u32.to_le_bytes()).unwrap_err(),
            FrameError::Empty
        ));
    }

    #[test]
    fn a_half_written_frame_is_truncated_not_closed() {
        let frame = encode_frame(&handshake()).unwrap();

        // Cut inside the header.
        let mut reader = &frame[..2];
        assert!(matches!(
            read_frame::<_, ClientMessage>(&mut reader).unwrap_err(),
            FrameError::Truncated
        ));

        // Cut inside the body.
        let mut reader = &frame[..frame.len() - 1];
        assert!(matches!(
            read_frame::<_, ClientMessage>(&mut reader).unwrap_err(),
            FrameError::Truncated
        ));
    }

    #[test]
    fn a_body_that_is_not_a_known_message_is_malformed_not_ignored() {
        let mut stream = Vec::new();
        let body = br#"{"envelope":"something_we_do_not_speak"}"#;
        stream.extend_from_slice(&(body.len() as u32).to_le_bytes());
        stream.extend_from_slice(body);

        let mut reader = stream.as_slice();
        let error = read_frame::<_, ClientMessage>(&mut reader).unwrap_err();
        assert!(matches!(error, FrameError::Decode(_)), "{error}");
        assert!(error.is_fatal_to_connection());
    }

    #[test]
    fn a_reader_that_dribbles_bytes_still_assembles_the_frame() {
        // A pipe is free to return one byte at a time; the header loop must
        // not assume a single read fills it.
        struct Dribble<'a>(&'a [u8]);
        impl Read for Dribble<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if self.0.is_empty() || buffer.is_empty() {
                    return Ok(0);
                }
                buffer[0] = self.0[0];
                self.0 = &self.0[1..];
                Ok(1)
            }
        }

        let frame = encode_frame(&handshake()).unwrap();
        let mut reader = Dribble(&frame);
        let message: ClientMessage = read_frame(&mut reader).unwrap();
        assert_eq!(message, handshake());
    }
}
