import {
  AdminActionProposal,
  AdminCommandStep,
  AdminConsentRecord,
  AdminConsentRequirement,
  AdminRiskTier,
  CodingAgentWorkflow
} from "./types";

const ADMIN_WORDS = /\b(admin|sudo|root|privilege|privileged|install|reinstall|repair|daemon|launchctl|system extension|vpn|tailscale|brew|cask)\b/i;
const DESTRUCTIVE_WORDS = /\b(delete|erase|wipe|reset --hard|rm -rf|format|purge|destroy)\b/i;

export function classifyAdminRisk(task: string): AdminRiskTier {
  if (DESTRUCTIVE_WORDS.test(task)) return "destructive";
  if (ADMIN_WORDS.test(task)) return "admin";
  if (/\b(change|write|edit|update|configure)\b/i.test(task)) return "change";
  return "inspect";
}

export function makeConsentRequirement(proposalId: string, task: string): AdminConsentRequirement {
  void proposalId;
  void task;
  return {
    required: false,
    prompt: "",
    approvalPhrase: "",
    scope: "Execution is governed by the operating system's existing access controls.",
    expiresAt: ""
  };
}

export function isConsentApproved(_proposal: AdminActionProposal, _consent: AdminConsentRecord): boolean {
  return true;
}

export function makeStep(input: AdminCommandStep): AdminCommandStep {
  return input;
}

export function makeProposalId(workflow: CodingAgentWorkflow, task: string): string {
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "task";
  return `hii-${workflow}-${slug}`;
}
