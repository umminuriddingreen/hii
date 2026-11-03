//! Bounded receiver primitives for HII's Windows machine-fabric endpoint.
//!
//! This crate deliberately does not implement a wire transport, video decoder,
//! remote input injection, or localhost proxy. Those capabilities remain
//! explicit interfaces (and unsupported defaults) until a live executor exists.

mod error;
mod frame;
mod health;
mod interfaces;
mod lifecycle;
mod mailbox;
mod receiver;

#[cfg(windows)]
pub mod windows;

pub use error::{ReceiverError, ReceiverResult};
pub use frame::{
    ColorRange, Frame, FrameDescriptor, FramePlaneLayout, FrameValidationError, PixelFormat,
    TimestampClock,
};
pub use health::{ComponentHealth, ComponentStatus, HealthTelemetry, ReceiverHealth};
pub use interfaces::{
    InputEvent, InputSink, Renderer, ServiceBridge, ServiceExposure, ServiceRequest,
    UnsupportedInputSink, UnsupportedServiceBridge,
};
pub use lifecycle::{Lifecycle, LifecycleSnapshot, ReceiverState};
pub use mailbox::{LatestFrameMailbox, MailboxSnapshot, SubmitOutcome};
pub use receiver::Receiver;
