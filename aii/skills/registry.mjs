import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const RECEIPT_KIND = "hii.agent-action-receipt";
const EXPORT_KIND = "hii.skill-package";
const VERIFICATION_STATES = new Set(["verified", "partial", "unverified"]);
const OUTCOMES = new Set(["completed", "partial", "failed", "blocked"]);
const RISK_TIERS = new Set(["inspect", "change", "admin", "destructive"]);

function runtimeRoot() {
  return process.env.HII_RUNTIME_DIR || path.join(os.homedir(), ".hii");
}

function paths() {
  const root = path.join(runtimeRoot(), "skills");
  return {
    root,
    receipts: path.join(root, "actions.jsonl"),
    proposals: path.join(root, "proposals.jsonl"),
    registry: path.join(root, "registry.json"),
    proposed: path.join(root, "proposed"),
    registered: path.join(root, "registered"),
    exports: path.join(root, "exports")
  };
}

function now() {
  return new Date().toISOString();
}

function clean(value, max = 4000) {
  return String(value ?? "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)=)([^\s]+)/gi, "$1[redacted]")
    .replace(/((?:OPENAI|ANTHROPIC|SUPABASE|STRIPE|GITHUB|VERCEL|CLOUDFLARE|AWS)[A-Z0-9_]*=)([^\s]+)/g, "$1[redacted]")
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, "$1[redacted]")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[redacted]")
    .trim()
    .slice(0, max);
}

