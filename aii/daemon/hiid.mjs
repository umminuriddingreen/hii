#!/usr/bin/env node
// hiid — HII's local-first persistent runtime supervisor.
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = path.join(os.homedir(), "hii");
const RUNTIME = process.env.HII_RUNTIME_DIR || path.join(os.homedir(), ".hii");
const DAEMON_DIR = path.join(RUNTIME, "daemon");
const RUNS_DIR = path.join(DAEMON_DIR, "runs");
const EVENTS = path.join(DAEMON_DIR, "events.jsonl");
const ACTIONS = path.join(DAEMON_DIR, "actions.jsonl");
const INSTANCES = path.join(DAEMON_DIR, "instances.json");
const STATUS = path.join(DAEMON_DIR, "status.json");
const PID = path.join(DAEMON_DIR, "daemon.pid");
const LOG = path.join(DAEMON_DIR, "daemon.log");
const VOICE_STATUS = path.join(RUNTIME, "voice", "status.json");
const VOICE_PID = path.join(RUNTIME, "voice", "daemon.pid");
const CODEX_INDEX = path.join(RUNTIME, "codex", "index.json");

const OWNED_PATTERNS = [
  `${ROOT}/aii/daemon/hiid.mjs`,
  `${ROOT}/scripts/hii-voice-daemon.mjs`,
  `${ROOT}/server.mjs`,
  `${ROOT}/node_modules/.bin/next`,
  "codex exec"
];

const activeRuns = new Map();

// AII owns the capability registry (aii/capabilities/registry.json) and
// publishes it to the shared runtime substrate; HII reads the published copy.
const CAPABILITY_SOURCE = path.join(ROOT, "aii", "capabilities", "registry.json");
const CAPABILITY_PUBLISHED = path.join(RUNTIME, "capabilities.json");
let publishedCapabilityMtime = 0;

// HII surface configuration — the configuration-authority side of
// docs/aii-hii-boundary.md. AII owns ~/.hii/config.json; HII surfaces read it
// and render accordingly. `hiid config set` is how AII (or the operator)
// reshapes HII without touching HII code.
const HII_CONFIG = path.join(RUNTIME, "config.json");

const DEFAULT_CONFIG = {
  version: 1,
  updatedAt: null,
  updatedBy: "aii.hiid",
  defaults: { homepage: "canvas" },
  surfaces: {
    canvas: { enabled: true },
    terminal: { enabled: true, defaultCwd: "~" },
    boards: { enabled: true },
    feed: { enabled: true }
  },
  agentNotes: []
};

function ensureConfig() {
  if (fs.existsSync(HII_CONFIG)) return;
  writeJson(HII_CONFIG, { ...DEFAULT_CONFIG, updatedAt: now() });
  event("config.initialized", {
    actor: "hii.daemon",
    target: HII_CONFIG,
    status: "ok",
    text: "Wrote default HII surface config"
  });
}

