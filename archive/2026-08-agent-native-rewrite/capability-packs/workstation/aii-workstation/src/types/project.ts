import type { AgentTool } from "./agentTask";

export type Project = {
  id: string;
  name: string;
  repoUrl: string;
  localPath: string;
  defaultBranch: string;
  preferredAgent: AgentTool;
  defaultMachineId: string;
};
