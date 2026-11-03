//! Windows-specific Direct3D 11 renderer boundary.
//!
//! D3D11 hardware-device creation is implemented. Decoding, texture upload,
//! swap-chain creation, and presentation remain unsupported until window and
//! codec contracts are wired.

use windows::Win32::{
    Foundation::HMODULE,
    Graphics::{
        Direct3D::D3D_DRIVER_TYPE_HARDWARE,
        Direct3D11::{
            D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            D3D11_SDK_VERSION,
        },
        Dxgi::IDXGIAdapter,
    },
};

use crate::{ComponentHealth, ComponentStatus, Frame, ReceiverError, ReceiverResult, Renderer};

pub struct D3d11Renderer {
    device: Option<ID3D11Device>,
    context: Option<ID3D11DeviceContext>,
    started: bool,
}

impl Default for D3d11Renderer {
    fn default() -> Self {
        Self::new()
    }
}

impl D3d11Renderer {
    pub fn new() -> Self {
        Self {
            device: None,
            context: None,
            started: false,
        }
    }
}

impl Renderer for D3d11Renderer {
    fn backend_name(&self) -> &'static str {
        "d3d11"
    }

    fn start(&mut self) -> ReceiverResult<()> {
        let mut device = None;
        let mut context = None;
        // SAFETY: output pointers reference live local `Option` storage for the
        // duration of the call. No software module or borrowed adapter is used.
        unsafe {
            D3D11CreateDevice(
                None::<&IDXGIAdapter>,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&raw mut device),
                None,
                Some(&raw mut context),
            )
        }
        .map_err(|error| ReceiverError::ComponentFailure {
            component: "D3D11 device",
            message: error.to_string(),
        })?;
        self.device = device;
        self.context = context;
        self.started = true;
        Ok(())
    }

    fn present(&mut self, _frame: &Frame) -> ReceiverResult<()> {
        Err(ReceiverError::Unsupported {
            capability: "D3D11 frame presentation",
            detail: "decoder, GPU texture upload, window, and swap chain are not attached",
        })
    }

    fn stop(&mut self) -> ReceiverResult<()> {
        self.context = None;
        self.device = None;
        self.started = false;
        Ok(())
    }

    fn health(&self) -> ComponentHealth {
        ComponentHealth::new(
            "renderer",
            if self.started {
                ComponentStatus::Degraded
            } else {
                ComponentStatus::Stopped
            },
            if self.started {
                "D3D11 device initialized; decode and presentation unsupported"
            } else {
                "D3D11 boundary stopped"
            },
        )
    }
}
