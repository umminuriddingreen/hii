import type { MachineStatus } from "../types/machine";
import type { AgentStatus, AgentTool } from "../types/agentTask";

export const machineStatusColor: Record<MachineStatus, string> = {
  online: "bg-ok",
  busy: "bg-busy",
  offline: "bg-idle",
  error: "bg-err",
};

export const machineStatusLabel: Record<MachineStatus, string> = {
  online: "online",
  busy: "busy",
  offline: "offline",
  error: "error",
};

export const agentStatusStyle: Record<AgentStatus, string> = {
  queued: "bg-idle/15 text-ink-dim border-idle/30",
  running: "bg-ok/10 text-ok border-ok/30",
  blocked: "bg-warn/10 text-warn border-warn/30",
  needs_review: "bg-accent/10 text-accent border-accent/30",
  failed: "bg-err/10 text-err border-err/30",
  completed: "bg-ink-faint/10 text-ink-dim border-edge",
  archived: "bg-ink-faint/10 text-ink-faint border-edge",
};

export const agentStatusLabel: Record<AgentStatus, string> = {
  queued: "queued",
  running: "running",
  blocked: "blocked",
  needs_review: "needs review",
  failed: "failed",
  completed: "completed",
  archived: "archived",
};

export const agentToolLabel: Record<AgentTool, string> = {
  codex: "Codex",
  claude_code: "Claude Code",
  cursor: "Cursor",
  custom: "Custom",
};

export function metricColor(percent: number): string {
  if (percent >= 85) return "bg-err";
  if (percent >= 65) return "bg-warn";
  return "bg-accent";
}
