export type AgentStatus =
  | "queued"
  | "running"
  | "blocked"
  | "needs_review"
  | "failed"
  | "completed"
  | "archived";

export type AgentTool = "codex" | "claude_code" | "cursor" | "custom";

export type AgentTask = {
  id: string;
  title: string;
  projectId: string;
  machineId: string;
  repoPath: string;
  branchName: string;
  worktreePath: string;
  agentTool: AgentTool;
  prompt: string;
  status: AgentStatus;
  sessionId: string;
  latestLog: string;
  logs: string[];
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateAgentTaskInput = {
  title: string;
  projectId: string;
  machineId: string;
  agentTool: AgentTool;
  prompt: string;
};
