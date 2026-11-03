use std::{collections::BTreeMap, sync::Mutex, time::Instant};

use crate::{LifecycleSnapshot, MailboxSnapshot, ReceiverError, ReceiverResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComponentStatus {
    Stopped,
    Ready,
    Degraded,
    Unsupported,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComponentHealth {
    pub name: &'static str,
    pub status: ComponentStatus,
    pub detail: String,
}

impl ComponentHealth {
    pub fn new(name: &'static str, status: ComponentStatus, detail: impl Into<String>) -> Self {
        Self {
            name,
            status,
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiverHealth {
    pub lifecycle: LifecycleSnapshot,
    pub mailbox: MailboxSnapshot,
    pub components: Vec<ComponentHealth>,
    pub uptime_millis: u128,
}

#[derive(Debug)]
pub struct HealthTelemetry {
    started_at: Instant,
    components: Mutex<BTreeMap<&'static str, ComponentHealth>>,
}

impl Default for HealthTelemetry {
    fn default() -> Self {
        Self::new()
    }
}

impl HealthTelemetry {
    pub fn new() -> Self {
        Self {
            started_at: Instant::now(),
            components: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn record(&self, health: ComponentHealth) -> ReceiverResult<()> {
        self.components
            .lock()
            .map_err(|_| ReceiverError::StatePoisoned("health telemetry"))?
            .insert(health.name, health);
        Ok(())
    }

    pub fn snapshot(
        &self,
        lifecycle: LifecycleSnapshot,
        mailbox: MailboxSnapshot,
    ) -> ReceiverResult<ReceiverHealth> {
        let components = self
            .components
            .lock()
            .map_err(|_| ReceiverError::StatePoisoned("health telemetry"))?
            .values()
            .cloned()
            .collect();
        Ok(ReceiverHealth {
            lifecycle,
            mailbox,
            components,
            uptime_millis: self.started_at.elapsed().as_millis(),
        })
    }
}