function slug(value) {
  return clean(value, 160)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function title(value) {
  return slug(value)
    .split("-")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function list(value) {
  if (Array.isArray(value)) return value.map((item) => clean(item, 1000)).filter(Boolean);
  return String(value ?? "")
    .split(",")
    .map((item) => clean(item, 1000))
    .filter(Boolean);
}

function bool(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "y"].includes(String(value ?? "").toLowerCase());
}

function appendJsonl(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function flag(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

function has(args, name) {
  return args.includes(name);
}

function registry() {
  const value = readJson(paths().registry, { schemaVersion: 1, updatedAt: null, skills: [] });
  if (!Array.isArray(value.skills)) value.skills = [];
  return value;
}

function writeRegistry(skills) {
  writeJson(paths().registry, {
    schemaVersion: 1,
    updatedAt: now(),
    skills: [...skills].sort((a, b) => a.id.localeCompare(b.id))
  });
}

function ensureRegistryFile() {
  if (!fs.existsSync(paths().registry)) writeRegistry([]);
}

function latestProposals() {
  const values = new Map();
  for (const event of readJsonl(paths().proposals)) {
    if (!event?.proposal?.id) continue;
    values.set(event.proposal.id, event.proposal);
  }
  return [...values.values()];
}

function receiptById(id) {
  return readJsonl(paths().receipts).find((item) => item.id === id) ?? null;
}

function proposalById(id) {
  const cleanId = slug(id);
  return latestProposals().find((item) => item.id === cleanId) ?? null;
}

function registeredById(id) {
  const cleanId = slug(id);
  return registry().skills.find((item) => item.id === cleanId) ?? null;
}

function parseReceiptFile(file) {
  const absolute = path.resolve(file);
  const value = readJson(absolute, null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`receipt file must contain one JSON object: ${absolute}`);
  }
  return value;
}

function normalizeReceipt(input) {
  const summary = clean(input.summary || input.action || input.intent, 1200);
  if (!summary) throw new Error("agent action summary is required");
  const agentId = clean(input.agent?.id || input.agent || input.actor, 160);
  if (!agentId) throw new Error("agent id is required");
  const outcome = OUTCOMES.has(input.outcome) ? input.outcome : "completed";
  const verificationStatus = VERIFICATION_STATES.has(input.verification?.status || input.verificationStatus)
    ? (input.verification?.status || input.verificationStatus)
    : "unverified";
  const riskTier = RISK_TIERS.has(input.risk?.tier || input.riskTier)
    ? (input.risk?.tier || input.riskTier)
    : "change";
  const id = clean(input.id, 160) || randomUUID();
  const createdAt = clean(input.createdAt, 80) || now();
  const skillId = slug(input.skillHint?.id || input.skillId || summary);
  return {
    schemaVersion: 1,
    kind: RECEIPT_KIND,
    id,
    createdAt,
    agent: {
      id: agentId,
      kind: clean(input.agent?.kind || input.agentKind || "agent", 80),
      model: clean(input.agent?.model || input.model, 160) || null,
      sessionId: clean(input.agent?.sessionId || input.sessionId, 200) || null
    },
    project: {
      id: slug(input.project?.id || input.projectId || path.basename(input.coordinate || process.cwd())) || "local",
      root: clean(input.project?.root || input.coordinate || process.cwd(), 1200)
    },
    intent: clean(input.intent || summary, 1200),
    summary,
    actions: list(input.actions || input.action),
    commands: list(input.commands || input.command),
    files: list(input.files || input.file),
    capabilities: list(input.capabilities || input.capability),
    outcome,
    verification: {
      status: verificationStatus,
      checks: list(input.verification?.checks || input.checks || input.check),
      proof: list(input.verification?.proof || input.proof)
    },
    risk: {
      tier: riskTier,
      permissions: list(input.risk?.permissions || input.permissions || input.permission),
      sideEffects: list(input.risk?.sideEffects || input.sideEffects || input.sideEffect)
    },
    repeatable: bool(input.repeatable),
    skillHint: bool(input.repeatable) ? {
      id: skillId,
      name: clean(input.skillHint?.name || input.skillName || title(skillId), 160),
      description: clean(input.skillHint?.description || input.skillDescription || summary, 1200)
    } : null,
    nextAction: clean(input.nextAction, 1200) || null,
    localOnly: true
  };
}

function candidateFromReceipt(receipt) {
  if (!receipt.repeatable || !receipt.skillHint?.id) return null;
  const previous = proposalById(receipt.skillHint.id);
  const receiptIds = [...new Set([...(previous?.sourceReceiptIds ?? []), receipt.id])];
  const proposal = {
    schemaVersion: 1,
    id: receipt.skillHint.id,
    name: receipt.skillHint.name,
    description: receipt.skillHint.description,
    status: "draft",
    source: "agent-action-receipt",
    sourceReceiptIds: receiptIds,
    observations: receiptIds.length,
    agentKinds: [...new Set([...(previous?.agentKinds ?? []), receipt.agent.kind])],
    projectIds: [...new Set([...(previous?.projectIds ?? []), receipt.project.id])],
    commands: [...new Set([...(previous?.commands ?? []), ...receipt.commands])],
    files: [...new Set([...(previous?.files ?? []), ...receipt.files])],
    capabilities: [...new Set([...(previous?.capabilities ?? []), ...receipt.capabilities])],
    permissions: [...new Set([...(previous?.permissions ?? []), ...receipt.risk.permissions])],
    sideEffects: [...new Set([...(previous?.sideEffects ?? []), ...receipt.risk.sideEffects])],
    verification: [...new Set([...(previous?.verification ?? []), ...receipt.verification.checks])],
    instructions: previous?.instructions || `Repeat the verified workflow described by receipt ${receipt.id}. Inspect live state first, preserve unrelated work, execute only within the approved scope, and return a HII receipt.`,
    createdAt: previous?.createdAt || now(),
    updatedAt: now()
  };
  appendJsonl(paths().proposals, { type: previous ? "updated" : "created", ts: now(), proposal });
  writeProposalBundle(proposal);
  return proposal;
}

function skillMarkdown(proposal) {
  const verification = proposal.verification?.length
    ? proposal.verification.map((item) => `- ${item}`).join("\n")
    : "- Define and run a task-appropriate verification check before promotion.";
  const permissions = proposal.permissions?.length
    ? proposal.permissions.map((item) => `- ${item}`).join("\n")
    : "- Use only the permissions explicitly granted for the current task.";
  const sideEffects = proposal.sideEffects?.length
    ? proposal.sideEffects.map((item) => `- ${item}`).join("\n")
    : "- No undeclared side effects.";
  return `---\nname: ${proposal.id}\ndescription: ${JSON.stringify(proposal.description)}\n---\n\n# ${proposal.name}\n\n${proposal.instructions}\n\n## Permissions\n\n${permissions}\n\n## Side effects\n\n${sideEffects}\n\n## Verification\n\n${verification}\n\nFinish with Done, Verified, Not Verified, Proof, Risk, and Next Command.\n`;
}

function proposalManifest(proposal) {
  return {
    schemaVersion: 1,
    kind: "hii.skill-manifest",
    id: proposal.id,
    name: proposal.name,
    description: proposal.description,
    status: proposal.status,
    sourceReceiptIds: proposal.sourceReceiptIds ?? [],
    observations: proposal.observations ?? 0,
    permissions: proposal.permissions ?? [],
    sideEffects: proposal.sideEffects ?? [],
    verification: proposal.verification ?? [],
    commands: proposal.commands ?? [],
    capabilities: proposal.capabilities ?? [],
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt
  };
}

function writeProposalBundle(proposal) {
  const folder = path.join(paths().proposed, proposal.id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "SKILL.md"), skillMarkdown(proposal), "utf8");
  writeJson(path.join(folder, "manifest.json"), proposalManifest(proposal));
  return folder;
}

function createProposal(input) {
  ensureRegistryFile();
  const id = slug(input.id || input.name);
  if (!id) throw new Error("skill id is required and must contain letters or digits");
  const previous = proposalById(id);
  if (registeredById(id)) throw new Error(`skill is already registered: ${id}`);
  const sourceReceiptIds = [...new Set([
    ...(previous?.sourceReceiptIds ?? []),
    ...list(input.sourceReceiptIds || input.fromReport)
  ])];
  for (const receiptId of sourceReceiptIds) {
    if (!receiptById(receiptId)) throw new Error(`source receipt not found: ${receiptId}`);
  }
  const proposal = {
    schemaVersion: 1,
    id,
    name: clean(input.name || previous?.name || title(id), 160),
    description: clean(input.description || previous?.description, 1200),
    status: "draft",
    source: input.source || previous?.source || "manual",
    sourceReceiptIds,
    observations: sourceReceiptIds.length,
    agentKinds: previous?.agentKinds ?? [],
    projectIds: previous?.projectIds ?? [],
    commands: [...new Set([...(previous?.commands ?? []), ...list(input.commands)])],
    files: previous?.files ?? [],
    capabilities: [...new Set([...(previous?.capabilities ?? []), ...list(input.capabilities)])],
    permissions: [...new Set([...(previous?.permissions ?? []), ...list(input.permissions)])],
    sideEffects: [...new Set([...(previous?.sideEffects ?? []), ...list(input.sideEffects)])],
    verification: [...new Set([...(previous?.verification ?? []), ...list(input.verification)])],
    instructions: clean(input.instructions || previous?.instructions, 12000),
    createdAt: previous?.createdAt || now(),
    updatedAt: now()
  };
  if (!proposal.description) throw new Error("skill description is required");
  if (!proposal.instructions) throw new Error("skill instructions are required");
  appendJsonl(paths().proposals, { type: previous ? "updated" : "created", ts: now(), proposal });
  return { proposal, folder: writeProposalBundle(proposal) };
}

function verifiedReceipts(proposal) {
  return (proposal.sourceReceiptIds ?? [])
    .map(receiptById)
    .filter(Boolean)
    .filter((receipt) => receipt.verification?.status === "verified");
}

function registerProposal(id, reviewedBy) {
  const proposal = proposalById(id);
  if (!proposal) throw new Error(`skill proposal not found: ${id}`);
  if (!clean(reviewedBy, 160)) throw new Error("--reviewed-by is required for registration");
  if (proposal.verification.length === 0 && verifiedReceipts(proposal).length === 0) {
    throw new Error("registration requires a verification command or a verified source receipt");
  }
  const registeredAt = now();
  const registered = {
    ...proposal,
    status: "registered",
    trustLevel: "operator-reviewed",
    reviewedBy: clean(reviewedBy, 160),
    registeredAt,
    updatedAt: registeredAt
  };
  const folder = path.join(paths().registered, proposal.id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "SKILL.md"), skillMarkdown(registered), "utf8");
  writeJson(path.join(folder, "manifest.json"), {
    ...proposalManifest(registered),
    trustLevel: registered.trustLevel,
    reviewedBy: registered.reviewedBy,
    registeredAt
  });
  const current = registry().skills.filter((item) => item.id !== proposal.id);
  current.push({
    id: proposal.id,
    name: proposal.name,
    description: proposal.description,
    status: "registered",
    trustLevel: "operator-reviewed",
    path: folder,
    sourceReceiptIds: proposal.sourceReceiptIds,
    registeredAt,
    reviewedBy: registered.reviewedBy
  });
  writeRegistry(current);
  appendJsonl(paths().proposals, { type: "registered", ts: registeredAt, proposal: registered });
  return { skill: current.find((item) => item.id === proposal.id), folder };
}

