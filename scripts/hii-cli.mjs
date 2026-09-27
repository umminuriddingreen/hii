#!/usr/bin/env node
// HII CLI — single current entrypoint for the Human Information Interface.
// Installed via ~/bin/hii.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import url from "node:url";
import { runSkillCommand } from "../runtime/skills/registry.mjs";
import { observeInstances } from "./lib/instance-observation.mjs";
import { buildInventory, renderDocs, renderHelp } from "./hii-inventory.mjs";
import { archiveCommand } from "./hii-conversation-archive.mjs";
import { mailboxCommand } from "./hii-agent-mailbox.mjs";

// The repository this CLI belongs to. Derived from this file's own location so
// a checkout anywhere works; HII_ROOT overrides it. Hardcoding ~/hii made every
// delegated command report on whatever repo happened to sit at that path.
const ROOT = process.env.HII_ROOT
  ? path.resolve(process.env.HII_ROOT)
  : path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const RUNTIME = process.env.HII_RUNTIME_DIR || path.join(os.homedir(), ".hii");
const BRIDGE_DIR = path.join(RUNTIME, "bridge", "messages");
const BRIDGE_LOG = path.join(RUNTIME, "bridge", "codex.jsonl");
const CAPABILITY_REGISTRY = path.join(ROOT, "runtime", "capabilities", "registry.json");
const CAPABILITY_PACKS = path.join(ROOT, "runtime", "capabilities", "packs.json");
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
const HII_PROFILE = path.join(RUNTIME, "profile.md");
const HII_USER = path.join(RUNTIME, "user.md");
const HERMES_USER = path.join(os.homedir(), ".hermes", "memories", "USER.md");
const HII_SCHEDULES = path.join(RUNTIME, "schedules", "schedules.json");
const HII_SKILL_INDEX = path.join(RUNTIME, "skills", "_index.json");
const HERMES_SKILLS = path.join(os.homedir(), ".hermes", "skills");
const HII_KNOWLEDGE_DB = path.join(RUNTIME, "hii.db");
const WEB_RUNTIME_DIR = path.join(RUNTIME, "web");
const WEB_PID = path.join(WEB_RUNTIME_DIR, "web.pid");
const WEB_LOG = path.join(WEB_RUNTIME_DIR, "web.log");
const SLASH_REGISTRY = path.join(RUNTIME, "cli", "slash-commands.json");
const DAEMON_STATUS = path.join(RUNTIME, "daemon", "status.json");
const DAEMON_INSTANCES = path.join(RUNTIME, "daemon", "instances.json");
const CLI_RUNS = path.join(RUNTIME, "runs", "cli");
const HIID = path.join(ROOT, "runtime", "daemon", "hiid.mjs");
const HII_TUI = path.join(ROOT, "scripts", "hii-tui.mjs");
const CODEX_APP_SERVER_PROBE = path.join(ROOT, "scripts", "hii-codex-app-server-probe.mjs");
const CODEX_SCHEMA_PIN = path.join(ROOT, "scripts", "hii-codex-schema-pin.mjs");
const CODEX_THREADS = path.join(ROOT, "scripts", "hii-codex-threads.mjs");
const LINK_POSTS = path.join(ROOT, ".hii", "link-posts.jsonl");
const LINK_CACHE = path.join(ROOT, ".hii", "link-cache.jsonl");
const RUNNER_CAPABILITIES = ["hii.rhino.managed_job"];
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

function localWebUrl() {
  return cleanEnvValue(process.env.HII_WEB_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
}

function ownedWebPid() {
  const pid = Number(fs.existsSync(WEB_PID) ? fs.readFileSync(WEB_PID, "utf8").trim() : "");
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try { process.kill(pid, 0); } catch { return null; }
  const observed = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return observed.status === 0 && observed.stdout.includes("hii-dev.mjs") ? pid : null;
}

async function webReady() {
  try {
    const response = await fetch(localWebUrl(), { signal: AbortSignal.timeout(750) });
    return response.ok;
  } catch {
    return false;
  }
}

function startWeb() {
  const existing = ownedWebPid();
  if (existing) return existing;
  fs.mkdirSync(WEB_RUNTIME_DIR, { recursive: true });
  const out = fs.openSync(WEB_LOG, "a");
  const child = spawn(process.execPath, [path.join(ROOT, "scripts", "hii-dev.mjs")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, HII_NEXT_DIST_DIR: ".next-web-cli" }
  });
  child.unref();
  fs.closeSync(out);
  fs.writeFileSync(WEB_PID, `${child.pid}\n`, { mode: 0o600 });
  return child.pid;
}

async function waitForWeb(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await webReady()) return;
    const pid = ownedWebPid();
    if (!pid) throw new Error(`HII web exited during startup; inspect ${WEB_LOG}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`HII web did not become ready; inspect ${WEB_LOG}`);
}

function openUrl(target) {
  const program = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  const result = spawnSync(program, [target], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`could not open ${target}`);
}

async function cmdWeb(args) {
  const sub = args[0] || "status";
  if (sub === "start") {
    const pid = startWeb();
    await waitForWeb();
    console.log(JSON.stringify({ ok: true, state: "ready", pid, url: localWebUrl(), log: WEB_LOG }, null, 2));
  } else if (sub === "open") {
    const pid = startWeb();
    await waitForWeb();
    openUrl(localWebUrl());
    console.log(JSON.stringify({ ok: true, state: "opened", pid, url: localWebUrl(), log: WEB_LOG }, null, 2));
  } else if (sub === "status") {
    console.log(JSON.stringify({
      state: await webReady() ? "ready" : ownedWebPid() ? "starting" : "stopped",
      pid: ownedWebPid(), url: localWebUrl(), log: WEB_LOG
    }, null, 2));
  } else if (sub === "logs") {
    const lines = Number(args[1] || 80);
    if (!fs.existsSync(WEB_LOG)) throw new Error("HII web has no log yet");
    console.log(fs.readFileSync(WEB_LOG, "utf8").split("\n").slice(-lines).join("\n"));
  } else if (sub === "stop") {
    const pid = ownedWebPid();
    if (!pid) return console.log("HII web is not running");
    process.kill(-pid, "SIGTERM");
    fs.rmSync(WEB_PID, { force: true });
    console.log(`stopped HII web pid=${pid}`);
  } else {
    throw new Error("usage: hii web <open|start|status|logs|stop>");
  }
}

function cmdApp(args) {
  const sub = args[0] || "open";
  const app = process.platform === "darwin"
    ? "/Applications/HII.app"
    : process.platform === "win32"
      ? [
          path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "HII", "hii.exe"),
          path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "HII", "hii.exe")
        ].find((candidate) => fs.existsSync(candidate))
      : "/usr/bin/hii";
  if (sub === "open") {
    if (!app || !fs.existsSync(app)) throw new Error(`HII app is not installed${app ? ` at ${app}` : ""}`);
    if (process.platform === "darwin") {
      const result = spawnSync("open", ["-a", app], { stdio: "inherit" });
      if (result.status !== 0) throw new Error("could not open the HII app");
    } else {
      const child = spawn(app, [], { detached: true, stdio: "ignore" });
      child.unref();
    }
    console.log(`opened ${app}`);
  } else if (sub === "status") {
    const result = process.platform === "win32"
      ? spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq hii.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" })
      : spawnSync("pgrep", ["-x", "HII"], { encoding: "utf8" });
    const running = result.status === 0 && (process.platform !== "win32" || result.stdout.toLowerCase().includes('"hii.exe"'));
    console.log(JSON.stringify({ installed: Boolean(app && fs.existsSync(app)), running, pid: process.platform === "win32" ? null : result.stdout.trim() || null, app: app || null }, null, 2));
  } else {
    throw new Error("usage: hii app <open|status>");
  }
}

function slashDefaults() {
  return [
    { name: "backend", description: "manage HII models", argvPrefix: ["model"] },
    { name: "open", description: "launch HII app, web, or site", argvPrefix: ["open"] },
    { name: "ui", description: "control app and web surfaces", argvPrefix: ["ui"] }
  ];
}

function readSlashRegistry() {
  try {
    const value = JSON.parse(fs.readFileSync(SLASH_REGISTRY, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function writeSlashRegistry(entries) {
  fs.mkdirSync(path.dirname(SLASH_REGISTRY), { recursive: true });
  const temp = `${SLASH_REGISTRY}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, SLASH_REGISTRY);
}

