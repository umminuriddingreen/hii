// SPDX-License-Identifier: LicenseRef-BSL-1.1
use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
use tempfile::TempDir;

fn init_hii_repo(root: &Path) {
    fs::create_dir_all(root.join("docs")).unwrap();
    fs::write(root.join("docs/HII_AII_MASTER_CONTEXT.md"), "fixture\n").unwrap();
    git(root, &["init", "--quiet"]);
    git(
        root,
        &[
            "-c",
            "user.name=HII test",
            "-c",
            "user.email=hii-test@example.invalid",
            "add",
            ".",
        ],
    );
    git(
        root,
        &[
            "-c",
            "user.name=HII test",
            "-c",
            "user.email=hii-test@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "fixture",
        ],
    );
}

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_hii(args: &[&str], home: &Path, runtime: &Path, source: Option<&Path>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hii"));
    command
        .args(args)
        .env("HOME", home)
        .env("HII_RUNTIME_DIR", runtime);
    if let Some(source) = source {
        command.env("HII_SOURCE_CHECKOUT", source);
    }
    command.output().unwrap()
}

fn json_output(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "hii failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "hii did not print JSON ({error}): {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })
}

#[test]
fn update_status_reads_clean_overridden_hii_checkout() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let runtime = temp.path().join("runtime");
    let source = temp.path().join("source");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&runtime).unwrap();
    init_hii_repo(&source);
    let expected_commit = {
        let output = Command::new("git")
            .arg("-C")
            .arg(&source)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };

    let status = json_output(&run_hii(
        &["update", "status"],
        &home,
        &runtime,
        Some(&source),
    ));

    assert_eq!(status["kind"], "hii.update.status");
    assert_eq!(
        status["source"]["path"],
        fs::canonicalize(&source)
            .unwrap()
            .to_string_lossy()
            .as_ref()
    );
    assert_eq!(status["source"]["commit"], expected_commit);
    assert_eq!(status["source"]["dirty"], false);
    assert_eq!(status["source"]["changedFiles"], 0);
    assert_eq!(status["featureRunCount"], 0);
}

#[test]
fn update_sync_imports_codex_skill_and_memory_then_reports_no_changes() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let runtime = temp.path().join("runtime");
    let skill = home.join(".codex/skills/sample/SKILL.md");
    let memory = home.join(".codex/memories/MEMORY.md");
    fs::create_dir_all(skill.parent().unwrap()).unwrap();
    fs::create_dir_all(memory.parent().unwrap()).unwrap();
    fs::create_dir_all(&runtime).unwrap();
    fs::write(&skill, "# Sample skill\nUse the fixture safely.\n").unwrap();
    fs::write(&memory, "# Fixture memory\nOnly temporary test content.\n").unwrap();

    let first = json_output(&run_hii(&["update", "sync"], &home, &runtime, None));
    let second = json_output(&run_hii(&["update", "sync"], &home, &runtime, None));

    assert_eq!(first["changed"], 2);
    assert_eq!(first["tracked"], 2);
    assert_eq!(first["remoteTransfer"], false);
    assert_eq!(second["changed"], 0);
    assert_eq!(second["tracked"], 2);
    assert_eq!(second["remoteTransfer"], false);
    assert!(runtime.join("memory/blobs/blake3").is_dir());
    assert!(runtime.join("hii.db").is_file());
}

#[cfg(unix)]
#[test]
fn update_feature_uses_new_worktree_and_records_worker_completion() {
    use std::{os::unix::fs::PermissionsExt, thread, time::Duration};
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let runtime = temp.path().join("runtime");
    let source = temp.path().join("source");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&runtime).unwrap();
    init_hii_repo(&source);
    let codex = temp.path().join("codex-fixture");
    fs::write(
        &codex,
        "#!/bin/sh\nprintf '{\"type\":\"turn.completed\"}\\n'\nexit 0\n",
    )
    .unwrap();
    fs::set_permissions(&codex, fs::Permissions::from_mode(0o700)).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_hii"))
        .args(["update", "feature", "Add a fixture capability"])
        .env("HOME", &home)
        .env("HII_RUNTIME_DIR", &runtime)
        .env("HII_SOURCE_CHECKOUT", &source)
        .env("HII_CODEX_BINARY", &codex)
        .output()
        .unwrap();
    let started = json_output(&output);
    let worktree = started["worktree"].as_str().unwrap();
    assert!(Path::new(worktree)
        .join("docs/HII_AII_MASTER_CONTEXT.md")
        .is_file());
    let run_path = runtime
        .join("update/runs")
        .join(started["id"].as_str().unwrap())
        .join("run.json");
    let mut finished = Value::Null;
    for _ in 0..100 {
        finished = serde_json::from_slice(&fs::read(&run_path).unwrap()).unwrap();
        if finished["status"] == "completed" {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(finished["status"], "completed", "{finished}");
    assert_eq!(finished["exitCode"], 0);
    let source_status = Command::new("git")
        .arg("-C")
        .arg(&source)
        .args(["status", "--porcelain=v1"])
        .output()
        .unwrap();
    assert!(
        source_status.stdout.is_empty(),
        "feature run changed the source checkout"
    );
}
