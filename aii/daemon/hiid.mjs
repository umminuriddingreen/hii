#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1
// hiid — HII's local-first persistent runtime supervisor.
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  cleanupWorkspaceRunContext,
  stageWorkspaceRunContext
} from "./workspace-run-staging.mjs";
import {
  selectConsumerModelProfile,
  totalMemoryGiB
} from "../model-runtime/profiles.mjs";
import {
  buildCodexMemoryPack,
  codexExecInvocation
} from "./codex-memory.mjs";

const ROOT = process.env.HII_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME = process.env.HII_RUNTIME_DIR || path.join(os.homedir(), ".hii");
const DAEMON_DIR = path.join(RUNTIME, "daemon");
const RUNS_DIR = path.join(DAEMON_DIR, "runs");
const EVENTS = path.join(DAEMON_DIR, "events.jsonl");
const ACTIONS = path.join(DAEMON_DIR, "actions.jsonl");
const INSTANCES = path.join(DAEMON_DIR, "instances.json");
const STATUS = path.join(DAEMON_DIR, "status.json");
const PID = path.join(DAEMON_DIR, "daemon.pid");
const LOG = path.join(DAEMON_DIR, "daemon.log");
const CODEX_INDEX = path.join(RUNTIME, "codex", "index.json");
const CODEX_APP_SERVER_DIR = path.join(RUNTIME, "codex", "app-server");
const CODEX_APP_SERVER_PID = path.join(CODEX_APP_SERVER_DIR, "app-server.pid");
const CODEX_APP_SERVER_STATUS = path.join(CODEX_APP_SERVER_DIR, "status.json");
const CODEX_APP_SERVER_LOG = path.join(CODEX_APP_SERVER_DIR, "app-server.log");
const CODEX_APP_SERVER_SOCKET = path.join(CODEX_APP_SERVER_DIR, "app-server.sock");
const MODEL_RUNTIME_DIR = path.join(RUNTIME, "model-runtime");
const MODEL_RUNTIME_PID = path.join(MODEL_RUNTIME_DIR, "runner.pid");
const MODEL_RUNTIME_STATUS = path.join(MODEL_RUNTIME_DIR, "status.json");
const MODEL_RUNTIME_LOG = path.join(MODEL_RUNTIME_DIR, "runner.log");
const MODEL_BENCHMARKS = path.join(MODEL_RUNTIME_DIR, "benchmarks.json");
const MODEL_RUNTIME_URL = "http://127.0.0.1:11435";
const MODEL_HOME = path.join(RUNTIME, "models");
const HF_CACHE = path.join(MODEL_HOME, "huggingface", "hub");
const MODEL_PROFILES = path.join(ROOT, "config", "native-model-profiles.json");
const MODEL_PREFERENCE = path.join(RUNTIME, "config", "model.json");
const CONTEXT_DB = path.join(RUNTIME, "hii.db");
const OWNED_PATTERNS = [
  `${ROOT}/aii/daemon/hiid.mjs`,
  `${ROOT}/server.mjs`,
  `${ROOT}/node_modules/.bin/next`,
  "codex exec"
];

const activeRuns = new Map();
const activeWorkspaceRuns = new Map();
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
const LEGACY_SPATIAL_KEY = ["can", "vas"].join("");

const DEFAULT_CONFIG = {
  version: 2,
  updatedAt: null,
  updatedBy: "aii.hiid",
  defaults: { homepage: "workspace" },
  surfaces: {
    workspace: { enabled: true },
    terminal: { enabled: true, defaultCwd: "~" },
    boards: { enabled: true },
    feed: { enabled: true }
  },
  agentNotes: []
};

function migrateConfig(config) {
  let changed = false;
  if (!config.defaults || typeof config.defaults !== "object") {
    config.defaults = { ...DEFAULT_CONFIG.defaults };
    changed = true;
  }
  if (!config.surfaces || typeof config.surfaces !== "object") {
    config.surfaces = { ...DEFAULT_CONFIG.surfaces };
    changed = true;
  }
  if (config.defaults.homepage === LEGACY_SPATIAL_KEY) {
    config.defaults.homepage = "workspace";
    changed = true;
  }
  if (config.surfaces[LEGACY_SPATIAL_KEY]) {
    if (!config.surfaces.workspace) config.surfaces.workspace = config.surfaces[LEGACY_SPATIAL_KEY];
    delete config.surfaces[LEGACY_SPATIAL_KEY];
    changed = true;
  }
  if (config.version !== DEFAULT_CONFIG.version) {
    config.version = DEFAULT_CONFIG.version;
    changed = true;
  }
  return changed;
}

function ensureConfig() {
  const exists = fs.existsSync(HII_CONFIG);
  const config = exists ? safeReadJson(HII_CONFIG, { ...DEFAULT_CONFIG }) : { ...DEFAULT_CONFIG };
  const changed = migrateConfig(config);
  if (exists && !changed) return;
  writeJson(HII_CONFIG, { ...config, updatedAt: now(), updatedBy: "aii.hiid" });
  event("config.initialized", {
    actor: "hii.daemon",
    target: HII_CONFIG,
    status: "ok",
    text: "Wrote default HII surface config"
  });
}