function cmdConfig(args) {
  const sub = args[0];
  const config = safeReadJson(HII_CONFIG, { ...DEFAULT_CONFIG });
  if (!sub || sub === "show") {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (sub === "get") {
    const value = args[1]?.split(".").reduce((cur, key) => cur?.[key], config);
    console.log(JSON.stringify(value ?? null, null, 2));
    return;
  }
  if (sub === "set") {
    const dotPath = args[1];
    const raw = args.slice(2).join(" ");
    if (!dotPath || !raw) throw new Error("usage: hiid config set <dot.path> <json-value>");
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw; // treat unparseable input as a plain string
    }
    const keys = dotPath.split(".");
    let cursor = config;
    for (const key of keys.slice(0, -1)) {
      if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[keys[keys.length - 1]] = value;
    config.updatedAt = now();
    config.updatedBy = "aii.hiid";
    writeJson(HII_CONFIG, config);
    event("config.updated", {
      actor: "hii.daemon",
      target: dotPath,
      status: "ok",
      text: `HII config ${dotPath} = ${JSON.stringify(value)}`
    });
    console.log(`set ${dotPath} = ${JSON.stringify(value)}`);
    return;
  }
  throw new Error("usage: hiid config <show|get <path>|set <path> <value>>");
}

// Agent-spawn intents: HII surfaces append intents to INTENTS; the daemon is
// the only thing that actually executes agent spawns (docs/aii-hii-boundary.md).
// Job progress is reported by appending updated records (same id, last wins)
// to HII's capability job ledger.
const INTENTS = path.join(DAEMON_DIR, "intents.jsonl");
const INTENTS_CURSOR = path.join(DAEMON_DIR, "intents.cursor.json");
const CAPABILITY_JOBS = path.join(ROOT, ".hii", "capability-jobs.jsonl");
const CLAUDE_BIN = "/opt/homebrew/bin/claude";

function cleanSessionName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const SPAWN_PRESETS = {
  observer: [
    "You are a read-only HII observer agent.",
    "Watch the local HII/AII/Termite workstation state and report actionable status.",
    "Do not edit files, do not touch secrets, do not push or commit."
  ],
  shipper: [
    "You are a bounded HII shipping agent.",
    "Improve the HII product surface only when the requested scope is clear.",
    "Do not delete or revert user work. Do not touch secrets. Verify with npm run build when editing HII."
  ],
  "termite-demo": [
    "You are a Termite demo operator for HII.",
    "Prepare or monitor a Rhino/Termite alpha demo and report exact blockers and proof artifacts.",
    "Do not edit files unless explicitly asked. Do not touch secrets."
  ]
};

const AGENT_REPORTING = [
  "After meaningful work, record a structured after-work receipt with `hii skill report`.",
  "Mark repeatable verified work with `--repeatable` to create a draft skill candidate; do not register, publish, sell, or license it yourself."
];

function presetPrompt(preset, prompt) {
  const base = String(prompt || "").trim();
  const framing = SPAWN_PRESETS[preset];
  return framing ? [...framing, ...AGENT_REPORTING, base].filter(Boolean).join("\n\n") : [...AGENT_REPORTING, base].filter(Boolean).join("\n\n");
}

function reportSpawnJob(intent, { status, output, startedAt }) {
  const ts = now();
  const job = {
    id: intent.id,
    capabilityId: "hii.agent.spawn",
    inputSummary: `${intent.preset}: ${String(intent.prompt).slice(0, 240)}`,
    userId: "local",
    userEmail: null,
    status,
    budget: "local-operator",
    logs: [`[${startedAt}] intent ${intent.id} → ${status}`, output || "spawn request accepted"],
    ledger: [
      {
        id: randomUUID(),
        jobId: intent.id,
        capabilityId: "hii.agent.spawn",
        actor: "aii.hiid",
        type: "approval",
        summary: `hiid executed spawn intent (preset ${intent.preset}).`,
        createdAt: ts
      }
    ],
    proofArtifacts: [
      {
        id: randomUUID(),
        kind: "log",
        label: "Spawn receipt",
        summary: output || "Claude session spawn request accepted.",
        createdAt: ts
      }
    ],
    createdAt: intent.requestedAt || startedAt,
    updatedAt: ts,
    metadata: { preset: intent.preset, name: intent.name }
  };
  appendJsonl(CAPABILITY_JOBS, job);
}

function executeSpawnIntent(intent) {
  const preset = Object.hasOwn(SPAWN_PRESETS, intent.preset) || intent.preset === "custom" ? intent.preset : "observer";
  const prompt = presetPrompt(preset, intent.prompt).slice(0, 12000);
  const name = cleanSessionName(intent.name || `hii-${preset}-${Date.now().toString(36)}`);
  const startedAt = now();
  const args = [
    prompt,
    "--bg",
    "--safe-mode",
    "--model",
    "claude-fable-5",
    "--name",
    name,
    "--permission-mode",
    preset === "observer" ? "default" : "auto"
  ];
  execFile(CLAUDE_BIN, args, { cwd: ROOT, timeout: 15000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
    const output = redact(`${stdout ?? ""}${stderr ?? ""}`.trim());
    if (error) {
      reportSpawnJob({ ...intent, preset, name }, { status: "failed", output: output || String(error.message), startedAt });
      event("agent.spawn.failed", { actor: "hii.daemon", target: name, status: "failed", text: output || String(error.message) });
      return;
    }
    reportSpawnJob({ ...intent, preset, name }, { status: "running", output, startedAt });
    event("agent.spawned", { actor: "hii.daemon", target: name, status: "running", text: `Spawned ${name} from intent ${intent.id}` });
  });
}

function processSpawnIntents() {
  let lines;
  try {
    lines = fs.readFileSync(INTENTS, "utf8").split("\n").filter(Boolean);
  } catch {
    return;
  }
  const cursor = safeReadJson(INTENTS_CURSOR, null);
  // First run: skip history rather than replaying old intents.
  const processed = cursor && Number.isInteger(cursor.processed) ? cursor.processed : lines.length;
  if (lines.length <= processed) {
    if (!cursor) writeJson(INTENTS_CURSOR, { processed });
    return;
  }
  for (const line of lines.slice(processed)) {
    let intent;
    try {
      intent = JSON.parse(line);
    } catch {
      continue;
    }
    if (intent?.kind === "agent.spawn" && intent.id) executeSpawnIntent(intent);
  }
  writeJson(INTENTS_CURSOR, { processed: lines.length });
}

function publishCapabilities() {
  let mtime;
  try {
    mtime = fs.statSync(CAPABILITY_SOURCE).mtimeMs;
  } catch {
    return; // no source registry on this machine
  }
  if (mtime === publishedCapabilityMtime) return;
  const registry = safeReadJson(CAPABILITY_SOURCE, null);
  if (!Array.isArray(registry)) return;
  writeJson(CAPABILITY_PUBLISHED, registry);
  publishedCapabilityMtime = mtime;
  event("capabilities.published", {
    actor: "hii.daemon",
    target: CAPABILITY_PUBLISHED,
    status: "ok",
    text: `Published ${registry.length} capabilities from AII registry`
  });
}

function ensureDirs() {
  fs.mkdirSync(DAEMON_DIR, { recursive: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(CODEX_INDEX), { recursive: true });
}

function now() {
  return new Date().toISOString();
}

function safeReadJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function safeReadJsonl(file) {
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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function redact(value) {
  return String(value ?? "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)=)([^\s]+)/gi, "$1[redacted]")
    .replace(/((?:OPENAI|ANTHROPIC|SUPABASE|STRIPE|GITHUB|VERCEL|CLOUDFLARE|AWS)[A-Z0-9_]*=)([^\s]+)/g, "$1[redacted]")
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, "$1[redacted]")
    .replace(/(--(?:api-key|token|secret|password|auth|key)\s+)([^\s]+)/gi, "$1[redacted]")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[redacted]")
    .slice(0, 1200);
}

function event(type, patch = {}) {
  const entry = {
    id: randomUUID(),
    ts: now(),
    source: "hiid",
    type,
    ...patch
  };
  appendJsonl(EVENTS, entry);
  if (type === "action") appendJsonl(ACTIONS, entry);
  return entry;
}

function codexBin() {
  const pinned = path.join(os.homedir(), ".local", "bin", "codex");
  return fs.existsSync(pinned) ? pinned : "codex";
}

function pidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EPERM") return true;
    return false;
  }
}

function runningDaemonPids() {
  const r = spawnSync("ps", ["auxww"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0) return [];
  return r.stdout
    .split("\n")
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11 || parts[0] === "USER") return null;
      const pid = Number(parts[1]);
      const command = parts.slice(10).join(" ");
      if (pid === process.pid) return null;
      if (!command.includes("scripts/hiid.mjs run")) return null;
      return pid;
    })
    .filter(Boolean);
}

