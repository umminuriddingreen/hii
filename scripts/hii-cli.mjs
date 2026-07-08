#!/usr/bin/env node
// HII CLI — single current entrypoint for the local capability terminal.
// Installed via ~/bin/hii.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const ROOT = path.join(os.homedir(), "hii");
const RUNTIME = path.join(os.homedir(), ".hii");
const BRIDGE_DIR = path.join(ROOT, "bridge", "messages");
const BRIDGE_LOG = path.join(RUNTIME, "bridge", "yin-codex.jsonl");
const CAPABILITY_REGISTRY = path.join(ROOT, "lib", "capabilities", "registry.json");
const CAPABILITY_PACKS = path.join(ROOT, "lib", "capabilities", "packs.json");
const LOCAL_CAPABILITY_JOBS = path.join(ROOT, ".hii", "capability-jobs.jsonl");
const CLAUDE_JOBS_DIR = path.join(os.homedir(), ".claude", "jobs");
const OG_EVENTS = path.join(RUNTIME, "og", "events.jsonl");
const LOOP_DIR = path.join(RUNTIME, "loop");
const LOOP_DECISIONS = path.join(LOOP_DIR, "decisions.jsonl");
const LOOP_NOTES = path.join(LOOP_DIR, "notes.jsonl");
const LOOP_DISABLED = path.join(LOOP_DIR, "disabled");
const PACK_EXPORT_DIR = path.join(RUNTIME, "packs", "exports");
const MONEY_DIR = path.join(RUNTIME, "money");
const MONEY_IDEAS = path.join(MONEY_DIR, "ideas.jsonl");
const MONEY_OFFERS_DIR = path.join(MONEY_DIR, "offers");
const BOARD_DIR = path.join(RUNTIME, "board");
const BOARD_TASKS = path.join(BOARD_DIR, "tasks.jsonl");
const LINK_POSTS = path.join(ROOT, ".hii", "link-posts.jsonl");
const LINK_CACHE = path.join(ROOT, ".hii", "link-cache.jsonl");
const RUNNER_CAPABILITIES = ["termite.rhino.managed_job"];
const BOARD_LANES = ["backlog", "next", "doing", "blocked", "done"];
const BOARD_PRIORITIES = ["low", "normal", "high", "urgent"];

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

function cleanEnvValue(value) {
  return String(value ?? "").replace(/^['"]|['"]$/g, "");
}

function appBaseUrl() {
  const env = readEnvFile();
  return cleanEnvValue(process.env.NEXT_PUBLIC_BASE_URL || env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
}

function runnerToken() {
  return process.env.HII_RUNNER_TOKEN || cleanEnvValue(readEnvFile().HII_RUNNER_TOKEN || "");
}

function supabaseEnvConfigured() {
  const env = readEnvFile();
  const url = cleanEnvValue(process.env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "");
  const key = cleanEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "");
  return Boolean(url && key);
}

function createRunnerToken() {
  return `hii_runner_${randomBytes(32).toString("base64url")}`;
}

function hashRunnerToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function supabaseRpc(name, body) {
  const env = readEnvFile();
  const url = cleanEnvValue(process.env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "");
  const key = cleanEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for runner init.");
  }
  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `${name} failed with ${res.status}`);
  return data;
}