function cmdConfig(args) {
  ensureConfig();
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
const CAPABILITY_JOBS = path.join(RUNTIME, "capability-jobs.jsonl");
const CLAUDE_BIN = process.env.HII_CLAUDE_BIN || (process.platform === "win32" ? "claude" : "/opt/homebrew/bin/claude");
const HII_BIN = process.env.HII_WORKSPACE_RUNNER_BIN || (process.platform === "win32" ? "hii" : path.join(os.homedir(), "bin", "hii"));

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
  "partner-onboard": [
    "You are an agent working inside a design partner's own project folder.",
    "Stay strictly within the provided workspace folder and never touch files outside it.",
    "Never install anything, push, publish, or contact the network.",
    "Complete exactly the one bounded task given and verify the result before claiming completion."
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

function latestCapabilityJob(id) {
  return safeReadJsonl(CAPABILITY_JOBS).filter((job) => job?.id === id).at(-1) || null;
}

function findWorkspaceReceipt(intent, startedAt) {
  const receiptsRoot = path.join(RUNTIME, "runs", "cli");
  let candidates = [];
  try {
    candidates = fs.readdirSync(receiptsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(receiptsRoot, entry.name, "receipt.json"))
      .filter((file) => {
        try { return fs.statSync(file).mtimeMs >= Date.parse(startedAt) - 1000; } catch { return false; }
      });
  } catch { return null; }
  for (const file of candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)) {
    const receipt = safeReadJson(file, null);
    if (receipt?.goal === intent.goal && receipt?.workspace === intent.workspaceRoot) return { receipt, file };
  }
  return null;
}

/**
 * Read the receipt's completion assessment.
 *
 * The daemon used to decide completion itself: receipt status plus any passing
 * check. That was a second, weaker definition of the same word, so a run could
 * be failed by the CLI and completed here. The assessment in the receipt is now
 * the authority; this function reads it rather than re-deriving it.
 *
 * Receipts written before the assessment existed carry no `completion` field.
 * They stay readable and fall back to the old rule, but are marked `legacy` so
 * nothing treats them as stronger evidence than they hold.
 */
function receiptCompletion(receipt) {
  if (!receipt) {
    return { completed: false, legacy: false, proofStrength: "none", reasons: ["No receipt was produced for this run."] };
  }
  const assessment = receipt.completion;
  if (assessment && typeof assessment === "object") {
    const reasons = [
      ...(Array.isArray(assessment.unmetRequirements) ? assessment.unmetRequirements : []),
      ...(Array.isArray(assessment.failedChecks) ? assessment.failedChecks.map((check) => `Declared check failed: ${check}`) : []),
      ...(Array.isArray(assessment.missingArtifacts) ? assessment.missingArtifacts.map((path) => `Required artifact missing: ${path}`) : []),
      ...(Array.isArray(assessment.invalidArtifacts) ? assessment.invalidArtifacts.map((detail) => `Required artifact invalid: ${detail}`) : [])
    ];
    const completed = assessment.satisfied === true && receipt.status === "completed";
    if (assessment.satisfied === true && receipt.status !== "completed") {
      reasons.push(`Receipt status is ${receipt.status || "unknown"} despite a satisfied assessment.`);
    }
    return {
      completed,
      legacy: false,
      proofStrength: String(assessment.proofStrength || "none"),
      reasons: completed ? [] : (reasons.length ? reasons : ["The completion assessment was not satisfied."])
    };
  }
  const hasPassingCheck = Array.isArray(receipt.verification) && receipt.verification.some((check) => check?.ok === true);
  const completed = receipt.status === "completed" && hasPassingCheck;
  return {
    completed,
    legacy: true,
    proofStrength: "legacy",
    reasons: completed ? [] : [`Legacy receipt: status ${receipt.status || "unknown"}${hasPassingCheck ? "" : " with no passing verification"}.`]
  };
}

function reportWorkspaceJob(intent, { status, output, startedAt, receiptMatch = null, pid = null, completion = null }) {
  const ts = now();
  const previous = latestCapabilityJob(intent.id);
  const receipt = receiptMatch?.receipt || null;
  const proofArtifacts = [];
  if (receiptMatch?.file) {
    proofArtifacts.push({
      id: randomUUID(), kind: "receipt", label: "HII workspace receipt", path: receiptMatch.file,
      summary: redact(receipt?.summary || "Bounded workspace receipt."), createdAt: ts
    });
  }
  for (const check of Array.isArray(receipt?.verification) ? receipt.verification : []) {
    proofArtifacts.push({
      id: randomUUID(), kind: "log", label: `Verification · ${String(check.command || "check").slice(0, 120)}`,
      summary: redact(`${check.ok ? "passed" : "failed"}: ${check.output || ""}`), createdAt: ts
    });
  }
  const job = {
    id: intent.id,
    capabilityId: "hii.agent.workspace_run",
    inputSummary: String(intent.goal).slice(0, 240),
    userId: "local",
    userEmail: null,
    status,
    budget: `local · ${intent.maxSteps} steps`,
    logs: [...(previous?.logs || []), `[${ts}] ${redact(output || `workspace run ${status}`)}`].slice(-40),
    ledger: [
      ...(previous?.ledger || []),
      {
        id: randomUUID(), jobId: intent.id, capabilityId: "hii.agent.workspace_run", actor: "aii.hiid",
        type: status === "completed" ? "proof" : "reconciliation",
        summary: status === "running" ? "AII started the approved bounded run." : `AII recorded workspace run as ${status}.`,
        createdAt: ts
      }
    ],
    proofArtifacts: proofArtifacts.length ? proofArtifacts : (previous?.proofArtifacts || []),
    createdAt: previous?.createdAt || intent.requestedAt || startedAt,
    updatedAt: ts,
    metadata: {
      ...(previous?.metadata || {}), knowledgeRunId: intent.id, projectId: intent.projectId,
      workspaceRoot: intent.workspaceRoot, goal: intent.goal, context: intent.context || [],
      contextPreview: intent.contextPreview || previous?.metadata?.contextPreview || null,
      contextStaging: intent.contextStaging || previous?.metadata?.contextStaging || null,
      requestedBy: intent.requestedBy, model: intent.model, maxSteps: intent.maxSteps,
      pid: status === "running" ? pid : null,
      startedAt: previous?.metadata?.startedAt || startedAt,
      receiptId: receipt?.id || null,
      // Carried onto the job so every surface reads the same verdict and the
      // same reasons, rather than re-deriving completion from the receipt.
      completion: completion || previous?.metadata?.completion || null
    }
  };
  appendJsonl(CAPABILITY_JOBS, job);
  return job;
}

export function approvedSpawnCwd(requestedCwd) {
  let database;
  try {
    if (typeof requestedCwd !== "string" || !requestedCwd) {
      throw new Error("intent.cwd must be a non-empty string");
    }
    database = new DatabaseSync(CONTEXT_DB, { readOnly: true });
    const approved = database.prepare(`
      SELECT 1 AS approved
      FROM context_projects
      WHERE root_path = ? AND approved_root = 1 AND excluded = 0
      LIMIT 1
    `).get(requestedCwd);
    if (!approved) throw new Error("intent.cwd is not an approved context project root");
    return requestedCwd;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`hiid: rejected spawn cwd ${redact(requestedCwd)}; falling back to ${ROOT}: ${redact(reason)}`);
    return ROOT;
  } finally {
    try { database?.close(); } catch { /* read-only validation cleanup */ }
  }
}

function approvedWorkspaceCwd(requestedCwd) {
  if (typeof requestedCwd !== "string" || !requestedCwd) throw new Error("intent.workspaceRoot must be a non-empty string");
  let database;
  try {
    database = new DatabaseSync(CONTEXT_DB, { readOnly: true });
    const approved = database.prepare(`
      SELECT root_path AS rootPath
      FROM context_projects
      WHERE root_path = ? AND approved_root = 1 AND excluded = 0
      LIMIT 1
    `).get(requestedCwd);
    if (!approved?.rootPath) throw new Error("workspace root is not an approved Context Dock project");
    return approved.rootPath;
  } finally {
    try { database?.close(); } catch { /* read-only validation cleanup */ }
  }
}

