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
  case "caps": cmdCaps(); break;
  case "jobs": cmdJobs(rest); break;
  case "terminal": cmdTerminal(rest); break;
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
  status              env + git + codex snapshot
  doctor              status + registry doctor
  caps                list backend-owned capabilities
  jobs [n]            list recent local capability jobs
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
