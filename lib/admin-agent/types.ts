import { RegistrySnapshot } from "@/lib/registry/types";

export type CodingAgentWorkflow = "codex" | "claude-code" | "manual";

export type AdminRiskTier = "inspect" | "change" | "admin" | "destructive";

export interface AdminAgentManifest {
  schemaVersion: 1;
  id: "hii-admin-consent-agent";
  name: string;
  description: string;
  supportedWorkflows: CodingAgentWorkflow[];
  hardening: string[];
  registry?: Pick<RegistrySnapshot, "generatedAt" | "machine" | "agents" | "providers" | "mcpServers">;
}

export interface AdminCommandStep {
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  riskTier: AdminRiskTier;
  requiresAdmin: boolean;
  why: string;
}

export interface AdminActionProposal {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  workflow: CodingAgentWorkflow;
  task: string;
  summary: string;
  riskTier: AdminRiskTier;
  steps: AdminCommandStep[];
  verification: AdminCommandStep[];
  consent: AdminConsentRequirement;
  refusedReasons: string[];
}

export interface AdminConsentRequirement {
  required: true;
  prompt: string;
  approvalPhrase: "yes";
  scope: string;
  expiresAt: string;
}

export interface AdminConsentRecord {
  proposalId: string;
  approved: boolean;
  response: string;
  approvedAt?: string;
  approvedBy?: string;
}