function executeSpawnIntent(intent) {
  const preset = Object.hasOwn(SPAWN_PRESETS, intent.preset) || intent.preset === "custom" ? intent.preset : "observer";
  const prompt = presetPrompt(preset, intent.prompt).slice(0, 12000);
  const name = cleanSessionName(intent.name || `hii-${preset}-${Date.now().toString(36)}`);
  const startedAt = now();
  const spawnCwd = Object.hasOwn(intent, "cwd") ? approvedSpawnCwd(intent.cwd) : ROOT;
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
  execFile(CLAUDE_BIN, args, { cwd: spawnCwd, timeout: 15000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
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

function executeWorkspaceIntent(intent) {
  const startedAt = now();
  const maxSteps = Math.max(1, Math.min(24, Number(intent.maxSteps) || 8));
  const model = String(intent.model || "").trim();
  if (!model) {
    const output = "AII rejected a workspace run without an approved installed model.";
    reportWorkspaceJob(intent, { status: "failed", output, startedAt });
    event("workspace.run.failed", { actor: "aii.hiid", target: intent.id, status: "failed", text: output });
    return;
  }
  let workspaceRoot;
  try {
    workspaceRoot = approvedWorkspaceCwd(intent.workspaceRoot);
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);
    reportWorkspaceJob(intent, { status: "failed", output, startedAt });
    event("workspace.run.failed", { actor: "aii.hiid", target: intent.id, status: "failed", text: output });
    return;
  }
  const latest = latestCapabilityJob(intent.id);
  if (latest?.metadata?.cancelRequestedAt) {
    reportWorkspaceJob({ ...intent, workspaceRoot }, {
      status: "cancelled",
      output: "AII honoured cancellation before execution started.",
      startedAt
    });
    event("workspace.run.cancelled", {
      actor: "aii.hiid", target: intent.id, status: "cancelled",
      text: "Cancelled before bounded workspace execution started."
    });
    return;
  }
  let contextStaging;
  try {
    contextStaging = stageWorkspaceRunContext({
      runtimeRoot: RUNTIME,
      workspaceRoot,
      intentId: intent.id,
      contextPreview: intent.contextPreview
    });
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);
    reportWorkspaceJob({ ...intent, workspaceRoot }, { status: "failed", output, startedAt });
    event("workspace.run.failed", {
      actor: "aii.hiid", target: intent.id, status: "failed",
      text: "AII rejected local asset staging before bounded execution."
    });
    return;
  }
  const args = ["--cwd", workspaceRoot, "--model", model, "--max-steps", String(maxSteps), "run", String(intent.goal).slice(0, 16000)];
  const normalizedIntent = { ...intent, workspaceRoot, model, maxSteps, contextStaging };
  const child = execFile(HII_BIN, args, {
    cwd: workspaceRoot,
    timeout: 30 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024
  }, (error, stdout, stderr) => {
    activeWorkspaceRuns.delete(intent.id);
    const terminal = latestCapabilityJob(intent.id);
    let cleanedStaging;
    try {
      cleanedStaging = cleanupWorkspaceRunContext({
        workspaceRoot,
        intentId: intent.id,
        staging: normalizedIntent.contextStaging
      });
    } catch (cleanupError) {
      cleanedStaging = {
        ...normalizedIntent.contextStaging,
        cleanupStatus: "failed",
        cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      };
    }
    const terminalIntent = { ...normalizedIntent, contextStaging: cleanedStaging };
    if (terminal?.status === "cancelled") {
      reportWorkspaceJob(terminalIntent, {
        status: "cancelled",
        output: cleanedStaging.cleanupStatus === "removed" || cleanedStaging.cleanupStatus === "not-required"
          ? "AII stopped the bounded run and removed its disposable context copy."
          : `AII stopped the bounded run, but context cleanup needs attention: ${cleanedStaging.cleanupError || cleanedStaging.cleanupStatus}`,
        startedAt
      });
      return;
    }
    const output = redact(`${stdout ?? ""}${stderr ?? ""}`.trim());
    const receiptMatch = findWorkspaceReceipt(terminalIntent, startedAt);
    // One assessment, read from the receipt. The daemon presents it; it does not
    // apply a rule of its own.
    const completion = receiptCompletion(receiptMatch?.receipt || null);
    const cleanupPassed = ["removed", "not-required"].includes(cleanedStaging.cleanupStatus);
    const status = error || !completion.completed || !cleanupPassed ? "failed" : "completed";
    reportWorkspaceJob(terminalIntent, {
      status,
      output: !cleanupPassed
        ? `Context cleanup needs attention: ${cleanedStaging.cleanupError || cleanedStaging.cleanupStatus}`
        : !completion.completed
          // Say why, in the same words the receipt used, instead of a bare "failed".
          ? `Run did not meet its declared outcome. ${completion.reasons.join(" ")}`.trim()
          : output || receiptMatch?.receipt?.summary || (error ? String(error.message) : "Bounded workspace run finished."),
      startedAt,
      receiptMatch,
      completion
    });
    event(`workspace.run.${status}`, {
      actor: "aii.hiid", target: intent.id, status,
      text: receiptMatch?.receipt?.summary || output || `Workspace run ${status}`
    });
  });
  activeWorkspaceRuns.set(intent.id, { child, intent: normalizedIntent, startedAt });
  reportWorkspaceJob(normalizedIntent, {
    status: "running",
    output: "AII started the approved bounded workspace run.",
    startedAt,
    pid: child.pid
  });
  event("workspace.run.started", {
    actor: "aii.hiid", target: intent.id, status: "running", pid: child.pid,
    text: `Started approved bounded workspace run ${intent.id}.`
  });
}

function workspaceIntentFromJob(job) {
  const metadata = job?.metadata || {};
  return {
    kind: "workspace.run",
    id: job.id,
    capabilityId: "hii.agent.workspace_run",
    goal: String(metadata.goal || job.inputSummary || ""),
    workspaceRoot: String(metadata.workspaceRoot || ""),
    model: String(metadata.model || ""),
    maxSteps: Number(metadata.maxSteps) || 8,
    requestedAt: job.createdAt,
    requestedBy: String(metadata.requestedBy || "hii.workspace"),
    projectId: String(metadata.projectId || "hii-spatial-workspace"),
    context: Array.isArray(metadata.context) ? metadata.context : [],
    contextPreview: metadata.contextPreview || null,
    contextStaging: metadata.contextStaging || null
  };
}

function ownedWorkspacePid(pid, intent) {
  if (!pidAlive(pid)) return false;
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 64 * 1024
  });
  if (result.status !== 0) return false;
  const command = String(result.stdout || "");
  const runnerNames = [HII_BIN, path.basename(HII_BIN), "hii-cli.mjs"];
  return runnerNames.some((name) => name && command.includes(name))
    && command.includes("--cwd")
    && command.includes(String(intent.workspaceRoot));
}

function cancelWorkspaceIntent(intent) {
  const current = latestCapabilityJob(intent.id);
  if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return;
  const execution = activeWorkspaceRuns.get(intent.id);
  const runIntent = execution?.intent || workspaceIntentFromJob(current);
  const startedAt = String(current.metadata?.startedAt || current.createdAt || now());
  let stopped = false;
  if (execution?.child) {
    stopped = execution.child.kill("SIGTERM");
  } else {
    const pid = Number(current.metadata?.pid);
    if (ownedWorkspacePid(pid, runIntent)) {
      process.kill(pid, "SIGTERM");
      stopped = true;
    }
  }
  reportWorkspaceJob(runIntent, {
    status: "cancelled",
    output: stopped
      ? "AII stopped the bounded workspace run at the operator's request."
      : "AII cancelled the queued or no-longer-running workspace run.",
    startedAt
  });
  event("workspace.run.cancelled", {
    actor: "aii.hiid", target: intent.id, status: "cancelled",
    text: stopped
      ? "Stopped bounded local execution and recorded cancellation."
      : "Recorded cancellation; no owned local process remained."
  });
}

