// SPDX-License-Identifier: LicenseRef-BSL-1.1
use anyhow::Result;
use async_trait::async_trait;
use futures_util::StreamExt;
use hii_chat::{files::AppFiles, model::*, provider::*, service::*, store::Store};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn settings() -> Settings {
    Settings {
        model: "test-model".into(),
        ..Settings::default()
    }
}
fn request(conversation: &str, parent: Option<String>, text: &str) -> SendRequest {
    SendRequest {
        conversation_id: conversation.into(),
        parent_id: parent,
        parts: vec![MessagePart::Text { text: text.into() }],
    }
}

#[test]
fn chat_migrations_coexist_with_hii_schema_and_preserve_its_version() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let files = AppFiles::acquire(dir.path())?;
    assert_eq!(files.database(), dir.path().join("hii.db"));
    assert!(dir.path().join("hii.db.chat-owner.lockfile").is_file());
    let db = rusqlite::Connection::open(files.database())?;
    db.execute_batch(
        "PRAGMA user_version=42;
         CREATE TABLE conversations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
         INSERT INTO conversations VALUES ('existing-hii-conversation', 'original');
         CREATE TABLE messages (id TEXT PRIMARY KEY);
         CREATE TABLE message_parts (id TEXT PRIMARY KEY);
         CREATE TABLE generations (id TEXT PRIMARY KEY);
         CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO settings VALUES ('provider', 'existing-hii-provider');",
    )?;
    let conversation;
    {
        let store = Store::open(&files.database())?;
        conversation = store.create()?.conversation.id;
        store.save_settings(&settings())?;
        let generation = store.begin(&request(&conversation, None, "hello"), &settings())?;
        store.checkpoint(
            &generation,
            &[MessagePart::Text {
                text: "preserved partial".into(),
            }],
            "streaming",
            None,
            None,
        )?;
    }
    let reopened = Store::open(&files.database())?;
    assert_eq!(reopened.recover()?, 1);
    assert_eq!(
        reopened.snapshot(&conversation)?.generations[0].status,
        "interrupted"
    );
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))?,
        42
    );
    assert_eq!(
        db.query_row("SELECT payload FROM conversations", [], |r| r
            .get::<_, String>(0))?,
        "original"
    );
    assert_eq!(
        db.query_row("SELECT value FROM settings WHERE key='provider'", [], |r| r
            .get::<_, String>(0))?,
        "existing-hii-provider"
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM chat_schema_migrations", [], |r| r
            .get::<_, i64>(0))?,
        1
    );
    assert_eq!(reopened.settings()?.model, "test-model");
    drop(reopened);
    drop(db);
    drop(files);
    Ok(())
}

#[test]
fn newer_chat_schema_is_rejected_without_touching_hii() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("hii.db");
    drop(Store::open(&path)?);
    let db = rusqlite::Connection::open(&path)?;
    db.execute_batch(
        "PRAGMA user_version=42;
         INSERT INTO chat_schema_migrations (version, applied_at) VALUES (2, 0);",
    )?;
    assert!(Store::open(&path).is_err());
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))?,
        42
    );
    drop(db);
    Ok(())
}

#[test]
fn structured_parts_restart_recovery_and_single_instance() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let files = AppFiles::acquire(dir.path())?;
    assert!(AppFiles::acquire(dir.path()).is_err());
    let conversation;
    let generation;
    {
        let store = Store::open(&files.database())?;
        store.save_settings(&settings())?;
        conversation = store.create()?.conversation.id;
        generation = store.begin(&request(&conversation, None, "hello"), &settings())?;
        store.checkpoint(
            &generation,
            &[
                MessagePart::Reasoning {
                    text: "consider".into(),
                },
                MessagePart::Text {
                    text: "partial answer".into(),
                },
            ],
            "streaming",
            None,
            None,
        )?;
    }
    let store = Store::open(&files.database())?;
    assert_eq!(store.recover()?, 1);
    assert_eq!(store.recover()?, 0);
    let snapshot = store.snapshot(&conversation)?;
    assert_eq!(snapshot.generations[0].status, "interrupted");
    assert_eq!(snapshot.messages[1].parts.len(), 2);
    assert_eq!(
        snapshot.messages[1].parts[1],
        MessagePart::Text {
            text: "partial answer".into()
        }
    );
    assert_eq!(store.settings()?.model, "test-model");
    drop(store);
    drop(files);
    assert!(AppFiles::acquire(dir.path()).is_ok());
    Ok(())
}

