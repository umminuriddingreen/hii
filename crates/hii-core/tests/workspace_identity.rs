// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Exercise the public native/CLI boundary in a separate process so environment
//! routing cannot race other tests or touch the operator's actual runtime.
use hii_core::{runtime::*, runtime_space_apply, runtime_space_snapshot};
use serde_json::{json, Value};
use std::{env, fs, path::Path, process::Command};

fn document(id: &str) -> Value {
    json!({
        "version": 1, "revision": 0, "updatedAt": "2026-09-08T00:00:00Z",
        "viewport": {"x": 0, "y": 0, "zoom": 1}, "nextZ": 2, "links": [],
        "nodes": [{"id": id, "type": "canvas-text", "x": 0, "y": 0,
            "w": 100, "h": 100, "z": 1, "createdAt": "2026-09-08T00:00:00Z",
            "updatedAt": "2026-09-08T00:00:00Z", "payload": {"text": id}}]
    })
}

fn write(path: &Path, value: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

#[test]
fn workspace_identity_child() {
    if env::var_os("HII_TEST_WORKSPACE_IDENTITY").is_none() {
        return;
    }
    let root = hii_core::runtime_root().unwrap();
    let selected_path = root.join("workspace/workspaces/selected.json");
    let addressed_path = root.join("workspace/workspaces/addressed.json");
    let selected = document("selected-private");
    let addressed = document("addressed-private");
    write(
        &root.join("workspace/selection.json"),
        &json!({"workspaceId": "selected"}),
    );
    write(&selected_path, &selected);
    write(&addressed_path, &addressed);
    write(
        &root.join("workspace/workspace.json"),
        &document("legacy-private"),
    );

    let snapshot = runtime_space_snapshot(Some("addressed".into())).unwrap();
    assert_eq!(snapshot.document["nodes"][0]["id"], "addressed-private");
    let mut changed = snapshot.document.clone();
    changed["nodes"][0]["payload"]["text"] = json!("agent changed addressed Space");
    let request = RuntimeSpaceApplyV1 {
        version: 1,
        space_id: Some("addressed".into()),
        expected_sequence: snapshot.sequence,
        actor: IdentityRefV1 {
            id: "human:local".into(),
            kind: "human".into(),
        },
        authority_grant_id: None,
        run_id: None,
        idempotency_key: "identity-test".into(),
        document: changed,
    };
    let applied = runtime_space_apply(request.clone()).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&selected_path).unwrap()).unwrap(),
        selected
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&addressed_path).unwrap()).unwrap(),
        applied.document
    );
    assert_eq!(
        runtime_space_snapshot(None).unwrap().document["nodes"][0]["id"],
        "selected-private"
    );

    // Retries repair the same export, without another mutation or changing the
    // selected canvas. SQLite remains authoritative even if JSON is outdated.
    write(&addressed_path, &addressed);
    assert_eq!(
        runtime_space_snapshot(Some("addressed".into()))
            .unwrap()
            .sequence,
        applied.sequence
    );
    assert_eq!(
        runtime_space_apply(request).unwrap().sequence,
        applied.sequence
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&addressed_path).unwrap()).unwrap(),
        applied.document
    );

    let empty = runtime_space_snapshot(Some("new-space".into())).unwrap();
    assert!(empty.document["nodes"].as_array().unwrap().is_empty());
    let default = runtime_space_snapshot(Some("default".into())).unwrap();
    assert_eq!(default.document["nodes"][0]["id"], "legacy-private");
    assert!(runtime_space_snapshot(Some("../escape".into())).is_err());
    assert!(runtime_space_snapshot(Some(String::new())).is_err());

    // A history/share request can trigger migration too, so it must bind the
    // requested Space rather than the globally selected one.
    write(
        &root.join("workspace/workspaces/history-only.json"),
        &document("history-private"),
    );
    hii_core::runtime_space_history(Some("history-only".into()), None).unwrap();
    assert_eq!(
        runtime_space_snapshot(Some("history-only".into()))
            .unwrap()
            .document["nodes"][0]["id"],
        "history-private"
    );
    write(
        &root.join("workspace/workspaces/share-only.json"),
        &document("share-private"),
    );
    let share = hii_core::runtime_share_create(RuntimeShareRequestV1 {
        version: 1,
        space_id: Some("share-only".into()),
        mode: RuntimeShareModeV1::Export,
        object_ids: vec![],
        actor: IdentityRefV1 {
            id: "human:local".into(),
            kind: "human".into(),
        },
        recipient_id: None,
        authority_grant_id: None,
    })
    .unwrap();
    assert_eq!(share.document["nodes"][0]["id"], "share-private");
    assert_eq!(share.source_space_id, "share-only");

    // Corrupt or unreadable named state must fail, never import unrelated data.
    let corrupt = root.join("workspace/workspaces/corrupt.json");
    fs::write(&corrupt, b"{").unwrap();
    assert!(runtime_space_snapshot(Some("corrupt".into()))
        .unwrap_err()
        .contains("Could not parse"));
    assert_eq!(fs::read(corrupt).unwrap(), b"{");
    fs::create_dir(root.join("workspace/workspaces/unreadable.json")).unwrap();
    assert!(runtime_space_snapshot(Some("unreadable".into()))
        .unwrap_err()
        .contains("Could not read"));
}

#[test]
fn public_workspace_operations_preserve_space_identity() {
    let runtime = tempfile::tempdir().unwrap();
    let output = Command::new(env::current_exe().unwrap())
        .args(["--exact", "workspace_identity_child", "--nocapture"])
        .env("HII_RUNTIME_DIR", runtime.path())
        .env_remove("HII_DB_PATH")
        .env("HII_TEST_WORKSPACE_IDENTITY", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