async function supabaseRows(table, params) {
  const env = readEnvFile();
  const url = cleanEnvValue(process.env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "");
  const key = cleanEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (!url || !key) return null;
  const search = new URLSearchParams(params);
  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${table}?${search.toString()}`, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      accept: "application/json"
    }
  });
  const data = await res.json().catch(() => []);
  if (!res.ok) throw new Error(data.message || `${table} query failed with ${res.status}`);
  return Array.isArray(data) ? data : [];
}

async function runnerFetch(pathname, options = {}) {
  const token = runnerToken();
  if (!token) {
    throw new Error("HII_RUNNER_TOKEN is required. Run `hii runner init <name>` first.");
  }
  const headers = {
    authorization: `Bearer ${token}`,
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(options.headers ?? {})
  };
  const res = await fetch(`${appBaseUrl()}${pathname}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${options.method || "GET"} ${pathname} failed with ${res.status}`);
  return data;
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

function latestById(entries) {
  const byId = new Map();
  for (const entry of entries) {
    if (!entry?.id) continue;
    byId.set(entry.id, entry);
  }
  return Array.from(byId.values());
}

function localCapabilityJobsLatest() {
  return latestById(readJsonl(LOCAL_CAPABILITY_JOBS));
}

function recentLocalCapabilityJobs(limit) {
  return localCapabilityJobsLatest()
    .sort((a, b) => String(b.createdAt ?? b.created_at ?? "").localeCompare(String(a.createdAt ?? a.created_at ?? "")))
    .slice(0, limit);
}

function claudeStateForJob(jobId) {
  const statePath = path.join(CLAUDE_JOBS_DIR, jobId, "state.json");
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return { statePath, state };
  } catch {
    return { statePath, state: null };
  }
}

function mappedClaudeStatus(state) {
  const map = {
    done: "completed",
    failed: "failed",
    blocked: "blocked",
    stopped: "cancelled"
  };
  return map[String(state ?? "").toLowerCase()] ?? null;
}

function slug(input) {
  return String(input || "idea")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72) || "idea";
}

function normalizeBoardLane(value) {
  return BOARD_LANES.includes(value) ? value : "backlog";
}

function normalizeBoardPriority(value) {
  return BOARD_PRIORITIES.includes(value) ? value : "normal";
}

function parseCsvTags(value) {
  return String(value || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function parseFlagValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

function withoutFlags(args, flagsWithValues = [], booleanFlags = []) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (flagsWithValues.includes(arg)) {
      i += 1;
      continue;
    }
    if (booleanFlags.includes(arg)) continue;
    out.push(arg);
  }
  return out;
}

function sanitizeText(value) {
  return String(value)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\b\r]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)=)([^\s]+)/gi, "$1[redacted]")
    .replace(/((?:OPENAI|ANTHROPIC|SUPABASE|STRIPE|GITHUB|VERCEL|CLOUDFLARE|AWS)[A-Z0-9_]*=)([^\s]+)/g, "$1[redacted]")
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, "$1[redacted]")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[redacted]");
}

function redactText(value) {
  return sanitizeText(value)
    .slice(0, 2000);
}

function classifyGitStatus(lines) {
  const counts = {
    total: lines.length,
    staged: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    untracked: 0,
    conflicted: 0
  };
  const files = lines.map((line) => {
    const index = line[0] ?? " ";
    const worktree = line[1] ?? " ";
    const rawPath = line.slice(3).trim();
    const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() : rawPath;
    if (index !== " " && index !== "?") counts.staged += 1;
    if (index === "?" && worktree === "?") counts.untracked += 1;
    if (index === "R" || worktree === "R") counts.renamed += 1;
    if (index === "D" || worktree === "D") counts.deleted += 1;
    if (index === "U" || worktree === "U" || (index === "A" && worktree === "A") || (index === "D" && worktree === "D")) counts.conflicted += 1;
    if (worktree !== " " && worktree !== "?" && worktree !== "D" && worktree !== "U") counts.modified += 1;
    return { path: filePath, index, worktree, raw: line };
  });
  return {
    clean: lines.length === 0,
    counts,
    files,
    sample: files.slice(0, 60)
  };
}

function cleanModelOutput(value) {
  let text = sanitizeText(value);
  text = text.replace(/^Thinking\.\.\.[\s\S]*?\.\.\.done thinking\.\s*/i, "");
  const firstBrief = text.indexOf("# Idea to Offer");
  if (firstBrief > 0) text = text.slice(firstBrief);
  return text.trim();
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
    return { branch, status, worktree: classifyGitStatus(status), recent };
  } catch {
    return { branch: "unknown", status: [], worktree: classifyGitStatus([]), recent: [] };
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
    fileExistsSummary(BOARD_TASKS),
    fileExistsSummary(path.join(RUNTIME, "mind0", "state.json"))
  ];
}

function staleLegacyRuntimeProbe() {
  const legacyPath = path.join(os.homedir(), "hii-old");
  const capabilityCache = path.join(RUNTIME, "capabilities.json");
  const findings = [];
  if (fs.existsSync(legacyPath)) {
    findings.push({
      path: legacyPath,
      state: "present",
      action: "remove or mine then discard; current HII is /Users/ummi/hii"
    });
  }
  if (fs.existsSync(capabilityCache)) {
    const text = fs.readFileSync(capabilityCache, "utf8");
    if (text.includes(legacyPath) || text.includes("hii-old")) {
      findings.push({
        path: capabilityCache,
        state: "stale-reference",
        action: "ignore as runtime truth until refreshed by current registry scan"
      });
    }
  }
  return {
    legacyPath,
    currentRepo: ROOT,
    clean: findings.length === 0,
    findings
  };
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

function boardTasks({ includeDone = false } = {}) {
  const tasks = new Map();
  for (const event of readJsonl(BOARD_TASKS)) {
    if (event.type === "created" && event.task?.id) {
      tasks.set(event.task.id, event.task);
      continue;
    }
    if (event.type === "updated" && event.id && tasks.has(event.id)) {
      const existing = tasks.get(event.id);
      tasks.set(event.id, {
        ...existing,
        ...(event.patch ?? {}),
        id: existing.id,
        updatedAt: event.patch?.updatedAt ?? event.ts ?? existing.updatedAt
      });
    }
  }
  return Array.from(tasks.values())
    .filter((task) => includeDone || task.lane !== "done")
    .sort((a, b) => {
      const laneDelta = BOARD_LANES.indexOf(a.lane) - BOARD_LANES.indexOf(b.lane);
      if (laneDelta !== 0) return laneDelta;
      const priorityDelta = BOARD_PRIORITIES.indexOf(b.priority) - BOARD_PRIORITIES.indexOf(a.priority);
      if (priorityDelta !== 0) return priorityDelta;
      return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
    });
}

function appendBoardEvent(event) {
  return appendJsonl(BOARD_TASKS, event);
}

function createBoardTask({ title, lane, priority, owner, coordinate, notes, tags, source = "hii board" }) {
  const cleanTitle = redactText(title).trim();
  if (cleanTitle.length < 2) {
    console.error("usage: hii board add <title> [--lane backlog|next|doing|blocked|done] [--priority low|normal|high|urgent]");
    process.exit(1);
  }
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    title: cleanTitle.slice(0, 240),
    lane: normalizeBoardLane(lane),
    priority: normalizeBoardPriority(priority),
    owner: redactText(owner || "main agent").slice(0, 80),
    coordinate: redactText(coordinate || ROOT).slice(0, 240),
    notes: redactText(notes || "").slice(0, 2000),
    tags: parseCsvTags(tags),
    source,
    createdAt: now,
    updatedAt: now
  };
  appendBoardEvent({ type: "created", task, ts: now });
  return task;
}

function updateBoardTask(idOrPrefix, patch) {
  const matches = boardTasks({ includeDone: true }).filter((task) => task.id.startsWith(idOrPrefix));
  if (matches.length !== 1) {
    console.error(matches.length === 0 ? `task not found: ${idOrPrefix}` : `task id is ambiguous: ${idOrPrefix}`);
    if (matches.length > 1) matches.slice(0, 8).forEach((task) => console.error(`  ${task.id.slice(0, 8)} ${task.title}`));
    process.exit(1);
  }
  const task = matches[0];
  const now = new Date().toISOString();
  const cleanPatch = { updatedAt: now };
  if (patch.lane !== undefined) {
    cleanPatch.lane = normalizeBoardLane(patch.lane);
    cleanPatch.completedAt = cleanPatch.lane === "done" ? now : undefined;
  }
  if (patch.priority !== undefined) cleanPatch.priority = normalizeBoardPriority(patch.priority);
  if (patch.owner !== undefined) cleanPatch.owner = redactText(patch.owner).trim().slice(0, 80) || task.owner;
  if (patch.coordinate !== undefined) cleanPatch.coordinate = redactText(patch.coordinate).trim().slice(0, 240) || task.coordinate;
  if (patch.notes !== undefined) cleanPatch.notes = redactText(patch.notes).trim().slice(0, 2000);
  if (patch.tags !== undefined) cleanPatch.tags = parseCsvTags(patch.tags);
  appendBoardEvent({ type: "updated", id: task.id, patch: cleanPatch, ts: now });
  return { ...task, ...cleanPatch };
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
  const jobs = recentLocalCapabilityJobs(20);
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
  const jobs = recentLocalCapabilityJobs(20);
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
    { command: "hii probe", purpose: "Print the full HII worktree probe and stale-runtime warnings." },
    { command: "hii caps show", purpose: "List backend-owned capabilities." },
    { command: "hii og status", purpose: "Infer likely next work from repo, bridge, job, and runtime context." },
    { command: "hii og capture <message>", purpose: "Append an operational-graph event for this turn." },
    { command: "hii loop once", purpose: "Propose the next user-proxy plan locally; do not act until y/n approval." },
    { command: "hii loop note <note>", purpose: "Add user notes to steer the persistent loop." },
    { command: "hii loop decide <yes|no>", purpose: "Approve or reject the latest proposed plan." },
    { command: "hii board", purpose: "Show the local kanban/todo board grouped by backlog, next, doing, blocked, and done." },
    { command: "hii board add <title>", purpose: "Create a local task with owner, coordinate, priority, tags, and notes." },
    { command: "hii board move <id> <lane>", purpose: "Move a task between kanban lanes." },
    { command: "hii money idea <idea>", purpose: "Use local models to turn a rough idea into a sellable offer and execution handoff." },
    { command: "hii money list", purpose: "List recent local idea-to-offer receipts." },
    { command: "hii links cache", purpose: "Cache browser-captured links locally and summarize them with Ollama when available." },
    { command: "hii links publish", purpose: "Publish locally captured links to the token-gated public stream." },
    { command: "hii pack list", purpose: "List compartmentalized HII capability packs." },
    { command: "hii pack export <id>", purpose: "Write a local-only pack manifest for staged shipping." },
    { command: "hii runner init <name>", purpose: "Register an owned runner and print its local token once." },
    { command: "hii runner start --once", purpose: "Heartbeat, claim one whitelisted capability job, stream logs, and exit." },
    { command: "hii jobs", purpose: "List recent local capability jobs." },
    { command: "hii jobs reconcile", purpose: "Append local reconciliation receipts for completed Claude-backed HII agent jobs." },
    { command: "hii doctor", purpose: "Run status plus registry doctor." },
    { command: "hii ship", purpose: "Typecheck and commit locally; does not push." },
    { command: "hii ship --push <message>", purpose: "Explicit external push; use only after user approval." },
    { command: "npm run build", purpose: "Validate the Next.js product app." }
  ];
}

function agentContextPayload() {
  const git = gitSnapshot();
  const capabilities = readJsonArray(CAPABILITY_REGISTRY);
  const jobs = recentLocalCapabilityJobs(10);
  const tasks = boardTasks({ includeDone: false }).slice(0, 12);
  const bridge = fileExistsSummary(BRIDGE_LOG);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    identity: {
      name: "HII",
      role: "local-first capability terminal and exchange spine",
      repo: ROOT,
      runtime: RUNTIME
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
      worktreeProbe: git.worktree,
      legacyRuntimeProbe: staleLegacyRuntimeProbe(),
      boardTasks: {
        path: BOARD_TASKS,
        open: tasks.length,
        byLane: BOARD_LANES.reduce((acc, lane) => {
          acc[lane] = tasks.filter((task) => task.lane === lane).length;
          return acc;
        }, {}),
        recent: tasks.map((task) => ({
          id: task.id,
          title: task.title,
          lane: task.lane,
          priority: task.priority,
          owner: task.owner,
          coordinate: task.coordinate,
          updatedAt: task.updatedAt
        }))
      },
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
      "Use /Users/ummi/hii as the only HII product/runtime surface; legacy patterns are migrated into this repo before old checkouts are discarded."
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
  console.log(`probe:   staged=${payload.git.worktree.counts.staged} modified=${payload.git.worktree.counts.modified} deleted=${payload.git.worktree.counts.deleted} untracked=${payload.git.worktree.counts.untracked}`);
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

function cmdProbe(args) {
  const git = gitSnapshot();
  const legacy = staleLegacyRuntimeProbe();
  if (args.includes("--json")) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), repo: ROOT, git, legacyRuntimeProbe: legacy }, null, 2));
    return;
  }
  console.log("HII Worktree Probe\n");
  console.log(`repo:    ${ROOT}`);
  console.log(`git:     ${git.branch}${git.worktree.clean ? " (clean)" : ` (${git.worktree.counts.total} dirty)`}`);
  console.log(`counts:  staged=${git.worktree.counts.staged} modified=${git.worktree.counts.modified} deleted=${git.worktree.counts.deleted} untracked=${git.worktree.counts.untracked} conflicted=${git.worktree.counts.conflicted}`);
  if (git.worktree.files.length) {
    console.log("\nFiles:");
    for (const file of git.worktree.files) console.log(`  ${file.raw}`);
  }
  if (!legacy.clean) {
    console.log("\nLegacy runtime warnings:");
    for (const finding of legacy.findings) console.log(`  ${finding.state}: ${finding.path} - ${finding.action}`);
  }
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

function printBoard(tasks, { includeDone = false } = {}) {
  console.log("HII Board\n");
  console.log(`store: ${BOARD_TASKS}`);
  console.log(`open:  ${tasks.filter((task) => task.lane !== "done").length}`);
  if (includeDone) console.log("done:  included");
  console.log("");

  for (const lane of BOARD_LANES) {
    if (!includeDone && lane === "done") continue;
    const laneTasks = tasks.filter((task) => task.lane === lane);
    console.log(`${lane} (${laneTasks.length})`);
    if (laneTasks.length === 0) {
      console.log("  -");
      continue;
    }
    for (const task of laneTasks) {
      const tags = task.tags?.length ? ` #${task.tags.join(" #")}` : "";
      console.log(`  ${task.id.slice(0, 8)}  [${task.priority}] ${task.title}${tags}`);
      console.log(`      owner: ${task.owner}  coordinate: ${task.coordinate}`);
      if (task.notes) console.log(`      notes: ${task.notes.slice(0, 180)}`);
    }
    console.log("");
  }
}

