// SPDX-License-Identifier: Apache-2.0
use super::*;

fn headers(worker: bool) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(
        "authorization",
        format!(
            "Bearer {}",
            if worker {
                "w".repeat(32)
            } else {
                "c".repeat(32)
            }
        )
        .parse()
        .unwrap(),
    );
    h
}
fn queue(dir: &tempfile::TempDir) -> Queue {
    Queue::open(
        dir.path().join("queue.json"),
        "c".repeat(32),
        "w".repeat(32),
    )
    .unwrap()
}
fn node(model: &str) -> Node {
    Node {
        name: "m3-max".into(),
        platform: "macos".into(),
        architecture: "aarch64".into(),
        models: vec![model.into()],
        last_seen: 0,
    }
}
async fn enqueue(q: &Queue) -> Job {
    submit(
        State(q.clone()),
        headers(false),
        Json(Request {
            model: "native-test".into(),
            prompt: "2+2".into(),
            max_tokens: 16,
        }),
    )
    .await
    .unwrap()
    .0
}

#[tokio::test]
async fn routing_auth_persistence_and_stale_completion() {
    let dir = tempfile::tempdir().unwrap();
    let q = queue(&dir);
    let job = enqueue(&q).await;
    assert_eq!(
        claim(State(q.clone()), headers(false), Json(node("native-test")))
            .await
            .unwrap_err()
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert!(claim(State(q.clone()), headers(true), Json(node("other")))
        .await
        .unwrap()
        .0
        .is_none());
    let assigned = claim(State(q.clone()), headers(true), Json(node("native-test")))
        .await
        .unwrap()
        .0
        .unwrap();
    assert!(
        claim(State(q.clone()), headers(true), Json(node("native-test")))
            .await
            .unwrap()
            .0
            .is_none()
    );
    assert_eq!(assigned.worker.as_deref(), Some("m3-max"));
    let bad = Completion {
        lease: "wrong".into(),
        result: Some(json!({"answer":4})),
        error: None,
    };
    assert_eq!(
        finish(
            State(q.clone()),
            headers(true),
            Path(job.id.clone()),
            Json(bad)
        )
        .await
        .unwrap_err()
        .0,
        StatusCode::CONFLICT
    );
    let c = Completion {
        lease: assigned.lease.unwrap(),
        result: Some(json!({"answer":4})),
        error: None,
    };
    let _ = finish(
        State(q.clone()),
        headers(true),
        Path(job.id.clone()),
        Json(c),
    )
    .await
    .unwrap();
    drop(q);
    let loaded = queue(&dir);
    let saved = loaded.store.lock().await.jobs[&job.id].clone();
    assert_eq!(saved.status, "completed");
    assert_eq!(saved.result.unwrap()["answer"], 4);
}

#[tokio::test]
async fn expired_lease_reassigns_and_restart_invalidates() {
    let dir = tempfile::tempdir().unwrap();
    let q = queue(&dir);
    let job = enqueue(&q).await;
    let first = claim(State(q.clone()), headers(true), Json(node("native-test")))
        .await
        .unwrap()
        .0
        .unwrap();
    q.store.lock().await.jobs.get_mut(&job.id).unwrap().deadline = 0;
    let second = claim(State(q.clone()), headers(true), Json(node("native-test")))
        .await
        .unwrap()
        .0
        .unwrap();
    assert_ne!(first.lease, second.lease);
    drop(q);
    let loaded = queue(&dir);
    let third = claim(State(loaded), headers(true), Json(node("native-test")))
        .await
        .unwrap()
        .0
        .unwrap();
    assert_ne!(second.lease, third.lease);
}

#[test]
fn reject_unbounded_work_and_unsafe_origins() {
    assert!(Request {
        model: "a".into(),
        prompt: "test".into(),
        max_tokens: 4097
    }
    .validate()
    .is_err());
    assert!(origin("http://example.com", false, false).is_err());
    assert!(origin("https://example.com", false, true).is_err());
    assert!(origin("http://user:secret@127.0.0.1", false, true).is_err());
    assert!(origin("http://127.0.0.1:11436", false, true).is_ok());
    assert!(origin("http://192.168.1.2:6138", true, false).is_ok());
    assert!(origin("http://[::1]:11435", false, true).is_ok());
}

#[tokio::test]
async fn worker_round_trip_uses_native_contract() {
    let dir = tempfile::tempdir().unwrap();
    let q = queue(&dir);
    let job = enqueue(&q).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let coordinator = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(axum::serve(listener, router(q.clone())).into_future());
    let native = Router::new()
        .route(
            "/v1/models",
            get(|| async { Json(json!({"data":[{"id":"native-test"}]})) }),
        )
        .route(
            "/v1/chat/completions",
            post(|Json(request): Json<Value>| async move {
                assert_eq!(request["model"], "native-test");
                assert_eq!(request["stream"], false);
                Json(json!({"choices":[{"message":{"role":"assistant","content":"4"}}]}))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let runtime = format!("http://{}", listener.local_addr().unwrap());
    let native_server = tokio::spawn(axum::serve(listener, native).into_future());
    let receipt = work_once(
        &client().unwrap(),
        &coordinator,
        &runtime,
        "windows-5080",
        &"w".repeat(32),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(receipt["job"], job.id);
    let saved = q.store.lock().await.jobs[&job.id].clone();
    assert_eq!(saved.status, "completed");
    assert_eq!(
        saved.result.unwrap()["choices"][0]["message"]["content"],
        "4"
    );
    server.abort();
    native_server.abort();
}

use std::future::IntoFuture;

#[test]
fn queue_has_exclusive_owner_and_distinct_roles() {
    let dir = tempfile::tempdir().unwrap();
    let q = queue(&dir);
    assert!(Queue::open(
        dir.path().join("queue.json"),
        "c".repeat(32),
        "w".repeat(32)
    )
    .is_err());
    assert!(Queue::open(
        dir.path().join("other.json"),
        "c".repeat(32),
        "c".repeat(32)
    )
    .is_err());
    drop(q);
    assert!(Queue::open(
        dir.path().join("queue.json"),
        "c".repeat(32),
        "w".repeat(32)
    )
    .is_ok());
}

#[tokio::test]
async fn native_failure_is_saved_without_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let q = queue(&dir);
    let job = enqueue(&q).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let coordinator = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(axum::serve(listener, router(q.clone())).into_future());
    let native = Router::new()
        .route(
            "/v1/models",
            get(|| async { Json(json!({"data":[{"id":"native-test"}]})) }),
        )
        .route(
            "/v1/chat/completions",
            post(|| async { StatusCode::SERVICE_UNAVAILABLE }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let runtime = format!("http://{}", listener.local_addr().unwrap());
    let native_server = tokio::spawn(axum::serve(listener, native).into_future());
    work_once(
        &client().unwrap(),
        &coordinator,
        &runtime,
        "m3-max",
        &"w".repeat(32),
    )
    .await
    .unwrap();
    let saved = q.store.lock().await.jobs[&job.id].clone();
    assert_eq!(saved.status, "failed");
    assert!(saved.result.is_none());
    assert!(saved.error.unwrap().contains("503"));
    server.abort();
    native_server.abort();
}
