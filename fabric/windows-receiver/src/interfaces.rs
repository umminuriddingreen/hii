use crate::{ComponentHealth, ComponentStatus, Frame, ReceiverError, ReceiverResult};

pub trait Renderer: Send {
    fn backend_name(&self) -> &'static str;
    fn start(&mut self) -> ReceiverResult<()>;
    fn present(&mut self, frame: &Frame) -> ReceiverResult<()>;
    fn stop(&mut self) -> ReceiverResult<()>;
    fn health(&self) -> ComponentHealth;
}

#[derive(Debug, Clone, PartialEq)]
pub enum InputEvent {
    PointerMove { x: f64, y: f64 },
    PointerButton { button: u8, pressed: bool },
    Scroll { delta_x: f64, delta_y: f64 },
    Key { scan_code: u32, pressed: bool },
    Text(String),
}

pub trait InputSink: Send {
    fn inject(&mut self, event: &InputEvent) -> ReceiverResult<()>;
    fn health(&self) -> ComponentHealth;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceRequest {
    pub request_id: u64,
    pub service_id: String,
    pub remote_host: String,
    pub remote_port: u16,
    pub local_port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceExposure {
    pub request_id: u64,
    pub bound_host: String,
    pub bound_port: u16,
}

pub trait ServiceBridge: Send {
    fn expose(&mut self, request: &ServiceRequest) -> ReceiverResult<ServiceExposure>;
    fn revoke(&mut self, request_id: u64) -> ReceiverResult<()>;
    /// Revoke every concrete exposure owned by this bridge before receiver
    /// teardown completes.
    fn stop(&mut self) -> ReceiverResult<()>;
    fn health(&self) -> ComponentHealth;
}

#[derive(Debug, Default)]
pub struct UnsupportedInputSink;

impl InputSink for UnsupportedInputSink {
    fn inject(&mut self, _event: &InputEvent) -> ReceiverResult<()> {
        Err(ReceiverError::Unsupported {
            capability: "remote input injection",
            detail: "no authenticated Windows input executor is attached",
        })
    }

    fn health(&self) -> ComponentHealth {
        ComponentHealth::new(
            "input",
            ComponentStatus::Unsupported,
            "remote input injection is not implemented",
        )
    }
}

#[derive(Debug, Default)]
pub struct UnsupportedServiceBridge;

impl ServiceBridge for UnsupportedServiceBridge {
    fn expose(&mut self, _request: &ServiceRequest) -> ReceiverResult<ServiceExposure> {
        Err(ReceiverError::Unsupported {
            capability: "localhost service proxy",
            detail: "no authenticated service bridge is attached",
        })
    }

    fn revoke(&mut self, _request_id: u64) -> ReceiverResult<()> {
        Err(ReceiverError::Unsupported {
            capability: "localhost service proxy",
            detail: "no authenticated service bridge is attached",
        })
    }

    fn stop(&mut self) -> ReceiverResult<()> {
        Ok(())
    }

    fn health(&self) -> ComponentHealth {
        ComponentHealth::new(
            "services",
            ComponentStatus::Unsupported,
            "localhost service proxying is not implemented",
        )
    }
}