function cmdBoard(args) {
  const sub = args[0] || "list";
  if (sub === "list" || sub === "show") {
    const includeDone = args.includes("--done") || args.includes("--all");
    printBoard(boardTasks({ includeDone }), { includeDone });
    return;
  }
  if (sub === "add") {
    const rest = args.slice(1);
    const title = withoutFlags(rest, ["--lane", "--priority", "--owner", "--coordinate", "--notes", "--tags"]).join(" ").trim();
    const task = createBoardTask({
      title,
      lane: parseFlagValue(rest, "--lane", "backlog"),
      priority: parseFlagValue(rest, "--priority", "normal"),
      owner: parseFlagValue(rest, "--owner", "main agent"),
      coordinate: parseFlagValue(rest, "--coordinate", ROOT),
      notes: parseFlagValue(rest, "--notes", ""),
      tags: parseFlagValue(rest, "--tags", "")
    });
    console.log(`added ${task.id.slice(0, 8)}  ${task.title}`);
    console.log(`lane: ${task.lane}  priority: ${task.priority}`);
    console.log(`store: ${BOARD_TASKS}`);
    return;
  }
  if (sub === "move") {
    const id = args[1];
    const lane = args[2];
    if (!id || !lane) {
      console.error("usage: hii board move <task-id-prefix> <backlog|next|doing|blocked|done>");
      process.exit(1);
    }
    const task = updateBoardTask(id, { lane });
    console.log(`moved ${task.id.slice(0, 8)} -> ${task.lane}`);
    console.log(task.title);
    return;
  }
  if (sub === "done") {
    const id = args[1];
    if (!id) {
      console.error("usage: hii board done <task-id-prefix>");
      process.exit(1);
    }
    const task = updateBoardTask(id, { lane: "done" });
    console.log(`done ${task.id.slice(0, 8)}`);
    console.log(task.title);
    return;
  }
  if (sub === "edit") {
    const id = args[1];
    const rest = args.slice(2);
    if (!id) {
      console.error("usage: hii board edit <task-id-prefix> [--priority high] [--owner name] [--coordinate path] [--notes text] [--tags a,b]");
      process.exit(1);
    }
    const task = updateBoardTask(id, {
      priority: parseFlagValue(rest, "--priority", undefined),
      owner: parseFlagValue(rest, "--owner", undefined),
      coordinate: parseFlagValue(rest, "--coordinate", undefined),
      notes: parseFlagValue(rest, "--notes", undefined),
      tags: parseFlagValue(rest, "--tags", undefined)
    });
    console.log(`updated ${task.id.slice(0, 8)}  ${task.title}`);
    return;
  }
  console.error("usage: hii board [list|add|move|done|edit]");
  process.exit(1);
}

