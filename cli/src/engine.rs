//! Replaceable reasoning/orchestration engines beneath HII's authority and
//! receipt boundary.

use crate::{
    agent::{self, RunOptions},
    config::AppPaths,
    hermes_engine,
    receipt::Receipt,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum EngineKind {
    #[default]
    Native,
    Hermes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EngineCapabilities {
    pub structured_events: bool,
    pub cancellation: bool,
    pub session_continuity: bool,
    pub hii_governed_tools: bool,
}

pub trait AgentEngine {
    fn id(&self) -> &'static str;
    fn capabilities(&self) -> EngineCapabilities;
    fn run(&self, paths: &AppPaths, options: RunOptions) -> Result<Receipt, String>;
}

struct NativeEngine;

impl AgentEngine for NativeEngine {
    fn id(&self) -> &'static str {
        "native"
    }

    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities {
            structured_events: true,
            cancellation: true,
            session_continuity: false,
            hii_governed_tools: true,
        }
    }

    fn run(&self, paths: &AppPaths, options: RunOptions) -> Result<Receipt, String> {
        agent::run(paths, options)
    }
}

struct HermesEngine;

impl AgentEngine for HermesEngine {
    fn id(&self) -> &'static str {
        "hermes"
    }

    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities {
            structured_events: true,
            cancellation: true,
            session_continuity: true,
            hii_governed_tools: true,
        }
    }

    fn run(&self, paths: &AppPaths, options: RunOptions) -> Result<Receipt, String> {
        hermes_engine::run(paths, options)
    }
}

pub fn run(kind: EngineKind, paths: &AppPaths, options: RunOptions) -> Result<Receipt, String> {
    let engine: &dyn AgentEngine = match kind {
        EngineKind::Native => &NativeEngine,
        EngineKind::Hermes => &HermesEngine,
    };
    let capabilities = engine.capabilities();
    debug_assert!(capabilities.structured_events);
    debug_assert!(capabilities.cancellation);
    debug_assert!(capabilities.hii_governed_tools);
    let _supports_session_continuity = capabilities.session_continuity;
    let _engine_id = engine.id();
    engine.run(paths, options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engines_declare_the_hii_tool_boundary() {
        for engine in [&NativeEngine as &dyn AgentEngine, &HermesEngine] {
            assert!(engine.capabilities().hii_governed_tools, "{}", engine.id());
            assert!(engine.capabilities().structured_events, "{}", engine.id());
        }
    }
}