function displaySkill(skill) {
  console.log(`${skill.id}`);
  console.log(`  name:        ${skill.name}`);
  console.log(`  state:       ${skill.status}${skill.trustLevel ? ` / ${skill.trustLevel}` : ""}`);
  console.log(`  description: ${skill.description}`);
  if (skill.observations != null) console.log(`  observations:${String(skill.observations).padStart(2, " ")}`);
  if (skill.path) console.log(`  path:        ${skill.path}`);
  console.log("");
}

function exportSkill(id, args) {
  const skill = registeredById(id);
  if (!skill) throw new Error(`registered skill not found: ${id}`);
  const manifest = readJson(path.join(skill.path, "manifest.json"), null);
  const markdown = fs.readFileSync(path.join(skill.path, "SKILL.md"), "utf8");
  if (!manifest) throw new Error(`registered manifest is missing: ${skill.path}`);
  const includeProvenance = has(args, "--include-provenance");
  const receipts = includeProvenance
    ? (manifest.sourceReceiptIds ?? []).map(receiptById).filter(Boolean).map((receipt) => ({
        id: receipt.id,
        createdAt: receipt.createdAt,
        agent: receipt.agent,
        project: receipt.project,
        summary: receipt.summary,
        outcome: receipt.outcome,
        verification: receipt.verification,
        risk: receipt.risk
      }))
    : [];
  const exportedAt = now();
  const priceCentsRaw = flag(args, "--price-cents", "");
  const priceCents = priceCentsRaw === "" ? null : Number.parseInt(priceCentsRaw, 10);
  if (priceCentsRaw !== "" && (!Number.isInteger(priceCents) || priceCents < 0)) {
    throw new Error("--price-cents must be a non-negative integer");
  }
  const payload = {
    schemaVersion: 1,
    exportKind: EXPORT_KIND,
    exportedAt,
    localOnly: true,
    skill: manifest,
    files: { "SKILL.md": markdown },
    provenance: {
      included: includeProvenance,
      sourceReceiptCount: manifest.sourceReceiptIds?.length ?? 0,
      receipts
    },
    distribution: {
      status: "review-required",
      license: clean(flag(args, "--license", "unspecified"), 160),
      price: priceCents == null ? null : {
        amountCents: priceCents,
        currency: clean(flag(args, "--currency", "usd"), 12).toLowerCase()
      },
      published: false
    },
    guardrails: [
      "This package was exported locally and was not uploaded or published.",
      "Review commands, permissions, side effects, provenance, and licensing before sharing.",
      "Secret values are excluded by the reporting redactor; inspect the package before distribution."
    ]
  };
  const stamp = exportedAt.replace(/[:.]/g, "-");
  const output = flag(args, "--output", path.join(paths().exports, `${skill.id}-${stamp}.hii-skill.json`));
  writeJson(path.resolve(output), payload);
  appendJsonl(path.join(paths().exports, "exports.jsonl"), {
    id: randomUUID(),
    skillId: skill.id,
    exportedAt,
    path: path.resolve(output),
    includedProvenance: includeProvenance,
    published: false
  });
  return path.resolve(output);
}