async function readDurableJobs(limit) {
  const durable = await supabaseRows("capability_jobs", {
    select: "*",
    order: "created_at.desc",
    limit: String(limit)
  });
  if (!durable) return { jobs: [], configured: false };
  if (durable.length === 0) return { jobs: [], configured: true };

  const jobIds = durable.map((job) => job.id).filter(Boolean);
  const jobFilter = `in.(${jobIds.join(",")})`;
  const [ledger, proof] = await Promise.all([
    supabaseRows("credit_ledger_entries", {
      select: "*",
      job_id: jobFilter,
      order: "created_at.desc"
    }),
    supabaseRows("proof_artifacts", {
      select: "*",
      job_id: jobFilter,
      order: "created_at.asc"
    })
  ]);

  const ledgerByJob = groupRows(ledger ?? [], (entry) => entry.job_id);
  const proofByJob = groupRows(proof ?? [], (entry) => entry.job_id);

  return {
    configured: true,
    jobs: durable.map((job) => ({
      ...job,
      capabilityId: job.capability_id,
      inputSummary: job.input_summary,
      createdAt: job.created_at,
      budget: job.budget,
      ledger: ledgerByJob.get(job.id) ?? [],
      proofArtifacts: proofByJob.get(job.id) ?? [],
      source: "supabase"
    }))
  };
}

function groupRows(rows, keyFor) {
  const out = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!key) continue;
    const existing = out.get(key) ?? [];
    existing.push(row);
    out.set(key, existing);
  }
  return out;
}

async function cmdJobs(args) {
  if (args[0] === "reconcile") {
    cmdJobsReconcile(args.slice(1));
    return;
  }
  const limit = Number(args[0] ?? 20);
  const resolvedLimit = Number.isFinite(limit) ? limit : 20;
  const localJobs = localCapabilityJobsLatest().map((job) => ({ ...job, source: "local" }));
  let durableResult = { jobs: [], configured: false };
  let durableWarning = null;
  try {
    durableResult = await readDurableJobs(resolvedLimit);
  } catch (error) {
    durableResult.configured = supabaseEnvConfigured();
    durableWarning = error instanceof Error ? error.message : String(error);
  }

  const byId = new Map();
  for (const job of [...localJobs, ...durableResult.jobs]) {
    byId.set(job.id, job);
  }
  const jobs = Array.from(byId.values())
    .sort((a, b) => String(b.createdAt ?? b.created_at ?? "").localeCompare(String(a.createdAt ?? a.created_at ?? "")))
    .slice(0, resolvedLimit);
  if (jobs.length === 0) {
    console.log("No capability jobs yet.");
    if (!durableResult.configured) console.log("durable: Supabase env not configured; showing local JSONL only.");
    if (durableWarning) console.log(`durable warning: ${redactText(durableWarning)}`);
    return;
  }
  console.log("Recent HII capability jobs\n");
  if (!durableResult.configured) console.log("durable: Supabase env not configured; showing local JSONL only.\n");
  if (durableWarning) console.log(`durable schema warning: ${redactText(durableWarning)}\n`);
  for (const job of jobs) {
    console.log(`${job.id}  ${job.status ?? "unknown"}  ${job.capabilityId ?? job.capability_id ?? "unknown"}`);
    console.log(`  source:  ${job.source ?? "unknown"}`);
    console.log(`  created: ${job.createdAt ?? job.created_at ?? "unknown"}`);
    console.log(`  input:   ${job.inputSummary ?? job.input_summary ?? ""}`);
    if (job.budget) console.log(`  budget:  ${job.budget}`);
    console.log(`  ledger:  ${job.ledger?.length ?? 0}`);
    console.log(`  proof:   ${job.proofArtifacts?.length ?? 0}`);
    console.log("");
  }
}

