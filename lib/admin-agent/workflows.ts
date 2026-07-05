import { RegistrySnapshot } from "@/lib/registry/types";
import { AdminActionProposal, AdminCommandStep, CodingAgentWorkflow } from "./types";
import { classifyAdminRisk, makeConsentRequirement, makeProposalId, makeStep } from "./policy";

export function createAdminAgentManifest(snapshot?: RegistrySnapshot) {
  return {
    schemaVersion: 1,
    id: "hii-admin-consent-agent",
    name: "HII Admin Consent Agent",
    description:
      "A hardened coding-agent workflow contract for proposing privileged local actions while requiring explicit user yes/no consent before execution.",
    supportedWorkflows: ["codex", "claude-code", "manual"],
    hardening: [
      "No privileged command is executed by this module.",
      "Every admin action must be represented as command plus args, never as an opaque shell string.",
      "Consent is scoped to a single proposal and expires after 15 minutes.",
      "Destructive tasks are refused until a narrower proposal is authored by a human.",
      "Secrets are referenced by presence/path only and are never copied into proposals.",
      "Verification commands are listed separately from mutation commands."
    ],
    registry: snapshot
      ? {
          generatedAt: snapshot.generatedAt,
          machine: snapshot.machine,
          agents: snapshot.agents,
          providers: snapshot.providers,
          mcpServers: snapshot.mcpServers
        }
      : undefined
  } as const;
}

export function proposeCodingAgentAdminAction(params: {
  task: string;
  workflow: CodingAgentWorkflow;
  cwd?: string;
}): AdminActionProposal {
  const task = params.task.trim();
  const workflow = params.workflow;
  const riskTier = classifyAdminRisk(task);
  const id = makeProposalId(workflow, task);
  const refusedReasons: string[] = [];
  const steps: AdminCommandStep[] = [];
  const verification: AdminCommandStep[] = [];

  if (riskTier === "destructive") {
    refusedReasons.push("Destructive admin tasks require a narrower hand-authored proposal before HII will generate commands.");
  } else if (/\btailscale\b/i.test(task)) {
    steps.push(
      makeStep({
        label: "Inspect Tailscale cask",
        command: "brew",
        args: ["info", "--cask", "tailscale-app"],
        cwd: params.cwd,
        riskTier: "inspect",
        requiresAdmin: false,
        why: "Confirms whether Homebrew currently owns the Tailscale install."
      }),
      makeStep({
        label: "Repair Tailscale app install",
        command: "brew",
        args: ["install", "--cask", "tailscale-app"],
        cwd: params.cwd,
        riskTier: "admin",
        requiresAdmin: true,
        why: "Runs the official package installer path and lets macOS request the needed privileged authorization."
      })
    );
    verification.push(
      makeStep({
        label: "Verify Tailscale status",
        command: "tailscale",
        args: ["status"],
        cwd: params.cwd,
        riskTier: "inspect",
        requiresAdmin: false,
        why: "Checks whether the CLI can reach the app/service and whether the node is authenticated."
      }),
      makeStep({
        label: "Verify Tailscale network path",
        command: "tailscale",
        args: ["netcheck"],
        cwd: params.cwd,
        riskTier: "inspect",
        requiresAdmin: false,
        why: "Checks DERP/direct connectivity after repair."
      })
    );
  } else {
    refusedReasons.push("No vetted admin recipe exists for this task yet; use manual review before adding commands.");
  }

  return {
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    workflow,
    task,
    summary: buildSummary(workflow, task, refusedReasons.length, steps),
    riskTier,
    steps,
    verification,
    consent: makeConsentRequirement(id, task),
    refusedReasons
  };
}

function buildSummary(
  workflow: CodingAgentWorkflow,
  task: string,
  refusedCount: number,
  steps: AdminCommandStep[]
): string {
  if (refusedCount) return `${workflow} admin proposal refused pending narrower human review: ${task}`;
  return `${workflow} may request user consent to run ${steps.length} scoped step(s) for: ${task}`;
}