function doctor() {
  const issues = [];
  const seen = new Set();
  const data = registry();
  for (const skill of data.skills) {
    if (!slug(skill.id) || slug(skill.id) !== skill.id) issues.push(`${skill.id}: invalid id`);
    if (seen.has(skill.id)) issues.push(`${skill.id}: duplicate registry id`);
    seen.add(skill.id);
    if (!skill.path || !fs.existsSync(path.join(skill.path, "SKILL.md"))) issues.push(`${skill.id}: missing SKILL.md`);
    const manifest = skill.path ? readJson(path.join(skill.path, "manifest.json"), null) : null;
    if (!manifest) issues.push(`${skill.id}: missing or invalid manifest.json`);
    if (!skill.reviewedBy) issues.push(`${skill.id}: missing reviewer`);
    for (const receiptId of skill.sourceReceiptIds ?? []) {
      if (!receiptById(receiptId)) issues.push(`${skill.id}: missing source receipt ${receiptId}`);
    }
  }
  const legacyFiles = (() => {
    try {
      return fs.readdirSync(paths().root).filter((file) => file.endsWith(".json") && !["registry.json", "_index.json"].includes(file)).length;
    } catch {
      return 0;
    }
  })();
  return {
    ok: issues.length === 0,
    registered: data.skills.length,
    proposals: latestProposals().filter((item) => item.status !== "registered").length,
    actionReceipts: readJsonl(paths().receipts).length,
    legacyManifests: legacyFiles,
    paths: paths(),
    issues
  };
}