function cmdJobsReconcile(args) {
  const dryRun = args.includes("--dry-run");
  const jobs = localCapabilityJobsLatest();
  const candidates = jobs.filter((job) => job.capabilityId === "hii.agent.spawn");
  const reconciled = [];
  const unchanged = [];
  const missing = [];

  for (const job of candidates) {
    const { statePath, state } = claudeStateForJob(job.id);
    if (!state) {
      missing.push({ id: job.id, status: job.status ?? "unknown", statePath });
      continue;
    }
    const nextStatus = mappedClaudeStatus(state.state);
    if (!nextStatus || job.status === nextStatus) {
      unchanged.push({ id: job.id, status: job.status ?? "unknown", claudeState: state.state ?? "unknown" });
      continue;
    }
    if (!["running", "queued", "pending"].includes(String(job.status ?? "").toLowerCase())) {
      unchanged.push({ id: job.id, status: job.status ?? "unknown", claudeState: state.state ?? "unknown" });
      continue;
    }

    const now = new Date().toISOString();
    const detail = state.detail ? redactText(String(state.detail)).slice(0, 500) : `Claude state ${state.state}`;
    const result = state.output?.result ? redactText(String(state.output.result)).slice(0, 500) : detail;
    const entry = {
      ...job,
      status: nextStatus,
      updatedAt: now,
      logs: [
        ...(Array.isArray(job.logs) ? job.logs : []),
        `[${now}] reconciled local HII job from Claude state ${state.state} -> ${nextStatus}`,
        detail
      ],
      ledger: [
        ...(Array.isArray(job.ledger) ? job.ledger : []),
        {
          id: randomUUID(),
          jobId: job.id,
          capabilityId: job.capabilityId,
          actor: "hii",
          type: "reconciliation",
          summary: `Mapped Claude job state ${state.state} to HII status ${nextStatus}.`,
          createdAt: now
        }
      ],
      proofArtifacts: [
        ...(Array.isArray(job.proofArtifacts) ? job.proofArtifacts : []),
        {
          id: randomUUID(),
          kind: "log",
          label: "Claude state reconciliation",
          path: statePath,
          summary: result,
          createdAt: now
        }
      ],
      metadata: {
        ...(job.metadata ?? {}),
        reconciledFrom: "claude",
        claudeStatePath: statePath,
        claudeState: state.state ?? null,
        claudeUpdatedAt: state.updatedAt ?? null,
        reconciledAt: now
      }
    };
    if (!dryRun) appendJsonl(LOCAL_CAPABILITY_JOBS, entry);
    reconciled.push({ id: job.id, from: job.status ?? "unknown", to: nextStatus, claudeState: state.state ?? "unknown" });
  }

  console.log("HII job reconciliation\n");
  console.log(`store:       ${LOCAL_CAPABILITY_JOBS}`);
  console.log(`claude:      ${CLAUDE_JOBS_DIR}`);
  console.log(`mode:        ${dryRun ? "dry-run" : "append-only"}`);
  console.log(`local jobs:  ${jobs.length}`);
  console.log(`agent jobs:  ${candidates.length}`);
  console.log(`updated:     ${reconciled.length}`);
  console.log(`unchanged:   ${unchanged.length}`);
  console.log(`missing:     ${missing.length}`);
  if (reconciled.length) {
    console.log("\nReconciled:");
    for (const item of reconciled) {
      console.log(`  ${item.id}  ${item.from} -> ${item.to}  claude=${item.claudeState}`);
    }
  }
  if (missing.length) {
    console.log("\nMissing Claude state:");
    for (const item of missing.slice(0, 12)) {
      console.log(`  ${item.id}  hii=${item.status}  ${item.statePath}`);
    }
  }
}

function recentMoneyContext() {
  const ideas = readJsonl(MONEY_IDEAS).slice(-5);
  const jobs = recentLocalCapabilityJobs(10);
  return {
    recentIdeas: ideas.map((idea) => ({
      id: idea.id,
      createdAt: idea.createdAt,
      idea: redactText(idea.idea ?? "").slice(0, 180),
      model: idea.model,
      status: idea.status
    })),
    recentJobs: jobs.map((job) => ({
      id: job.id,
      capabilityId: job.capabilityId,
      status: job.status,
      inputSummary: redactText(job.inputSummary ?? "").slice(0, 180)
    }))
  };
}

function moneyPrompt({ idea, model, flags }) {
  const context = recentMoneyContext();
  return [
    "You are HII's local money loop.",
    "Your job is to turn a rough idea into a near-term sellable offer for Ummi.",
    "",
    "Constraints:",
    "- Optimize for making money soon, not abstract strategy.",
    "- Prefer local-first workflows, HII, Codex, Claude Code, Ollama, Rhino/Termite, web intelligence, small business services, and packaged digital outputs when relevant.",
    "- Be concrete, direct, and short enough to act on today.",
    "- Return final answer only. Do not include thinking, reasoning traces, or terminal control output.",
    "- Do not claim buyers exist unless this prompt gives evidence. Frame buyer/pain as hypotheses when needed.",
    "- No external outreach is being sent here. Produce a handoff prompt only.",
    "",
    `Requested model: ${model}`,
    `Mode: ${flags.deep ? "deep" : flags.write ? "write" : "standard"}`,
    "",
    "Recent local HII context:",
    JSON.stringify(context, null, 2),
    "",
    "Rough idea:",
    idea,
    "",
    "Return exactly these Markdown sections:",
    "# Idea to Offer",
    "## Buyer",
    "## Pain",
    "## Offer",
    "## Proof",
    "## Price",
    "## Fastest Ship",
    "## Risks",
    "## Next 2 Hours",
    "## Handoff Prompt",
    "",
    "In Handoff Prompt, write one concise prompt for Codex or Claude Code to execute the next build/sales asset step. Do not include shell commands that publish, email, charge money, delete, reset, or push."
  ].join("\n");
}

