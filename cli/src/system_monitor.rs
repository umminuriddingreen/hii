use crate::config::AppPaths;
use std::{path::Path, process::Command};

pub fn snapshot(paths: &AppPaths, workspace: &Path) -> Result<String, String> {
    let top = output("top", &["-l", "1", "-n", "0"])?;
    let cpu = top
        .lines()
        .find(|line| line.starts_with("CPU usage:"))
        .unwrap_or("CPU usage unavailable")
        .to_string();
    let memory = top
        .lines()
        .find(|line| line.starts_with("PhysMem:"))
        .unwrap_or("Memory usage unavailable")
        .to_string();
    let disk_output = output("df", &["-h", "/"])?;
    let disk = disk_output
        .lines()
        .nth(1)
        .unwrap_or("Disk usage unavailable")
        .split_whitespace()
        .collect::<Vec<_>>();
    let disk_line = if disk.len() >= 5 {
        format!("Disk: {} used of {} ({})", disk[2], disk[1], disk[4])
    } else {
        "Disk usage unavailable".into()
    };
    let ollama = output("ollama", &["ps"]).unwrap_or_else(|_| "Ollama unavailable".into());
    Ok(format!(
        "{cpu}\n{memory}\n{disk_line}\nWorkspace: {}\nHII runtime: {}\n\n{}",
        workspace.display(),
        paths.runtime.display(),
        ollama.trim()
    ))
}

pub fn launch_btop() -> Result<String, String> {
    let binary = if Path::new("/opt/homebrew/bin/btop").is_file() {
        "/opt/homebrew/bin/btop"
    } else {
        "btop"
    };
    let status = Command::new(binary)
        .status()
        .map_err(|error| format!("could not launch btop: {error}"))?;
    if status.success() {
        Ok("Resource monitor closed.".into())
    } else {
        Err(format!("btop exited with {status}"))
    }
}

fn output(program: &str, args: &[&str]) -> Result<String, String> {
    let result = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("{program}: {error}"))?;
    if result.status.success() {
        Ok(String::from_utf8_lossy(&result.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&result.stderr).trim().to_string())
    }
}