function reconcileWorkspaceRuns() {
  const latest = new Map();
  for (const job of safeReadJsonl(CAPABILITY_JOBS)) {
    if (job?.capabilityId === "hii.agent.workspace_run") latest.set(job.id, job);
  }
  for (const job of latest.values()) {
    if (
      ["completed", "failed", "cancelled"].includes(job.status)
      && !activeWorkspaceRuns.has(job.id)
      && job.metadata?.contextStaging?.preparedAt
      && !job.metadata.contextStaging.cleanupStatus
    ) {
      const terminalIntent = workspaceIntentFromJob(job);
      let cleanedStaging;
      try {
        cleanedStaging = cleanupWorkspaceRunContext({
          workspaceRoot: terminalIntent.workspaceRoot,
          intentId: terminalIntent.id,
          staging: terminalIntent.contextStaging
        });
      } catch (cleanupError) {
        cleanedStaging = {
          ...terminalIntent.contextStaging,
          cleanupStatus: "failed",
          cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        };
      }
      reportWorkspaceJob({ ...terminalIntent, contextStaging: cleanedStaging }, {
        status: job.status,
        output: ["removed", "not-required"].includes(cleanedStaging.cleanupStatus)
          ? "AII reconciled and removed the terminal run's disposable context copy."
          : `Terminal run context cleanup needs attention: ${cleanedStaging.cleanupError || cleanedStaging.cleanupStatus}`,
        startedAt: String(job.metadata?.startedAt || job.createdAt || now())
      });
      continue;
    }
    if (job.status !== "running" || activeWorkspaceRuns.has(job.id)) continue;
    const intent = workspaceIntentFromJob(job);
    const pid = Number(job.metadata?.pid);
    if (ownedWorkspacePid(pid, intent)) continue;
    const startedAt = String(job.metadata?.startedAt || job.createdAt || now());
    const receiptMatch = findWorkspaceReceipt(intent, startedAt);
    const completion = receiptCompletion(receiptMatch?.receipt || null);
    const verified = completion.completed;
    let cleanedStaging;
    try {
      cleanedStaging = cleanupWorkspaceRunContext({
        workspaceRoot: intent.workspaceRoot,
        intentId: intent.id,
        staging: intent.contextStaging
      });
    } catch (cleanupError) {
      cleanedStaging = {
        ...(intent.contextStaging || {}),
        cleanupStatus: "failed",
        cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      };
    }
    const cleanupPassed = ["removed", "not-required"].includes(cleanedStaging.cleanupStatus);
    const status = job.metadata?.cancelRequestedAt ? "cancelled" : verified && cleanupPassed ? "completed" : "failed";
    reportWorkspaceJob({ ...intent, contextStaging: cleanedStaging }, {
      status,
      output: verified && cleanupPassed
        ? "AII recovered a verified receipt after an interrupted daemon lifecycle."
        : status === "cancelled"
          ? "AII reconciled the interrupted run as cancelled."
          : !cleanupPassed
            ? `AII could not safely remove the interrupted run context: ${cleanedStaging.cleanupError || cleanedStaging.cleanupStatus}`
          : `AII found no owned process and no satisfied receipt after daemon interruption. ${completion.reasons.join(" ")}`.trim(),
      startedAt,
      receiptMatch,
      completion
    });
    event(`workspace.run.${status}`, {
      actor: "aii.hiid", target: job.id, status,
      text: status === "completed"
        ? "Recovered verified workspace receipt after daemon interruption."
        : `Reconciled interrupted workspace run as ${status}.`
    });
  }
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
    if (intent?.kind === "workspace.run" && intent.id) executeWorkspaceIntent(intent);
    if (intent?.kind === "workspace.cancel" && intent.id) cancelWorkspaceIntent(intent);
  }
  writeJson(INTENTS_CURSOR, { processed: lines.length });
}

function enqueueClaude(prompt, options = {}) {
  ensureDirs();
  const cleanPrompt = redact(prompt).trim();
  if (!cleanPrompt) throw new Error("Claude prompt required.");
  if (!fs.existsSync(INTENTS_CURSOR)) {
    writeJson(INTENTS_CURSOR, { processed: safeReadJsonl(INTENTS).length });
  }
  const id = `claude-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const intent = {
    id,
    kind: "agent.spawn",
    preset: options.preset || "custom",
    prompt: cleanPrompt,
    name: cleanSessionName(options.name || id),
    requestedAt: now(),
    requestedBy: "hii.cli"
  };
  appendJsonl(INTENTS, intent);
  event("agent.spawn.queued", {
    actor: "hii.cli",
    target: intent.name,
    status: "queued",
    text: `Queued managed Claude session ${intent.name}`
  });
  return intent;
}

function printClaudeSessions() {
  const result = spawnSync(CLAUDE_BIN, ["agents", "--json", "--all"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) throw new Error(redact(result.stderr || result.stdout || "Claude session query failed"));
  let sessions = [];
  try {
    const parsed = JSON.parse(result.stdout || "[]");
    sessions = Array.isArray(parsed) ? parsed : (parsed.sessions || parsed.agents || []);
  } catch {
    console.log(redact(result.stdout || "No Claude sessions."));
    return;
  }
  if (!sessions.length) {
    console.log("No Claude sessions.");
    return;
  }
  for (const session of sessions.slice(0, 30)) {
    const id = session.id || session.sessionId || session.name || "claude";
    const status = session.status || session.state || "observed";
    const title = session.name || session.title || session.prompt || "";
    console.log(`${id} ${status} ${String(title).slice(0, 100)}`.trim());
  }
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
  fs.mkdirSync(CODEX_APP_SERVER_DIR, { recursive: true });
  fs.mkdirSync(MODEL_RUNTIME_DIR, { recursive: true });
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

function appServerPid() {
  const pid = Number(fs.existsSync(CODEX_APP_SERVER_PID) ? fs.readFileSync(CODEX_APP_SERVER_PID, "utf8").trim() : "");
  return pidAlive(pid) ? pid : null;
}

function writeAppServerStatus(state, patch = {}) {
  const status = {
    schemaVersion: 1,
    state,
    pid: appServerPid(),
    socket: CODEX_APP_SERVER_SOCKET,
    log: CODEX_APP_SERVER_LOG,
    transport: "unix-websocket",
    updatedAt: now(),
    ...patch
  };
  writeJson(CODEX_APP_SERVER_STATUS, status);
  return status;
}

function startCodexAppServer() {
  ensureDirs();
  const existing = appServerPid();
  if (existing) {
    console.log(`Codex app-server already running pid=${existing}`);
    printCodexAppServerStatus();
    return;
  }
  if (fs.existsSync(CODEX_APP_SERVER_SOCKET)) fs.rmSync(CODEX_APP_SERVER_SOCKET, { force: true });
  const out = fs.openSync(CODEX_APP_SERVER_LOG, "a");
  const child = spawn(codexBin(), ["app-server", "--listen", `unix://${CODEX_APP_SERVER_SOCKET}`], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, LOG_FORMAT: "json" }
  });
  child.unref();
  fs.closeSync(out);
  fs.writeFileSync(CODEX_APP_SERVER_PID, String(child.pid));
  writeAppServerStatus("starting", { pid: child.pid, startedAt: now(), codex: codexBin() });
  event("codex.app_server.started", {
    actor: "hii.cli",
    target: CODEX_APP_SERVER_SOCKET,
    status: "starting",
    pid: child.pid,
    text: "Started HII-owned Codex app-server"
  });
  console.log(`started Codex app-server pid=${child.pid}`);
  console.log(`socket ${CODEX_APP_SERVER_SOCKET}`);
}

function printCodexAppServerStatus() {
  const pid = appServerPid();
  const previous = safeReadJson(CODEX_APP_SERVER_STATUS, {});
  const socketReady = Boolean(pid && fs.existsSync(CODEX_APP_SERVER_SOCKET));
  const status = writeAppServerStatus(socketReady ? "ready" : pid ? "starting" : "stopped", {
    ...previous,
    state: socketReady ? "ready" : pid ? "starting" : "stopped",
    pid,
    socketReady,
    updatedAt: now()
  });
  console.log(JSON.stringify(status, null, 2));
}

function stopCodexAppServer() {
  const pid = appServerPid();
  if (!pid) {
    writeAppServerStatus("stopped", { pid: null, socketReady: false });
    console.log("Codex app-server is not running");
    return;
  }
  process.kill(pid, "SIGTERM");
  writeAppServerStatus("stopped", { pid: null, socketReady: false, stoppedAt: now() });
  event("codex.app_server.stopped", {
    actor: "hii.cli",
    target: CODEX_APP_SERVER_SOCKET,
    status: "stopped",
    pid,
    text: "Stopped HII-owned Codex app-server"
  });
  console.log(`stopped Codex app-server pid=${pid}`);
}

function nativeRunnerBin() {
  const configured = process.env.HII_NATIVE_RUNNER_BIN;
  if (configured) return configured;
  const release = path.join(ROOT, "target", "release", "hii-native-runner");
  if (fs.existsSync(release)) return release;
  return path.join(ROOT, "target", "debug", "hii-native-runner");
}