#[test]
fn concurrent_connections_read_consistent_revision_parts_and_generation() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("hii.db");
    let writer = Store::open(&path)?;
    let conversation = writer.create()?.conversation.id;
    let generation = writer.begin(&request(&conversation, None, "hello"), &settings())?;
    writer.checkpoint(
        &generation,
        &[MessagePart::Text { text: "2".into() }],
        "streaming",
        None,
        Some("2"),
    )?;
    let reader = Store::open(&path)?;
    let barrier = Arc::new(std::sync::Barrier::new(2));
    std::thread::scope(|scope| -> Result<()> {
        let writer_barrier = barrier.clone();
        let writes = scope.spawn(move || -> Result<()> {
            writer_barrier.wait();
            for revision in 3..=202 {
                let text = revision.to_string();
                writer.checkpoint(
                    &generation,
                    &[MessagePart::Text { text: text.clone() }],
                    "streaming",
                    None,
                    Some(&text),
                )?;
                std::thread::yield_now();
            }
            Ok(())
        });
        barrier.wait();
        for _ in 0..500 {
            let snapshot = reader.snapshot(&conversation)?;
            let expected = snapshot.conversation.revision.to_string();
            assert_eq!(
                snapshot.messages[1].parts,
                vec![MessagePart::Text {
                    text: expected.clone()
                }]
            );
            assert_eq!(
                snapshot.generations[0].finish_reason.as_deref(),
                Some(expected.as_str())
            );
            std::thread::yield_now();
        }
        writes.join().expect("writer thread must not panic")?;
        assert_eq!(reader.snapshot(&conversation)?.conversation.revision, 202);
        Ok(())
    })?;
    drop(reader);
    Ok(())
}

#[test]
fn branches_keep_siblings_and_reject_foreign_parents_and_duplicate_runs() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let store = Store::open(&dir.path().join("test.db"))?;
    let a = store.create()?.conversation.id;
    let b = store.create()?.conversation.id;
    let first = store.begin(&request(&a, None, "first"), &settings())?;
    assert!(store
        .begin(&request(&a, None, "duplicate"), &settings())
        .is_err());
    store.checkpoint(
        &first,
        &[MessagePart::Text {
            text: "answer".into(),
        }],
        "completed",
        None,
        Some("stop"),
    )?;
    assert!(store
        .begin(
            &request(&b, Some(first.message_id.clone()), "foreign"),
            &settings()
        )
        .is_err());
    assert!(store.snapshot(&b)?.messages.is_empty());
    let left = store.begin(
        &request(&a, Some(first.message_id.clone()), "left"),
        &settings(),
    )?;
    store.checkpoint(&left, &[], "completed", None, Some("stop"))?;
    let right = store.begin(
        &request(&a, Some(first.message_id.clone()), "right"),
        &settings(),
    )?;
    store.checkpoint(&right, &[], "completed", None, Some("stop"))?;
    let snapshot = store.snapshot(&a)?;
    assert_eq!(snapshot.messages.len(), 6);
    assert_eq!(snapshot.branch.len(), 4);
    assert!(!snapshot.branch.contains(&left.message_id));
    assert!(store
        .select_branch(&a, &left.message_id)?
        .branch
        .contains(&left.message_id));
    assert!(store.select_branch(&b, &left.message_id).is_err());
    Ok(())
}

#[test]
fn loopback_only_no_credentials_or_redirect_hosts() {
    for url in [
        "https://example.com/v1",
        "http://192.168.1.4/v1",
        "http://localhost.evil/v1",
        "http://user:secret@localhost/v1",
        "file:///tmp",
        "http://localhost/v1?key=secret",
    ] {
        assert!(local_endpoint(url).is_err(), "{url}");
    }
    for url in [
        "http://localhost:8080/v1",
        "http://127.0.0.1:8080/v1",
        "http://[::1]:8080/v1",
    ] {
        assert!(local_endpoint(url).is_ok());
    }
}

struct RecordingSink {
    store: Arc<Store>,
    events: Mutex<Vec<Snapshot>>,
}
impl EventSink for RecordingSink {
    fn publish(&self, snapshot: Snapshot) {
        let persisted = self.store.snapshot(&snapshot.conversation.id).unwrap();
        assert!(persisted.conversation.revision >= snapshot.conversation.revision);
        self.events.lock().unwrap().push(snapshot);
    }
}

struct FakeProvider {
    captured: Arc<Mutex<Vec<ChatRequest>>>,
    hang: bool,
}
#[async_trait]
impl InferenceProvider for FakeProvider {
    async fn models(&self) -> Result<Vec<ModelInfo>> {
        Ok(vec![ModelInfo {
            id: "test-model".into(),
        }])
    }
    async fn chat(&self, request: ChatRequest) -> Result<InferenceStream> {
        self.captured.lock().unwrap().push(request);
        let hang = self.hang;
        Ok(Box::pin(async_stream::try_stream! {
            yield InferenceEvent::Part(MessagePart::Reasoning { text: "thinking".into() });
            yield InferenceEvent::Part(MessagePart::Text { text: "hello".into() });
            tokio::time::sleep(Duration::from_millis(350)).await;
            if hang { futures_util::future::pending::<()>().await; }
            yield InferenceEvent::Part(MessagePart::Text { text: " world".into() });
            yield InferenceEvent::Completed { reason: Some("stop".into()) };
        }))
    }
}

