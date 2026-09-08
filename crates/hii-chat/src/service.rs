// SPDX-License-Identifier: LicenseRef-BSL-1.1
use crate::{
    model::*,
    provider::{validate_settings, ChatRequest, InferenceEvent, InferenceProvider},
    store::Store,
};
use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub trait EventSink: Send + Sync {
    fn publish(&self, snapshot: Snapshot);
    fn persistence_failed(&self, generation_id: &str, error: &str) {
        eprintln!("generation {generation_id} persistence failed: {error}");
    }
}

pub struct ConversationService {
    pub store: Arc<Store>,
    sink: Arc<dyn EventSink>,
    active: Mutex<HashMap<String, CancellationToken>>,
    failures: Mutex<HashMap<String, String>>,
}

fn append(parts: &mut Vec<MessagePart>, part: MessagePart) {
    match (parts.last_mut(), &part) {
        (Some(MessagePart::Text { text }), MessagePart::Text { text: delta })
        | (Some(MessagePart::Reasoning { text }), MessagePart::Reasoning { text: delta }) => {
            text.push_str(delta)
        }
        _ => parts.push(part),
    }
}

impl ConversationService {
    pub fn new(store: Arc<Store>, sink: Arc<dyn EventSink>) -> Self {
        Self {
            store,
            sink,
            active: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),
        }
    }

    pub fn has_active(&self) -> bool {
        self.active.lock().map(|m| !m.is_empty()).unwrap_or(true)
    }

    pub fn failure(&self, id: &str) -> Option<String> {
        self.failures.lock().ok()?.get(id).cloned()
    }

    pub fn publish(&self, conversation_id: &str) -> Result<()> {
        self.sink.publish(self.store.snapshot(conversation_id)?);
        Ok(())
    }

    pub fn start(
        self: &Arc<Self>,
        request: SendRequest,
        settings: Settings,
        provider: Arc<dyn InferenceProvider>,
    ) -> Result<Generation> {
        validate_settings(&settings)?;
        let mut active = self
            .active
            .lock()
            .map_err(|_| anyhow!("Generation lock poisoned"))?;
        let generation = self.store.begin(&request, &settings)?;
        let cancel = CancellationToken::new();
        active.insert(generation.id.clone(), cancel.clone());
        let service = self.clone();
        let running = generation.clone();
        tokio::spawn(async move {
            let mut parts = Vec::new();
            let outcome = service
                .generate(&running, settings, provider, cancel.clone(), &mut parts)
                .await;
            let (status, reason, error) = match outcome {
                Ok(reason) => ("completed", reason, None),
                Err(_) if cancel.is_cancelled() => ("cancelled", None, None),
                Err(error) => ("failed", None, Some(error.to_string())),
            };
            // Commit the final state before announcing completion. Recovery handles disk failures.
            if let Err(error) = service.store.checkpoint(
                &running,
                &parts,
                status,
                error.as_deref(),
                reason.as_deref(),
            ) {
                let error = format!("Output could not be saved: {error}. Restart after resolving the storage problem to recover the last saved output.");
                if let Ok(mut failures) = service.failures.lock() {
                    failures.insert(running.id.clone(), error.clone());
                }
                service.sink.persistence_failed(&running.id, &error);
            }
            if let Ok(mut active) = service.active.lock() {
                active.remove(&running.id);
            }
            if let Err(error) = service.publish(&running.conversation_id) {
                eprintln!("generation event failed: {error}");
            }
        });
        Ok(generation)
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        let active = self
            .active
            .lock()
            .map_err(|_| anyhow!("Generation lock poisoned"))?;
        if let Some(token) = active.get(id) {
            token.cancel();
        }
        Ok(())
    }

    pub fn cancel_all(&self) {
        if let Ok(active) = self.active.lock() {
            for token in active.values() {
                token.cancel();
            }
        }
    }

    async fn generate(
        &self,
        generation: &Generation,
        settings: Settings,
        provider: Arc<dyn InferenceProvider>,
        cancel: CancellationToken,
        parts: &mut Vec<MessagePart>,
    ) -> Result<Option<String>> {
        let snapshot = self.store.snapshot(&generation.conversation_id)?;
        // Resolve history through parent IDs; siblings never enter the prompt.
        let assistant = snapshot
            .messages
            .iter()
            .find(|m| m.id == generation.message_id)
            .ok_or_else(|| anyhow!("Assistant missing"))?;
        let branch = crate::store::ancestry(&snapshot.messages, assistant.parent_id.as_deref())?;
        let messages = branch
            .iter()
            .filter_map(|id| snapshot.messages.iter().find(|m| &m.id == id).cloned())
            .collect();
        self.sink.publish(snapshot);
        let mut stream = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(anyhow!("Cancelled")),
            result = tokio::time::timeout(Duration::from_secs(120), provider.chat(ChatRequest { model: settings.model, messages, max_tokens: settings.max_tokens })) => result.map_err(|_| anyhow!("Runtime timed out before responding"))??,
        };
        let mut checkpoint = tokio::time::interval(Duration::from_millis(250));
        checkpoint.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut dirty = false;
        let idle = tokio::time::sleep(Duration::from_secs(120));
        tokio::pin!(idle);
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(anyhow!("Cancelled")),
                _ = &mut idle => return Err(anyhow!("Runtime produced no data for 120 seconds")),
                _ = checkpoint.tick(), if dirty => {
                    self.store.checkpoint(generation, parts, "streaming", None, None)?;
                    self.publish(&generation.conversation_id)?;
                    dirty = false;
                }
                event = stream.next() => {
                    idle.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(120));
                    match event.ok_or_else(|| anyhow!("Provider ended without completion"))?? {
                        InferenceEvent::Part(part) => { append(parts, part); dirty = true; },
                        InferenceEvent::Completed { reason } => return Ok(reason),
                    }
                }
            }
        }
    }
}
