#!/usr/bin/env node
// HII CLI — marketplace-era entrypoint (replaces the old Python psyche-engine CLI).
// Installed via ~/bin/hii. `hii legacy ...` still reaches the old CLI at ~/hii-old.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = path.join(os.homedir(), "hii");
const RUNTIME = path.join(os.homedir(), ".hii");
const BRIDGE_DIR = path.join(ROOT, "bridge", "messages");
const BRIDGE_LOG = path.join(RUNTIME, "bridge", "yin-codex.jsonl");
const CAPABILITY_REGISTRY = path.join(ROOT, "lib", "capabilities", "registry.json");
const CAPABILITY_PACKS = path.join(ROOT, "lib", "capabilities", "packs.json");
const LOCAL_CAPABILITY_JOBS = path.join(ROOT, ".hii", "capability-jobs.jsonl");
const OG_EVENTS = path.join(RUNTIME, "og", "events.jsonl");
const LOOP_DIR = path.join(RUNTIME, "loop");
const LOOP_DECISIONS = path.join(LOOP_DIR, "decisions.jsonl");
const LOOP_NOTES = path.join(LOOP_DIR, "notes.jsonl");
const LOOP_DISABLED = path.join(LOOP_DIR, "disabled");
const PACK_EXPORT_DIR = path.join(RUNTIME, "packs", "exports");

function codexBin() {
  const pinned = path.join(os.homedir(), ".local", "bin", "codex");
  return fs.existsSync(pinned) ? pinned : "codex";
}

const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "NEXT_PUBLIC_BASE_URL"
];

function readEnvFile() {
  const values = {};
  for (const name of [".env", ".env.local"]) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
      if (m) values[m[1]] = m[2].trim();
    }
  }
  return values;
}

function logBridge(event) {
  fs.mkdirSync(path.dirname(BRIDGE_LOG), { recursive: true });
  const entry = { ts: new Date().toISOString(), from: "yang", ...event };
  fs.appendFileSync(BRIDGE_LOG, `${JSON.stringify(entry)}\n`);
  return entry;
}