function fallbackMoneyBrief({ idea, model, error }) {
  const cleanIdea = redactText(idea);
  return [
    "# Idea to Offer",
    "",
    "## Buyer",
    "Likely buyer is the person or business that already pays for this outcome manually. Validate with one concrete example before building further.",
    "",
    "## Pain",
    `They need a faster, cleaner, or cheaper path from request to finished output around: ${cleanIdea}`,
    "",
    "## Offer",
    "Package the workflow as a fixed-scope service with one clear deliverable, one revision, and a fast turnaround.",
    "",
    "## Proof",
    "Create one before/after, demo brief, screenshot, sample asset, or local receipt that shows the output is real.",
    "",
    "## Price",
    "Start with a simple paid test: $50-$250 depending on effort and buyer urgency. Raise price only after one completed delivery.",
    "",
    "## Fastest Ship",
    "Make a one-page offer, one sample output, and one direct outreach list of 10 likely buyers.",
    "",
    "## Risks",
    "The buyer may not value the output, the scope may be too broad, or the proof may not be specific enough.",
    "",
    "## Next 2 Hours",
    "Define the exact deliverable, create one sample, write the offer copy, and identify 10 reachable buyers.",
    "",
    "## Handoff Prompt",
    `Turn this idea into a concrete first sellable asset: ${cleanIdea}. Create the smallest proof artifact, offer copy, price/package, and a 10-buyer outreach list. Keep the work local-first and do not publish, push, email, or charge anyone.`,
    "",
    `<!-- partial: local model ${model} unavailable: ${redactText(error)} -->`
  ].join("\n");
}

async function runOllamaMoney({ model, prompt }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `ollama generate failed with ${response.status}`);
    }
    const output = cleanModelOutput(data.response || "");
    if (!output) throw new Error("ollama returned an empty response");
    return output;
  } finally {
    clearTimeout(timeout);
  }
}