export function reportAgentAction(input) {
  ensureRegistryFile();
  const receipt = normalizeReceipt(input);
  appendJsonl(paths().receipts, receipt);
  const proposal = candidateFromReceipt(receipt);
  return { receipt, proposal };
}

export function registerSkillProposal(id, reviewedBy) {
  ensureRegistryFile();
  return registerProposal(id, reviewedBy);
}

export function runSkillCommand(args) {
  const sub = args[0] || "list";
  if (sub === "report") {
    const fromFile = flag(args, "--file", "");
    const input = fromFile ? parseReceiptFile(fromFile) : {
      agent: { id: flag(args, "--agent", ""), kind: flag(args, "--agent-kind", "agent"), model: flag(args, "--model", ""), sessionId: flag(args, "--session", "") },
      projectId: flag(args, "--project", ""),
      coordinate: flag(args, "--coordinate", process.cwd()),
      intent: flag(args, "--intent", ""),
      summary: flag(args, "--summary", ""),
      actions: flag(args, "--actions", ""),
      commands: flag(args, "--commands", ""),
      files: flag(args, "--files", ""),
      capabilities: flag(args, "--capabilities", ""),
      outcome: flag(args, "--outcome", "completed"),
      verificationStatus: flag(args, "--verification", "unverified"),
      checks: flag(args, "--checks", ""),
      proof: flag(args, "--proof", ""),
      riskTier: flag(args, "--risk", "change"),
      permissions: flag(args, "--permissions", ""),
      sideEffects: flag(args, "--side-effects", ""),
      repeatable: has(args, "--repeatable"),
      skillId: flag(args, "--skill-id", ""),
      skillName: flag(args, "--skill-name", ""),
      skillDescription: flag(args, "--skill-description", ""),
      nextAction: flag(args, "--next", "")
    };
    const result = reportAgentAction(input);
    console.log(`reported ${result.receipt.id}`);
    console.log(`receipt: ${paths().receipts}`);
    if (result.proposal) {
      console.log(`draft:   ${result.proposal.id}`);
      console.log(`bundle:  ${path.join(paths().proposed, result.proposal.id)}`);
    }
    return;
  }
  if (sub === "create") {
    const id = args[1];
    const instructionsFile = flag(args, "--instructions-file", "");
    const instructions = instructionsFile
      ? fs.readFileSync(path.resolve(instructionsFile), "utf8")
      : flag(args, "--instructions", "");
    const result = createProposal({
      id,
      name: flag(args, "--name", ""),
      description: flag(args, "--description", ""),
      instructions,
      commands: flag(args, "--commands", ""),
      capabilities: flag(args, "--capabilities", ""),
      permissions: flag(args, "--permissions", ""),
      sideEffects: flag(args, "--side-effects", ""),
      verification: flag(args, "--verify", ""),
      fromReport: flag(args, "--from-report", "")
    });
    console.log(`created draft ${result.proposal.id}`);
    console.log(`bundle: ${result.folder}`);
    return;
  }
  if (sub === "register" || sub === "promote") {
    const id = args[1];
    if (!id) throw new Error("usage: hii skill register <id> --reviewed-by <name>");
    const result = registerProposal(id, flag(args, "--reviewed-by", ""));
    console.log(`registered ${result.skill.id}`);
    console.log(`bundle: ${result.folder}`);
    return;
  }
  if (sub === "list") {
    const includeDrafts = has(args, "--all") || has(args, "--drafts");
    console.log("HII skill registry\n");
    for (const skill of registry().skills) displaySkill(skill);
    if (includeDrafts) {
      for (const proposal of latestProposals().filter((item) => item.status !== "registered")) displaySkill(proposal);
    }
    console.log(`registered: ${registry().skills.length}`);
    if (includeDrafts) console.log(`drafts:     ${latestProposals().filter((item) => item.status !== "registered").length}`);
    console.log(`registry:   ${paths().registry}`);
    return;
  }
  if (sub === "search") {
    const query = clean(args.slice(1).filter((item) => !item.startsWith("--")).join(" "), 500).toLowerCase();
    if (!query) throw new Error("usage: hii skill search <query> [--all]");
    const candidates = [...registry().skills, ...(has(args, "--all") ? latestProposals().filter((item) => item.status !== "registered") : [])];
    const matches = candidates.filter((item) => `${item.id} ${item.name} ${item.description}`.toLowerCase().includes(query));
    for (const match of matches) displaySkill(match);
    console.log(`matches: ${matches.length}`);
    return;
  }
  if (sub === "show") {
    const id = args[1];
    const skill = registeredById(id) || proposalById(id);
    if (!skill) throw new Error(`skill not found: ${id}`);
    console.log(JSON.stringify(skill, null, 2));
    return;
  }
  if (sub === "export") {
    const id = args[1];
    if (!id) throw new Error("usage: hii skill export <id> [--include-provenance] [--output <path>]");
    const output = exportSkill(id, args.slice(2));
    console.log(`exported ${id}`);
    console.log(`package: ${output}`);
    console.log("local only; not uploaded or published");
    return;
  }
  if (sub === "doctor") {
    const result = doctor();
    console.log("HII Skill Registry Doctor\n");
    console.log(`registered:      ${result.registered}`);
    console.log(`draft proposals: ${result.proposals}`);
    console.log(`action receipts: ${result.actionReceipts}`);
    console.log(`legacy manifests:${String(result.legacyManifests).padStart(2, " ")} (reference only)`);
    console.log(`status:          ${result.ok ? "ok" : "failed"}`);
    console.log(`registry:        ${result.paths.registry}`);
    if (result.issues.length) {
      console.log("\nIssues:");
      for (const issue of result.issues) console.log(`  - ${issue}`);
      process.exitCode = 1;
    }
    return;
  }
  throw new Error("usage: hii skill <report|create|register|list|search|show|export|doctor>");
}

export const skillRegistryPaths = paths;
