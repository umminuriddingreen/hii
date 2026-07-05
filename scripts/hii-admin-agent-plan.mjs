import { pathToFileURL } from "node:url";

const SUPPORTED_WORKFLOWS = new Set(["codex", "claude-code", "manual"]);

function parseArgs(argv) {
  const parsed = { workflow: "codex", task: "", cwd: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workflow") parsed.workflow = argv[++i] || parsed.workflow;
    else if (arg === "--cwd") parsed.cwd = argv[++i] || parsed.cwd;
    else if (arg === "--task") parsed.task = argv[++i] || "";
    else if (!parsed.task) parsed.task = arg;
    else parsed.task = `${parsed.task} ${arg}`;
  }
  if (!SUPPORTED_WORKFLOWS.has(parsed.workflow)) {
    throw new Error(`Unsupported workflow: ${parsed.workflow}`);
  }
  if (!parsed.task.trim()) {
    throw new Error("Missing task. Usage: node scripts/hii-admin-agent-plan.mjs --workflow codex --task \"repair tailscale\"");
  }
  return parsed;
}

function classifyAdminRisk(task) {
  if (/\b(delete|erase|wipe|reset --hard|rm -rf|format|purge|destroy)\b/i.test(task)) return "destructive";
  if (/\b(admin|sudo|root|privilege|privileged|install|reinstall|repair|daemon|launchctl|system extension|vpn|tailscale|brew|cask)\b/i.test(task)) return "admin";
  if (/\b(change|write|edit|update|configure)\b/i.test(task)) return "change";
  return "inspect";
}

function proposalId(workflow, task) {
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "task";
  return `hii-${workflow}-${slug}`;
}

function step({ label, command, args, cwd, riskTier, requiresAdmin, why }) {
  return { label, command, args, cwd, riskTier, requiresAdmin, why };
}

export function planAdminAgentTask({ workflow, task, cwd }) {
  const riskTier = classifyAdminRisk(task);
  const id = proposalId(workflow, task);
  const refusedReasons = [];
  const steps = [];
  const verification = [];

  if (riskTier === "destructive") {
    refusedReasons.push("Destructive admin tasks require a narrower hand-authored proposal before HII will generate commands.");
  } else if (/\btailscale\b/i.test(task)) {
    steps.push(
      step({
        label: "Inspect Tailscale cask",
        command: "brew",
        args: ["info", "--cask", "tailscale-app"],
        cwd,
        riskTier: "inspect",
        requiresAdmin: false,
        why: "Confirms whether Homebrew currently owns the Tailscale install."
      }),
      step({
        label: "Repair Tailscale app install",
        command: "brew",
        args: ["install", "--cask", "tailscale-app"],
        cwd,
        riskTier: "admin",
        requiresAdmin: true,
        why: "Runs the official package installer path and lets macOS request the needed privileged authorization."
      })
    );
    verification.push(
      step({
        label: "Verify Tailscale status",
        command: "tailscale",
        args: ["status"],
        cwd,
        riskTier: "inspect",
        requiresAdmin: false,
        why: "Checks whether the CLI can reach the app/service and whether the node is authenticated."
      }),
      step({
        label: "Verify Tailscale network path",
        command: "tailscale",
        args: ["netcheck"],
        cwd,
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
    summary: refusedReasons.length
      ? `${workflow} admin proposal refused pending narrower human review: ${task}`
      : `${workflow} may request user consent to run ${steps.length} scoped step(s) for: ${task}`,
    riskTier,
    steps,
    verification,
    consent: {
      required: true,
      prompt: `Approve HII admin proposal ${id} for this exact task: ${task}`,
      approvalPhrase: "yes",
      scope: "This approval applies only to the listed commands, arguments, working directories, and verification steps.",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    },
    refusedReasons
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(planAdminAgentTask(parsed), null, 2)}\n`);
}
