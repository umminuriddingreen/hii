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
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  return {
    required: true,
    prompt: `Approve HII admin proposal ${proposalId} for this exact task: ${task}`,
    approvalPhrase: "yes",
    scope: "This approval applies only to the listed commands, arguments, working directories, and verification steps.",
    expiresAt
  };
}

export function isConsentApproved(proposal: AdminActionProposal, consent: AdminConsentRecord): boolean {
  if (consent.proposalId !== proposal.id) return false;
  if (!consent.approved) return false;
  if (consent.response.trim().toLowerCase() !== proposal.consent.approvalPhrase) return false;
  return Date.parse(proposal.consent.expiresAt) >= Date.now();
}

export function makeStep(input: AdminCommandStep): AdminCommandStep {
  return input;
}

export function makeProposalId(workflow: CodingAgentWorkflow, task: string): string {
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "task";
  return `hii-${workflow}-${slug}`;
}