function npmRun(script, extra = []) {
  const r = spawnSync("npm", ["run", script, ...extra], { cwd: ROOT, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

function readJsonArray(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendJsonl(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

function redactText(value) {
  return String(value)
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)=)([^\s]+)/gi, "$1[redacted]")
    .replace(/((?:OPENAI|ANTHROPIC|SUPABASE|STRIPE|GITHUB|VERCEL|CLOUDFLARE|AWS)[A-Z0-9_]*=)([^\s]+)/g, "$1[redacted]")
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, "$1[redacted]")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[redacted]")
    .slice(0, 2000);
}

function gitSnapshot() {
  try {
    const branch = execFileSync("git", ["-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    const status = execFileSync("git", ["-C", ROOT, "status", "--short"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(redactText);
    const recent = execFileSync("git", ["-C", ROOT, "log", "--oneline", "-5"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    return { branch, status, recent };
  } catch {
    return { branch: "unknown", status: [], recent: [] };
  }
}

function fileExistsSummary(file) {
  try {
    const stat = fs.statSync(file);
    return { path: file, exists: true, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
  } catch {
    return { path: file, exists: false };
  }
}

function runtimePointers() {
  return [
    fileExistsSummary(path.join(RUNTIME, "agent_context.md")),
    fileExistsSummary(path.join(RUNTIME, "intent_state.json")),
    fileExistsSummary(path.join(RUNTIME, "registry", "snapshot.json")),
    fileExistsSummary(path.join(RUNTIME, "conversations", "bridge.jsonl")),
    fileExistsSummary(BRIDGE_LOG),
    fileExistsSummary(LOOP_DECISIONS),
    fileExistsSummary(LOOP_NOTES),
    fileExistsSummary(path.join(RUNTIME, "mind0", "state.json"))
  ];
}

function inferNextActions({ prompt, git, capabilities, jobs, bridge }) {
  const text = `${prompt} ${git.status.join(" ")} ${bridge.map((entry) => JSON.stringify(entry)).join(" ")}`.toLowerCase();
  const actions = [];
  if (git.status.length > 0) {
    actions.push({
      score: 95,
      track: "repo hygiene",
      coordinate: ROOT,
      action: "review dirty files, commit product changes, leave local/private files untracked"
    });
  }
  if (text.includes("og") || text.includes("oracle") || text.includes("persistent") || text.includes("conversation")) {
    actions.push({
      score: 92,
      track: "operational graph",
      coordinate: "hii og",
      action: "capture this turn as an OG event and use local context to rank the next path"
    });
  }
  if (capabilities.some((capability) => capability.id === "termite.rhino.managed_job")) {
    actions.push({
      score: text.includes("termite") || text.includes("rhino") ? 90 : 62,
      track: "Termite capability",
      coordinate: "/termite + termite.rhino.managed_job",
      action: "keep Termite as the first proof capability with logs and artifacts"
    });
  }
  if (text.includes("build") || text.includes("ci") || text.includes("local")) {
    actions.push({
      score: 88,
      track: "local CI/CD",
      coordinate: "npm run build",
      action: "run build and CLI checks after each meaningful implementation step"
    });
  }
  if (jobs.length > 0) {
    actions.push({
      score: 72,
      track: "capability jobs",
      coordinate: LOCAL_CAPABILITY_JOBS,
      action: "summarize recent job receipts before spawning more work"
    });
  }
  actions.push({
    score: 55,
    track: "HII exchange spine",
    coordinate: "/upload + /x/[id]",
    action: "preserve the file exchange loop as a first-party capability while extending OG"
  });
  return actions.sort((a, b) => b.score - a.score).slice(0, 5);
}

function appendOgEvent(event) {
  appendJsonl(OG_EVENTS, event);
}

function classifyLoopPolicy(action) {
  const text = `${action.track} ${action.coordinate} ${action.action}`.toLowerCase();
  const refused = ["push", "publish", "upload", "delete", "reset", "external", "network", "payment"];
  const approval = ["spawn", "commit", "edit", "write", "build", "ship", "agent", "npm run build"];
  if (refused.some((word) => text.includes(word))) {
    return {
      risk: "external-or-destructive",
      requiresApproval: true,
      allowedWithoutApproval: false,
      defaultDecision: "no",
      reason: "external, destructive, or payment-like actions stay blocked until the user explicitly says yes"
    };
  }
  if (approval.some((word) => text.includes(word))) {
    return {
      risk: "mutating-or-costly",
      requiresApproval: true,
      allowedWithoutApproval: false,
      defaultDecision: "ask",
      reason: "mutating or costly actions need a y/n gate"
    };
  }
  return {
    risk: "observe",
    requiresApproval: false,
    allowedWithoutApproval: true,
    defaultDecision: "yes",
    reason: "observe/summarize/propose actions are local-only and non-mutating"
  };
}

function userProxyContext(prompt = "") {
  const git = gitSnapshot();
  const capabilities = readJsonArray(CAPABILITY_REGISTRY);
  const jobs = readJsonl(LOCAL_CAPABILITY_JOBS).slice(-20);
  const bridge = readJsonl(BRIDGE_LOG).slice(-30).map((entry) => ({
    ts: entry.ts,
    type: entry.type,
    from: entry.from,
    to: entry.to,
    body: entry.body ? redactText(entry.body).slice(0, 500) : undefined,
    prompt: entry.prompt ? redactText(entry.prompt).slice(0, 500) : undefined
  }));
  const og = readJsonl(OG_EVENTS).slice(-20);
  const notes = readJsonl(LOOP_NOTES).slice(-20);
  const decisions = readJsonl(LOOP_DECISIONS).slice(-20);
  const nextActions = inferNextActions({ prompt, git, capabilities, jobs, bridge });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    prompt: redactText(prompt),
    identity: {
      repo: ROOT,
      runtime: RUNTIME,
      role: "local user-proxy context for persistent HII loops"
    },
    git,
    sources: {
      bridgeEvents: bridge.length,
      ogEvents: og.length,
      notes: notes.length,
      decisions: decisions.length,
      jobs: jobs.length,
      capabilities: capabilities.length
    },
    recent: {
      bridge,
      og: og.map((entry) => ({
        id: entry.id,
        ts: entry.ts,
        mode: entry.mode,
        prompt: entry.prompt ? redactText(entry.prompt).slice(0, 280) : ""
      })),
      notes: notes.map((entry) => ({
        id: entry.id,
        ts: entry.ts,
        note: redactText(entry.note ?? "").slice(0, 500)
      })),
      decisions: decisions.map((entry) => ({
        id: entry.id,
        ts: entry.ts,
        status: entry.status,
        decision: entry.decision,
        track: entry.proposal?.track,
        nextCommand: entry.proposal?.nextCommand
      }))
    },
    nextActions
  };
}

function loopDecisionFromContext(context, mode = "once") {
  const top = context.nextActions[0] ?? {
    score: 0,
    track: "idle",
    coordinate: "hii loop",
    action: "wait for a user note or new local event"
  };
  const policy = classifyLoopPolicy(top);
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    capabilityId: "hii.loop.user_proxy",
    mode,
    status: fs.existsSync(LOOP_DISABLED) ? "disabled" : "proposed",
    inputs: {
      prompt: context.prompt,
      repo: context.identity.repo,
      branch: context.git.branch,
      dirtyFiles: context.git.status.length,
      sources: context.sources
    },
    inferredIntent: {
      track: top.track,
      confidence: top.score,
      evidence: [
        `repo=${context.identity.repo}`,
        `branch=${context.git.branch}`,
        `dirtyFiles=${context.git.status.length}`,
        `bridgeEvents=${context.sources.bridgeEvents}`,
        `ogEvents=${context.sources.ogEvents}`,
        `notes=${context.sources.notes}`
      ]
    },
    proposal: {
      track: top.track,
      coordinate: top.coordinate,
      next: top.action,
      capabilityId: top.track === "operational graph" ? "hii.og.operational_graph" : "hii.terminal.observe",
      nextCommand: top.coordinate === ROOT
        ? "git status --short"
        : top.coordinate,
      verification: top.track === "local CI/CD" ? "npm run build" : "hii context --json"
    },
    policy,
    decision: policy.defaultDecision,
    controls: {
      yes: `hii loop decide ${top.score ? "yes" : "no"}`,
      no: "hii loop decide no",
      note: "hii loop note <your note>"
    }
  };
}

function printLoopDecision(decision) {
  console.log("HII Loop — user proxy\n");
  console.log(`decision: ${decision.id}`);
  console.log(`status:   ${decision.status}`);
  console.log(`intent:   ${decision.inferredIntent.track} (${decision.inferredIntent.confidence})`);
  console.log(`risk:     ${decision.policy.risk}`);
  console.log(`gate:     ${decision.policy.requiresApproval ? "y/n required" : "auto-observe ok"}`);
  console.log(`next:     ${decision.proposal.next}`);
  console.log(`command:  ${decision.proposal.nextCommand}`);
  console.log(`verify:   ${decision.proposal.verification}`);
  console.log("\ncontrols:");
  console.log(`  y   ${decision.controls.yes}`);
  console.log(`  n   ${decision.controls.no}`);
  console.log(`  tab ${decision.controls.note}`);
  console.log(`\nlog: ${LOOP_DECISIONS}`);
}

function cmdLoop(args) {
  const sub = args[0] || "once";
  if (sub === "note") {
    const note = redactText(args.slice(1).join(" "));
    if (!note) { console.error("usage: hii loop note <note>"); process.exit(1); }
    const entry = appendJsonl(LOOP_NOTES, {
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: "user-note",
      note
    });
    console.log(`noted ${entry.id}`);
    console.log(`log: ${LOOP_NOTES}`);
    return;
  }
  if (sub === "decide") {
    const value = String(args[1] ?? "").toLowerCase();
    if (!["y", "yes", "n", "no"].includes(value)) {
      console.error("usage: hii loop decide <yes|no>");
      process.exit(1);
    }
    const latest = readJsonl(LOOP_DECISIONS).slice(-1)[0];
    if (!latest) {
      console.error("no loop decision yet; run `hii loop once` first");
      process.exit(1);
    }
    const entry = appendJsonl(LOOP_DECISIONS, {
      ...latest,
      id: randomUUID(),
      ts: new Date().toISOString(),
      parentId: latest.id,
      status: value.startsWith("y") ? "approved" : "rejected",
      decision: value.startsWith("y") ? "yes" : "no"
    });
    console.log(`${entry.status} ${latest.id}`);
    console.log(`next: ${entry.status === "approved" ? entry.proposal.nextCommand : "wait for note or new event"}`);
    return;
  }
  if (sub === "status") {
    const decisions = readJsonl(LOOP_DECISIONS);
    const notes = readJsonl(LOOP_NOTES);
    const latest = decisions.slice(-1)[0];
    console.log("HII Loop Status\n");
    console.log(`enabled:   ${fs.existsSync(LOOP_DISABLED) ? "no" : "yes"}`);
    console.log(`decisions: ${decisions.length}`);
    console.log(`notes:     ${notes.length}`);
    console.log(`log:       ${LOOP_DECISIONS}`);
    if (latest) {
      console.log(`\nlatest:   ${latest.id}`);
      console.log(`status:   ${latest.status}`);
      console.log(`intent:   ${latest.inferredIntent?.track ?? "unknown"}`);
      console.log(`next:     ${latest.proposal?.next ?? "unknown"}`);
      console.log(`decision: ${latest.decision ?? "unknown"}`);
    }
    return;
  }
  if (sub === "disable") {
    fs.mkdirSync(LOOP_DIR, { recursive: true });
    fs.writeFileSync(LOOP_DISABLED, `${new Date().toISOString()}\n`);
    console.log(`disabled: ${LOOP_DISABLED}`);
    return;
  }
  if (sub === "enable") {
    if (fs.existsSync(LOOP_DISABLED)) fs.unlinkSync(LOOP_DISABLED);
    console.log("enabled");
    return;
  }
  if (sub !== "once") {
    console.error("usage: hii loop [once|status|note|decide|enable|disable]");
    process.exit(1);
  }
  const prompt = args.slice(1).join(" ") || "persistent user proxy loop";
  const context = userProxyContext(prompt);
  const decision = appendJsonl(LOOP_DECISIONS, loopDecisionFromContext(context, "once"));
  appendOgEvent({
    id: randomUUID(),
    ts: decision.ts,
    capabilityId: "hii.loop.user_proxy",
    mode: "loop-once",
    prompt: context.prompt,
    decisionId: decision.id,
    nextActions: context.nextActions
  });
  printLoopDecision(decision);
}

function cmdOg(args) {
  const sub = args[0] || "status";
  const prompt = redactText(args.slice(1).join(" "));
  const capabilities = readJsonArray(CAPABILITY_REGISTRY);
  const jobs = readJsonl(LOCAL_CAPABILITY_JOBS).slice(-20);
  const bridge = readJsonl(BRIDGE_LOG).slice(-20).map((entry) => ({
    ts: entry.ts,
    type: entry.type,
    from: entry.from,
    to: entry.to,
    body: entry.body ? redactText(entry.body).slice(0, 280) : undefined
  }));
  const git = gitSnapshot();
  const event = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    capabilityId: "hii.og.operational_graph",
    mode: sub,
    prompt,
    sources: {
      repo: ROOT,
      branch: git.branch,
      dirtyFiles: git.status.length,
      capabilities: capabilities.length,
      recentJobs: jobs.length,
      bridgeEvents: bridge.length,
      runtime: runtimePointers()
    },
    nextActions: inferNextActions({ prompt, git, capabilities, jobs, bridge })
  };
  if (sub === "capture" || prompt) appendOgEvent(event);
  console.log("OG — Operational Graph\n");
  console.log(`event:   ${event.id}`);
  console.log(`mode:    ${event.mode}${sub === "capture" || prompt ? " (captured)" : ""}`);
  console.log(`repo:    ${ROOT}`);
  console.log(`git:     ${git.branch}${git.status.length ? ` (${git.status.length} dirty)` : " (clean)"}`);
  console.log(`sources: capabilities=${capabilities.length} jobs=${jobs.length} bridge=${bridge.length}`);
  console.log("\nLikely next path:");
  for (const item of event.nextActions) {
    console.log(`  ${item.score}  ${item.track}`);
    console.log(`      coordinate: ${item.coordinate}`);
    console.log(`      next:       ${item.action}`);
  }
  console.log(`\nlog: ${OG_EVENTS}`);
}

function cmdStatus() {
  const env = readEnvFile();
  console.log("HII — marketplace status\n");
  console.log(`repo:    ${ROOT}`);
  try {
    const branch = execFileSync("git", ["-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"]).toString().trim();
    const dirty = execFileSync("git", ["-C", ROOT, "status", "--porcelain"]).toString().trim();
    console.log(`git:     ${branch}${dirty ? " (dirty)" : " (clean)"}`);
  } catch { console.log("git:     unavailable"); }
  console.log("\nenv:");
  for (const key of ENV_KEYS) {
    const set = Boolean(env[key]);
    console.log(`  ${set ? "ok " : "MISSING"}  ${key}`);
  }
  const codex = spawnSync(codexBin(), ["--version"], { encoding: "utf8" });
  console.log(`\ncodex:   ${codex.status === 0 ? codex.stdout.trim() : "not installed"}`);
  console.log(`bridge:  ${fs.existsSync(BRIDGE_LOG) ? BRIDGE_LOG : "no log yet"}`);
}

function agentCommandCatalog() {
  return [
    { command: "hii health --text", purpose: "Human-readable repo, env-presence, codex, and bridge snapshot." },
    { command: "hii context --json", purpose: "Machine-readable agent context snapshot; best first command for agents." },
    { command: "hii caps show", purpose: "List backend-owned capabilities." },
    { command: "hii og status", purpose: "Infer likely next work from repo, bridge, job, and runtime context." },
    { command: "hii og capture <message>", purpose: "Append an operational-graph event for this turn." },
    { command: "hii loop once", purpose: "Propose the next user-proxy plan locally; do not act until y/n approval." },
    { command: "hii loop note <note>", purpose: "Add user notes to steer the persistent loop." },
    { command: "hii loop decide <yes|no>", purpose: "Approve or reject the latest proposed plan." },
    { command: "hii pack list", purpose: "List compartmentalized HII capability packs." },
    { command: "hii pack export <id>", purpose: "Write a local-only pack manifest for staged shipping." },
    { command: "hii jobs", purpose: "List recent local capability jobs." },
    { command: "hii doctor", purpose: "Run status plus registry doctor." },
    { command: "hii ship", purpose: "Typecheck and commit locally; does not push." },
    { command: "hii ship --push <message>", purpose: "Explicit external push; use only after user approval." },
    { command: "npm run build", purpose: "Validate the Next.js product app." }
  ];
}

function agentContextPayload() {
  const git = gitSnapshot();
  const capabilities = readJsonArray(CAPABILITY_REGISTRY);
  const jobs = readJsonl(LOCAL_CAPABILITY_JOBS)
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    .slice(0, 10);
  const bridge = fileExistsSummary(BRIDGE_LOG);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    identity: {
      name: "HII",
      role: "local-first capability terminal and exchange spine",
      repo: ROOT,
      runtime: RUNTIME,
      legacyRuntime: path.join(os.homedir(), "hii-old")
    },
    git,
    commands: agentCommandCatalog(),
    capabilities: capabilities.map((capability) => ({
      id: capability.id,
      name: capability.name,
      owner: capability.owner,
      runtime: capability.runtime,
      visibility: capability.visibility,
      status: capability.status,
      trustLevel: capability.trustLevel,
      summary: capability.summary
    })),
    localState: {
      bridge,
      capabilityJobs: fileExistsSummary(LOCAL_CAPABILITY_JOBS),
      ogEvents: fileExistsSummary(OG_EVENTS),
      runtimePointers: runtimePointers(),
      recentJobs: jobs.map((job) => ({
        id: job.id,
        capabilityId: job.capabilityId,
        status: job.status,
        createdAt: job.createdAt,
        inputSummary: job.inputSummary ? redactText(job.inputSummary).slice(0, 280) : ""
      }))
    },
    guardrails: [
      "Check git status and targeted diffs before editing.",
      "Do not reset, delete, or rewrite unclear user or agent work.",
      "Leave .claude, .hermes, life, screenshots, and other local/generated state untracked unless explicitly scoped.",
      "Keep secrets reference-only; report env presence, never raw values.",
      "Complete work locally by default; do not fetch, push, publish, upload, or call external services unless the user explicitly asks.",
      "Use hii ship for local typecheck and commit only; use hii ship --push only after explicit external publish approval.",
      "Run npm run build after meaningful HII product edits.",
      "Use /Users/ummi/hii for the product repo and /Users/ummi/hii-old only through hii legacy."
    ],
    nextActions: inferNextActions({
      prompt: "agent context accessibility",
      git,
      capabilities,
      jobs,
      bridge: readJsonl(BRIDGE_LOG).slice(-20)
    })
  };
}

function cmdContext(args) {
  const payload = agentContextPayload();
  if (args.includes("--json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log("HII Agent Context\n");
  console.log(`repo:    ${payload.identity.repo}`);
  console.log(`runtime: ${payload.identity.runtime}`);
  console.log(`git:     ${payload.git.branch}${payload.git.status.length ? ` (${payload.git.status.length} dirty)` : " (clean)"}`);
  console.log(`caps:    ${payload.capabilities.length}`);
  console.log(`jobs:    ${payload.localState.recentJobs.length}`);
  console.log("\nBest commands:");
  for (const item of payload.commands.slice(0, 6)) {
    console.log(`  ${item.command}`);
    console.log(`      ${item.purpose}`);
  }
  console.log("\nLikely next path:");
  for (const item of payload.nextActions.slice(0, 3)) {
    console.log(`  ${item.score} ${item.track}: ${item.action}`);
  }
  console.log("\nFor agents: hii context --json");
}

function cmdCaps() {
  const capabilities = readJsonArray(CAPABILITY_REGISTRY);
  if (capabilities.length === 0) {
    console.log("No capability registry found.");
    return;
  }
  console.log("HII backend capabilities\n");
  for (const capability of capabilities) {
    console.log(`${capability.id}`);
    console.log(`  name:       ${capability.name}`);
    console.log(`  owner:      ${capability.owner}`);
    console.log(`  runtime:    ${capability.runtime}`);
    console.log(`  state:      ${capability.status} / ${capability.trustLevel}`);
    console.log(`  visibility: ${capability.visibility}`);
    console.log(`  summary:    ${capability.summary}`);
    console.log("");
  }
}

function cmdJobs(args) {
  const limit = Number(args[0] ?? 20);
  const jobs = readJsonl(LOCAL_CAPABILITY_JOBS)
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    .slice(0, Number.isFinite(limit) ? limit : 20);
  if (jobs.length === 0) {
    console.log("No local capability jobs yet.");
    return;
  }
  console.log("Recent local capability jobs\n");
  for (const job of jobs) {
    console.log(`${job.id}  ${job.status ?? "unknown"}  ${job.capabilityId ?? "unknown"}`);
    console.log(`  created: ${job.createdAt ?? "unknown"}`);
    console.log(`  input:   ${job.inputSummary ?? ""}`);
    if (job.budget) console.log(`  budget:  ${job.budget}`);
    console.log("");
  }
}

function packById(id) {
  return readJsonArray(CAPABILITY_PACKS).find((pack) => pack.id === id);
}

function printPack(pack) {
  console.log(`${pack.id}`);
  console.log(`  name:       ${pack.name}`);
  console.log(`  summary:    ${pack.summary}`);
  console.log(`  caps:       ${(pack.capabilities ?? []).join(", ")}`);
  console.log(`  routes:     ${(pack.routes ?? []).join(", ")}`);
  console.log(`  commands:   ${(pack.commands ?? []).join(", ")}`);
  console.log(`  boundary:   ${pack.shipBoundary}`);
}

function cmdPack(args) {
  const sub = args[0] || "list";
  const packs = readJsonArray(CAPABILITY_PACKS);
  if (sub === "list") {
    console.log("HII capability packs\n");
    for (const pack of packs) {
      console.log(`${pack.id}`);
      console.log(`  ${pack.summary}`);
      console.log("");
    }
    return;
  }
  if (sub === "show") {
    const pack = packById(args[1]);
    if (!pack) { console.error("usage: hii pack show <pack-id>"); process.exit(1); }
    printPack(pack);
    console.log("\nfiles:");
    for (const file of pack.files ?? []) console.log(`  ${file}`);
    console.log("\nverification:");
    for (const command of pack.verification ?? []) console.log(`  ${command}`);
    return;
  }
  if (sub === "export") {
    const pack = packById(args[1]);
    if (!pack) { console.error("usage: hii pack export <pack-id>"); process.exit(1); }
    const git = gitSnapshot();
    const capabilities = readJsonArray(CAPABILITY_REGISTRY)
      .filter((capability) => (pack.capabilities ?? []).includes(capability.id));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = path.join(PACK_EXPORT_DIR, `${pack.id}-${stamp}.json`);
    const manifest = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      exportKind: "hii.capability-pack.manifest",
      localOnly: true,
      pack,
      capabilities,
      source: {
        repo: ROOT,
        branch: git.branch,
        dirtyFiles: git.status.length
      },
      guardrails: [
        "This is a local manifest export only.",
        "No files were uploaded, pushed, or published.",
        "Secret values are not included.",
        "Run verification commands before shipping this pack anywhere external."
      ]
    };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    appendJsonl(path.join(RUNTIME, "packs", "exports.jsonl"), {
      id: randomUUID(),
      ts: manifest.exportedAt,
      packId: pack.id,
      path: out,
      dirtyFiles: manifest.source.dirtyFiles
    });
    console.log(`exported ${pack.id}`);
    console.log(`manifest: ${out}`);
    console.log("not pushed; not published");
    return;
  }
  console.error("usage: hii pack <list|show|export>");
  process.exit(1);
}

function cmdTerminal(args) {
  const url = "http://localhost:3000/terminal";
  if (args.includes("--open")) {
    spawnSync("open", [url], { stdio: "inherit" });
    return;
  }
  console.log("HII Terminal");
  console.log(`  local UI: ${url}`);
  console.log("  start:    hii dev");
  console.log("  open:     hii terminal --open");
}

function cmdBridge(args) {
  const sub = args[0];
  if (sub === "send") {
    const body = args.slice(1).join(" ");
    if (!body) { console.error("usage: hii bridge send <message>"); process.exit(1); }
    fs.mkdirSync(BRIDGE_DIR, { recursive: true });
    const msg = { id: randomUUID(), ts: new Date().toISOString(), from: "yang", to: "yin", body };
    const file = path.join(BRIDGE_DIR, `${msg.ts.replace(/[:.]/g, "-")}-yang.json`);
    fs.writeFileSync(file, `${JSON.stringify(msg, null, 2)}\n`);
    logBridge({ type: "message", to: "yin", file, body });
    console.log(`sent → ${file}`);
  } else if (sub === "log") {
    const n = Number(args[1] ?? 20);
    if (!fs.existsSync(BRIDGE_LOG)) { console.log("no bridge log yet"); return; }
    const lines = fs.readFileSync(BRIDGE_LOG, "utf8").trim().split("\n").slice(-n);
    for (const line of lines) console.log(line);
  } else if (sub === "inbox") {
    if (!fs.existsSync(BRIDGE_DIR)) { console.log("no messages"); return; }
    for (const f of fs.readdirSync(BRIDGE_DIR).sort().slice(-Number(args[1] ?? 10))) console.log(f);
  } else {
    console.error("usage: hii bridge <send|log|inbox>");
    process.exit(1);
  }
}

function cmdCodex(args) {
  const prompt = args.join(" ");
  if (!prompt) { console.error("usage: hii codex <prompt>"); process.exit(1); }
  logBridge({ type: "codex-exec", prompt });
  const r = spawnSync(codexBin(), ["exec", "--cd", ROOT, prompt], { stdio: "inherit" });
  logBridge({ type: "codex-exec-done", prompt, exitCode: r.status ?? 1 });
  process.exit(r.status ?? 1);
}

function cmdCheck() {
  const r = spawnSync("npx", ["tsc", "--noEmit"], { cwd: ROOT, stdio: "inherit" });
  return r.status === 0;
}

function cmdShip(args) {
  if (!cmdCheck()) { console.error("ship aborted: typecheck failed"); process.exit(1); }
  const shouldPush = args.includes("--push");
  const messageArgs = args.filter((arg) => arg !== "--push");
  const msg = messageArgs.join(" ") || `ship: ${new Date().toISOString()}`;
  const dirty = execFileSync("git", ["-C", ROOT, "status", "--porcelain"]).toString().trim();
  if (dirty) {
    execFileSync("git", ["-C", ROOT, "add", "-A"]);
    const c = spawnSync("git", ["-C", ROOT, "commit", "-m", msg], { stdio: "inherit" });
    if (c.status !== 0) process.exit(c.status ?? 1);
  } else {
    console.log("tree clean — nothing to commit");
  }
  const commit = execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]).toString().trim();
  if (!shouldPush) {
    logBridge({ type: "ship-local", commit, message: msg, ok: true });
    console.log(`shipped local ${commit}`);
    console.log("not pushed; use `hii ship --push <message>` only when external publish is intended");
    return;
  }
  const p = spawnSync("git", ["-C", ROOT, "push", "origin", "HEAD"], { stdio: "inherit" });
  logBridge({ type: "ship-push", commit, message: msg, ok: p.status === 0 });
  console.log(p.status === 0 ? `pushed ${commit}` : "push failed");
  process.exit(p.status ?? 1);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "check":
    process.exit(cmdCheck() ? 0 : 1);
  case "ship": cmdShip(rest); break;
  case "health":
    cmdStatus();
    break;
  case "status":
  case "doctor":
    cmdStatus();
    if (cmd === "doctor") {
      console.log("");
      spawnSync("npm", ["run", "hii:registry:doctor", "--silent"], { cwd: ROOT, stdio: "inherit" });
    }
    break;
  case "dev": npmRun("dev", rest); break;
  case "build": npmRun("build", rest); break;
  case "start": npmRun("start", rest); break;
  case "caps":
    if (rest[0] && rest[0] !== "show") {
      console.error("usage: hii caps [show]");
      process.exit(1);
    }
    cmdCaps();
    break;
  case "context": cmdContext(rest); break;
  case "agent-context": cmdContext(rest); break;
  case "jobs": cmdJobs(rest); break;
  case "terminal": cmdTerminal(rest); break;
  case "og": cmdOg(rest); break;
  case "loop": cmdLoop(rest); break;
  case "pack": cmdPack(rest); break;
  case "registry": {
    const sub = rest[0];
    if (!["scan", "doctor", "export"].includes(sub)) {
      console.error("usage: hii registry <scan|doctor|export>");
      process.exit(1);
    }
    npmRun(`hii:registry:${sub}`, rest.slice(1));
    break;
  }
  case "bridge": cmdBridge(rest); break;
  case "mcp": {
    const r = spawnSync(codexBin(), ["mcp", ...(rest.length ? rest : ["list"])], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }
  case "codex": cmdCodex(rest); break;
  case "legacy": {
    const legacyRoot = path.join(os.homedir(), "hii-old");
    const py = path.join(legacyRoot, ".venv", "bin", "python");
    const r = spawnSync(fs.existsSync(py) ? py : "python3", ["-m", "hii", ...rest], {
      cwd: legacyRoot, stdio: "inherit"
    });
    process.exit(r.status ?? 1);
  }
  default:
    console.log(`HII — Human Information Interface (marketplace CLI)

usage: hii <command>

  terminal [--open]   show or open the local HII terminal
  health [--text]     compatibility alias for status
  context [--json]    agent-readable repo/runtime/capability context
  status              env + git + codex snapshot
  doctor              status + registry doctor
  caps [show]         list backend-owned capabilities
  jobs [n]            list recent local capability jobs
  og [capture <msg>]  infer the operational graph and likely next path
  loop once [prompt]  propose next plan; waits for y/n before acting
  loop status         show latest user-proxy plan and notes
  loop note <note>    add steering context (tab path in UI)
  loop decide yes|no  approve or reject latest plan
  pack list           list compartmentalized capability packs
  pack show <id>      show pack routes, files, caps, and checks
  pack export <id>    write local-only pack manifest
  check               typecheck (the inner fix loop)
  ship [message]      typecheck -> local commit only
  ship --push [msg]   explicit external push to origin
  dev|build|start     run the Next.js app
  registry <sub>      scan | doctor | export
  bridge send <msg>   message Yin (Codex) via ~/hii/bridge/messages
  bridge log [n]      tail ~/.hii/bridge/yin-codex.jsonl
  bridge inbox [n]    list recent bridge messages
  codex <prompt>      run Codex in the repo, logged to the bridge
  mcp [args]          codex mcp passthrough (default: list)
  legacy <args>       old Python CLI at ~/hii-old`);
    process.exit(cmd ? 1 : 0);
}