async fn wait_done(store: &Store, conversation: &str) -> Result<Snapshot> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = store.snapshot(conversation)?;
            if snapshot.generations.iter().all(|g| g.status != "streaming") {
                return Ok(snapshot);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?
}

#[tokio::test]
async fn orchestration_streams_committed_parts_and_cancellation_keeps_output() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let store = Arc::new(Store::open(&dir.path().join("test.db"))?);
    let sink = Arc::new(RecordingSink {
        store: store.clone(),
        events: Mutex::new(vec![]),
    });
    let service = Arc::new(ConversationService::new(store.clone(), sink.clone()));
    let captured = Arc::new(Mutex::new(vec![]));
    let conversation = store.create()?.conversation.id;
    service.start(
        request(&conversation, None, "prompt"),
        settings(),
        Arc::new(FakeProvider {
            captured: captured.clone(),
            hang: false,
        }),
    )?;
    let snapshot = wait_done(&store, &conversation).await?;
    assert_eq!(snapshot.generations[0].status, "completed");
    assert_eq!(
        snapshot.messages[1].parts,
        vec![MessagePart::Text {
            text: "hello world".into()
        }]
    );
    assert!(sink
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|s| s.generations[0].status == "streaming" && !s.messages[1].parts.is_empty()));
    let second = service.start(
        request(
            &conversation,
            Some(snapshot.messages[1].id.clone()),
            "follow up",
        ),
        settings(),
        Arc::new(FakeProvider {
            captured: captured.clone(),
            hang: true,
        }),
    )?;
    tokio::time::sleep(Duration::from_millis(400)).await;
    service.cancel(&second.id)?;
    let snapshot = wait_done(&store, &conversation).await?;
    assert_eq!(snapshot.generations[1].status, "cancelled");
    assert_eq!(
        snapshot.messages[3].parts,
        vec![MessagePart::Text {
            text: "hello".into()
        }]
    );
    let requests = captured.lock().unwrap();
    assert_eq!(requests[1].messages.len(), 3);
    assert_eq!(requests[1].messages[0].role, "user");
    Ok(())
}

async fn sse_server(body: &'static str, status: &'static str) -> Result<String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![0; 8192];
        let _ = socket.read(&mut request).await;
        let headers = format!("HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        socket.write_all(headers.as_bytes()).await.unwrap();
        // Exercise boundaries inside UTF-8 characters and SSE records.
        for byte in body.as_bytes() {
            if socket.write_all(&[*byte]).await.is_err() {
                return;
            }
        }
    });
    Ok(format!("http://{address}/v1"))
}

fn chat() -> ChatRequest {
    ChatRequest {
        model: "test".into(),
        messages: vec![],
        max_tokens: 64,
    }
}

#[tokio::test]
async fn real_http_provider_handles_fragmented_sse_unicode_reasoning_and_done() -> Result<()> {
    let url = sse_server(": keepalive\r\n\r\ndata: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hmm\"}}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"caf\u{e9}\"},\"finish_reason\":\"stop\"}]}\r\n\r\ndata: [DONE]\r\n\r\n", "200 OK").await?;
    let provider = OpenAiCompatible::new(&url)?;
    let events = provider.chat(chat()).await?.collect::<Vec<_>>().await;
    assert_eq!(events.len(), 3);
    assert!(
        matches!(&events[0], Ok(InferenceEvent::Part(MessagePart::Reasoning { text })) if text == "hmm")
    );
    assert!(
        matches!(&events[1], Ok(InferenceEvent::Part(MessagePart::Text { text })) if text == "caf\u{e9}")
    );
    assert!(
        matches!(&events[2], Ok(InferenceEvent::Completed { reason }) if reason.as_deref() == Some("stop"))
    );
    Ok(())
}

#[tokio::test]
async fn disconnected_stream_and_http_errors_are_not_success() -> Result<()> {
    let url = sse_server(
        "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
        "200 OK",
    )
    .await?;
    let events = OpenAiCompatible::new(&url)?
        .chat(chat())
        .await?
        .collect::<Vec<_>>()
        .await;
    assert!(events[0].is_ok());
    assert!(events.last().unwrap().is_err());
    let url = sse_server("", "500 Internal Server Error").await?;
    assert!(OpenAiCompatible::new(&url)?.chat(chat()).await.is_err());
    Ok(())
}