function currentDaemonPid() {
  const pid = Number(fs.existsSync(PID) ? fs.readFileSync(PID, "utf8").trim() : "");
  if (pidAlive(pid)) return pid;
  return runningDaemonPids()[0] ?? null;
}

function parseProcessLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("USER ")) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 11) return null;
  const command = redact(parts.slice(10).join(" "));
  const owned = OWNED_PATTERNS.some((pattern) => command.includes(pattern));
  const relevant = owned || /claude|codex|hii|aii|termite|ollama|rhino|node.*next|python.*hii/i.test(command);
  if (!relevant) return null;
  return {
    id: `process:${parts[1]}`,
    type: "process",
    pid: Number(parts[1]),
    title: command.split(/\s+/).slice(0, 4).join(" "),
    command,
    cpu: parts[2],
    mem: parts[3],
    status: "running",
    owned,
    autonomy: owned ? "reversible-local" : "observe-only",
    heartbeatAt: now()
  };
}

function discoverProcesses() {
  const r = spawnSync("ps", ["auxww"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").map(parseProcessLine).filter(Boolean).slice(0, 80);
}

function voiceInstance() {
  const status = safeReadJson(VOICE_STATUS, {});
  const pid = Number(fs.existsSync(VOICE_PID) ? fs.readFileSync(VOICE_PID, "utf8").trim() : "");
  const alive = Boolean(status?.alive) || pidAlive(pid);
  return {
    id: "voice:hii",
    type: "voice",
    title: "HII Voice",
    pid: alive && pid ? pid : null,
    status: alive ? "running" : "stopped",
    owned: true,
    autonomy: "reversible-local",
    model: status?.status?.model ?? status?.model ?? "local",
    heartbeatAt: status?.status?.updatedAt ?? status?.updatedAt ?? null
  };
}

function runFiles() {
  try {
    return fs.readdirSync(RUNS_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(RUNS_DIR, name));
  } catch {
    return [];
  }
}

function readRuns() {
  return runFiles()
    .map((file) => safeReadJson(file, null))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

function writeRun(run) {
  writeJson(path.join(RUNS_DIR, `${run.id}.json`), run);
  writeJson(CODEX_INDEX, {
    updatedAt: now(),
    runs: readRuns().slice(0, 100).map((item) => ({
      id: item.id,
      status: item.status,
      prompt: item.prompt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      exitCode: item.exitCode ?? null,
      log: item.log
    }))
  });
}

function codexInstances() {
  return readRuns().slice(0, 12).map((run) => ({
    id: `codex:${run.id}`,
    type: "codex-run",
    title: run.title || run.prompt?.slice(0, 72) || "Codex run",
    pid: run.pid ?? null,
    status: run.status,
    owned: true,
    autonomy: "reversible-local",
    coordinate: run.coordinate || ROOT,
    heartbeatAt: run.updatedAt,
    runId: run.id
  }));
}

function instanceSnapshot() {
  const processInstances = discoverProcesses();
  const instances = [
    {
      id: "daemon:hiid",
      type: "agent",
      title: "hiid",
      pid: process.pid,
      status: "running",
      owned: true,
      autonomy: "reversible-local",
      heartbeatAt: now(),
      coordinate: DAEMON_DIR
    },
    voiceInstance(),
    ...codexInstances(),
    ...processInstances.filter((item) => item.pid !== process.pid)
  ];
  return instances;
}

function writeStatus(state = "running") {
  const instances = instanceSnapshot();
  writeJson(INSTANCES, { updatedAt: now(), instances });
  const active = instances.filter((item) => item.status === "running").length;
  const blocked = instances.filter((item) => item.status === "blocked" || item.status === "failed").length;
  const queued = readRuns().filter((run) => run.status === "queued").length;
  const status = {
    schemaVersion: 1,
    state,
    pid: process.pid,
    root: ROOT,
    runtime: DAEMON_DIR,
    updatedAt: now(),
    autonomy: "reversible-local",
    policy: {
      autonomous: [
        "read local files and process state",
        "run checks and probes",
        "start or restart HII-owned services",
        "edit local workspace files for assigned tasks",
        "write memories, skill proposals, events, and receipts"
      ],
      approvalRequired: [
        "delete, reset, or destructive cleanup",
        "publish, push, deploy, email, or post",
        "spend money or change billing",
        "print or export secrets",
        "control non-HII system services"
      ]
    },
    counts: {
      instances: instances.length,
      active,
      blocked,
      queued,
      events: safeReadJsonl(EVENTS).length
    }
  };
  writeJson(STATUS, status);
  return status;
}

function enqueueCodex(prompt, options = {}) {
  ensureDirs();
  const cleanPrompt = redact(prompt).trim();
  if (!cleanPrompt) throw new Error("Codex prompt required.");
  const id = `codex-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const run = {
    id,
    kind: "codex-run",
    status: "queued",
    prompt: cleanPrompt,
    title: options.title || cleanPrompt.slice(0, 90),
    coordinate: options.cwd || ROOT,
    createdAt: now(),
    updatedAt: now(),
    autonomy: "reversible-local",
    loop: ["observed request", "queued managed Codex run"],
    log: path.join(RUNS_DIR, `${id}.log`)
  };
  writeRun(run);
  event("codex.queued", {
    actor: "hii.daemon",
    target: id,
    status: "queued",
    text: `Queued HII Codex run: ${run.title}`,
    loop: "observed -> queued -> waiting"
  });
  return run;
}

function startQueuedRuns() {
  const queued = readRuns().filter((run) => run.status === "queued").slice(0, 1);
  for (const run of queued) {
    if (activeRuns.has(run.id)) continue;
    const logFd = fs.openSync(run.log, "a");
    const child = spawn(codexBin(), ["exec", "--cd", run.coordinate || ROOT, run.prompt], {
      cwd: run.coordinate || ROOT,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, HII_DAEMON_RUN_ID: run.id }
    });
    activeRuns.set(run.id, child);
    const running = {
      ...run,
      status: "running",
      pid: child.pid,
      startedAt: now(),
      updatedAt: now(),
      loop: [...(run.loop || []), "started backend execution"]
    };
    writeRun(running);
    event("codex.started", {
      actor: "hii.daemon",
      target: run.id,
      status: "running",
      pid: child.pid,
      text: `Started HII Codex run ${run.id}`,
      loop: "observed -> decided -> acted"
    });
    child.on("close", (code) => {
      activeRuns.delete(run.id);
      fs.closeSync(logFd);
      const previous = safeReadJson(path.join(RUNS_DIR, `${run.id}.json`), running);
      const done = {
        ...previous,
        status: code === 0 ? "completed" : "failed",
        exitCode: code,
        pid: null,
        completedAt: now(),
        updatedAt: now(),
        loop: [...(previous.loop || []), code === 0 ? "verified completion" : "recorded failure"]
      };
      writeRun(done);
      event(code === 0 ? "codex.completed" : "codex.failed", {
        actor: "hii.daemon",
        target: run.id,
        status: done.status,
        exitCode: code,
        text: `${done.status}: HII Codex run ${run.id}`,
        loop: "observed -> decided -> acted -> verified -> next"
      });
    });
  }
}

function stopRun(id) {
  const child = activeRuns.get(id);
  if (child) child.kill("SIGTERM");
  const run = safeReadJson(path.join(RUNS_DIR, `${id}.json`), null);
  if (run) {
    writeRun({ ...run, status: "stopped", pid: null, updatedAt: now(), completedAt: now() });
    event("codex.stopped", { actor: "hii.daemon", target: id, status: "stopped", text: `Stopped HII Codex run ${id}` });
  }
}

function runLoop() {
  ensureDirs();
  fs.writeFileSync(PID, String(process.pid));
  event("daemon.started", {
    actor: "hii.daemon",
    target: "hiid",
    status: "running",
    text: "hiid started; autonomy is reversible-local",
    loop: "observed -> decided -> acted -> next"
  });
  writeStatus("running");
  ensureConfig();
  publishCapabilities();
  setInterval(() => {
    try {
      publishCapabilities();
      processSpawnIntents();
      startQueuedRuns();
      writeStatus("running");
    } catch (error) {
      event("daemon.error", {
        actor: "hii.daemon",
        target: "hiid",
        status: "failed",
        text: error instanceof Error ? error.message : String(error)
      });
    }
  }, 3000);
}

function startDaemon() {
  ensureDirs();
  const existing = currentDaemonPid();
  if (existing) {
    fs.writeFileSync(PID, String(existing));
    console.log(`hiid already running pid=${existing}`);
    return;
  }
  const out = fs.openSync(LOG, "a");
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "run"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env
  });
  child.unref();
  fs.writeFileSync(PID, String(child.pid));
  event("daemon.spawned", { actor: "hii.cli", target: "hiid", status: "starting", pid: child.pid, text: "Spawned hiid" });
  console.log(`started hiid pid=${child.pid}`);
}

function stopDaemon() {
  const pids = Array.from(new Set([currentDaemonPid(), ...runningDaemonPids()].filter(Boolean)));
  if (pids.length === 0) {
    console.log("hiid is not running");
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      event("daemon.stopped", { actor: "hii.cli", target: "hiid", status: "stopped", pid, text: "Stopped hiid" });
      console.log(`stopped hiid pid=${pid}`);
    } catch {
      /* already gone */
    }
  }
}

function printStatus() {
  const pid = currentDaemonPid();
  const status = safeReadJson(STATUS, {});
  const instances = safeReadJson(INSTANCES, { instances: [] }).instances || [];
  console.log(`hiid:      ${pid ? "running" : "stopped"}`);
  if (pid) console.log(`pid:       ${pid}`);
  console.log(`runtime:   ${DAEMON_DIR}`);
  console.log(`updated:   ${status.updatedAt || "never"}`);
  console.log(`autonomy:  ${status.autonomy || "reversible-local"}`);
  console.log(`instances: ${instances.length}`);
  console.log(`events:    ${safeReadJsonl(EVENTS).length}`);
}

function printFeed(limit = 20) {
  for (const entry of safeReadJsonl(EVENTS).slice(-limit)) {
    console.log(`${entry.ts} ${entry.type} ${entry.status || ""} ${entry.text || ""}`.trim());
  }
}

function followFeed(limit = 20) {
  let seen = safeReadJsonl(EVENTS).length;
  printFeed(limit);
  setInterval(() => {
    const events = safeReadJsonl(EVENTS);
    for (const entry of events.slice(seen)) {
      console.log(`${entry.ts} ${entry.type} ${entry.status || ""} ${entry.text || ""}`.trim());
    }
    seen = events.length;
  }, 1000);
}

function printInstances() {
  const instances = safeReadJson(INSTANCES, { instances: [] }).instances || [];
  for (const item of instances) {
    const pid = item.pid ? ` pid=${item.pid}` : "";
    const owned = item.owned ? "owned" : "observed";
    console.log(`${item.id} ${item.status}${pid} ${owned} ${item.title || ""}`.trim());
  }
}

function printRuns(limit = 20) {
  for (const run of readRuns().slice(0, limit)) {
    console.log(`${run.id} ${run.status} ${run.exitCode ?? ""} ${run.title || run.prompt}`.trim());
  }
}

function tailFile(file, lines = 80) {
  if (!fs.existsSync(file)) {
    console.log(`missing: ${file}`);
    return;
  }
  const text = fs.readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
  console.log(text);
}

process.on("SIGTERM", () => {
  try {
    writeStatus("stopped");
    event("daemon.exiting", { actor: "hii.daemon", target: "hiid", status: "stopped", text: "hiid exiting" });
  } finally {
    process.exit(0);
  }
});

const [cmd = "status", ...args] = process.argv.slice(2);
try {
  if (cmd === "run") runLoop();
  else if (cmd === "start" || cmd === "on") startDaemon();
  else if (cmd === "stop" || cmd === "off") stopDaemon();
  else if (cmd === "restart") {
    stopDaemon();
    setTimeout(startDaemon, 500);
  } else if (cmd === "status") printStatus();
  else if (cmd === "feed") {
    if (args.includes("--follow")) followFeed(Number(args.find((arg) => /^\d+$/.test(arg)) || 20));
    else printFeed(Number(args[0] || 20));
  }
  else if (cmd === "logs") tailFile(LOG, Number(args[0] || 80));
  else if (cmd === "config") cmdConfig(args);
  else if (cmd === "instances") printInstances();
  else if (cmd === "runs") printRuns(Number(args[0] || 20));
  else if (cmd === "codex") {
    const sub = args[0] || "status";
    if (sub === "run" || sub === "enqueue") {
      if (!currentDaemonPid()) startDaemon();
      const run = enqueueCodex(args.slice(1).join(" "));
      console.log(`queued ${run.id}`);
      console.log(`log ${run.log}`);
    } else if (sub === "status") {
      printRuns(Number(args[1] || 20));
    } else if (sub === "logs") {
      const id = args[1];
      if (!id) throw new Error("usage: hiid codex logs <run-id>");
      const run = safeReadJson(path.join(RUNS_DIR, `${id}.json`), null);
      tailFile(run?.log || path.join(RUNS_DIR, `${id}.log`), Number(args[2] || 120));
    } else if (sub === "stop") {
      const id = args[1];
      if (!id) throw new Error("usage: hiid codex stop <run-id>");
      stopRun(id);
    } else {
      throw new Error("usage: hiid codex <run|status|logs|stop>");
    }
  } else {
    throw new Error("usage: hiid <start|stop|restart|status|feed|logs|config|instances|runs|codex>");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
