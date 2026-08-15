//! Command boundary between the UI and the execution substrate.
//!
//! All reads are live: projects/tasks come from the HII runtime
//! (`~/.hii/hii.db`), machines from HII remotes + local `sysinfo` metrics.
//! The frontend `src/lib/api.ts` is shaped 1:1 against these commands.

use crate::models::*;

#[tauri::command]
pub async fn get_machines() -> Vec<Machine> {
    // async: sysinfo sampling + remote TCP probes block for up to ~1s.
    crate::hii::machines().unwrap_or_default()
}

#[tauri::command]
pub fn get_projects() -> Vec<Project> {
    crate::hii::projects().unwrap_or_default()
}

#[tauri::command]
pub fn get_agent_tasks() -> Vec<AgentTask> {
    // TODO(phase-5): reconcile with live tmux/Zellij sessions
    //                (`tmux ls`, `zellij list-sessions`) named aii__{project}__{task}.
    crate::hii::tasks().unwrap_or_default()
}

#[tauri::command]
pub fn get_agent_task(id: String) -> Option<AgentTask> {
    crate::hii::tasks()
        .unwrap_or_default()
        .into_iter()
        .find(|t| t.id == id)
}

#[tauri::command]
pub fn create_agent_task(input: CreateAgentTaskInput) -> Result<AgentTask, String> {
    // TODO: INSERT into hii.db tasks + task_workflow_events (HII stays the
    //       source of truth), then:
    // TODO(phase-6): git fetch + `git worktree add ~/aii/worktrees/{project}/{task}
    //                -b agent/{task}` + dependency install on the target machine.
    // TODO(phase-7): start tmux/Zellij session and launch the agent tool
    //                (codex / claude code / custom command) inside the worktree.
    Err(format!("create_agent_task not implemented: {}", input.title))
}

#[tauri::command]
pub fn stop_agent_task(id: String) -> bool {
    // TODO(phase-7): send interrupt to the agent process / kill the session.
    let _ = id;
    false
}

#[tauri::command]
pub fn restart_agent_task(id: String) -> bool {
    // TODO(phase-9): recovery layer — restart agent in place; escalate to
    //                Wake-on-LAN, network KVM, smart plug, or Fingerbot when
    //                the host itself is unresponsive.
    let _ = id;
    false
}

#[tauri::command]
pub async fn get_machine_metrics(machine_id: String) -> Option<MachineMetrics> {
    if machine_id != "local" {
        // TODO(phase-4): remote machines via SSH.
        return None;
    }
    let live = crate::metrics::local_snapshot();
    Some(MachineMetrics {
        machine_id,
        cpu_percent: live.cpu_percent,
        ram_percent: live.ram_percent,
        disk_percent: live.disk_percent,
        gpu_percent: None,
        process_count: live.process_count,
        uptime_seconds: live.uptime_seconds,
        hostname: live.hostname,
    })
}

// TODO(phase-8): GitHub PR tracking commands (`gh pr view --json`, `gh pr checks`)
//                for diff summary, CI status, review comments, merge state.
