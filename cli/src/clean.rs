// SPDX-License-Identifier: LicenseRef-BSL-1.1

use chrono::Utc;
use ring::digest::{Context, SHA256};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
#[cfg(target_os = "macos")]
use std::{process::Command, thread, time::Duration};
use uuid::Uuid;

const SCHEMA_VERSION: u8 = 1;

#[derive(Clone, Debug)]
pub struct CleanPaths {
    pub applications: Vec<PathBuf>,
    pub backup_root: PathBuf,
}

impl CleanPaths {
    pub fn installed_hii() -> Result<Self, String> {
        let home = dirs::home_dir().ok_or("HII could not resolve the home directory")?;
        Ok(Self {
            applications: vec![
                PathBuf::from("/Applications/HII.app"),
                PathBuf::from("/Applications/HII Bar.app"),
            ],
            backup_root: home.join("HII Backups/Applications"),
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanTarget {
    pub source: String,
    pub backup: String,
    pub present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanResult {
    pub schema_version: u8,
    pub kind: &'static str,
    pub status: &'static str,
    pub applied: bool,
    pub backup_directory: String,
    pub targets: Vec<CleanTarget>,
    pub preserved: Vec<&'static str>,
    pub restore_instructions: Option<String>,
}

fn backup_directory(root: &Path) -> PathBuf {
    root.join(format!(
        "{}-{}",
        Utc::now().format("%Y%m%dT%H%M%SZ"),
        &Uuid::new_v4().to_string()[..8]
    ))
}

fn bundle_digest(path: &Path) -> Result<String, String> {
    fn visit(root: &Path, path: &Path, context: &mut Context) -> Result<(), String> {
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        let relative = path.strip_prefix(root).unwrap_or(path);
        context.update(relative.to_string_lossy().as_bytes());
        if metadata.is_dir() {
            context.update(b"\0directory\0");
            let mut entries = fs::read_dir(path)
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                visit(root, &entry.path(), context)?;
            }
        } else if metadata.file_type().is_symlink() {
            context.update(b"\0symlink\0");
            context.update(
                fs::read_link(path)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .as_bytes(),
            );
        } else {
            context.update(b"\0file\0");
            context.update(&metadata.len().to_le_bytes());
            context.update(&fs::read(path).map_err(|error| error.to_string())?);
        }
        Ok(())
    }

    let mut context = Context::new(&SHA256);
    visit(path, path, &mut context)?;
    Ok(context
        .finish()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn target_plan(paths: &CleanPaths, backup: &Path) -> Result<Vec<CleanTarget>, String> {
    paths
        .applications
        .iter()
        .map(|source| {
            Ok(CleanTarget {
                source: source.display().to_string(),
                backup: backup
                    .join(source.file_name().unwrap_or_default())
                    .display()
                    .to_string(),
                present: source.is_dir(),
                sha256: source.is_dir().then(|| bundle_digest(source)).transpose()?,
            })
        })
        .collect()
}

pub fn preview(paths: &CleanPaths) -> Result<CleanResult, String> {
    let backup = backup_directory(&paths.backup_root);
    Ok(CleanResult {
        schema_version: SCHEMA_VERSION,
        kind: "hii.clean/1",
        status: "preview",
        applied: false,
        backup_directory: backup.display().to_string(),
        targets: target_plan(paths, &backup)?,
        preserved: vec!["~/.hii", "repositories", "creator packages", "user data"],
        restore_instructions: None,
    })
}

#[cfg(target_os = "macos")]
fn stop_installed_surfaces(targets: &[PathBuf]) -> Result<(), String> {
    for bundle_id in ["com.ummi.hii", "ai.hii.bar"] {
        let script = format!("tell application id \"{bundle_id}\" to quit");
        let _ = Command::new("osascript").args(["-e", &script]).status();
    }
    thread::sleep(Duration::from_millis(800));

    let executable_prefixes: Vec<String> = targets
        .iter()
        .map(|path| format!("{}/Contents/MacOS/", path.display()))
        .collect();
    for _ in 0..2 {
        let output = Command::new("ps")
            .args(["-axo", "pid=,command="])
            .output()
            .map_err(|error| format!("could not inspect HII processes: {error}"))?;
        let mut pids = Vec::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let line = line.trim();
            let Some((pid, command)) = line.split_once(char::is_whitespace) else {
                continue;
            };
            if executable_prefixes
                .iter()
                .any(|prefix| command.trim_start().starts_with(prefix))
            {
                pids.push(pid.to_string());
            }
        }
        if pids.is_empty() {
            return Ok(());
        }
        let status = Command::new("kill")
            .arg("-TERM")
            .args(&pids)
            .status()
            .map_err(|error| format!("could not stop installed HII surfaces: {error}"))?;
        if !status.success() {
            return Err("could not stop every installed HII surface".into());
        }
        thread::sleep(Duration::from_millis(800));
    }
    Err("an installed HII surface is still running; no application was moved".into())
}

#[cfg(not(target_os = "macos"))]
fn stop_installed_surfaces(_: &[PathBuf]) -> Result<(), String> {
    Ok(())
}

fn rollback(moved: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    let mut errors = Vec::new();
    for (source, backup) in moved.iter().rev() {
        if backup.exists() {
            if let Some(parent) = source.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Err(error) = fs::rename(backup, source) {
                errors.push(format!("{}: {error}", source.display()));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("rollback needs attention: {}", errors.join("; ")))
    }
}

pub fn apply(paths: &CleanPaths, stop_apps: bool) -> Result<CleanResult, String> {
    let backup = backup_directory(&paths.backup_root);
    let targets = target_plan(paths, &backup)?;
    let present: Vec<PathBuf> = paths
        .applications
        .iter()
        .filter(|path| path.is_dir())
        .cloned()
        .collect();
    if present.is_empty() {
        return Ok(CleanResult {
            schema_version: SCHEMA_VERSION,
            kind: "hii.clean/1",
            status: "no-op",
            applied: true,
            backup_directory: backup.display().to_string(),
            targets,
            preserved: vec!["~/.hii", "repositories", "creator packages", "user data"],
            restore_instructions: None,
        });
    }
    if stop_apps {
        stop_installed_surfaces(&present)?;
    }
    fs::create_dir_all(&backup)
        .map_err(|error| format!("could not create HII backup directory: {error}"))?;

    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for source in &present {
        let destination = backup.join(source.file_name().unwrap_or_default());
        if let Err(error) = fs::rename(source, &destination) {
            let rollback_error = rollback(&moved).err();
            return Err(match rollback_error {
                Some(rollback_error) => format!(
                    "could not back up {}: {error}; {rollback_error}",
                    source.display()
                ),
                None => format!(
                    "could not back up {}: {error}; earlier moves were restored",
                    source.display()
                ),
            });
        }
        moved.push((source.clone(), destination));
    }
    for target in &targets {
        if let Some(expected) = &target.sha256 {
            let actual = bundle_digest(Path::new(&target.backup))?;
            if &actual != expected {
                let rollback_error = rollback(&moved).err();
                return Err(match rollback_error {
                    Some(rollback_error) => format!("backup checksum mismatch; {rollback_error}"),
                    None => "backup checksum mismatch; installed apps were restored".into(),
                });
            }
        }
    }

    let restore_path = backup.join("RESTORE.md");
    let manifest_path = backup.join("manifest.json");
    let result = CleanResult {
        schema_version: SCHEMA_VERSION,
        kind: "hii.clean/1",
        status: "applied",
        applied: true,
        backup_directory: backup.display().to_string(),
        targets,
        preserved: vec!["~/.hii", "repositories", "creator packages", "user data"],
        restore_instructions: Some(restore_path.display().to_string()),
    };
    let manifest = serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?;
    let restore = format!(
        "# Restore this HII application backup\n\nCreated: {}\n\nQuit HII and HII Bar, then move the application bundles in this directory back to `/Applications`. Do not overwrite a newer installation without backing it up first.\n\nThis procedure preserved `~/.hii`, repositories, creator packages, and user data.\n",
        Utc::now().to_rfc3339()
    );
    if let Err(error) = fs::write(&manifest_path, format!("{manifest}\n"))
        .and_then(|_| fs::write(&restore_path, restore))
    {
        let rollback_error = rollback(&moved).err();
        return Err(match rollback_error {
            Some(rollback_error) => {
                format!("could not write backup proof: {error}; {rollback_error}")
            }
            None => format!("could not write backup proof: {error}; installed apps were restored"),
        });
    }
    Ok(result)
}

pub fn render(result: &CleanResult, json: bool) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(result).map_err(|error| error.to_string())?
        );
        return Ok(());
    }
    println!("HII clean · {}", result.status);
    println!("backup: {}", result.backup_directory);
    for target in &result.targets {
        let state = if target.present {
            "will back up"
        } else {
            "not installed"
        };
        println!("  {state}: {}", target.source);
    }
    println!("preserved: {}", result.preserved.join(", "));
    if result.status == "preview" {
        println!("\nNothing changed. Run `hii clean --apply` to continue.");
    } else if let Some(path) = &result.restore_instructions {
        println!("restore: {path}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, CleanPaths) {
        let root = std::env::temp_dir().join(format!("hii-clean-test-{}", Uuid::new_v4()));
        let applications = root.join("Applications");
        fs::create_dir_all(applications.join("HII.app/Contents/MacOS")).unwrap();
        fs::create_dir_all(applications.join("HII Bar.app/Contents/MacOS")).unwrap();
        let paths = CleanPaths {
            applications: vec![
                applications.join("HII.app"),
                applications.join("HII Bar.app"),
            ],
            backup_root: root.join("Backups"),
        };
        (root, paths)
    }

    #[test]
    fn preview_never_moves_installed_apps() {
        let (root, paths) = fixture();
        let result = preview(&paths).unwrap();
        assert_eq!(result.status, "preview");
        assert!(paths.applications.iter().all(|path| path.is_dir()));
        assert!(!paths.backup_root.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn apply_moves_apps_intact_and_writes_restore_proof() {
        let (root, paths) = fixture();
        fs::write(paths.applications[0].join("Contents/MacOS/hii"), b"binary").unwrap();
        let result = apply(&paths, false).unwrap();
        let backup = PathBuf::from(&result.backup_directory);
        assert_eq!(result.status, "applied");
        assert!(backup.join("HII.app/Contents/MacOS/hii").is_file());
        assert!(backup.join("HII Bar.app").is_dir());
        assert!(backup.join("manifest.json").is_file());
        assert!(backup.join("RESTORE.md").is_file());
        assert_eq!(result.targets[0].sha256.as_deref().map(str::len), Some(64));
        assert!(paths.applications.iter().all(|path| !path.exists()));
        fs::remove_dir_all(root).unwrap();
    }
}
