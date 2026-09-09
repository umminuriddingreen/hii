// SPDX-License-Identifier: LicenseRef-BSL-1.1
use clap::Subcommand;
use hii_core::session_backup::{self, SourceRoot};
use std::{env, path::PathBuf};

#[derive(Debug, Subcommand)]
pub enum SessionBackupCommand {
    /// Snapshot Codex, Claude and Pi session logs locally; never upload credentials.
    Run,
    /// Show counts and storage use without printing transcript contents.
    Status,
    /// List snapshot metadata for restore, without transcript contents.
    List,
    /// Verify and restore one snapshot to a new file. Existing files are never overwritten.
    Restore {
        snapshot_id: String,
        destination: PathBuf,
    },
}

fn configured_root(key: &str, default: PathBuf) -> PathBuf {
    env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(default)
}

fn sources() -> Result<Vec<SourceRoot>, String> {
    let home = dirs::home_dir().ok_or("Cannot locate the user's home directory")?;
    let codex = configured_root("CODEX_HOME", home.join(".codex"));
    let claude = configured_root("CLAUDE_CONFIG_DIR", home.join(".claude"));
    let pi = configured_root("PI_CODING_AGENT_DIR", home.join(".pi/agent"));
    Ok(vec![
        SourceRoot {
            provider: "codex".into(),
            source_id: "sessions".into(),
            root: codex.join("sessions"),
        },
        SourceRoot {
            provider: "codex".into(),
            source_id: "archived_sessions".into(),
            root: codex.join("archived_sessions"),
        },
        SourceRoot {
            provider: "claude".into(),
            source_id: "projects".into(),
            root: claude.join("projects"),
        },
        SourceRoot {
            provider: "pi".into(),
            source_id: "sessions".into(),
            root: pi.join("sessions"),
        },
    ])
}

fn print(value: &impl serde::Serialize) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string(value).map_err(|error| error.to_string())?
    );
    Ok(())
}

pub fn execute(command: SessionBackupCommand) -> Result<(), String> {
    let runtime = hii_core::runtime_root()?;
    let database = configured_root("HII_DB_PATH", runtime.join("hii.db"));
    let host = env::var("COMPUTERNAME")
        .or_else(|_| env::var("HOSTNAME"))
        .unwrap_or_else(|_| "local".into());
    let device = format!("{}:{host}", env::consts::OS);
    match command {
        SessionBackupCommand::Run => {
            let report = session_backup::backup(&database, &device, &sources()?)?;
            print(&report)?;
            if report.errors.is_empty() {
                Ok(())
            } else {
                Err(
                    "Some session files could not be backed up; inspect the metadata report."
                        .into(),
                )
            }
        }
        SessionBackupCommand::Status => print(&session_backup::status(&database, None)?),
        SessionBackupCommand::List => print(&session_backup::list(&database, None)?),
        SessionBackupCommand::Restore {
            snapshot_id,
            destination,
        } => print(&session_backup::restore(
            &database,
            &snapshot_id,
            &destination,
        )?),
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    #[test]
    fn backup_commands_are_native_and_parse() {
        for args in [
            vec!["hii", "session-backup", "run"],
            vec!["hii", "session-backup", "status"],
            vec!["hii", "session-backup", "list"],
            vec!["hii", "session-backup", "restore", "snapshot", "new.jsonl"],
        ] {
            assert!(crate::Cli::try_parse_from(args).is_ok());
        }
        assert!(crate::route::claims_verb("session-backup", Some("run")));
    }
}