function ensureHiiNativeEngine() {
  if (process.platform !== "darwin" || process.arch !== "arm64") return null;
  const runtimeRoot = path.join(RUNTIME, "runtimes", "mlx");
  const server = path.join(runtimeRoot, "bin", "mlx_vlm.server");
  if (fs.existsSync(server)) return server;
  const candidates = ["/opt/homebrew/bin/python3.12", "/opt/homebrew/bin/python3.13", "python3"];
  const python = candidates.find((candidate) => {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    return result.status === 0;
  });
  if (!python) throw new Error("HII Native needs Python 3.12+ to prepare its MLX engine.");
  console.log("Preparing HII Native's private Apple-Silicon runtime…");
  let result = spawnSync(python, ["-m", "venv", runtimeRoot], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("could not create HII Native's managed MLX environment");
  const pip = path.join(runtimeRoot, "bin", "python");
  result = spawnSync(pip, [
    "-m", "pip", "install", "--disable-pip-version-check",
    "mlx-vlm==0.6.17", "jinja2==3.1.6"
  ], {
    stdio: "inherit"
  });
  if (result.status !== 0 || !fs.existsSync(server)) {
    throw new Error("could not install HII Native's MLX-VLM engine");
  }
  return server;
}

function modelRuntimeProcess() {
  const recorded = Number(fs.existsSync(MODEL_RUNTIME_PID) ? fs.readFileSync(MODEL_RUNTIME_PID, "utf8").trim() : "");
  const observed = spawnSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" });
  if (observed.status !== 0) return null;
  const mlxServer = path.join(RUNTIME, "runtimes", "mlx", "bin", "mlx_vlm.server");
  const rows = observed.stdout.split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? { pid: Number(match[1]), pgid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
  const owned = rows.find((row) => row.pid === recorded
    && row.command.includes(path.basename(nativeRunnerBin())))
    || rows.find((row) => row.command.includes(mlxServer)
      && row.command.includes("--host 127.0.0.1")
      && row.command.includes("--port 11435"));
  if (owned && owned.pid !== recorded) fs.writeFileSync(MODEL_RUNTIME_PID, String(owned.pid));
  return owned || null;
}

function modelRuntimePid() {
  return modelRuntimeProcess()?.pid || null;
}

function consumerModelProfile(memoryGiB = totalMemoryGiB()) {
  return selectConsumerModelProfile(MODEL_PROFILES, memoryGiB);
}

function modelRuntimeStatus() {
  const pid = modelRuntimePid();
  const previous = safeReadJson(MODEL_RUNTIME_STATUS, {});
  const status = {
    schemaVersion: 1,
    ...previous,
    pid,
    endpoint: MODEL_RUNTIME_URL,
    backend: previous.backend || "hii-native",
    modelHome: path.join(RUNTIME, "models"),
    log: MODEL_RUNTIME_LOG,
    binary: nativeRunnerBin(),
    profile: consumerModelProfile(),
    state: pid ? (previous.state === "starting" ? "starting" : "running") : "stopped",
    updatedAt: now()
  };
  writeJson(MODEL_RUNTIME_STATUS, status);
  return status;
}

async function printModelRuntimeStatus() {
  const status = modelRuntimeStatus();
  const preference = safeReadJson(MODEL_PREFERENCE, {});
  const hosted = hostedModelCatalog().find((entry) => entry.provider === preference.provider);
  status.selection = preference.provider ? {
    provider: preference.provider,
    model: preference.model || null,
    endpoint: hosted?.endpoint || MODEL_RUNTIME_URL,
    externalTransmission: Boolean(hosted?.externalTransmission)
  } : {
    provider: "native",
    model: status.model || null,
    endpoint: MODEL_RUNTIME_URL,
    externalTransmission: false
  };
  if (status.pid) {
    try {
      const response = await fetch(`${MODEL_RUNTIME_URL}/health`, { signal: AbortSignal.timeout(500) });
      status.state = response.ok ? "ready" : "starting";
      if (response.ok) {
        const health = await response.json().catch(() => ({}));
        status.loadedModel = health.loaded_model || health.model || status.loadedModel || null;
      }
    } catch {
      status.state = "starting";
    }
    writeJson(MODEL_RUNTIME_STATUS, status);
  }
  console.log(JSON.stringify(status, null, 2));
}

function cliOption(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function requireHuggingFaceModel(value, command) {
  const model = String(value || "").trim();
  if (!/^[\w.-]+\/[\w./-]+$/.test(model)) {
    throw new Error(`usage: hii model ${command} <hugging-face-org/model>`);
  }
  return model;
}

function hf(args, options = {}) {
  const result = spawnSync("hf", args, { encoding: "utf8", ...options });
  if (result.error?.code === "ENOENT") {
    throw new Error("Hugging Face CLI is missing; install `hf` before managing HII Native models");
  }
  if (result.status !== 0) {
    if (options.stdio === "inherit") process.exitCode = result.status || 1;
    throw new Error((result.stderr || result.stdout || "Hugging Face command failed").trim());
  }
  return result;
}

function cachedModelPath(model) {
  return path.join(HF_CACHE, `models--${model.replaceAll("/", "--")}`);
}

function modelIsInstalled(model) {
  const root = cachedModelPath(model);
  return fs.existsSync(path.join(root, "refs")) || fs.existsSync(path.join(root, "snapshots"));
}

function modelSelectionCatalog() {
  const manifest = safeReadJson(MODEL_PROFILES, {});
  return Array.isArray(manifest.selectionCatalog) ? manifest.selectionCatalog : [];
}

function hostedModelCatalog() {
  const manifest = safeReadJson(MODEL_PROFILES, {});
  return Array.isArray(manifest.hostedCatalog) ? manifest.hostedCatalog : [];
}

function resolveHostedModelSelection(value) {
  const requested = String(value || "").trim().toLowerCase();
  return hostedModelCatalog().find((entry) =>
    entry.model.toLowerCase() === requested
      || entry.provider.toLowerCase() === requested
      || (entry.aliases || []).includes(requested)
  ) || null;
}

function saveModelPreference(provider, model) {
  writeJson(MODEL_PREFERENCE, { provider, model });
  return MODEL_PREFERENCE;
}

function resolveModelSelection(value, command) {
  const requested = String(value || "").trim();
  const selected = modelSelectionCatalog().find((entry) =>
    entry.model === requested || (entry.aliases || []).includes(requested.toLowerCase())
  );
  return requireHuggingFaceModel(selected?.model || requested, command);
}

function modelBenchmarkResults() {
  return safeReadJson(MODEL_BENCHMARKS, { schemaVersion: 1, results: {} });
}

function modelRecommendations() {
  const memoryGiB = totalMemoryGiB();
  const status = modelRuntimeStatus();
  const benchmarks = modelBenchmarkResults().results || {};
  return {
    schemaVersion: 1,
    objective: "utility-per-wait",
    advisoryOnly: true,
    hardware: {
      platform: process.platform,
      arch: process.arch,
      chip: os.cpus()[0]?.model || "unknown",
      memoryGiB
    },
    activeModel: status.pid ? status.model || null : null,
    choices: modelSelectionCatalog().map((entry, index) => {
      const benchmark = benchmarks[entry.model] || null;
      return {
        rank: index + 1,
        ...entry,
        fits: memoryGiB >= Number(entry.minimumMemoryGiB || 0),
        installed: modelIsInstalled(entry.model),
        active: Boolean(status.pid && status.model === entry.model),
        benchmark: benchmark ? {
          completionTokensPerSecond: benchmark.completionTokensPerSecond,
          throughputMeasured: benchmark.throughputMeasured,
          wallMs: benchmark.wallMs,
          measuredAt: benchmark.measuredAt
        } : null,
        commands: {
          install: `hii model install ${entry.aliases?.[0] || entry.model}`,
          use: `hii model use ${entry.aliases?.[0] || entry.model}`,
          benchmark: "hii model bench"
        }
      };
    }),
    hostedChoices: hostedModelCatalog().map((entry) => ({
      ...entry,
      active: safeReadJson(MODEL_PREFERENCE, {}).provider === entry.provider,
      commands: { use: `hii model use ${entry.aliases?.[0] || entry.model}` }
    }))
  };
}

function printModelRecommendations(args = []) {
  const report = modelRecommendations();
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`HII model guide — ${report.hardware.chip} · ${report.hardware.memoryGiB} GiB`);
  console.log("Optimized for utility per wait. Advisory only: nothing is downloaded or switched here.\n");
  for (const choice of report.choices) {
    const state = [
      choice.active ? "active" : null,
      choice.installed ? "installed" : "not installed",
      choice.fits ? "fits" : `needs ${choice.minimumMemoryGiB}+ GiB`
    ].filter(Boolean).join(" · ");
    const measured = choice.benchmark?.throughputMeasured
      ? ` · measured ${choice.benchmark.completionTokensPerSecond} tok/s`
      : choice.benchmark?.wallMs ? ` · smoke ${choice.benchmark.wallMs} ms` : "";
    console.log(`${choice.rank}. ${choice.role} [${(choice.aliases || [])[0] || choice.model}]`);
    console.log(`   ${choice.model}`);
    console.log(`   ${choice.bestFor}`);
    console.log(`   ${choice.speed} · ${choice.quality} · ~${choice.estimatedDiskGiB} GiB disk · ${(choice.capabilities || []).join(", ")}`);
    console.log(`   ${state}${measured}`);
    console.log(`   ${choice.installed ? "Use" : "Install"}: ${choice.installed ? choice.commands.use : choice.commands.install}\n`);
  }
  if (report.hostedChoices.length) {
    console.log("Explicit external models\n");
    for (const choice of report.hostedChoices) {
      console.log(`- ${choice.role} [${choice.aliases?.[0] || choice.model}]${choice.active ? " · active" : ""}`);
      console.log(`  ${choice.model} · ${(choice.capabilities || []).join(", ")}`);
      console.log(`  ${choice.bestFor}`);
      console.log(`  External transmission: explicit selection required`);
      console.log(`  Use: ${choice.commands.use}\n`);
    }
  }
  console.log("Explore more MLX models: hii model search <query>");
  console.log("Machine-readable view: hii model recommend --json");
}

function syncPiModel(model, makeDefault) {
  const piDir = path.join(os.homedir(), ".pi", "agent");
  const modelsPath = path.join(piDir, "models.json");
  const settingsPath = path.join(piDir, "settings.json");
  if (!fs.existsSync(piDir)) return { configured: false, reason: "Pi is not installed" };
  const config = safeReadJson(modelsPath, { providers: {} });
  config.providers ||= {};
  const provider = config.providers["hii-native"] ||= {
    api: "openai-completions",
    apiKey: "hii-local",
    baseUrl: `${MODEL_RUNTIME_URL}/v1`,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: []
  };
  provider.baseUrl = `${MODEL_RUNTIME_URL}/v1`;
  provider.models ||= [];
  if (!provider.models.some((entry) => entry.id === model)) {
    provider.models.push({
      id: model,
      name: `${model} (HII Native MLX)`,
      input: ["text"],
      reasoning: false,
      contextWindow: 262144,
      maxTokens: 16384
    });
  }
  writeJson(modelsPath, config);
  if (makeDefault) {
    const settings = safeReadJson(settingsPath, {});
    settings.defaultProvider = "hii-native";
    settings.defaultModel = model;
    writeJson(settingsPath, settings);
  }
  return { configured: true, provider: "hii-native", default: makeDefault };
}

function searchModels(args) {
  const query = args.filter((arg) => !arg.startsWith("--")).join(" ").trim();
  if (!query) throw new Error("usage: hii model search <query> [--all-authors]");
  // hf 1.0+ rejects --human-readable when listing model repositories. The
  // default table remains readable and compatible with the current Hub CLI.
  const command = ["models", "list", "--search", query, "--limit", "20"];
  if (!args.includes("--all-authors")) command.push("--author", "mlx-community");
  const result = hf(command);
  process.stdout.write(result.stdout);
}

function installModel(args) {
  const model = resolveModelSelection(args[0], "install");
  fs.mkdirSync(HF_CACHE, { recursive: true });
  hf(["download", model, "--cache-dir", HF_CACHE], { stdio: "inherit" });
  hf(["cache", "verify", model, "--cache-dir", HF_CACHE], { stdio: "inherit" });
  const pi = syncPiModel(model, false);
  event("model_runtime.model_installed", {
    actor: "hii.cli", target: model, status: "verified", text: `Installed ${model} in HII Native's model cache`
  });
  console.log(JSON.stringify({ ok: true, model, cache: HF_CACHE, verified: true, pi }, null, 2));
}

function listInstalledModels() {
  fs.mkdirSync(HF_CACHE, { recursive: true });
  const result = hf(["cache", "list", "--cache-dir", HF_CACHE]);
  process.stdout.write(result.stdout);
}

async function waitForModelRuntime(timeoutMs = 30 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${MODEL_RUNTIME_URL}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("HII Native did not become ready within 30 minutes; run `hii model logs`");
}

async function waitForModelRuntimeStopped(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!modelRuntimeProcess()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("HII Native did not stop within 30 seconds; inspect `hii model status` and `hii model logs`");
}

async function useModel(args) {
  const hosted = resolveHostedModelSelection(args[0]);
  if (hosted) {
    if (hosted.provider === "ox-alpha-web") {
      const adapter = path.join(ROOT, "browser", "dist", "src", "oxalpha-main.js");
      if (!fs.existsSync(adapter)) {
        throw new Error(`Ox Alpha browser adapter is not built; run: npm --prefix ${path.join(ROOT, "browser")} run build`);
      }
    }
    const preference = saveModelPreference(hosted.provider, hosted.model);
    event("model_runtime.hosted_selected", {
      actor: "hii.cli",
      target: hosted.model,
      status: "selected",
      text: `Selected ${hosted.role}; prompts now leave the machine through ${hosted.endpoint}`
    });
    console.log(JSON.stringify({
      ok: true,
      active: hosted.model,
      provider: hosted.provider,
      endpoint: hosted.endpoint,
      externalTransmission: true,
      transport: "HII headless Chromium DOM",
      tools: "HII-owned bounded action protocol",
      preference
    }, null, 2));
    return;
  }
  const model = resolveModelSelection(args[0], "use");
  if (!modelIsInstalled(model)) {
    throw new Error(`${model} is not installed; run: hii model install ${model}`);
  }
  if (modelRuntimePid()) {
    stopModelRuntime();
    await waitForModelRuntimeStopped();
  }
  await startModelRuntime(["--model", model]);
  await waitForModelRuntime();
  const preference = saveModelPreference("native", model);
  const pi = syncPiModel(model, true);
  console.log(JSON.stringify({ ok: true, active: model, endpoint: MODEL_RUNTIME_URL, preference, pi }, null, 2));
}

function removeModel(args) {
  const model = resolveModelSelection(args[0], "remove");
  const active = modelRuntimeStatus().model === model && Boolean(modelRuntimePid());
  if (active) throw new Error(`${model} is active; choose another model or run \`hii model stop\` first`);
  if (!modelIsInstalled(model)) throw new Error(`${model} is not installed in HII Native`);
  if (!args.includes("--yes")) {
    console.log(JSON.stringify({ ok: true, dryRun: true, model, path: cachedModelPath(model), apply: `hii model remove ${model} --yes` }, null, 2));
    return;
  }
  hf(["cache", "rm", `model/${model}`, "--cache-dir", HF_CACHE, "--yes"], { stdio: "inherit" });
  event("model_runtime.model_removed", {
    actor: "hii.cli", target: model, status: "removed", text: `Removed ${model} from HII Native's model cache`
  });
}

async function startModelRuntime(args) {
  ensureDirs();
  const existing = modelRuntimePid();
  if (existing) {
    console.log(`HII native runner already running pid=${existing}`);
    await printModelRuntimeStatus();
    return;
  }
  const binary = nativeRunnerBin();
  if (!fs.existsSync(binary)) {
    throw new Error(`native runner binary missing at ${binary}; run npm run runner:build`);
  }
  const mlxVlm = ensureHiiNativeEngine();
  const modelIndex = args.indexOf("--model");
  const quantIndex = args.indexOf("--quant");
  const profile = consumerModelProfile();
  const model = modelIndex >= 0 ? args[modelIndex + 1] : profile.model;
  const quant = quantIndex >= 0 ? args[quantIndex + 1] : "4";
  if (!model) throw new Error("--model requires a model ID or local path");
  if (!quant) throw new Error("--quant requires a mistral.rs ISQ value");
  const out = fs.openSync(MODEL_RUNTIME_LOG, "a");
  const forwarded = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--model" || args[index] === "--quant") {
      index += 1;
      continue;
    }
    forwarded.push(args[index]);
  }
  const child = spawn(binary, [
    "serve", "--model", model, "--quant", quant, ...forwarded,
    "--model-home", path.join(RUNTIME, "models")
  ], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      HII_RUNTIME_DIR: RUNTIME,
      ...(mlxVlm ? { HII_MLX_VLM_BIN: mlxVlm } : {})
    }
  });
  child.unref();
  fs.closeSync(out);
  fs.writeFileSync(MODEL_RUNTIME_PID, String(child.pid));
  writeJson(MODEL_RUNTIME_STATUS, {
    schemaVersion: 1,
    state: "starting",
    pid: child.pid,
    endpoint: MODEL_RUNTIME_URL,
    backend: process.platform === "darwin" && process.arch === "arm64"
      ? "hii-native/mlx-vlm"
      : "hii-native/mistral.rs",
    model,
    quantization: quant,
    performance: {
      automaticPrefixCache: !forwarded.includes("--no-apc"),
      prefillStepSize: Number(cliOption(forwarded, "--prefill-step-size", 2048)),
      maxConcurrentSequences: Number(cliOption(forwarded, "--max-num-seqs", 1)),
      visionCacheSize: Number(cliOption(forwarded, "--vision-cache-size", 2)),
      kvBits: forwarded.includes("--kv-bits")
        ? Number(cliOption(forwarded, "--kv-bits"))
        : null,
      draftModel: forwarded.includes("--draft-model")
        ? cliOption(forwarded, "--draft-model")
        : null
    },
    profile,
    modelHome: path.join(RUNTIME, "models"),
    log: MODEL_RUNTIME_LOG,
    binary,
    startedAt: now(),
    updatedAt: now()
  });
  event("model_runtime.started", {
    actor: "hii.cli", target: MODEL_RUNTIME_URL, status: "starting", pid: child.pid,
    text: `Started HII native model runtime with ${model}`
  });
  console.log(`started HII native runner pid=${child.pid}`);
  console.log(`model ${model}`);
  console.log(`endpoint ${MODEL_RUNTIME_URL}`);
  console.log("Model acquisition is explicit to this start command and may take time on first use.");
}

