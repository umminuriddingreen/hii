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
const LOCAL_CAPABILITY_JOBS = path.join(ROOT, ".hii", "capability-jobs.jsonl");
const OG_EVENTS = path.join(RUNTIME, "og", "events.jsonl");

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
  fs.mkdirSync(path.dirname(OG_EVENTS), { recursive: true });
  fs.appendFileSync(OG_EVENTS, `${JSON.stringify(event)}\n`);
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

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
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
  case "jobs": cmdJobs(rest); break;
  case "terminal": cmdTerminal(rest); break;
  case "og": cmdOg(rest); break;
  case "loop": cmdOg(rest); break;
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
  status              env + git + codex snapshot
  doctor              status + registry doctor
  caps [show]         list backend-owned capabilities
  jobs [n]            list recent local capability jobs
  og [capture <msg>]  infer the operational graph and likely next path
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
