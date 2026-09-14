// SPDX-License-Identifier: LicenseRef-BSL-1.1
use clap::Subcommand;
use std::path::PathBuf;

#[derive(Debug, Subcommand)]
pub enum MemoryCommand {
    /// Reference a local file and preserve a verified immutable version.
    Save { path: PathBuf },
    /// Select a file or folder for reconciliation scans.
    Watch { path: PathBuf },
    /// Reconcile watched files and folders now.
    Scan,
    /// Keep reconciling watched paths until stopped (Ctrl+C).
    Monitor {
        #[arg(long, default_value_t = 5)]
        interval_seconds: u64,
    },
    /// Search captured file names and UTF-8 content.
    Search {
        #[arg(required = true, num_args = 1..)]
        query: Vec<String>,
    },
    /// Inspect a captured file object.
    Get { id: String },
    /// List preserved versions of a file.
    Versions { id: String },
    /// Restore one version to a new path; existing paths are never replaced.
    Restore {
        id: String,
        version: i64,
        output: PathBuf,
    },
    /// Report the truth about local memory and peer sync.
    Status,
}

pub fn execute(command: MemoryCommand) -> Result<(), String> {
    let runtime = hii_core::runtime_root()?;
    let output = match command {
        MemoryCommand::Save { path } => hii_core::memory::save(&runtime, &path)?,
        MemoryCommand::Watch { path } => {
            let selected = hii_core::memory::watch(&runtime, &path)?;
            let scan = hii_core::memory::scan(&runtime)?;
            serde_json::json!({"watch":selected,"scan":scan})
        }
        MemoryCommand::Scan => hii_core::memory::scan(&runtime)?,
        MemoryCommand::Monitor { interval_seconds } => {
            let seconds = interval_seconds.clamp(1, 3600);
            loop {
                println!("{}", hii_core::memory::scan(&runtime)?);
                std::thread::sleep(std::time::Duration::from_secs(seconds));
            }
        }
        MemoryCommand::Search { query } => {
            serde_json::json!(hii_core::memory::search(&runtime, &query.join(" "), 20)?)
        }
        MemoryCommand::Get { id } => hii_core::memory::get(&runtime, &id)?,
        MemoryCommand::Versions { id } => {
            serde_json::json!(hii_core::memory::versions(&runtime, &id)?)
        }
        MemoryCommand::Restore {
            id,
            version,
            output,
        } => hii_core::memory::restore(&runtime, &id, version, &output)?,
        MemoryCommand::Status => hii_core::memory::status(&runtime)?,
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&output).map_err(|e| e.to_string())?
    );
    Ok(())
}