function stopModelRuntime() {
  const owned = modelRuntimeProcess();
  if (!owned) {
    writeJson(MODEL_RUNTIME_STATUS, { ...modelRuntimeStatus(), state: "stopped", pid: null, stoppedAt: now() });
    console.log("HII native runner is not running");
    return;
  }
  // The native runner owns engine children (MLX-VLM on Apple Silicon). It is
  // launched as a detached process group, so stop the whole owned runtime and
  // never leave a model server orphaned on the loopback port.
  if (process.platform === "win32") process.kill(owned.pid, "SIGTERM");
  else process.kill(-owned.pgid, "SIGTERM");
  writeJson(MODEL_RUNTIME_STATUS, { ...modelRuntimeStatus(), state: "stopped", pid: null, stoppedAt: now() });
  event("model_runtime.stopped", {
    actor: "hii.cli", target: MODEL_RUNTIME_URL, status: "stopped", pid: owned.pid,
    text: "Stopped HII native model runtime"
  });
  console.log(`stopped HII native runner pid=${owned.pid}`);
}

function doctorModelRuntime() {
  ensureDirs();
  const profile = consumerModelProfile();
  const binary = nativeRunnerBin();
  const build = fs.existsSync(binary)
    ? spawnSync(binary, ["doctor", "--json", "--model-home", path.join(RUNTIME, "models")], { encoding: "utf8" })
    : null;
  const report = {
    ok: Boolean(build?.status === 0),
    hardware: { platform: process.platform, arch: process.arch, memoryGiB: totalMemoryGiB() },
    profile,
    runner: build?.status === 0 ? JSON.parse(build.stdout) : {
      state: "not-built",
      binary,
      fix: "npm run runner:build"
    },
    routing: ["hii-native", "approved-hosted"],
    privacy: "Hosted transmission requires an explicit provider action or approved escalation."
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

async function listModelRuntimeModels() {
  let nativeModels = [];
  let nativeError = null;
  try {
    const response = await fetch(`${MODEL_RUNTIME_URL}/v1/models`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`native model listing failed with ${response.status}`);
    const body = await response.json();
    nativeModels = (body.data || []).map((model) => ({ ...model, provider: "native", externalTransmission: false }));
  } catch (error) {
    nativeError = error.message;
  }
  const preference = safeReadJson(MODEL_PREFERENCE, {});
  const hostedModels = hostedModelCatalog().map((entry) => ({
    id: entry.model,
    object: "model",
    provider: entry.provider,
    endpoint: entry.endpoint,
    aliases: entry.aliases || [],
    capabilities: entry.capabilities || [],
    externalTransmission: true,
    active: preference.provider === entry.provider && preference.model === entry.model
  }));
  console.log(JSON.stringify({
    object: "list",
    data: [...nativeModels, ...hostedModels],
    nativeError
  }, null, 2));
}

async function benchModelRuntime(args) {
  const prompt = args.join(" ").trim() || "Reply with exactly: HII_NATIVE_OK";
  const status = modelRuntimeStatus();
  if (!status.pid) throw new Error("HII native runner is not running");
  const started = performance.now();
  const response = await fetch(`${MODEL_RUNTIME_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: status.model,
      stream: false,
      temperature: 0,
      max_tokens: 32,
      messages: [{ role: "user", content: prompt }]
    }),
    signal: AbortSignal.timeout(600000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || `benchmark failed with ${response.status}`);
  const wallMs = Math.round(performance.now() - started);
  const gate = safeReadJson(MODEL_PROFILES, {}).performanceGate || {};
  const completionTokens = Number(body.usage?.completion_tokens || 0);
  const reportedTokensPerSecond = Number(body.usage?.avg_compl_tok_per_sec || 0);
  const completionTokensPerSecond = reportedTokensPerSecond > 0
    ? reportedTokensPerSecond
    : completionTokens / Math.max(wallMs / 1000, 0.001);
  // A tiny exact-output smoke mostly measures prompt evaluation and request
  // overhead. Do not label that as failed decode throughput when the backend
  // omits native timing; use openai_endpoint_benchmark.py for a long decode.
  const throughputMeasured = reportedTokensPerSecond > 0 || completionTokens >= 16;
  const gates = {
    completion: gate.requiresCompletion !== true || completionTokens > 0,
    wall: wallMs <= Number(gate.maxWallMs || 120000),
    throughput: !throughputMeasured
      || completionTokensPerSecond >= Number(gate.minCompletionTokensPerSecond || 8)
  };
  const ok = Object.values(gates).every(Boolean);
  const report = {
    ok,
    gates,
    thresholds: gate,
    wallMs,
    throughputMeasured,
    completionTokensPerSecond: Number(completionTokensPerSecond.toFixed(1)),
    model: status.model,
    usage: body.usage || null,
    output: body.choices?.[0]?.message?.content || "",
    measuredAt: now(),
    hardware: { platform: process.platform, arch: process.arch, memoryGiB: totalMemoryGiB() }
  };
  const benchmarkStore = modelBenchmarkResults();
  benchmarkStore.schemaVersion = 1;
  benchmarkStore.results ||= {};
  benchmarkStore.results[status.model] = report;
  writeJson(MODEL_BENCHMARKS, benchmarkStore);
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exitCode = 1;
}

async function cmdModelRuntime(args) {
  const sub = args[0] || "recommend";
  if (sub === "start") {
    if (!currentDaemonPid()) startDaemon();
    await startModelRuntime(args.slice(1));
  }
  else if (sub === "stop") stopModelRuntime();
  else if (sub === "status") await printModelRuntimeStatus();
  else if (sub === "doctor") doctorModelRuntime();
  else if (sub === "models") await listModelRuntimeModels();
  else if (sub === "bench") await benchModelRuntime(args.slice(1));
  else if (sub === "logs") tailFile(MODEL_RUNTIME_LOG, Number(args[1] || 80));
  else if (sub === "search") searchModels(args.slice(1));
  else if (sub === "install") installModel(args.slice(1));
  else if (sub === "installed") listInstalledModels();
  else if (sub === "use") await useModel(args.slice(1));
  else if (sub === "recommend" || sub === "choose") printModelRecommendations(args.slice(1));
  else if (sub === "remove") removeModel(args.slice(1));
  else throw new Error("usage: hii model <recommend|search|install|installed|use|status|start|stop|models|bench|logs|remove>");
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
      if (!command.includes(`${ROOT}/aii/daemon/hiid.mjs run`)) return null;
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
  const pid = Number(parts[1]);
  const command = redact(parts.slice(10).join(" "));
  const owned = OWNED_PATTERNS.some((pattern) => command.includes(pattern)) || pid === appServerPid();
  const relevant = owned || /claude|codex|hii|aii|termite|ollama|rhino|node.*next|python.*hii/i.test(command);
  if (!relevant) return null;
  return {
    id: `process:${parts[1]}`,
    type: "process",
    pid,
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
  const runtimePid = modelRuntimePid();
  const runtimeState = safeReadJson(MODEL_RUNTIME_STATUS, {});
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
    ...(runtimePid ? [{
      id: "service:model-runtime",
      type: "model-runtime",
      title: `HII Native · ${runtimeState.model || "loading"}`,
      pid: runtimePid,
      status: runtimeState.state === "ready" ? "running" : "starting",
      owned: true,
      autonomy: "local-inference-only",
      heartbeatAt: runtimeState.updatedAt || now(),
      coordinate: MODEL_RUNTIME_URL
    }] : []),
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
    const memoryPack = buildCodexMemoryPack({
      prompt: run.prompt,
      coordinate: run.coordinate || ROOT
    });
    const invocation = codexExecInvocation({
      prompt: run.prompt,
      coordinate: run.coordinate || ROOT,
      memoryPack
    });
    // Managed runs target coordinates a human already approved (activation wizard
    // or operator queue), which may not be trusted git repos — e.g. a partner's
    // plain project folder — so codex's repo trust check must be bypassed here.
    const child = spawn(codexBin(), invocation.args, {
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
      memoryContext: memoryPack.ok ? {
        strategy: memoryPack.strategy,
        source: memoryPack.source,
        sourceSha256: memoryPack.sourceSha256,
        sourceBytes: memoryPack.sourceBytes,
        tokenBudget: memoryPack.tokenBudget,
        estimatedTokens: memoryPack.estimatedTokens,
        selected: memoryPack.selected
      } : {
        strategy: "codex-native-memories",
        reason: memoryPack.reason
      },
      loop: [...(run.loop || []), "started backend execution"]
    };
    writeRun(running);
    event("codex.memory_context", {
      actor: "hii.daemon",
      target: run.id,
      status: memoryPack.ok ? "focused" : "native-fallback",
      text: memoryPack.ok
        ? `Selected ${memoryPack.selected.length} bounded memory section(s) for Codex`
        : `Preserved Codex native memories: ${memoryPack.reason}`,
      memoryContext: running.memoryContext
    });
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
      reconcileWorkspaceRuns();
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
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run"], {
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
    for (const [id, execution] of activeWorkspaceRuns) {
      execution.child.kill("SIGTERM");
      let cleanedStaging;
      try {
        cleanedStaging = cleanupWorkspaceRunContext({
          workspaceRoot: execution.intent.workspaceRoot,
          intentId: id,
          staging: execution.intent.contextStaging
        });
      } catch (cleanupError) {
        cleanedStaging = {
          ...(execution.intent.contextStaging || {}),
          cleanupStatus: "failed",
          cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        };
      }
      reportWorkspaceJob({ ...execution.intent, contextStaging: cleanedStaging }, {
        status: "cancelled",
        output: ["removed", "not-required"].includes(cleanedStaging.cleanupStatus)
          ? "AII stopped the bounded workspace run and removed its disposable context copy during daemon shutdown."
          : `AII stopped the bounded run, but context cleanup needs attention: ${cleanedStaging.cleanupError || cleanedStaging.cleanupStatus}`,
        startedAt: execution.startedAt
      });
      event("workspace.run.cancelled", {
        actor: "aii.hiid", target: id, status: "cancelled",
        text: "Cancelled bounded workspace execution during daemon shutdown."
      });
    }
    if (modelRuntimePid()) stopModelRuntime();
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
  else if (cmd === "model-runtime") await cmdModelRuntime(args);
  else if (cmd === "codex") {
    const sub = args[0] || "status";
    if (sub === "app-server") {
      const action = args[1] || "status";
      if (action === "start") startCodexAppServer();
      else if (action === "status") printCodexAppServerStatus();
      else if (action === "stop") stopCodexAppServer();
      else if (action === "logs") tailFile(CODEX_APP_SERVER_LOG, Number(args[2] || 80));
      else throw new Error("usage: hiid codex app-server <start|status|logs|stop>");
    } else if (sub === "run" || sub === "enqueue") {
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
      throw new Error("usage: hiid codex <run|status|logs|stop|app-server>");
    }
  } else if (cmd === "claude") {
    const sub = args[0] || "status";
    if (sub === "run" || sub === "enqueue") {
      if (!currentDaemonPid()) startDaemon();
      const intent = enqueueClaude(args.slice(1).join(" "));
      console.log(`queued ${intent.id}`);
      console.log(`session ${intent.name}`);
    } else if (sub === "status") {
      printClaudeSessions();
    } else {
      throw new Error("usage: hiid claude <run|status>");
    }
  } else {
    throw new Error("usage: hiid <start|stop|restart|status|feed|logs|config|instances|runs|model-runtime|codex|claude>");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
