//! Data models mirrored 1:1 with `src/types/*.ts`.
//! Serialized as camelCase so the frontend types match without mapping.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MachineStatus {
    Online,
    Busy,
    Offline,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Queued,
    Running,
    Blocked,
    NeedsReview,
    Failed,
    Completed,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTool {
    Codex,
    ClaudeCode,
    Cursor,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub id: String,
    pub name: String,
    pub os: String,
    pub host: String,
    pub ssh_user: String,
    pub status: MachineStatus,
    pub cpu_percent: f32,
    pub ram_percent: f32,
    pub disk_percent: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_percent: Option<f32>,
    pub active_agent_count: u32,
    pub last_heartbeat: String,
    pub default_worktree_root: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineMetrics {
    pub machine_id: String,
    pub cpu_percent: f32,
    pub ram_percent: f32,
    pub disk_percent: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_percent: Option<f32>,
    pub process_count: u32,
    pub uptime_seconds: u64,
    pub hostname: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub repo_url: String,
    pub local_path: String,
    pub default_branch: String,
    pub preferred_agent: AgentTool,
    pub default_machine_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTask {
    pub id: String,
    pub title: String,
    pub project_id: String,
    pub machine_id: String,
    pub repo_path: String,
    pub branch_name: String,
    pub worktree_path: String,
    pub agent_tool: AgentTool,
    pub prompt: String,
    pub status: AgentStatus,
    pub session_id: String,
    pub latest_log: String,
    pub logs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentTaskInput {
    pub title: String,
    pub project_id: String,
    pub machine_id: String,
    pub agent_tool: AgentTool,
    pub prompt: String,
}
