use std::{fmt, sync::Arc};

pub const MAX_FRAME_DIMENSION: u32 = 16_384;
pub const MAX_FRAME_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
    Nv12,
    Bgra8,
    Rgba8,
    EncodedH264,
    EncodedHevc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimestampClock {
    UnixEpoch,
    SenderMonotonic,
    MediaPresentation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorRange {
    Video,
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FramePlaneLayout {
    pub index: u8,
    pub width: u32,
    pub height: u32,
    pub bytes_per_row: u32,
    pub offset_bytes: usize,
    pub byte_len: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameDescriptor {
    pub stream_id: u64,
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub format: PixelFormat,
    pub captured_at_ns: u64,
    pub timestamp_clock: TimestampClock,
    pub payload_len: usize,
    pub planes: Vec<FramePlaneLayout>,
    pub color_range: Option<ColorRange>,
}

impl FrameDescriptor {
    pub fn validate(&self) -> Result<(), FrameValidationError> {
        if self.width == 0 || self.height == 0 {
            return Err(FrameValidationError::ZeroDimension);
        }
        if self.width > MAX_FRAME_DIMENSION || self.height > MAX_FRAME_DIMENSION {
            return Err(FrameValidationError::DimensionTooLarge {
                width: self.width,
                height: self.height,
                maximum: MAX_FRAME_DIMENSION,
            });
        }
        if self.payload_len == 0 {
            return Err(FrameValidationError::EmptyPayload);
        }
        if self.payload_len > MAX_FRAME_BYTES {
            return Err(FrameValidationError::PayloadTooLarge {
                actual: self.payload_len,
                maximum: MAX_FRAME_BYTES,
            });
        }

        let expected_planes = match self.format {
            PixelFormat::Bgra8 | PixelFormat::Rgba8 => Some(vec![(
                self.width,
                self.height,
                self.width
                    .checked_mul(4)
                    .ok_or(FrameValidationError::SizeOverflow)?,
            )]),
            PixelFormat::Nv12 => {
                if !self.width.is_multiple_of(2) || !self.height.is_multiple_of(2) {
                    return Err(FrameValidationError::Nv12RequiresEvenDimensions);
                }
                Some(vec![
                    (self.width, self.height, self.width),
                    (self.width / 2, self.height / 2, self.width),
                ])
            }
            PixelFormat::EncodedH264 | PixelFormat::EncodedHevc => None,
        };

        if let Some(expected_planes) = expected_planes {
            if self.planes.len() != expected_planes.len() {
                return Err(FrameValidationError::InvalidPlaneLayout);
            }
            let mut next_offset = 0_usize;
            for (index, (plane, (width, height, minimum_stride))) in
                self.planes.iter().zip(expected_planes).enumerate()
            {
                let minimum_len = (plane.bytes_per_row as usize)
                    .checked_mul(plane.height as usize)
                    .ok_or(FrameValidationError::SizeOverflow)?;
                if plane.index as usize != index
                    || plane.width != width
                    || plane.height != height
                    || plane.bytes_per_row < minimum_stride
                    || plane.offset_bytes != next_offset
                    || plane.byte_len < minimum_len
                {
                    return Err(FrameValidationError::InvalidPlaneLayout);
                }
                next_offset = plane
                    .offset_bytes
                    .checked_add(plane.byte_len)
                    .ok_or(FrameValidationError::SizeOverflow)?;
            }
            if next_offset != self.payload_len {
                return Err(FrameValidationError::PayloadLengthMismatch {
                    expected: next_offset,
                    actual: self.payload_len,
                });
            }
        } else if !self.planes.is_empty() {
            return Err(FrameValidationError::InvalidPlaneLayout);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    descriptor: FrameDescriptor,
    payload: Arc<[u8]>,
}

impl Frame {
    pub fn new(
        descriptor: FrameDescriptor,
        payload: impl Into<Arc<[u8]>>,
    ) -> Result<Self, FrameValidationError> {
        descriptor.validate()?;
        let payload = payload.into();
        if descriptor.payload_len != payload.len() {
            return Err(FrameValidationError::PayloadLengthMismatch {
                expected: descriptor.payload_len,
                actual: payload.len(),
            });
        }
        Ok(Self {
            descriptor,
            payload,
        })
    }

    pub fn descriptor(&self) -> &FrameDescriptor {
        &self.descriptor
    }

    pub fn payload(&self) -> &[u8] {
        &self.payload
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameValidationError {
    ZeroDimension,
    DimensionTooLarge {
        width: u32,
        height: u32,
        maximum: u32,
    },
    EmptyPayload,
    PayloadTooLarge {
        actual: usize,
        maximum: usize,
    },
    PayloadLengthMismatch {
        expected: usize,
        actual: usize,
    },
    Nv12RequiresEvenDimensions,
    InvalidPlaneLayout,
    SizeOverflow,
}

impl fmt::Display for FrameValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroDimension => write!(f, "width and height must be non-zero"),
            Self::DimensionTooLarge {
                width,
                height,
                maximum,
            } => write!(
                f,
                "dimensions {width}x{height} exceed the {maximum}-pixel bound"
            ),
            Self::EmptyPayload => write!(f, "payload must not be empty"),
            Self::PayloadTooLarge { actual, maximum } => {
                write!(f, "payload is {actual} bytes; maximum is {maximum}")
            }
            Self::PayloadLengthMismatch { expected, actual } => {
                write!(f, "payload length is {actual} bytes; expected {expected}")
            }
            Self::Nv12RequiresEvenDimensions => {
                write!(f, "NV12 frames require even width and height")
            }
            Self::InvalidPlaneLayout => {
                write!(f, "frame plane layout is invalid for its format or payload")
            }
            Self::SizeOverflow => write!(f, "frame dimensions overflow addressable size"),
        }
    }
}

impl std::error::Error for FrameValidationError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_zero_and_oversized_dimensions() {
        let zero = FrameDescriptor {
            stream_id: 1,
            sequence: 1,
            width: 0,
            height: 1,
            format: PixelFormat::EncodedH264,
            captured_at_ns: 0,
            timestamp_clock: TimestampClock::SenderMonotonic,
            payload_len: 1,
            planes: vec![],
            color_range: None,
        };
        assert_eq!(zero.validate(), Err(FrameValidationError::ZeroDimension));

        let oversized = FrameDescriptor {
            width: MAX_FRAME_DIMENSION + 1,
            ..zero.clone()
        };
        assert!(matches!(
            oversized.validate(),
            Err(FrameValidationError::DimensionTooLarge { .. })
        ));
    }

    #[test]
    fn validates_raw_payload_bounds() {
        let descriptor = FrameDescriptor {
            stream_id: 1,
            sequence: 1,
            width: 2,
            height: 2,
            format: PixelFormat::Bgra8,
            captured_at_ns: 0,
            timestamp_clock: TimestampClock::SenderMonotonic,
            payload_len: 80,
            planes: vec![FramePlaneLayout {
                index: 0,
                width: 2,
                height: 2,
                bytes_per_row: 40,
                offset_bytes: 0,
                byte_len: 80,
            }],
            color_range: Some(ColorRange::Full),
        };
        assert_eq!(descriptor.validate(), Ok(()));
    }

    #[test]
    fn rejects_odd_nv12_dimensions() {
        let descriptor = FrameDescriptor {
            stream_id: 1,
            sequence: 1,
            width: 3,
            height: 2,
            format: PixelFormat::Nv12,
            captured_at_ns: 0,
            timestamp_clock: TimestampClock::SenderMonotonic,
            payload_len: 9,
            planes: vec![],
            color_range: Some(ColorRange::Video),
        };
        assert_eq!(
            descriptor.validate(),
            Err(FrameValidationError::Nv12RequiresEvenDimensions)
        );
    }
}
