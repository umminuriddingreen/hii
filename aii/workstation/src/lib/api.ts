/**
 * Data boundary between the UI and the Tauri backend.
 *
 * Everything is live: projects/tasks come from the HII runtime
 * (~/.hii/hii.db), machines from HII remotes.json plus local sysinfo
 * metrics. Each function maps 1:1 to a Rust command in
 * src-tauri/src/commands.rs / hii.rs.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Machine, MachineMetrics } from "../types/machine";
import type { Project } from "../types/project";
import type { AgentTask, CreateAgentTaskInput } from "../types/agentTask";

export type BackendStatus = {
  available: boolean;
  dbPath: string;
  taskCount: number;
  projectCount: number;
};

export function getBackendStatus(): Promise<BackendStatus> {
  return invoke("hii_status");
}

export function getMachines(): Promise<Machine[]> {
  return invoke("get_machines");
}

export function getProjects(): Promise<Project[]> {
  return invoke("get_projects");
}

export function getAgentTasks(): Promise<AgentTask[]> {
  return invoke("get_agent_tasks");
}

export function getAgentTask(id: string): Promise<AgentTask | null> {
  return invoke("get_agent_task", { id });
}

export function createAgentTask(
  input: CreateAgentTaskInput,
): Promise<AgentTask> {
  return invoke("create_agent_task", { input });
}

export function stopAgentTask(id: string): Promise<boolean> {
  return invoke("stop_agent_task", { id });
}

export function restartAgentTask(id: string): Promise<boolean> {
  return invoke("restart_agent_task", { id });
}

export function getMachineMetrics(
  machineId: string,
): Promise<MachineMetrics | null> {
  return invoke("get_machine_metrics", { machineId });
}