function extractHandoffPrompt(brief) {
  const match = brief.match(/## Handoff Prompt\s+([\s\S]*?)(?:\n## |\n<!--|$)/);
  return (match?.[1]?.trim() || "Use the money-loop brief above to build the smallest proof artifact and offer copy. Do not publish, push, email, or charge anyone.")
    .replace(/^["']|["']$/g, "");
}

function printMoneyHandoff({ handoff, brief }) {
  const prompt = extractHandoffPrompt(brief);
  if (handoff === "codex") {
    console.log("\nHandoff command, not run:");
    console.log(`hii codex ${JSON.stringify(prompt)}`);
  } else if (handoff === "claude") {
    console.log("\nClaude Code handoff prompt, not run:");
    console.log(prompt);
  }
}

async function cmdMoney(args) {
  const sub = args[0] || "help";
  if (sub === "idea") {
    const rest = args.slice(1);
    const flags = {
      json: rest.includes("--json"),
      deep: rest.includes("--deep"),
      write: rest.includes("--write")
    };
    const requestedModel = parseFlagValue(rest, "--model", null);
    const handoff = parseFlagValue(rest, "--handoff", "none");
    const model = requestedModel || (flags.deep ? "qwen-deep" : flags.write ? "gemma-write" : "qwen-work");
    const idea = withoutFlags(rest, ["--model", "--handoff"], ["--json", "--deep", "--write"]).join(" ").trim();
    if (!idea) {
      console.error("usage: hii money idea <rough idea> [--model qwen-work] [--deep] [--write] [--json] [--handoff codex|claude|none]");
      process.exit(1);
    }
    if (!["codex", "claude", "none"].includes(handoff)) {
      console.error("handoff must be one of: codex, claude, none");
      process.exit(1);
    }

    const id = randomUUID();
    const prompt = moneyPrompt({ idea: redactText(idea), model, flags });
    let status = "completed";
    let error;
    let brief;
    try {
      brief = await runOllamaMoney({ model, prompt });
    } catch (err) {
      status = "partial";
      error = err instanceof Error ? err.message : String(err);
      brief = fallbackMoneyBrief({ idea, model, error });
    }
    const receipt = writeMoneyReceipt({ id, idea, model, status, brief, prompt, handoff, error });
    if (flags.json) {
      console.log(JSON.stringify({ receipt, brief }, null, 2));
      return;
    }
    console.log(brief.trim());
    console.log(`\nreceipt: ${receipt.id}`);
    console.log(`offer:   ${receipt.offerPath}`);
    console.log(`status:  ${receipt.status}`);
    printMoneyHandoff({ handoff, brief });
    return;
  }
  if (sub === "list") {
    const limit = Number(args[1] ?? 10);
    const ideas = readJsonl(MONEY_IDEAS)
      .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
      .slice(0, Number.isFinite(limit) ? limit : 10);
    if (ideas.length === 0) {
      console.log("No money-loop ideas yet.");
      return;
    }
    console.log("Recent HII money-loop ideas\n");
    for (const idea of ideas) {
      console.log(`${idea.id}  ${idea.status ?? "unknown"}  ${idea.model ?? "unknown"}`);
      console.log(`  created: ${idea.createdAt ?? "unknown"}`);
      console.log(`  idea:    ${idea.idea ?? ""}`);
      console.log(`  offer:   ${idea.offerPath ?? ""}`);
      console.log("");
    }
    return;
  }
  if (sub === "show") {
    const id = args[1];
    if (!id) {
      console.error("usage: hii money show <id>");
      process.exit(1);
    }
    const receipt = readJsonl(MONEY_IDEAS).find((entry) => entry.id === id);
    if (!receipt) {
      console.error(`money receipt not found: ${id}`);
      process.exit(1);
    }
    if (receipt.offerPath && fs.existsSync(receipt.offerPath)) {
      console.log(fs.readFileSync(receipt.offerPath, "utf8").trim());
      console.log(`\nreceipt: ${receipt.id}`);
      console.log(`offer:   ${receipt.offerPath}`);
      return;
    }
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  console.error("usage: hii money <idea|list|show>");
  process.exit(sub === "help" ? 0 : 1);
}

function writeMoneyReceipt({ id, idea, model, status, brief, prompt, handoff, error }) {
  const createdAt = new Date().toISOString();
  const offerPath = path.join(MONEY_OFFERS_DIR, `${createdAt.replace(/[:.]/g, "-")}-${slug(idea)}.md`);
  fs.mkdirSync(path.dirname(offerPath), { recursive: true });
  fs.writeFileSync(offerPath, `${brief.trim()}\n`);
  const receipt = appendJsonl(MONEY_IDEAS, {
    id,
    capabilityId: "hii.money.idea_to_offer",
    createdAt,
    idea: redactText(idea),
    model,
    status,
    handoff,
    offerPath,
    promptPreview: redactText(prompt).slice(0, 1200),
    error: error ? redactText(error) : undefined
  });
  appendJsonl(LOCAL_CAPABILITY_JOBS, {
    id,
    capabilityId: "hii.money.idea_to_offer",
    inputSummary: redactText(idea),
    userId: "local",
    status: status === "completed" ? "completed" : "failed",
    budget: "local-only",
    logs: [
      `Generated idea-to-offer brief with ${model}.`,
      `Offer brief: ${offerPath}`,
      handoff === "none" ? "No execution handoff requested." : `Handoff target: ${handoff}.`
    ],
    ledger: [
      {
        id: randomUUID(),
        jobId: id,
        capabilityId: "hii.money.idea_to_offer",
        actor: "hii",
        type: "proof",
        summary: "Created local idea-to-offer receipt and proof artifact.",
        createdAt
      }
    ],
    proofArtifacts: [{
      id: randomUUID(),
      kind: "log",
      label: "Idea-to-offer brief",
      path: offerPath,
      summary: "Local HII money-loop offer brief.",
      createdAt
    }],
    createdAt,
    updatedAt: createdAt,
    metadata: {
      source: "hii money idea",
      model,
      moneyReceiptId: id
    }
  });
  return receipt;
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
  const url = "http://localhost:3000/console";
  if (args.includes("--open")) {
    spawnSync("open", [url], { stdio: "inherit" });
    return;
  }
  console.log("HII Console");
  console.log(`  local UI: ${url}`);
  console.log("  start:    hii dev");
  console.log("  open:     hii console --open");
}

function cmdLinks(args) {
  const sub = args[0] || "status";
  if (sub === "status") {
    const posts = readJsonl(LINK_POSTS);
    const cache = readJsonl(LINK_CACHE);
    const cached = cache.filter((entry) => entry.status === "cached").length;
    const failed = cache.filter((entry) => entry.status === "failed").length;
    console.log("HII Links\n");
    console.log(`feed:      http://localhost:3000/feed`);
    console.log(`extension: ${path.join(ROOT, "extensions", "chrome-link-capture")}`);
    console.log(`posts:     ${posts.length}`);
    console.log(`cached:    ${cached}`);
    console.log(`failed:    ${failed}`);
    console.log(`cache:     ${LINK_CACHE}`);
    console.log("\nnext: hii links cache && hii links publish --dry-run");
    return;
  }
  if (sub === "cache") {
    const r = spawnSync("node", [path.join(ROOT, "scripts", "hii-link-cache.mjs"), ...args.slice(1)], {
      cwd: ROOT,
      stdio: "inherit"
    });
    process.exit(r.status ?? 1);
  }
  if (sub === "publish") {
    cmdLinksPublish(args.slice(1));
    return;
  }
  console.error("usage: hii links [status|cache|publish]");
  process.exit(1);
}

const LINK_PUBLISHED = path.join(ROOT, ".hii", "link-publish.jsonl");

async function cmdLinksPublish(args) {
  const endpoint = process.env.HII_LINKS_PUBLISH_ENDPOINT || process.env.HII_LINKS_PUBLISH_URL || "https://umminuriddingreen.com/api/links";
  const token = process.env.HII_LINKS_PUBLISH_TOKEN;
  const dryRun = args.includes("--dry-run");
  if (!token && !dryRun) {
    console.error("HII_LINKS_PUBLISH_TOKEN is not set; publish target requires it");
    process.exit(1);
  }
  const force = args.includes("--force");
  const posts = readJsonl(LINK_POSTS);
  const published = new Set(readJsonl(LINK_PUBLISHED).map((r) => r.postId));
  const cache = readJsonl(LINK_CACHE);
  const summaryByPost = new Map();
  for (const entry of cache) {
    if (entry.summary && !summaryByPost.has(entry.postId)) summaryByPost.set(entry.postId, entry.summary);
  }
  const pending = posts.filter((p) => /^https?:\/\//i.test(p.url || "") && (force || !published.has(p.id)));
  console.log(`publish target: ${endpoint}`);
  console.log(`pending: ${pending.length} (of ${posts.length} local posts)`);
  console.log(`receipts: ${LINK_PUBLISHED}`);
  if (force) console.log("force: yes");
  if (dryRun || pending.length === 0) return;
  let ok = 0;
  for (const post of pending) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          url: post.url,
          title: post.title || "",
          note: post.note || "",
          tags: post.tags || [],
          source: post.source || "hii-local",
          summary: summaryByPost.get(post.id) || null
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      appendJsonl(LINK_PUBLISHED, {
        postId: post.id,
        remoteId: body?.post?.id ?? null,
        target: endpoint,
        ts: new Date().toISOString()
      });
      ok += 1;
      console.log(`published: ${post.title || post.url}`);
    } catch (error) {
      console.error(`failed: ${post.url} (${error.message})`);
    }
  }
  console.log(`done: ${ok}/${pending.length} published`);
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

function runnerUsage() {
  console.error("usage: hii runner <init <name>|start [--once]>");
}

async function cmdRunner(args) {
  const sub = args[0];
  if (sub === "init") {
    const name = args.slice(1).join(" ").trim();
    if (!name) {
      runnerUsage();
      process.exit(1);
    }
    const token = createRunnerToken();
    const runner = await supabaseRpc("register_capability_runner", {
      p_name: name,
      p_token_hash: hashRunnerToken(token),
      p_capabilities: RUNNER_CAPABILITIES
    });
    console.log("HII runner registered\n");
    console.log(`runner: ${runner.name ?? name}`);
    console.log(`id:     ${runner.id ?? "created"}`);
    console.log("\nAdd this to your local runner environment. It is shown once:");
    console.log(`export HII_RUNNER_TOKEN=${token}`);
    console.log(`export NEXT_PUBLIC_BASE_URL=${appBaseUrl()}`);
    return;
  }

  if (sub === "start") {
    const once = args.includes("--once");
    const intervalMs = 5000;
    do {
      const heartbeat = await runnerFetch("/api/runners/heartbeat", {
        method: "POST",
        body: JSON.stringify({ capabilities: RUNNER_CAPABILITIES })
      });
      console.log(`heartbeat: ${heartbeat.runner?.name ?? heartbeat.runner?.id ?? "runner"} online`);

      const next = await runnerFetch(`/api/runners/jobs/next?capability=${encodeURIComponent(RUNNER_CAPABILITIES[0])}`);
      const job = next.job;
      if (!job) {
        console.log("job: none");
        if (once) return;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      if (job.capability_id !== "termite.rhino.managed_job") {
        throw new Error(`No whitelisted handler for ${job.capability_id}`);
      }

      const started = `Runner claimed Termite job ${job.id}: ${job.input_summary}`;
      console.log(started);
      await runnerFetch(`/api/runners/jobs/${job.id}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: [
            { actor: "agent", text: started },
            { actor: "operator", text: "Termite runner v1 is operator-reviewed; Rhino execution is whitelisted to termite.rhino.managed_job." }
          ]
        })
      });

      const summary = "Termite runner accepted the managed Rhino job and produced an initial operator-reviewed log proof.";
      const complete = await runnerFetch(`/api/runners/jobs/${job.id}/complete`, {
        method: "POST",
        body: JSON.stringify({
          status: "completed",
          summary,
          computeCostCents: 0,
          platformFeeCents: 0,
          proof: [
            {
              kind: "log",
              label: "Termite runner log",
              summary
            }
          ],
          transcript: [{ actor: "agent", text: summary }]
        })
      });
      console.log(`completed: ${complete.job?.id ?? job.id}`);
      if (once) return;
    } while (true);
  }

  runnerUsage();
  process.exit(1);
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
  case "probe": cmdProbe(rest); break;
  case "jobs":
    cmdJobs(rest).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
    break;
  case "console": cmdTerminal(rest); break;
  case "terminal": cmdTerminal(rest); break;
  case "og": cmdOg(rest); break;
  case "loop": cmdLoop(rest); break;
  case "board": cmdBoard(rest); break;
  case "money": cmdMoney(rest); break;
  case "links": cmdLinks(rest); break;
  case "pack": cmdPack(rest); break;
  case "runner":
    cmdRunner(rest).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
    break;
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
  case "legacy":
    console.error("HII is now a single current surface at /Users/ummi/hii. Migrate needed legacy behavior into the current repo instead of running ~/hii-old.");
    process.exit(1);
  default:
    console.log(`HII — Human Information Interface (marketplace CLI)

usage: hii <command>

  console [--open]    show or open the local HII console
  terminal [--open]   compatibility alias for the local HII console
  health [--text]     compatibility alias for status
  context [--json]    agent-readable repo/runtime/capability context
  probe [--json]      full worktree probe + stale-runtime warnings
  status              env + git + codex snapshot
  doctor              status + registry doctor
  caps [show]         list backend-owned capabilities
  jobs [n]            list recent local capability jobs
  jobs reconcile      reconcile local HII agent jobs from Claude state
  og [capture <msg>]  infer the operational graph and likely next path
  loop once [prompt]  propose next plan; waits for y/n before acting
  loop status         show latest user-proxy plan and notes
  loop note <note>    add steering context (tab path in UI)
  loop decide yes|no  approve or reject latest plan
  board               show local kanban/todo board
  board add <title>   create a task with lane/priority/owner/coordinate
  board move <id> <lane>
                      move a task to backlog|next|doing|blocked|done
  money idea <idea>   turn a rough idea into a local offer brief
  money list [n]      list recent idea-to-offer receipts
  money show <id>     show a saved offer brief
  links status        show browser link stream and cache coordinates
  links cache         cache browser links and summarize with Ollama
  links publish       push local link posts to the public stream (umminuriddingreen.com)
  pack list           list compartmentalized capability packs
  pack show <id>      show pack routes, files, caps, and checks
  pack export <id>    write local-only pack manifest
  runner init <name>  register an owned runner and print its token once
  runner start --once claim one whitelisted runner job and exit
  check               typecheck (the inner fix loop)
  ship [message]      typecheck -> local commit only
  ship --push [msg]   explicit external push to origin
  dev|build|start     run the Next.js app
  registry <sub>      scan | doctor | export
  bridge send <msg>   message Yin (Codex) via ~/hii/bridge/messages
  bridge log [n]      tail ~/.hii/bridge/yin-codex.jsonl
  bridge inbox [n]    list recent bridge messages
  codex <prompt>      run Codex in the repo, logged to the bridge
  mcp [args]          codex mcp passthrough (default: list)`);
    process.exit(cmd ? 1 : 0);
}