function cmdSlash(args) {
  const sub = args[0] || "list";
  if (sub === "sync") {
    const current = readSlashRegistry();
    for (const entry of slashDefaults()) {
      const index = current.findIndex((item) => item.name === entry.name);
      if (index >= 0) current[index] = entry;
      else current.push(entry);
    }
    writeSlashRegistry(current);
    console.log(`Slash controls hot-reloaded: ${SLASH_REGISTRY}`);
  } else if (sub === "list") {
    console.log(JSON.stringify({ path: SLASH_REGISTRY, controls: readSlashRegistry() }, null, 2));
  } else if (sub === "add") {
    const name = String(args[1] || "").replace(/^\//, "");
    const marker = args.indexOf("--description");
    const argvPrefix = args.slice(2, marker >= 0 ? marker : undefined);
    const description = marker >= 0 ? args.slice(marker + 1).join(" ").trim() : "HII CLI control";
    if (!/^[a-z][a-z0-9-]*$/.test(name) || argvPrefix.length === 0) {
      throw new Error("usage: hii slash add <name> <cli argv prefix...> [--description text]");
    }
    const current = readSlashRegistry().filter((entry) => entry.name !== name);
    current.push({ name, description, argvPrefix });
    writeSlashRegistry(current);
    console.log(`/${name} is available now; no HII restart required`);
  } else if (sub === "remove") {
    const name = String(args[1] || "").replace(/^\//, "");
    const current = readSlashRegistry();
    if (!current.some((entry) => entry.name === name)) throw new Error(`/${name} is not registered`);
    if (!args.includes("--yes")) {
      console.log(`Preview: remove /${name}\nApply: hii slash remove ${name} --yes`);
      return;
    }
    writeSlashRegistry(current.filter((entry) => entry.name !== name));
    console.log(`/${name} removed; no HII restart required`);
  } else {
    throw new Error("usage: hii slash <sync|list|add|remove>");
  }
}

async function cmdOpen(args) {
  const target = args[0] || "app";
  if (target === "app" || target === "desktop") return cmdApp(["open"]);
  if (target === "web") return cmdWeb(["open"]);
  if (target === "site") {
    openUrl(appBaseUrl());
    return console.log(`opened ${appBaseUrl()}`);
  }
  throw new Error("usage: hii open <app|web|site>");
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
  const entry = { ts: new Date().toISOString(), from: "hii", ...event };
  fs.appendFileSync(BRIDGE_LOG, `${JSON.stringify(entry)}\n`);
  return entry;
}

function npmRun(script, extra = []) {
  const r = spawnSync("npm", ["run", script, ...extra], { cwd: ROOT, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

function nodeScript(script, args = []) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, stdio: "inherit", env: process.env });
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

function readJsonObject(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
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

function personalContextSummary() {
  const profile = [HII_PROFILE, HII_USER, HERMES_USER].find((file) => fs.existsSync(file));
  const schedules = readJsonArray(HII_SCHEDULES)
    .filter((item) => item?.enabled !== false)
    .slice(0, 12)
    .map((item) => ({
      id: item.id,
      cron: item.cron,
      task: redactText(item.task ?? "").slice(0, 240),
      workspace: item.workspace ?? ROOT
    }));
  return {
    profile: profile ? fileExistsSummary(profile) : { path: HII_PROFILE, exists: false },
    schedules: { path: HII_SCHEDULES, active: schedules.length, items: schedules },
    knowledge: fileExistsSummary(HII_KNOWLEDGE_DB),
    skills: {
      hii: { path: HII_SKILL_INDEX, indexed: readJsonArray(HII_SKILL_INDEX).length },
      hermes: { path: HERMES_SKILLS, available: fs.existsSync(HERMES_SKILLS), role: "local migration source" }
    }
  };
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

function parseAcceptanceCriteria(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  return [...new Set(values
    .map((criterion) => redactText(criterion).trim().slice(0, 240))
    .filter(Boolean))]
    .slice(0, 8);
}

function proposalQualityIssues(task) {
  if ((task.origin || "system") === "human") return [];
  const issues = [];
  const title = String(task.title || "").trim();
  const vague = /^(?:review|fix|improve|update|task|todo|tbd|do this|work on it)$/i.test(title);
  if (title.split(/\s+/).filter(Boolean).length < 2 || vague) {
    issues.push("Name a bounded outcome, not a vague activity.");
  }
  if (String(task.notes || "").trim().length < 20) {
    issues.push("Explain why this work matters and what context it uses.");
  }
  if (parseAcceptanceCriteria(task.acceptanceCriteria).length === 0) {
    issues.push("Add at least one concrete “done when” criterion.");
  }
  return issues;
}

function parseFlagValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

function parseFlagValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] && !args[index + 1].startsWith("--")) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
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
    fileExistsSummary(path.join(RUNTIME, "mind0", "state.json")),
    fileExistsSummary(path.join(RUNTIME, "daemon", "status.json")),
    fileExistsSummary(path.join(RUNTIME, "daemon", "instances.json")),
    fileExistsSummary(path.join(RUNTIME, "daemon", "events.jsonl")),
    fileExistsSummary(path.join(RUNTIME, "codex", "index.json")),
    fileExistsSummary(path.join(RUNTIME, "skills", "actions.jsonl")),
    fileExistsSummary(path.join(RUNTIME, "skills", "registry.json"))
  ];
}

function countBy(items, key) {
  return items.reduce((counts, item) => {
    const value = String(item?.[key] || "unknown");
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function receiptStateSummary() {
  try {
    const receipts = fs.readdirSync(CLI_RUNS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(CLI_RUNS, entry.name, "receipt.json"))
      .filter((file) => fs.existsSync(file))
      .map((file) => fileExistsSummary(file))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return { path: CLI_RUNS, count: receipts.length, latestAt: receipts[0]?.updatedAt || null };
  } catch {
    return { path: CLI_RUNS, count: 0, latestAt: null };
  }
}

function activeStatePayload(context) {
  const observedAt = context.generatedAt;
  const tasks = context.localState.boardTasks;
  const activeJobs = context.localState.recentJobs.filter((job) =>
    ["queued", "running", "working", "attention"].includes(String(job.status).toLowerCase())
  );
  const daemon = readJsonObject(DAEMON_STATUS);
  const instanceDocument = readJsonObject(DAEMON_INSTANCES);
  const reportedInstances = observeInstances(instanceDocument, { now: Date.parse(observedAt) });
  const observations = countBy(reportedInstances, "observation");
  const activeInstances = reportedInstances.filter((instance) => instance.live === true);
  const ownedInstances = activeInstances.filter((instance) => instance.owned === true);
  const observedProcesses = activeInstances.filter((instance) => instance.type === "process" && instance.owned !== true);
  const partialCapabilities = context.capabilities.filter((capability) => capability.status === "partial");
  const readyCapabilities = context.capabilities.filter((capability) => capability.status === "ready");
  const receipts = receiptStateSummary();
  const pointers = runtimePointers();
  const eventPointers = pointers.filter((pointer) => pointer.exists && /(?:events|actions|bridge|notes|decisions).*\.(?:jsonl|json)$/i.test(pointer.path));
  const latestEventAt = eventPointers.map((pointer) => pointer.updatedAt).filter(Boolean).sort().at(-1) || null;
  const domains = [
    {
      id: "workspace", state: context.git.worktree.clean ? "idle" : "active", visibility: "observed",
      source: "git status", updatedAt: observedAt,
      basis: context.git.worktree.clean ? "No uncommitted files." : `${context.git.worktree.counts.total} uncommitted file change(s).`,
      counts: context.git.worktree.counts
    },
    {
      id: "work", state: tasks.byLane.doing ? "active" : tasks.byLane.blocked ? "attention" : tasks.open ? "ready" : "idle", visibility: "observed",
      source: tasks.path, updatedAt: tasks.recent.map((task) => task.updatedAt).filter(Boolean).sort().at(-1) || null,
      basis: `${tasks.byLane.doing || 0} doing, ${tasks.byLane.blocked || 0} blocked, ${tasks.open} open.`, counts: tasks.byLane
    },
    {
      id: "agents", state: ownedInstances.some((instance) => instance.type === "codex-run") ? "active" : activeJobs.length ? "ready" : "idle", visibility: activeJobs.length ? "partial" : "observed",
      source: LOCAL_CAPABILITY_JOBS, updatedAt: context.localState.capabilityJobs.updatedAt || null,
      basis: `${activeJobs.length} reported bounded job(s), not process-verified; ${ownedInstances.filter((instance) => instance.type === "codex-run").length} verified live managed agent run(s).`,
      counts: { boundedJobs: activeJobs.length, managedRuns: ownedInstances.filter((instance) => instance.type === "codex-run").length }
    },
    {
      id: "systems", state: activeInstances.length ? "active" : reportedInstances.length ? "unknown" : daemon ? "idle" : "offline", visibility: observations.stale || observations.unknown ? "partial" : daemon ? "observed" : "unavailable",
      source: DAEMON_INSTANCES, updatedAt: instanceDocument?.updatedAt || daemon?.updatedAt || null,
      basis: instanceDocument ? `${activeInstances.length} verified live instance(s); ${observations.dead || 0} dead, ${observations.stale || 0} stale, ${observations.unknown || 0} unverified report(s).` : "The HII daemon has not published system state.",
      counts: { active: activeInstances.length, owned: ownedInstances.length, observed: observedProcesses.length, reported: reportedInstances.length, dead: observations.dead || 0, stale: observations.stale || 0, unknown: observations.unknown || 0, byType: countBy(activeInstances, "type") }
    },
    {
      id: "context", state: context.localState.personalContext.knowledge.exists ? "ready" : "unknown", visibility: "observed",
      source: HII_KNOWLEDGE_DB, updatedAt: context.localState.personalContext.knowledge.updatedAt || null,
      basis: context.localState.personalContext.knowledge.exists ? "Canonical local knowledge store is present." : "Canonical local knowledge store was not found.",
      counts: { bytes: context.localState.personalContext.knowledge.bytes || 0, skills: context.localState.personalContext.skills.hii.indexed }
    },
    {
      id: "capabilities", state: partialCapabilities.length ? "partial" : "ready", visibility: "observed",
      source: CAPABILITY_REGISTRY, updatedAt: fileExistsSummary(CAPABILITY_REGISTRY).updatedAt || null,
      basis: `${readyCapabilities.length} ready; ${partialCapabilities.length} partial.`, counts: { ready: readyCapabilities.length, partial: partialCapabilities.length }
    },
    {
      id: "authority", state: daemon?.policy ? "ready" : "partial", visibility: daemon?.policy ? "observed" : "partial",
      source: DAEMON_STATUS, updatedAt: daemon?.updatedAt || null,
      basis: daemon?.policy ? `${daemon.policy.autonomous?.length || 0} local action class(es); ${daemon.policy.approvalRequired?.length || 0} approval-gated class(es).` : "No current daemon policy snapshot is available.",
      counts: { autonomous: daemon?.policy?.autonomous?.length || 0, approvalRequired: daemon?.policy?.approvalRequired?.length || 0 }
    },
    {
      id: "evidence", state: receipts.count ? "ready" : "unknown", visibility: "observed",
      source: receipts.path, updatedAt: receipts.latestAt,
      basis: receipts.count ? `${receipts.count} CLI receipt(s); latest receipt timestamp is exposed.` : "No CLI receipts were found.", counts: { receipts: receipts.count }
    },
    {
      id: "events", state: eventPointers.length ? "active" : "unknown", visibility: "observed",
      source: RUNTIME, updatedAt: latestEventAt,
      basis: `${eventPointers.length} observable event or activity ledger(s).`, counts: { ledgers: eventPointers.length }
    }
  ];
  const coverage = {
    registeredDomains: domains.length,
    observed: domains.filter((domain) => domain.visibility === "observed").length,
    partial: domains.filter((domain) => domain.visibility === "partial").length,
    unavailable: domains.filter((domain) => domain.visibility === "unavailable").length,
    exclusions: [
      "private or unregistered activity",
      "sources outside approved scopes",
      "raw model internals or private chain-of-thought",
      "remote devices without authenticated transport and a live executor"
    ]
  };
  return {
    schemaVersion: 1,
    kind: "hii.active-state",
    model: "white-box operational state",
    observedAt,
    claim: "All state HII is registered, permitted, and able to observe; unknown and excluded state stays explicit.",
    transition: "input -> context -> interpretation -> proposal -> authority -> action -> verification -> receipt",
    coverage,
    activeInstanceProjection: {
      total: activeInstances.length,
      returned: Math.min(activeInstances.length, 8),
      truncated: activeInstances.length > 8,
      inspectCommand: "hii instances list"
    },
    domains,
    activeInstances: activeInstances
      .sort((a, b) => Number(b.owned === true) - Number(a.owned === true) || String(a.type).localeCompare(String(b.type)))
      .slice(0, 8)
      .map((instance) => ({
        id: String(instance.id || "unknown"), type: String(instance.type || "unknown"), status: String(instance.status || "unknown"),
        owned: instance.owned === true, live: instance.live, pid: Number.isInteger(instance.pid) ? instance.pid : null,
        title: redactText(instance.title || "").replace(/\s+/g, " ").slice(0, 120),
        coordinate: instance.coordinate ? redactText(instance.coordinate).slice(0, 180) : null,
        heartbeatAt: instance.heartbeatAt || null
      }))
  };
}

function staleLegacyRuntimeProbe() {
  const legacyPath = path.join(os.homedir(), "hii-old");
  const capabilityCache = path.join(RUNTIME, "capabilities.json");
  const findings = [];
  if (fs.existsSync(legacyPath)) {
    findings.push({
      path: legacyPath,
      state: "present",
      action: `remove or mine then discard; current HII is ${ROOT}`
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
  const text = `${prompt} ${bridge.map((entry) => JSON.stringify(entry)).join(" ")}`.toLowerCase();
  const actions = [];
  if (text.includes("og") || text.includes("oracle") || text.includes("persistent") || text.includes("conversation")) {
    actions.push({
      score: 92,
      track: "operational graph",
      coordinate: "hii og",
      action: "capture this turn as an OG event and use local context to rank the next path"
    });
  }
  if (capabilities.some((capability) => capability.id === "hii.rhino.managed_job")) {
    actions.push({
      score: text.includes("rhino") || text.includes("grasshopper") ? 90 : 62,
      track: "HII Rhino capability",
      coordinate: "hii rhino + hii.rhino.managed_job",
      action: "use HII-owned RhinoCode execution with logs, artifacts, and receipts"
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
    score: 76,
    track: "Context Dock truthful bootstrap",
    coordinate: "docs/HII_AII_MASTER_CONTEXT.md + ~/.hii/hii.db",
    action: "align product truth, storage, permissions, context provenance, and bounded MCP around the Context Dock vertical slice"
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

function createBoardTask({ title, lane, priority, owner, coordinate, notes, acceptanceCriteria, tags, source = "hii board" }) {
  const cleanTitle = redactText(title).trim();
  if (cleanTitle.length < 2) {
    console.error("usage: hii board add <title> [--lane backlog|next|doing|blocked|done] [--priority low|normal|high|urgent]");
    process.exit(1);
  }
  if (/^--?[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(cleanTitle)) {
    console.error("Use an outcome-focused task title instead of a command flag.");
    process.exit(1);
  }
  const now = new Date().toISOString();
  const cleanCoordinate = redactText(coordinate || ROOT).slice(0, 240);
  const duplicateKey = [cleanTitle, cleanCoordinate]
    .map((value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " "))
    .join("\u0000");
  const duplicate = boardTasks().find((task) =>
    [task.title, task.coordinate]
      .map((value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " "))
      .join("\u0000") === duplicateKey
  );
  if (duplicate) {
    console.error(`An open task already covers this outcome: ${duplicate.id.slice(0, 8)} ${duplicate.title}`);
    process.exit(1);
  }
  const task = {
    id: randomUUID(),
    title: cleanTitle.slice(0, 240),
    lane: normalizeBoardLane(lane),
    priority: normalizeBoardPriority(priority),
    owner: redactText(owner || "main agent").slice(0, 80),
    coordinate: cleanCoordinate,
    notes: redactText(notes || "").slice(0, 2000),
    acceptanceCriteria: parseAcceptanceCriteria(acceptanceCriteria),
    tags: parseCsvTags(tags),
    source,
    origin: "human",
    reviewState: "approved",
    approvedAt: now,
    approvedBy: "local operator",
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
  const cleanPatch = {};
  const approvalRequested = patch.reviewState === "approved";
  if (patch.lane !== undefined) {
    const requestedLane = normalizeBoardLane(patch.lane);
    if (["next", "doing"].includes(requestedLane) && task.reviewState === "proposed" && !approvalRequested) {
      console.error("Approve this proposal before moving it into active work.");
      process.exit(1);
    }
    if (
      requestedLane === "done"
      && task.runId
      && (task.runStatus !== "completed" || !task.receiptRef)
    ) {
      console.error("A run-linked task needs completed status and a receipt before entering done.");
      process.exit(1);
    }
    if (requestedLane !== task.lane) {
      cleanPatch.lane = requestedLane;
      if (cleanPatch.lane === "done") cleanPatch.completedAt = now;
    }
  }
  if (patch.title !== undefined) {
    const title = redactText(patch.title).trim().slice(0, 240);
    if (title && title !== task.title) cleanPatch.title = title;
  }
  if (patch.priority !== undefined) {
    const priority = normalizeBoardPriority(patch.priority);
    if (priority !== task.priority) cleanPatch.priority = priority;
  }
  if (patch.owner !== undefined) {
    const owner = redactText(patch.owner).trim().slice(0, 80) || task.owner;
    if (owner !== task.owner) cleanPatch.owner = owner;
  }
  if (patch.coordinate !== undefined) {
    const coordinate = redactText(patch.coordinate).trim().slice(0, 240) || task.coordinate;
    if (coordinate !== task.coordinate) cleanPatch.coordinate = coordinate;
  }
  if (patch.notes !== undefined) {
    const notes = redactText(patch.notes).trim().slice(0, 2000);
    if (notes !== task.notes) cleanPatch.notes = notes;
  }
  if (patch.acceptanceCriteria !== undefined) {
    const acceptanceCriteria = parseAcceptanceCriteria(patch.acceptanceCriteria);
    if (JSON.stringify(acceptanceCriteria) !== JSON.stringify(task.acceptanceCriteria || [])) {
      cleanPatch.acceptanceCriteria = acceptanceCriteria;
    }
  }
  if (patch.tags !== undefined) {
    const tags = parseCsvTags(patch.tags);
    if (JSON.stringify(tags) !== JSON.stringify(task.tags || [])) cleanPatch.tags = tags;
  }
  if (approvalRequested && task.reviewState !== "approved") {
    const issues = proposalQualityIssues({ ...task, ...cleanPatch });
    if (issues.length) {
      console.error(`Define this proposal before approval: ${issues.join(" ")}`);
      process.exit(1);
    }
    cleanPatch.reviewState = "approved";
    cleanPatch.approvedAt = now;
    cleanPatch.approvedBy = redactText(patch.approvedBy || "local operator").trim().slice(0, 80);
  }
  if (Object.keys(cleanPatch).length === 0) return task;
  cleanPatch.updatedAt = now;
  appendBoardEvent({ type: "updated", id: task.id, patch: cleanPatch, ts: now });
  return { ...task, ...cleanPatch };
}

function boardDedupeKey(task) {
  return [task.title, task.coordinate]
    .map((value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " "))
    .join("\u0000");
}

function dedupeBoardTasks({ dryRun = false } = {}) {
  const groups = new Map();
  for (const task of boardTasks()) {
    const key = boardDedupeKey(task);
    const group = groups.get(key) ?? [];
    group.push(task);
    groups.set(key, group);
  }

  const reconciled = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) =>
      String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? ""))
    );
    const keep = ordered[0];
    for (const duplicate of ordered.slice(1)) {
      const note = `Archived duplicate of ${keep.id.slice(0, 8)} during append-only board reconciliation.`;
      const notes = [duplicate.notes, note].filter(Boolean).join("\n").slice(0, 2000);
      if (!dryRun) updateBoardTask(duplicate.id, { lane: "done", notes });
      reconciled.push({ duplicate, keep });
    }
  }
  return reconciled;
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
      sources: context.sources
    },
    inferredIntent: {
      track: top.track,
      confidence: top.score,
      evidence: [
        `repo=${context.identity.repo}`,
        `branch=${context.git.branch}`,
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
      nextCommand: top.coordinate,
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
  console.log(`git:     ${git.branch}`);
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
  console.log("HII — Human Information Interface status\n");
  console.log(`repo:    ${ROOT}`);
  try {
    const branch = execFileSync("git", ["-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"]).toString().trim();
    console.log(`git:     ${branch}`);
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
    { command: "hii home --brief", purpose: "Smallest possible agent landing snapshot; cheapest first command for agents." },
    { command: "hii home --json", purpose: "Token-efficient agent landing snapshot; full detail when brief is not enough." },
    { command: "hii agents status", purpose: "Show which installed agent instruction adapters are configured." },
    { command: "hii agents guide", purpose: "Print the compact HII-first operating contract shared by agents." },
    { command: "hii agents inbox --for <agent>", purpose: "Read durable task, workspace, context, and receipt handoffs addressed to an agent." },
    { command: "hii agents send --to <agent> --task <task> --message <text>", purpose: "Send one local, source-linked handoff to another agent or all agents." },
    { command: "hii archive sync", purpose: "Incrementally import configured ChatGPT exports and local Codex sessions." },
    { command: "hii context --json", purpose: "Full machine-readable repo, runtime, and capability context." },
    { command: "hii probe", purpose: "Print the full HII worktree probe and stale-runtime warnings." },
    { command: "hii caps show", purpose: "List backend-owned capabilities." },
    { command: "hii og status", purpose: "Infer likely next work from repo, bridge, job, and runtime context." },
    { command: "hii og capture <message>", purpose: "Append an operational-graph event for this turn." },
    { command: "hii loop once", purpose: "Propose the next user-proxy plan locally; do not act until y/n approval." },
    { command: "hii loop note <note>", purpose: "Add user notes to steer the persistent loop." },
    { command: "hii loop decide <yes|no>", purpose: "Approve or reject the latest proposed plan." },
    { command: "hii platform --json", purpose: "Report the detected OS, architecture, compatible model format, and default runtime." },
    { command: "hii model recommend", purpose: "Compare HII-curated local models against this machine, installed state, and measured speed." },
    { command: "hii model field", purpose: "Inventory configured, installed, ready, hosted, and remote model rails without changing them." },
    { command: "hii model plan", purpose: "Produce a deterministic bounded spin-up plan without starting or stopping a model." },
    { command: "hii model discover", purpose: "Find compatible local runtimes, preset-backed weights, and reachable model endpoints." },
    { command: "hii model search <query>", purpose: "Search Hugging Face for OS-compatible MLX or GGUF model repositories." },
    { command: "hii model install <org/model>", purpose: "Explicitly download and verify weights in HII's private cache." },
    { command: "hii model installed", purpose: "List locally installed HII model weights and disk usage." },
    { command: "hii model use <org/model>", purpose: "Switch the HII backend and project the active choice into Pi." },
    { command: "hii model status", purpose: "Show backend, active model, endpoint, process, performance settings, and logs." },
    { command: "hii model bench", purpose: "Run HII's bounded end-to-end completion benchmark against the active model." },
    { command: "hii model remove <org/model>", purpose: "Preview removal; add --yes only when the displayed target is correct." },
    { command: "hii open app", purpose: "Launch the installed HII desktop application." },
    { command: "hii open web", purpose: "Start HII's CLI-owned local web runtime and open it in the browser." },
    { command: "hii open site", purpose: "Open the configured canonical website without starting a local runtime." },
    { command: "hii ui web status", purpose: "Show the local web process, URL, state, and log coordinate." },
    { command: "hii ui web start", purpose: "Start the local web runtime and wait until it is ready." },
    { command: "hii ui web logs", purpose: "Inspect the CLI-owned web runtime log." },
    { command: "hii ui web stop", purpose: "Stop only the web process group owned by this CLI." },
    { command: "hii ui app status", purpose: "Show whether the desktop bundle is installed and currently running." },
    { command: "hii slash list", purpose: "Show hot-reloaded CLI-backed slash controls and their registry path." },
    { command: "hii slash sync", purpose: "Publish HII's model and UI controls into the live slash menu." },
    { command: "hii slash add <name> <prefix>", purpose: "Add a CLI-backed slash control immediately, without restarting HII." },
    { command: "hii slash remove <name>", purpose: "Preview removal; add --yes to hot-remove the control." },
    { command: "hii daemon start", purpose: "Start hiid, the local HII daemon instance supervisor." },
    { command: "hii daemon status", purpose: "Show hiid health, runtime path, instance count, and autonomy boundary." },
    { command: "hii feed --follow", purpose: "Read the daemon action feed for live HII work." },
    { command: "hii instances list", purpose: "List HII-managed and observed daemon instances." },
    { command: "hii codex run <prompt>", purpose: "Queue a managed HII Codex run through hiid with receipts and logs." },
    { command: "hii board", purpose: "Show the local kanban/todo board grouped by backlog, next, doing, blocked, and done." },
    { command: "hii board add <title>", purpose: "Create a local task with owner, coordinate, priority, tags, and notes." },
    { command: "hii board move <id> <lane>", purpose: "Move a task between kanban lanes." },
    { command: "hii board approve <id>", purpose: "Approve a generated proposal into its requested active lane." },
    { command: "hii board dedupe", purpose: "Archive duplicate open cards through append-only board events." },
    { command: "hii knowledge", purpose: "Show canonical local HII knowledge and recent immutable source imports." },
    { command: "hii knowledge check", purpose: "Run the isolated notes, links, search, graph, history, lifecycle, and export smoke test." },
    { command: "hii money idea <idea>", purpose: "Use local models to turn a rough idea into a sellable offer and execution handoff." },
    { command: "hii money list", purpose: "List recent local idea-to-offer receipts." },
    { command: "hii links cache", purpose: "Cache browser-captured links locally and summarize them with Ollama when available." },
    { command: "hii links publish", purpose: "Publish locally captured links to the token-gated public stream." },
    { command: "hii pack list", purpose: "List compartmentalized HII capability packs." },
    { command: "hii pack export <id>", purpose: "Write a local-only pack manifest for staged shipping." },
    { command: "hii skill report", purpose: "Record a structured agent-action receipt and propose repeatable work as a draft skill." },
    { command: "hii skill list", purpose: "List proof-backed registered skills; add --all to include drafts." },
    { command: "hii skill register <id>", purpose: "Promote a validated draft into an operator-reviewed local skill." },
    { command: "hii skill export <id>", purpose: "Export one registered skill as a portable local package without publishing it." },
    { command: "hii runner init <name>", purpose: "Register an owned runner and print its local token once." },
    { command: "hii runner start --once", purpose: "Heartbeat, claim one whitelisted capability job, stream logs, and exit." },
    { command: "hii runner doctor", purpose: "Inspect the native model runtime, consumer hardware tier, and privacy route." },
    { command: "hii runner model start", purpose: "Start HII with the hardware-optimized local engine and explicit model acquisition." },
    { command: "hii runner bench", purpose: "Measure an end-to-end native completion and print model usage." },
    { command: "hii jobs", purpose: "List recent local capability jobs." },
    { command: "hii jobs reconcile", purpose: "Append local reconciliation receipts for completed Claude-backed HII agent jobs." },
    { command: "hii jobs cancel <id> --reason <reason>", purpose: "Append a cancellation receipt for one stale local capability job." },
    { command: "hii doctor", purpose: "Run status plus registry doctor." },
    { command: "hii ship", purpose: "Typecheck and commit locally; does not push." },
    { command: "hii ship --push <message>", purpose: "Validate, commit, and push when the active user contract authorizes it." },
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
      role: "local-first human interface for source-linked context and verified agent work",
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
      personalContext: personalContextSummary(),
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
      "Use hii ship for local validation and commit; hii ship --push is authorized by the active user contract for reversible branch pushes.",
      "Run npm run build after meaningful HII product edits.",
      `Use ${ROOT} as the only HII product/runtime surface; legacy patterns are migrated into this repo before old checkouts are discarded.`
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

function agentHomePayload() {
  const context = agentContextPayload();
  const pendingHandoffs = mailboxCommand(["inbox", "--for", process.env.HII_AGENT_ID || "hii"]).messages;
  const activeJobs = context.localState.recentJobs.filter((job) =>
    ["queued", "running", "working", "attention"].includes(job.status)
  );
  return {
    schemaVersion: 2,
    kind: "hii.agent.home",
    generatedAt: context.generatedAt,
    identity: context.identity,
    workspace: {
      branch: context.git.branch,
      clean: context.git.worktree.clean,
      changes: context.git.worktree.counts,
      files: context.git.worktree.files.slice(0, 8)
    },
    work: {
      board: context.localState.boardTasks,
      activeJobs,
      handoffs: {
        pending: pendingHandoffs.length,
        recent: pendingHandoffs.slice(-5).map(({ id, from, to, task, workspace, contextRefs, receipt, createdAt, body }) => ({
          id, from, to, task, workspace, contextRefs, receipt, createdAt, summary: body.slice(0, 240)
        }))
      }
    },
    context: context.localState.personalContext,
    activeState: activeStatePayload(context),
    capabilities: context.capabilities
      .filter((capability) => capability.status === "ready" || capability.status === "partial")
      .map((capability) => ({ id: capability.id, status: capability.status })),
    commands: [
      "hii home --json",
      "hii agents guide",
      "hii agents inbox --for <agent>",
      "hii context --json",
      "hii work --json",
      "hii caps show",
      "hii og status",
      "hii ship"
    ],
    guardrails: context.guardrails.slice(0, 5),
    nextActions: context.nextActions.slice(0, 3)
  };
}

function agentHomeBriefPayload(payload = agentHomePayload()) {
  const domains = payload.activeState.domains;
  return {
    kind: "hii.agent.home.brief",
    repo: payload.identity.repo,
    branch: payload.workspace.branch,
    clean: payload.workspace.clean,
    changes: payload.workspace.changes.total,
    openTasks: payload.work.board.open,
    activeJobs: payload.work.activeJobs.length,
    pendingHandoffs: payload.work.handoffs.pending,
    activeInstances: payload.activeState.activeInstanceProjection.total,
    activeInstanceSample: payload.activeState.activeInstanceProjection.returned,
    activeDomains: domains.filter((domain) => domain.state === "active").map((domain) => domain.id),
    attentionDomains: domains.filter((domain) => ["attention", "partial", "offline", "unknown"].includes(domain.state)).map((domain) => domain.id),
    observedDomains: payload.activeState.coverage.observed,
    capabilities: payload.capabilities.length,
    nextActions: payload.nextActions.map((action) => ({
      score: action.score,
      track: action.track,
      action: action.action
    }))
  };
}

function cmdHome(args) {
  const payload = agentHomePayload();
  if (args.includes("--brief")) {
    console.log(JSON.stringify(agentHomeBriefPayload(payload)));
    return;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log("HII Home\n");
  console.log(`repo:    ${payload.identity.repo}`);
  console.log(`runtime: ${payload.identity.runtime}`);
  console.log(`git:     ${payload.workspace.branch}${payload.workspace.clean ? " (clean)" : ` (${payload.workspace.changes.total} changes)`}`);
  console.log(`work:    ${payload.work.board.open} open tasks · ${payload.work.activeJobs.length} active jobs`);
  if (payload.work.handoffs.pending) console.log(`handoffs: ${payload.work.handoffs.pending} pending · hii agents inbox --for ${process.env.HII_AGENT_ID || 'hii'}`);
  console.log(`context: profile=${payload.context.profile.exists ? "ready" : "missing"} · ${payload.context.schedules.active} schedules · knowledge=${payload.context.knowledge.exists ? "ready" : "missing"} · ${payload.context.skills.hii.indexed} HII skills`);
  console.log(`caps:    ${payload.capabilities.length} ready or partial`);
  if (payload.nextActions.length) {
    console.log(`next:    ${payload.nextActions[0].track} — ${payload.nextActions[0].action}`);
  }
  console.log("\nFor agents: hii home --json");
  console.log("Full detail: hii context --json");
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
  console.log("\nFor agents: hii home --json");
  console.log("Full detail: hii context --json");
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

function runSdkContractSmoke(args = []) {
  const r = spawnSync("node", [path.join(ROOT, "scripts", "hii-sdk-contract-smoke.mjs"), ...args], { cwd: ROOT, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

function cmdSdk(args) {
  const sub = args[0] || "status";
  if (sub !== "status" && sub !== "check") {
    console.error("usage: hii sdk [status|check]");
    process.exit(1);
  }
  runSdkContractSmoke(args.slice(1));
}

function cmdCaps(args = []) {
  const sub = args[0] || "show";
  if (sub === "validate") {
    runSdkContractSmoke(args.slice(1));
  }
  if (sub !== "show") {
    console.error("usage: hii caps [show|validate]");
    process.exit(1);
  }
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
      const review = task.reviewState === "proposed" ? " [proposal]" : "";
      console.log(`  ${task.id.slice(0, 8)}  [${task.priority}]${review} ${task.title}${tags}`);
      console.log(`      owner: ${task.owner}  origin: ${task.origin || "legacy"}  coordinate: ${task.coordinate}`);
      if (task.reviewState === "proposed") {
        console.log(`      approval: required  requested: ${task.requestedLane || "review"}`);
        const issues = proposalQualityIssues(task);
        console.log(`      definition: ${issues.length ? `needs ${issues.join(" ")}` : "ready"}`);
      }
      for (const criterion of parseAcceptanceCriteria(task.acceptanceCriteria)) {
        console.log(`      done when: ${criterion}`);
      }
      if (task.runStatus) {
        console.log(`      run: ${task.runStatus}  id: ${task.runId || "pending"}  receipt: ${task.receiptRef ? "linked" : "pending"}`);
      }
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
    const title = withoutFlags(rest, ["--lane", "--priority", "--owner", "--coordinate", "--notes", "--check", "--tags"]).join(" ").trim();
    const task = createBoardTask({
      title,
      lane: parseFlagValue(rest, "--lane", "backlog"),
      priority: parseFlagValue(rest, "--priority", "normal"),
      owner: parseFlagValue(rest, "--owner", "main agent"),
      coordinate: parseFlagValue(rest, "--coordinate", ROOT),
      notes: parseFlagValue(rest, "--notes", ""),
      acceptanceCriteria: parseFlagValues(rest, "--check"),
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
  if (sub === "approve") {
    const id = args[1];
    const requestedLane = parseFlagValue(args.slice(2), "--lane", undefined);
    if (!id) {
      console.error("usage: hii board approve <task-id-prefix> [--lane next|doing]");
      process.exit(1);
    }
    const proposal = boardTasks({ includeDone: true }).find((task) => task.id.startsWith(id));
    const task = updateBoardTask(id, {
      lane: requestedLane || proposal?.requestedLane || "next",
      reviewState: "approved",
      approvedBy: "local operator"
    });
    console.log(`approved ${task.id.slice(0, 8)} -> ${task.lane}`);
    console.log(task.title);
    return;
  }
  if (sub === "dedupe") {
    const dryRun = args.includes("--dry-run");
    const reconciled = dedupeBoardTasks({ dryRun });
    console.log("HII board deduplication\n");
    console.log(`mode:       ${dryRun ? "dry-run" : "append-only"}`);
    console.log(`duplicates: ${reconciled.length}`);
    for (const item of reconciled) {
      console.log(`  ${item.duplicate.id.slice(0, 8)} -> done; keep ${item.keep.id.slice(0, 8)}  ${item.keep.title}`);
    }
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
      console.error("usage: hii board edit <task-id-prefix> [--title outcome] [--priority high] [--owner name] [--coordinate path] [--notes text] [--check criterion] [--tags a,b]");
      process.exit(1);
    }
    const task = updateBoardTask(id, {
      title: parseFlagValue(rest, "--title", undefined),
      priority: parseFlagValue(rest, "--priority", undefined),
      owner: parseFlagValue(rest, "--owner", undefined),
      coordinate: parseFlagValue(rest, "--coordinate", undefined),
      notes: parseFlagValue(rest, "--notes", undefined),
      acceptanceCriteria: parseFlagValues(rest, "--check").length
        ? parseFlagValues(rest, "--check")
        : undefined,
      tags: parseFlagValue(rest, "--tags", undefined)
    });
    console.log(`updated ${task.id.slice(0, 8)}  ${task.title}`);
    return;
  }
  console.error("usage: hii board [list|add|move|approve|done|edit|dedupe]");
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
  if (args[0] === "cancel") {
    cmdJobsCancel(args.slice(1));
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

function cmdJobsCancel(args) {
  const idOrPrefix = args[0];
  const reason = redactText(parseFlagValue(args, "--reason", "")).trim();
  if (!idOrPrefix || !reason) {
    console.error("usage: hii jobs cancel <job-id-prefix> --reason <reason>");
    process.exit(1);
  }
  const matches = localCapabilityJobsLatest().filter((job) => String(job.id).startsWith(idOrPrefix));
  if (matches.length !== 1) {
    console.error(matches.length === 0 ? `job not found: ${idOrPrefix}` : `job id is ambiguous: ${idOrPrefix}`);
    process.exit(1);
  }
  const job = matches[0];
  if (["completed", "failed", "cancelled"].includes(String(job.status))) {
    console.error(`job is already terminal: ${job.id} ${job.status}`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  const entry = {
    ...job,
    status: "cancelled",
    updatedAt: now,
    logs: [
      ...(Array.isArray(job.logs) ? job.logs : []),
      `[${now}] cancelled by local operator: ${reason}`
    ],
    ledger: [
      ...(Array.isArray(job.ledger) ? job.ledger : []),
      {
        id: randomUUID(),
        jobId: job.id,
        capabilityId: job.capabilityId,
        actor: "hii",
        type: "reconciliation",
        summary: `Cancelled stale local job: ${reason}`,
        createdAt: now
      }
    ],
    proofArtifacts: [
      ...(Array.isArray(job.proofArtifacts) ? job.proofArtifacts : []),
      {
        id: randomUUID(),
        kind: "log",
        label: "Local cancellation receipt",
        summary: reason,
        createdAt: now
      }
    ],
    metadata: {
      ...(job.metadata ?? {}),
      cancelledAt: now,
      cancelledBy: "local-operator",
      cancellationReason: reason
    }
  };
  appendJsonl(LOCAL_CAPABILITY_JOBS, entry);
  console.log(`cancelled ${job.id}`);
  console.log(`reason: ${reason}`);
  console.log(`store:  ${LOCAL_CAPABILITY_JOBS}`);
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
    "- Prefer local-first workflows, HII, Codex, Claude Code, Ollama, HII Rhino, web intelligence, small business services, and packaged digital outputs when relevant.",
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
        branch: git.branch
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
      path: out
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

function cmdChat(args = []) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("hii chat requires an interactive terminal; use `hii now --json` for scripts");
    process.exit(1);
  }
  const result = spawnSync(process.execPath, [HII_TUI, ...args], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
  });
  process.exit(result.status ?? 1);
}

// The command line is HII's fastest control surface.  It deliberately speaks in
// HII primitives (intent, context, bounded work, proof, receipt), rather than
// pretending an agent shell is the product.
const GLYPH = {
  mark: "◈",
  ready: "●",
  active: "◐",
  waiting: "○",
  proof: "✓",
  warning: "!",
  arrow: "→",
  rule: "─"
};

function terminalWidth() {
  return Math.max(56, Math.min(Number(process.stdout.columns) || 88, 112));
}

function line(label = "") {
  console.log(`${GLYPH.rule.repeat(terminalWidth() - 2)}${label ? ` ${label}` : ""}`);
}

function shortId(value) {
  return String(value || "").slice(0, 8) || "—";
}

function cliSnapshot() {
  const git = gitSnapshot();
  const tasks = boardTasks({ includeDone: false });
  const jobs = recentLocalCapabilityJobs(8);
  const running = jobs.filter((job) => ["queued", "pending", "running"].includes(String(job.status).toLowerCase()));
  const verified = jobs.filter((job) => String(job.status).toLowerCase() === "completed");
  const next = tasks.find((task) => task.lane === "doing") || tasks.find((task) => task.lane === "next") || tasks.find((task) => task.lane === "backlog");
  return { git, tasks, jobs, running, verified, next };
}

function compactTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    title: task.title,
    lane: task.lane,
    priority: task.priority,
    owner: task.owner,
    coordinate: task.coordinate,
    updatedAt: task.updatedAt
  };
}

function compactJob(job) {
  return {
    id: job.id,
    capabilityId: job.capabilityId,
    status: job.status,
    summary: redactText(job.inputSummary || "").replace(/\s+/g, " ").slice(0, 180),
    proofCount: Array.isArray(job.proofArtifacts) ? job.proofArtifacts.length : 0,
    updatedAt: job.updatedAt || job.createdAt || null
  };
}

function compactWorktree(worktree) {
  return {
    clean: worktree.clean,
    counts: worktree.counts,
    files: Array.isArray(worktree.files)
      ? worktree.files.slice(0, 12).map(({ path: filePath, index, worktree: state }) => ({
          path: filePath,
          index,
          worktree: state
        }))
      : []
  };
}

function cmdNow(args = []) {
  const snapshot = cliSnapshot();
  if (args.includes("--json")) {
    const full = args.includes("--full");
    console.log(JSON.stringify({
      schemaVersion: full ? 1 : 2,
      kind: "hii.cli.snapshot",
      generatedAt: new Date().toISOString(),
      repo: ROOT,
      runtime: RUNTIME,
      git: full ? snapshot.git.worktree : compactWorktree(snapshot.git.worktree),
      tasks: full ? snapshot.tasks : snapshot.tasks.slice(0, 12).map(compactTask),
      activeJobs: full ? snapshot.running : snapshot.running.map(compactJob),
      recentVerifiedJobs: full
        ? snapshot.verified.slice(0, 4)
        : snapshot.verified.slice(0, 4).map(compactJob),
      next: full ? (snapshot.next ?? null) : compactTask(snapshot.next)
    }, null, 2));
    return;
  }

  console.log(`\n${GLYPH.mark}  HII  /  HUMAN INFORMATION INTERFACE`);
  console.log("   intent → bounded work → proof → receipt");
  line();
  console.log(`${snapshot.git.worktree.clean ? GLYPH.ready : GLYPH.warning}  WORKSPACE  ${snapshot.git.branch}  ${snapshot.git.worktree.clean ? "clean" : `${snapshot.git.worktree.counts.total} changes need review`}`);
  console.log(`${snapshot.running.length ? GLYPH.active : GLYPH.waiting}  AGENTS     ${snapshot.running.length ? `${snapshot.running.length} active` : "no active bounded work"}  ·  ${snapshot.verified.length} verified receipts`);
  console.log(`${GLYPH.proof}  PROOF      ${snapshot.jobs.length ? `${snapshot.jobs.length} recent job receipts` : "none yet"}`);
  line(" NOW ");
  if (snapshot.next) {
    const state = snapshot.next.lane === "doing" ? "IN PROGRESS" : "READY";
    console.log(`${GLYPH.arrow}  ${state}  ${snapshot.next.title}`);
    console.log(`   ${shortId(snapshot.next.id)}  ·  ${snapshot.next.owner}  ·  ${snapshot.next.coordinate}`);
    if (snapshot.next.notes) console.log(`   ${snapshot.next.notes.slice(0, terminalWidth() - 6)}`);
  } else {
    console.log(`${GLYPH.arrow}  No bounded task selected.`);
    console.log("   Start one: hii task <intent>");
  }
  line(" COMMANDS ");
  console.log("  hii task <intent>       capture intent as a bounded local task");
  console.log("  hii work                 inspect the active work queue and receipts");
  console.log("  hii proof [receipt-id]   inspect proof before trusting completion");
  console.log("  hii codex run <prompt>   queue a managed local Codex run");
  console.log("  hii help                 command map and safety boundary\n");
}

function cmdTask(args) {
  const rest = args.slice();
  const title = withoutFlags(rest, ["--owner", "--coordinate", "--priority", "--notes", "--check", "--tags"]).join(" ").trim();
  if (!title) {
    console.error("usage: hii task <intent> [--owner name] [--coordinate path] [--priority low|normal|high|urgent] [--notes text] [--check criterion] [--tags a,b]");
    process.exit(1);
  }
  const task = createBoardTask({
    title,
    lane: "next",
    priority: parseFlagValue(rest, "--priority", "normal"),
    owner: parseFlagValue(rest, "--owner", "operator"),
    coordinate: parseFlagValue(rest, "--coordinate", ROOT),
    notes: parseFlagValue(rest, "--notes", "Intent captured through HII CLI. Define acceptance proof before execution."),
    acceptanceCriteria: parseFlagValues(rest, "--check"),
    tags: parseFlagValue(rest, "--tags", "")
  });
  logBridge({ type: "intent-captured", taskId: task.id, title: task.title, coordinate: task.coordinate });
  console.log(`\n${GLYPH.mark}  INTENT CAPTURED`);
  line();
  console.log(`${GLYPH.arrow}  ${task.title}`);
  console.log(`   task: ${shortId(task.id)}  ·  lane: next  ·  owner: ${task.owner}`);
  console.log(`   coordinate: ${task.coordinate}`);
  console.log(`\nNext: hii board move ${shortId(task.id)} doing`);
  console.log("Proof gate: record a receipt with `hii skill report` after verification.\n");
}

function cmdWork(args = []) {
  const snapshot = cliSnapshot();
  const activeLanes = ["next", "doing", "blocked"];
  if (args.includes("--brief")) {
    console.log(JSON.stringify({
      kind: "hii.agent.work.brief",
      tasks: snapshot.tasks
        .filter((task) => activeLanes.includes(task.lane))
        .map((task) => ({ id: shortId(task.id), lane: task.lane, priority: task.priority, title: task.title })),
      jobs: snapshot.running.map((job) => ({ id: shortId(job.id), capabilityId: job.capabilityId, status: job.status }))
    }));
    return;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify({ activeTasks: snapshot.tasks.filter((task) => ["next", "doing", "blocked"].includes(task.lane)), activeJobs: snapshot.running }, null, 2));
    return;
  }
  console.log(`\n${GLYPH.mark}  HII WORK QUEUE`);
  line();
  const tasks = snapshot.tasks.filter((task) => ["next", "doing", "blocked"].includes(task.lane));
  if (!tasks.length) console.log("○  No active tasks. Capture an intent with `hii task <intent>`.");
  for (const task of tasks) {
    const icon = task.lane === "doing" ? GLYPH.active : task.lane === "blocked" ? GLYPH.warning : GLYPH.ready;
    console.log(`${icon}  ${task.lane.toUpperCase().padEnd(7)} ${shortId(task.id)}  ${task.title}`);
    console.log(`   ${task.owner}  ·  ${task.coordinate}`);
  }
  if (snapshot.running.length) {
    line(" AGENTS ");
    for (const job of snapshot.running) console.log(`${GLYPH.active}  ${shortId(job.id)}  ${job.capabilityId || "unknown capability"}  ${job.status}`);
  }
  console.log("\nInspect evidence: hii proof\n");
}

function cmdProof(args = []) {
  const requested = args[0];
  const jobs = recentLocalCapabilityJobs(20);
  const matches = requested ? jobs.filter((job) => String(job.id).startsWith(requested)) : jobs;
  console.log(`\n${GLYPH.mark}  HII PROOF LEDGER`);
  line();
  if (!matches.length) {
    console.log("○  No matching receipts. A task is not verified until it has inspectable proof.");
    return;
  }
  for (const job of matches.slice(0, requested ? 20 : 8)) {
    const verified = String(job.status).toLowerCase() === "completed";
    console.log(`${verified ? GLYPH.proof : GLYPH.warning}  ${shortId(job.id)}  ${job.status || "unknown"}  ${job.capabilityId || "unknown capability"}`);
    console.log(`   proof: ${(job.proofArtifacts || []).length}  ·  ledger: ${(job.ledger || []).length}  ·  ${job.createdAt || "unknown time"}`);
    for (const artifact of (job.proofArtifacts || []).slice(0, 3)) console.log(`   ${GLYPH.arrow}  ${artifact.label || artifact.kind || "artifact"}${artifact.path ? `  ${artifact.path}` : ""}`);
  }
  console.log("\nCompletion is a claim; proof is the receipt.\n");
}

async function cmdAgents(args = []) {
  if (args[0] === "workspace") { const {runWorkspaceCommand}=await import("../runtime/agents/workspace.mjs"); await runWorkspaceCommand(args.slice(1)); return; }
  if (["sync","sessions","session","runs","events","stop"].includes(args[0])) {
    const {registryCommand}=await import("../runtime/agents/registry.mjs");
    console.log(JSON.stringify(await registryCommand(args),null,2)); return;
  }
  const sub = args.find((arg) => !arg.startsWith("-")) || "status";
  if (["send", "inbox", "ack", "thread"].includes(sub)) {
    console.log(JSON.stringify(mailboxCommand(args), null, 2));
    return;
  }
  const guide = [
    "Use HII as the local home for meaningful work on this Mac.",
    "1. Start with `hii home --json`; use its live workspace, work, and capability coordinates before broader discovery.",
    "2. Deepen only as needed with `hii context --json`, `hii work --json`, `hii caps show`, or `hii og status`.",
    "3. Search before reading. Query registries and configuration with targeted `hii`, `rg`, or `jq` commands instead of injecting whole index or config files into model context.",
    "4. Keep human intent and local changes visible. Verify work, inspect `hii proof`, and preserve unclear concurrent work.",
    "5. Set `HII_AGENT_ID` to your agent name. Read pending handoffs with `hii agents inbox --for <agent>`; send task, workspace, context references, and receipt ids with `hii agents send`, then acknowledge incorporated messages.",
    "6. `hii ship` may validate and commit locally. Follow the active user authority for external actions."
  ];
  const adapters = [
    { agent: "codex", path: path.join(os.homedir(), "AGENTS.md") },
    { agent: "claude", path: path.join(os.homedir(), ".claude", "CLAUDE.md") },
    { agent: "gemini", path: path.join(os.homedir(), ".gemini", "GEMINI.md") },
    { agent: "hermes", path: path.join(os.homedir(), ".hermes", "config.yaml") }
  ].map((adapter) => ({
    ...adapter,
    configured: fs.existsSync(adapter.path) && fs.readFileSync(adapter.path, "utf8").includes("hii home --json")
  }));
  if (sub === "guide") {
    if (args.includes("--json")) {
      console.log(JSON.stringify({ schemaVersion: 1, kind: "hii.agent.guide", guide, adapters }, null, 2));
    } else {
      console.log(guide.join("\n"));
    }
    return;
  }
  if (sub !== "status") {
    console.error("usage: hii agents [status|guide|send|inbox|ack|thread] [--json]");
    process.exit(1);
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify({ schemaVersion: 1, kind: "hii.agent.adapters", adapters }, null, 2));
    return;
  }
  console.log("HII agent adapters\n");
  for (const adapter of adapters) {
    console.log(`${adapter.configured ? GLYPH.ready : GLYPH.warning}  ${adapter.agent.padEnd(8)} ${adapter.path}`);
  }
  console.log("\nCanonical guide: hii agents guide");
}

function cmdHelp(topic) {
  const inventory = buildInventory({ live: false });
  if (topic === "--all") {
    console.log(renderHelp(inventory, { all: true }));
    return;
  }
  if (topic) {
    const route = inventory.commands.find((item) => item.name === topic);
    const entries = agentCommandCatalog().filter((item) =>
      item.command === `hii ${topic}` || item.command.startsWith(`hii ${topic} `)
    );
    console.log(`\n${GLYPH.mark}  HII ${topic.toUpperCase()}\n`);
    if (route) console.log(`  ${route.description} · ${route.implementation} · ${route.state}\n`);
    if (entries.length) {
      for (const item of entries) {
        console.log(`  ${item.command}`);
        console.log(`      ${item.purpose}`);
      }
    } else {
      console.log(`  Usage: hii ${topic} [options]`);
      console.log("  Run `hii help` for the complete command map.");
    }
    return;
  }
  console.log(renderHelp(inventory));
}

function cmdKnowledge(args) {
  const sub = args[0] || "status";
  if (sub === "check") {
    const result = spawnSync("npm", ["run", "hii:knowledge:check"], { cwd: ROOT, stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
  const url = "http://localhost:3000/knowledge";
  const database = path.join(RUNTIME, "hii.db");
  if (sub === "open" || args.includes("--open")) {
    spawnSync("open", [url], { stdio: "inherit" });
    return;
  }
  if (sub !== "status") {
    console.error("usage: hii knowledge [status|open|check]");
    process.exit(1);
  }
  const count = fs.existsSync(database)
    ? spawnSync("sqlite3", [database, "SELECT COUNT(*) FROM knowledge_notes WHERE deleted_at IS NULL;"], { encoding: "utf8" })
    : null;
  console.log("HII Knowledge Workspace\n");
  console.log(`ui:       ${url}`);
  console.log("authority: HII canonical local knowledge");
  console.log(`database: ${database}`);
  console.log(`exists:   ${fs.existsSync(database) ? "yes" : "not initialized"}`);
  console.log(`notes:    ${count?.status === 0 ? count.stdout.trim() : "-"}`);
  console.log("Approved source vaults are imported without mutation; portable export remains available.");
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
    const msg = { id: randomUUID(), ts: new Date().toISOString(), from: "hii", to: "codex", body };
    const file = path.join(BRIDGE_DIR, `${msg.ts.replace(/[:.]/g, "-")}-hii.json`);
    fs.writeFileSync(file, `${JSON.stringify(msg, null, 2)}\n`);
    logBridge({ type: "message", to: "codex", file, body });
    console.log(`sent → ${file}`);
  } else if (sub === "log" || sub === "read") {
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
  const sub = args[0] || "status";
  if (sub === "threads") {
    const r = spawnSync(process.execPath, [CODEX_THREADS, ...args.slice(1)], { cwd: ROOT, stdio: "inherit", env: process.env });
    process.exit(r.status ?? 1);
  }
  if (sub === "schema" && args[1] === "pin") {
    const r = spawnSync(process.execPath, [CODEX_SCHEMA_PIN], { cwd: ROOT, stdio: "inherit", env: process.env });
    process.exit(r.status ?? 1);
  }
  if (sub === "app-server-probe") {
    const r = spawnSync(process.execPath, [CODEX_APP_SERVER_PROBE], { cwd: ROOT, stdio: "inherit", env: process.env });
    process.exit(r.status ?? 1);
  }
  if (["run", "enqueue", "status", "logs", "stop", "app-server"].includes(sub)) {
    const r = spawnSync(process.execPath, [HIID, "codex", ...args], { cwd: ROOT, stdio: "inherit", env: process.env });
    process.exit(r.status ?? 1);
  }
  const prompt = args.join(" ");
  if (!prompt) { console.error("usage: hii codex run <prompt>"); process.exit(1); }
  logBridge({ type: "codex-queued", prompt });
  const r = spawnSync(process.execPath, [HIID, "codex", "run", prompt], { cwd: ROOT, stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}

function cmdDaemon(args) {
  const sub = args[0] || "status";
  const aliases = {
    on: "start",
    enable: "start",
    start: "start",
    off: "stop",
    disable: "stop",
    stop: "stop",
    restart: "restart",
    status: "status",
    logs: "logs",
    feed: "feed",
    instances: "instances",
    runs: "runs"
  };
  const mapped = aliases[sub];
  if (!mapped) {
    console.error("usage: hii daemon <start|stop|restart|status|feed|logs|instances|runs>");
    process.exit(1);
  }
  nodeScript(HIID, [mapped, ...args.slice(1)]);
}

function cmdFeed(args) {
  nodeScript(HIID, ["feed", ...(args.length ? args : ["30"])]);
}

function cmdInstances(args) {
  const sub = args[0] || "list";
  if (!["list", "show"].includes(sub)) {
    console.error("usage: hii instances list");
    process.exit(1);
  }
  nodeScript(HIID, ["instances"]);
}

function cmdCheck() {
  const r = spawnSync("npx", ["tsc", "--noEmit"], { cwd: ROOT, stdio: "inherit" });
  return r.status === 0;
}

function refreshReadmeState() {
  const script = path.join(ROOT, "scripts", "hii-readme-state.mjs");
  const result = spawnSync(process.execPath, [script, "--write"], {
    cwd: ROOT,
    env: { ...process.env, HII_ROOT: ROOT },
    stdio: "inherit"
  });
  return result.status === 0;
}

function runnerUsage() {
  console.error("usage: hii model <field|plan|recommend|discover|search|install|installed|use|status|start|stop|models|bench|logs|remove>");
}

async function cmdRunner(args) {
  const sub = args[0];
  if (sub === "model") {
    nodeScript(HIID, ["model-runtime", ...(args.slice(1).length ? args.slice(1) : ["status"])]);
    return;
  }
  if (["doctor", "status", "models", "bench", "stop", "logs"].includes(sub)) {
    nodeScript(HIID, ["model-runtime", sub, ...args.slice(1)]);
    return;
  }
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

      if (job.capability_id !== "hii.rhino.managed_job") {
        throw new Error(`No whitelisted handler for ${job.capability_id}`);
      }

      const started = `Runner claimed HII Rhino job ${job.id}: ${job.input_summary}`;
      console.log(started);
      await runnerFetch(`/api/runners/jobs/${job.id}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: [
            { actor: "agent", text: started },
            { actor: "operator", text: "HII Rhino execution is operator-reviewed and whitelisted to hii.rhino.managed_job." }
          ]
        })
      });

      let request;
      try {
        request = JSON.parse(job.input_summary);
      } catch {
        request = null;
      }
      const allowed = new Set(["status", "command", "script", "grasshopper"]);
      const action = typeof request?.action === "string" ? request.action : "";
      const value = typeof request?.value === "string" ? request.value : "";
      if (!allowed.has(action) || (action !== "status" && !value)) {
        throw new Error(`HII Rhino job ${job.id} requires JSON input_summary {"action":"status|command|script|grasshopper","value":"..."}`);
      }
      const invocation = [path.join(ROOT, "scripts", "hii-rhino.mjs"), action, ...(action === "status" ? [] : [value])];
      const execution = spawnSync(process.execPath, invocation, { cwd: ROOT, encoding: "utf8", env: process.env });
      const output = [execution.stdout, execution.stderr].filter(Boolean).join("\n").trim();
      if (execution.error || execution.status !== 0) {
        throw new Error(`HII Rhino execution failed (${execution.status ?? "spawn"}): ${execution.error?.message ?? output}`);
      }
      const summary = `HII Rhino completed ${action} through RhinoCode.`;
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
              label: "HII Rhino runner log",
              summary: output || summary
            }
          ],
          transcript: [{ actor: "agent", text: output || summary }]
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
  if (!refreshReadmeState()) { console.error("ship aborted: README state refresh failed"); process.exit(1); }
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
if (cmd && !["help", "--help", "-h"].includes(cmd) && rest.some((arg) => arg === "--help" || arg === "-h")) {
  cmdHelp(cmd);
  process.exit(0);
}

// Commands whose handler reads flags only and ignores every positional argument.
// `hii context list` used to print the agent context and exit 0, so a typo produced
// plausible output for a command the user never ran. Silence is worse than an error.
const FLAG_ONLY_COMMANDS = new Set([
  "home",
  "context",
  "agent-context",
  "probe",
  "health"
]);

if (FLAG_ONLY_COMMANDS.has(cmd)) {
  const stray = rest.find((arg) => !arg.startsWith("-"));
  if (stray !== undefined) {
    console.error(`hii ${cmd}: unexpected argument \`${stray}\``);
    console.error(`\`hii ${cmd}\` takes options only. Run \`hii ${cmd} --help\` to see them.`);
    process.exit(1);
  }
}
switch (cmd) {
  case undefined:
    if (process.stdin.isTTY && process.stdout.isTTY) cmdChat(rest);
    else cmdNow(rest);
    break;
  case "chat":
    cmdChat(rest);
    break;
  case "now":
    cmdNow(rest);
    break;
  case "help":
  case "--help":
  case "-h":
    cmdHelp(rest[0]);
    break;
  case "inventory": {
    const inventory = buildInventory();
    console.log(rest.includes("--markdown") ? renderDocs(inventory) : JSON.stringify(inventory, null, 2));
    break;
  }
  case "archive":
    console.log(JSON.stringify(await archiveCommand(rest), null, 2));
    break;
  case "task":
  case "capture":
    cmdTask(rest);
    break;
  case "work":
    cmdWork(rest);
    break;
  case "proof":
  case "receipt":
    cmdProof(rest);
    break;
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
    cmdCaps(rest);
    break;
  case "sdk": cmdSdk(rest); break;
  case "home": cmdHome(rest); break;
  case "agents": await cmdAgents(rest); break;
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
  case "daemon": cmdDaemon(rest); break;
  case "instances": cmdInstances(rest); break;
  case "feed": cmdFeed(rest); break;
  case "platform":
    nodeScript(HIID, ["model-runtime", "platform", ...rest]);
    break;
  case "image":
    nodeScript(path.join(ROOT, "runtime", "image-generation", "comfy.mjs"), rest);
    break;
  case "model":
    if (rest.includes("--help") || rest.includes("-h")) cmdHelp("model");
    else nodeScript(HIID, ["model-runtime", ...(rest.length ? rest : ["recommend"])]);
    break;
  case "ui": {
    if (rest.includes("--help") || rest.includes("-h")) {
      cmdHelp("ui");
      break;
    }
    const surface = rest[0];
    const action = rest.slice(1);
    const operation = surface === "web"
      ? cmdWeb(action)
      : surface === "app" || surface === "desktop"
        ? Promise.resolve(cmdApp(action))
        : Promise.reject(new Error("usage: hii ui <web|app> <open|start|status|logs|stop>"));
    operation.catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
    break;
  }
  case "app":
    try { cmdApp(rest); } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    break;
  case "open":
    if (rest.includes("--help") || rest.includes("-h")) {
      cmdHelp("open");
      break;
    }
    cmdOpen(rest).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
    break;
  case "slash":
    if (rest.includes("--help") || rest.includes("-h")) {
      cmdHelp("slash");
      break;
    }
    try { cmdSlash(rest); } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    break;
  case "space": {
    const { cmdSpace } = await import("./hii-space.mjs");
    process.exit(cmdSpace(rest));
  }
  case "git-map": {
    const { cmdGitMap } = await import("./hii-git-map.mjs");
    try { cmdGitMap(rest); } catch (error) {
      console.error(`hii git-map: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    break;
  }
  case "rhino": {
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "hii-rhino.mjs"), ...rest], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit"
    });
    process.exit(result.status ?? 1);
  }
  case "board": cmdBoard(rest); break;
  case "money": cmdMoney(rest); break;
  case "links": cmdLinks(rest); break;
  case "pack": cmdPack(rest); break;
  case "knowledge": cmdKnowledge(rest); break;
  case "skill":
  case "skills":
    try {
      runSkillCommand(rest);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    break;
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
  case "object":
  case "objects": {
    // The governed object interface. Agents reach objects only through here:
    // never Workspace JSON, never the graph mutation API directly.
    const { cmdObject } = await import("./hii-object.mjs");
    await cmdObject(rest).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
    break;
  }
  case "bridge": cmdBridge(rest); break;
  case "codex": cmdCodex(rest); break;
  case "legacy":
    console.error(`HII is now a single current surface at ${ROOT}. Migrate needed legacy behavior into the current repo instead of running ~/hii-old.`);
    process.exit(1);
  default:
    console.log(`HII — Human Information Interface

usage: hii <command>

  chat                open the full-screen conversational HII terminal
  now [--json]        compact control-plane snapshot; add --full for receipts
  console [--open]    show or open the local HII console
  terminal [--open]   compatibility alias for the local HII console
  health [--text]     compatibility alias for status
  home [--json]       compact agent landing snapshot (best first command)
  agents [status|guide]
                      show installed instruction adapters or the shared guide
  context [--json]    full repo/runtime/capability context
  probe [--json]      full worktree probe + stale-runtime warnings
  status              env + git + codex snapshot
  doctor              status + registry doctor
  caps [show]         list backend-owned capabilities
  caps validate       validate registry, jobs, proof kinds, and API/CLI parity
  sdk status          run SDK contract smoke checks
  jobs [n]            list recent local capability jobs
  jobs reconcile      reconcile local HII agent jobs from Claude state
  jobs cancel <id>    append cancellation receipt; requires --reason
  og [capture <msg>]  infer the operational graph and likely next path
  loop once [prompt]  propose next plan; waits for y/n before acting
  loop status         show latest user-proxy plan and notes
  loop note <note>    add steering context (tab path in UI)
  loop decide yes|no  approve or reject latest plan
  daemon start        start hiid, the HII instance supervisor
  daemon stop         stop hiid
  daemon status       show hiid health, autonomy, and instance count
  daemon feed         show recent daemon actions
  instances list      list daemon instances and observed processes
  feed [n]            show the HII live action feed
  space health        inspect the deterministic macOS workspace layer
  space snapshot      show monitors, workspaces, and windows
  space apps          list visible desktop applications
  git-map             2D terminal map of commit topology and time
  git-map diff <n>    inspect a numbered commit; add --patch for full diff
  board               show local kanban/todo board
  board add <title>   create a task with lane/priority/owner/coordinate
  board move <id> <lane>
  board approve <id>   approve a generated proposal into active work
                      move a task to backlog|next|doing|blocked|done
  board dedupe        archive duplicate open cards; add --dry-run to preview
  money idea <idea>   turn a rough idea into a local offer brief
  money list [n]      list recent idea-to-offer receipts
  money show <id>     show a saved offer brief
  links status        show browser link stream and cache coordinates
  links cache         cache browser links and summarize with Ollama
  links publish       push local link posts to the public stream (umminuriddingreen.com)
  pack list           list compartmentalized capability packs
  pack show <id>      show pack routes, files, caps, and checks
  pack export <id>    write local-only pack manifest
  knowledge [status]  show the local knowledge workspace coordinate
  knowledge open      open /knowledge in the browser
  knowledge check     run the isolated SQLite knowledge lifecycle smoke test
  skill report        append an agent-action receipt; --repeatable creates a draft
  skill create <id>   create or update a draft skill bundle
  skill register <id> promote a proof-backed draft after operator review
  skill list [--all]  list registered skills and optionally drafts
  skill search <query> search the active skill catalog
  skill show <id>     show a registered skill or draft
  skill export <id>   create a portable local .hii-skill.json package
  skill doctor        validate registry, bundles, receipts, and legacy count
  runner init <name>  register an owned runner and print its token once
  runner start --once claim one whitelisted runner job and exit
  platform [--json]    detect OS, architecture, model format, and runtime
  model [recommend]    compare platform-compatible choices for this machine
  model field          inventory configured, installed, ready, hosted, and remote model rails
  model plan           produce a bounded read-only spin-up plan; never changes runtime state
  model discover       find local runtimes, weights, presets, and endpoints
  model search <query> discover compatible MLX or GGUF models
  model install <id>  download and verify a model in HII's private cache
  model installed     list models installed for HII
  model use <id|alias> activate an installed model and update Pi
  model status|models inspect the active HII backend
  model bench|logs    benchmark or inspect the active backend
  model start|stop    control the HII-owned model runtime
  model remove <id>   preview removal; add --yes to apply
  rhino status        inspect Rhino/RhinoCode; also command, script, grasshopper
  open app            launch the installed HII desktop app
  open web            start and open HII's local web instance
  open site           open the configured canonical HII website
  ui app status       inspect the installed desktop app
  ui web start|status control or inspect the local web instance
  ui web logs|stop    inspect logs or stop the CLI-owned web instance
  check               typecheck (the inner fix loop)
  ship [message]      typecheck -> local commit only
  ship --push [msg]   explicit external push to origin
  dev|build|start     run the Next.js app
  registry <sub>      scan | doctor | export
  bridge send <msg>   message Codex via ~/.hii/bridge/messages
  bridge log|read [n] tail ~/.hii/bridge/codex.jsonl
  bridge inbox [n]    list recent bridge messages
  codex run <prompt>  queue a managed HII Codex run through hiid
  codex status        list managed HII Codex runs
  codex logs <id>     show a managed HII Codex run log
  codex app-server-probe
                      verify HII can initialize Codex app-server
  codex app-server <start|status|logs|stop>
                      manage the HII-owned Codex app-server
  codex schema pin    generate the versioned Codex v2 protocol contract
  codex threads [--limit n] [--cwd path] [--search text] [--json]
                      list Codex threads through the read-only app-server path
  mcp                 serve HII tools and the canonical canvas over stdio`);
    process.exit(cmd ? 1 : 0);
}
