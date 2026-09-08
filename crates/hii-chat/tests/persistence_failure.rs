// SPDX-License-Identifier: LicenseRef-BSL-1.1
use anyhow::Result;
use async_trait::async_trait;
use hii_chat::{model::*, provider::*, service::*, store::Store};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

struct DiskFailure(PathBuf);
#[async_trait]
impl InferenceProvider for DiskFailure {
    async fn models(&self) -> Result<Vec<ModelInfo>> {
        Ok(vec![])
    }
    async fn chat(&self, _: ChatRequest) -> Result<InferenceStream> {
        rusqlite::Connection::open(&self.0)?.execute_batch(
            "CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON chat_generations BEGIN SELECT RAISE(FAIL, 'simulated disk failure'); END;"
        )?;
        Ok(Box::pin(futures_util::stream::iter(vec![Ok(
            InferenceEvent::Completed { reason: None },
        )])))
    }
}
#[derive(Default)]
struct Events(Mutex<Vec<String>>);
impl EventSink for Events {
    fn publish(&self, _: Snapshot) {}
    fn persistence_failed(&self, _: &str, error: &str) {
        self.0.lock().unwrap().push(error.into());
    }
}

#[tokio::test]
async fn terminal_storage_failure_is_reported_without_claiming_saved() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("hii.db");
    let store = Arc::new(Store::open(&path)?);
    let id = store.create()?.conversation.id;
    let sink = Arc::new(Events::default());
    let service = Arc::new(ConversationService::new(store.clone(), sink.clone()));
    let generation = service.start(
        SendRequest {
            conversation_id: id.clone(),
            parent_id: None,
            parts: vec![MessagePart::Text {
                text: "hello".into(),
            }],
        },
        Settings {
            model: "test".into(),
            ..Settings::default()
        },
        Arc::new(DiskFailure(path)),
    )?;
    tokio::time::timeout(Duration::from_secs(5), async {
        while service.has_active() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    assert!(service
        .failure(&generation.id)
        .unwrap()
        .contains("could not be saved"));
    assert_eq!(sink.0.lock().unwrap().len(), 1);
    assert_eq!(store.snapshot(&id)?.generations[0].status, "streaming");
    Ok(())
}
