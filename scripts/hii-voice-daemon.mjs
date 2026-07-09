#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const ROOT = path.join(os.homedir(), "hii");
const RUNTIME = path.join(os.homedir(), ".hii");
const VOICE_DIR = path.join(RUNTIME, "voice");
const LOG = path.join(VOICE_DIR, "daemon.log");
const PID = path.join(VOICE_DIR, "daemon.pid");
const STATUS = path.join(VOICE_DIR, "status.json");
const EVENTS = path.join(VOICE_DIR, "events.jsonl");
const TRANSCRIPTS = path.join(VOICE_DIR, "transcripts.jsonl");
const MEMORY = path.join(VOICE_DIR, "memory.jsonl");
const SKILL_PROPOSALS = path.join(VOICE_DIR, "skill-proposals.jsonl");
const LEARNING = path.join(VOICE_DIR, "learning.json");
const PROCESS_DIR = path.join(RUNTIME, "processes");
const PROCESS_REGISTRY = path.join(PROCESS_DIR, "registry.json");
const PROCESS_EVENTS = path.join(PROCESS_DIR, "events.jsonl");
const LOOP_NOTES = path.join(RUNTIME, "loop", "notes.jsonl");
const OG_EVENTS = path.join(RUNTIME, "og", "events.jsonl");
const SKILL_DIR = path.join(RUNTIME, "skills");
const PROPOSED_SKILL_DIR = path.join(SKILL_DIR, "proposed");
const LISTENER = path.join(ROOT, "scripts", "hii-voice-listener.swift");
const DEFAULT_MODEL = process.env.HII_VOICE_MODEL || process.env.HII_MODEL || "qwen3.6:35b-mlx";
const DEFAULT_SPEECH_VOICE = process.env.HII_VOICE_NAME || "Samantha";
const DEFAULT_SPEECH_RATE = process.env.HII_VOICE_RATE || "182";
const WAKE_PATTERN = /\b(?:hey\s+)?h(?:ii|i)\b/i;

function ensureDirs() {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  fs.mkdirSync(PROCESS_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(LOOP_NOTES), { recursive: true });
  fs.mkdirSync(path.dirname(OG_EVENTS), { recursive: true });
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  fs.mkdirSync(PROPOSED_SKILL_DIR, { recursive: true });
}

function sanitize(value) {
  return String(value ?? "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)=)([^\s]+)/gi, "$1[redacted]")
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, "$1[redacted]")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[redacted]")
    .trim();
}

function appendJsonl(file, entry) {
  ensureDirs();
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

function readJsonl(file, limit = 20) {
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function log(type, fields = {}) {
  const entry = { ts: new Date().toISOString(), type, ...fields };
  appendJsonl(EVENTS, entry);
  fs.appendFileSync(LOG, `${entry.ts} ${type} ${sanitize(fields.message ?? fields.text ?? "")}\n`);
  return entry;
}

function writeStatus(patch) {
  ensureDirs();
  const current = (() => {
    try { return JSON.parse(fs.readFileSync(STATUS, "utf8")); } catch { return {}; }
  })();
  const next = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    model: DEFAULT_MODEL,
    speechVoice: DEFAULT_SPEECH_VOICE,
    speechRate: DEFAULT_SPEECH_RATE,
    wakePattern: "hii",
    ...current,
    ...patch
  };
  fs.writeFileSync(STATUS, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function prepareSpeechText(value) {
  return sanitize(value)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\bHII\b/g, "high")
    .replace(/\bLLM\b/g, "local language model")
    .replace(/\bOllama\b/g, "Oh llama")
    .replace(/\bCLI\b/g, "command line")
    .replace(/\s*[:;]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function speak(text, { enabled = true } = {}) {
  const clean = prepareSpeechText(text).slice(0, 900);
  if (!clean) return;
  log("speak", { text: clean, voice: DEFAULT_SPEECH_VOICE, rate: DEFAULT_SPEECH_RATE });
  if (!enabled) return;
  spawn("say", ["-v", DEFAULT_SPEECH_VOICE, "-r", String(DEFAULT_SPEECH_RATE), clean], { stdio: "ignore", detached: true }).unref();
}

function recentContext() {
  return {
    voiceMemory: readJsonl(MEMORY, 12).map((entry) => ({
      ts: entry.ts,
      kind: entry.kind,
      text: entry.text
    })),
    recentVoice: readJsonl(TRANSCRIPTS, 8).map((entry) => ({
      ts: entry.ts,
      utterance: entry.utterance,
      command: entry.command
    })),
    loopNotes: readJsonl(LOOP_NOTES, 8).map((entry) => ({
      ts: entry.ts,
      note: entry.note
    })),
    og: readJsonl(OG_EVENTS, 6).map((entry) => ({
      ts: entry.ts,
      mode: entry.mode,
      prompt: entry.prompt,
      nextActions: entry.nextActions?.slice?.(0, 2)
    })),
    processes: processSnapshot().slice(0, 12)
  };
}

function buildPrompt(command) {
  return [
    "You are HII, Ummi's local-first always-on voice agent.",
    "You run on this Mac, use local state, and keep work conversational.",
    "",
    "Rules:",
    "- Answer in a spoken update, 2 to 5 short sentences.",
    "- Recite the observable work loop: heard, checked, proposed next action, approval boundary.",
    "- Do not reveal hidden chain-of-thought. Say concise reasons and evidence instead.",
    "- Do not claim you executed destructive, external, payment, publish, push, email, or secret-reading actions.",
    "- If the command implies a repeatable workflow, suggest a HII skill proposal.",
    "- If the command contains durable user preference, project fact, or correction, suggest a HII memory.",
    "- Be direct, useful, and conversational.",
    "",
    "Local context:",
    JSON.stringify(recentContext(), null, 2),
    "",
    "Heard command:",
    sanitize(command)
  ].join("\n");
}

async function ollamaGenerate(prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.4 }
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `ollama failed with ${response.status}`);
    const output = sanitize(data.response || "");
    if (!output) throw new Error("ollama returned empty response");
    return output.replace(/^Thinking\.\.\.[\s\S]*?\.\.\.done thinking\.\s*/i, "").trim();
  } finally {
    clearTimeout(timeout);
  }
}

function fallbackReply(command, error) {
  return [
    `I heard: ${sanitize(command).slice(0, 180)}.`,
    "I checked the local HII voice state, but the local model did not return a response.",
    "I saved the utterance and can keep listening.",
    `Approval boundary is unchanged: I will propose writes, skills, and actions before executing them. Model issue: ${sanitize(error).slice(0, 160)}.`
  ].join(" ");
}

function extractMemoryCandidate(command, reply) {
  const text = sanitize(command);
  if (/\b(remember|from now on|preference|always|never|call me|i want|i need)\b/i.test(text)) {
    return `User voice note: ${text}`;
  }
  if (/\bskill|workflow|when i say|automate|repeatable|every time\b/i.test(text)) {
    return `Potential repeatable workflow from voice: ${text}`;
  }
  if (/\b(hii should|hii needs|native to hii|better than hermes|same capabilities)\b/i.test(text)) {
    return `HII product direction: ${text}`;
  }
  if (/\b(memory|persistent|daemon|voice|conversational)\b/i.test(reply)) {
    return `Voice interaction context: ${text}`;
  }
  return null;
}

function extractSkillProposal(command) {
  const text = sanitize(command);
  if (!/\b(skill|workflow|when i say|automate|repeatable|every time|capabilities|hermes)\b/i.test(text)) return null;
  const id = `voice-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 54) || "workflow"}`;
  return {
    id,
    name: id.split("-").map((part) => part ? part[0].toUpperCase() + part.slice(1) : "").join(" ").slice(0, 80),
    category: "voice",
    target: "local",
    description: text.slice(0, 240),
    script: "hii voice ask <prompt>",
    source: "hii voice daemon",
    status: "proposed"
  };
}

function processDefaults() {
  return [
    {
      id: "hii.voice",
      name: "HII Voice Daemon",
      kind: "launchd",
      label: "ai.hii.voice",
      autostart: false,
      notes: "Native HII wake phrase, local LLM, memory, skill proposal, and process supervision daemon."
    },
    {
      id: "hii.mind0",
      name: "HII Mind0 Runtime",
      kind: "launchd",
      label: "ai.hii.mind0",
      autostart: false,
      notes: "Existing HII background runtime; tracked but not modified by the voice daemon."
    },
    {
      id: "ollama",
      name: "Ollama Local Model Runtime",
      kind: "process-match",
      match: "ollama",
      autostart: false,
      notes: "Local model server used by HII voice and other HII loops."
    }
  ];
}

function processRegistry() {
  ensureDirs();
  const existing = readJson(PROCESS_REGISTRY, null);
  if (Array.isArray(existing)) return existing;
  const defaults = processDefaults();
  writeJson(PROCESS_REGISTRY, defaults);
  return defaults;
}

function launchdAlive(label) {
  const r = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], { encoding: "utf8" });
  return {
    alive: r.status === 0,
    detail: r.status === 0 ? "loaded" : sanitize(r.stderr || r.stdout).slice(0, 160)
  };
}

function processMatchAlive(match) {
  const r = spawnSync("ps", ["auxww"], { encoding: "utf8" });
  if (r.status !== 0) return { alive: false, detail: "ps unavailable" };
  const lines = r.stdout.split("\n").filter((line) => line.includes(match) && !line.includes("hii-voice-daemon.mjs"));
  return {
    alive: lines.length > 0,
    detail: lines.slice(0, 3).map(sanitize).join(" | ")
  };
}

function commandAlive(spec) {
  if (spec.pidFile) {
    const pid = Number(readJson(spec.pidFile, null) || (fs.existsSync(spec.pidFile) ? fs.readFileSync(spec.pidFile, "utf8").trim() : 0));
    if (pid && spawnSync("ps", ["-p", String(pid)], { encoding: "utf8" }).status === 0) {
      return { alive: true, detail: `pid=${pid}` };
    }
  }
  if (spec.match) return processMatchAlive(spec.match);
  return { alive: false, detail: "no pidFile or match configured" };
}

function startCommandSpec(spec) {
  if (!spec.autostart || !Array.isArray(spec.command) || spec.command.length === 0) return null;
  const child = spawn(spec.command[0], spec.command.slice(1), {
    cwd: spec.cwd || ROOT,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...(spec.env || {}) }
  });
  child.unref();
  return child.pid;
}

function processSnapshot({ supervise = false } = {}) {
  const snapshot = [];
  for (const spec of processRegistry()) {
    let state;
    if (spec.kind === "launchd" && spec.label) state = launchdAlive(spec.label);
    else if (spec.kind === "process-match" && spec.match) state = processMatchAlive(spec.match);
    else state = commandAlive(spec);

    let startedPid = null;
    if (supervise && !state.alive && spec.autostart && spec.kind === "command") {
      startedPid = startCommandSpec(spec);
      state = { alive: Boolean(startedPid), detail: startedPid ? `started pid=${startedPid}` : state.detail };
    }

    const entry = {
      id: spec.id,
      name: spec.name,
      kind: spec.kind,
      label: spec.label,
      autostart: Boolean(spec.autostart),
      alive: state.alive,
      detail: state.detail,
      startedPid
    };
    snapshot.push(entry);
  }
  return snapshot;
}

function heartbeatProcesses() {
  const snapshot = processSnapshot({ supervise: true });
  appendJsonl(PROCESS_EVENTS, {
    id: randomUUID(),
    ts: new Date().toISOString(),
    source: "hii.voice.daemon",
    processes: snapshot
  });
  writeStatus({ processSupervisor: { updatedAt: new Date().toISOString(), processes: snapshot } });
  return snapshot;
}

function learningKey(text) {
  return sanitize(text)
    .toLowerCase()
    .replace(/\b(hii|hey|please|can you|could you|would you)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 10)
    .join(" ");
}

function promoteDraftSkill({ key, command, count }) {
  const id = `learned-${key.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "voice-workflow"}`;
  const file = path.join(PROPOSED_SKILL_DIR, `${id}.json`);
  if (fs.existsSync(file)) return file;
  const manifest = {
    id,
    name: id.split("-").map((part) => part ? part[0].toUpperCase() + part.slice(1) : "").join(" ").slice(0, 80),
    description: `Draft HII skill learned from ${count} similar voice requests.`,
    category: "learned",
    target: "local",
    inputs: { prompt: "string" },
    script: "hii voice ask {prompt}",
    status: "draft",
    source: "hii voice learning loop",
    example: command,
    created_at: new Date().toISOString(),
    version: 1
  };
  writeJson(file, manifest);
  appendJsonl(SKILL_PROPOSALS, {
    ...manifest,
    proposedAt: new Date().toISOString(),
    proposalPath: file
  });
  return file;
}

function learnFromUse(command, reply) {
  const key = learningKey(command);
  if (!key) return null;
  const state = readJson(LEARNING, { schemaVersion: 1, commands: {} });
  const current = state.commands[key] || { count: 0, firstSeenAt: new Date().toISOString(), examples: [] };
  current.count += 1;
  current.lastSeenAt = new Date().toISOString();
  current.examples = [sanitize(command), ...(current.examples || [])].slice(0, 5);
  current.lastReply = sanitize(reply).slice(0, 500);
  state.commands[key] = current;
  state.updatedAt = new Date().toISOString();
  writeJson(LEARNING, state);
  if (current.count === 2) {
    appendJsonl(MEMORY, {
      id: randomUUID(),
      ts: new Date().toISOString(),
      kind: "learned-pattern",
      text: `Repeated voice pattern: ${key}`,
      examples: current.examples
    });
  }
  if (current.count >= 3) {
    return promoteDraftSkill({ key, command, count: current.count });
  }
  return null;
}

async function handleCommand(command, options = {}) {
  const clean = sanitize(command);
  if (!clean) return null;
  const id = randomUUID();
  writeStatus({ state: "thinking", lastCommand: clean, lastCommandAt: new Date().toISOString() });
  appendJsonl(TRANSCRIPTS, {
    id,
    ts: new Date().toISOString(),
    utterance: clean,
    command: clean,
    source: options.source || "voice"
  });
  appendJsonl(LOOP_NOTES, {
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: "voice-command",
    note: clean
  });
  appendJsonl(OG_EVENTS, {
    id: randomUUID(),
    ts: new Date().toISOString(),
    capabilityId: "hii.voice.daemon",
    mode: "voice-command",
    prompt: clean,
    nextActions: [
      {
        score: 94,
        track: "voice persistence",
        coordinate: VOICE_DIR,
        action: "keep listening, answer conversationally, and persist memory/skill proposals locally"
      }
    ]
  });

  let reply;
  try {
    reply = await ollamaGenerate(buildPrompt(clean));
  } catch (error) {
    reply = fallbackReply(clean, error instanceof Error ? error.message : String(error));
  }

  const memory = extractMemoryCandidate(clean, reply);
  if (memory) {
    appendJsonl(MEMORY, {
      id: randomUUID(),
      ts: new Date().toISOString(),
      kind: "candidate",
      text: memory,
      sourceTranscriptId: id
    });
  }

  const proposal = extractSkillProposal(clean);
  if (proposal) {
    appendJsonl(SKILL_PROPOSALS, {
      ...proposal,
      proposedAt: new Date().toISOString(),
      sourceTranscriptId: id
    });
  }
  const learnedSkillPath = learnFromUse(clean, reply);

  log("reply", { text: reply });
  writeStatus({ state: "listening", lastReply: reply, lastReplyAt: new Date().toISOString(), learnedSkillPath });
  speak(reply, { enabled: options.speak !== false });
  return { id, reply, memory, skillProposal: proposal, learnedSkillPath };
}

function commandAfterWake(text) {
  const clean = sanitize(text);
  const match = clean.match(WAKE_PATTERN);
  if (!match) return null;
  const rest = clean.slice((match.index ?? 0) + match[0].length).replace(/^[,.:;\s-]+/, "").trim();
  return rest || "status update";
}

function runListener() {
  ensureDirs();
  fs.writeFileSync(PID, `${process.pid}\n`);
  writeStatus({ state: "starting", startedAt: new Date().toISOString(), mode: "microphone" });
  log("start", { message: `voice daemon starting with model ${DEFAULT_MODEL}` });
  speak("HII voice is listening.", { enabled: process.env.HII_VOICE_ANNOUNCE !== "0" });
  heartbeatProcesses();
  setInterval(() => {
    try {
      heartbeatProcesses();
    } catch (error) {
      log("process-supervisor-error", { message: error instanceof Error ? error.message : String(error) });
    }
  }, Number(process.env.HII_VOICE_PROCESS_INTERVAL_MS || 60000));

  const child = spawn("swift", [LISTENER], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let lastText = "";
  let lastHandled = "";
  let debounce = null;

  child.stderr.on("data", (chunk) => log("listener-stderr", { message: String(chunk) }));
  child.on("exit", (code, signal) => {
    writeStatus({ state: "stopped", stoppedAt: new Date().toISOString(), exitCode: code, signal });
    log("listener-exit", { message: `swift listener exited ${code ?? signal}` });
    process.exit(code ?? 1);
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    let event;
    try { event = JSON.parse(line); } catch {
      log("listener-line", { message: line });
      return;
    }
    if (event.type === "ready") {
      writeStatus({ state: "listening", listener: "ready" });
      return;
    }
    if (event.type === "error") {
      writeStatus({ state: "error", error: sanitize(event.message) });
      log("listener-error", { message: event.message });
      speak(`HII voice listener error: ${event.message}`);
      return;
    }
    if (!event.text) return;
    lastText = sanitize(event.text);
    const command = commandAfterWake(lastText);
    if (!command || command === lastHandled) return;
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const current = commandAfterWake(lastText);
      if (!current || current === lastHandled) return;
      lastHandled = current;
      await handleCommand(current, { source: "microphone" });
    }, event.type === "final" ? 100 : 1200);
  });

  process.on("SIGTERM", () => {
    log("stop", { message: "received SIGTERM" });
    child.kill("SIGTERM");
    try { fs.unlinkSync(PID); } catch {}
    writeStatus({ state: "stopped", stoppedAt: new Date().toISOString() });
    process.exit(0);
  });
}

function status() {
  ensureDirs();
  const pid = (() => {
    try { return Number(fs.readFileSync(PID, "utf8").trim()); } catch { return null; }
  })();
  const processes = processSnapshot();
  const voiceLaunchd = processes.find((entry) => entry.id === "hii.voice");
  const alive = Boolean(voiceLaunchd?.alive) || (pid ? spawnSync("ps", ["-p", String(pid)], { encoding: "utf8" }).status === 0 : false);
  const state = (() => {
    try { return JSON.parse(fs.readFileSync(STATUS, "utf8")); } catch { return null; }
  })();
  return { alive, pid, status: state, log: LOG, events: EVENTS, memory: MEMORY, skillProposals: SKILL_PROPOSALS, processRegistry: PROCESS_REGISTRY, processes };
}

function printStatus() {
  const s = status();
  console.log("HII Voice Daemon\n");
  console.log(`alive:     ${s.alive ? "yes" : "no"}`);
  console.log(`pid:       ${s.pid ?? "none"}`);
  console.log(`state:     ${s.status?.state ?? "unknown"}`);
  console.log(`model:     ${s.status?.model ?? DEFAULT_MODEL}`);
  console.log(`voice:     ${s.status?.speechVoice ?? DEFAULT_SPEECH_VOICE}`);
  console.log(`rate:      ${s.status?.speechRate ?? DEFAULT_SPEECH_RATE}`);
  console.log(`wake:      hii`);
  console.log(`log:       ${s.log}`);
  console.log(`memory:    ${s.memory}`);
  console.log(`skills:    ${s.skillProposals}`);
  console.log(`processes: ${s.processRegistry}`);
  for (const processInfo of s.processes) {
    console.log(`  ${processInfo.alive ? "ok " : "off"} ${processInfo.id} ${processInfo.detail ?? ""}`);
  }
}

function start() {
  ensureDirs();
  const s = status();
  if (s.alive) {
    console.log(`HII voice daemon already running pid=${s.pid}`);
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
  fs.writeFileSync(PID, `${child.pid}\n`);
  console.log(`started HII voice daemon pid=${child.pid}`);
  console.log(`log: ${LOG}`);
}

function stop() {
  const s = status();
  if (!s.pid) {
    console.log("HII voice daemon is not running");
    return;
  }
  try {
    process.kill(s.pid, "SIGTERM");
    console.log(`stopped HII voice daemon pid=${s.pid}`);
  } catch (error) {
    console.error(`failed to stop pid=${s.pid}: ${error.message}`);
    process.exit(1);
  }
}

function printLogs(lines = 80) {
  try {
    const rows = fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).slice(-lines);
    console.log(rows.join("\n"));
  } catch {
    console.log("no voice daemon log yet");
  }
}

function launchdPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.hii.voice</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${path.join(ROOT, "scripts", "hii-voice-daemon.mjs")}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HII_VOICE_MODEL</key>
    <string>${DEFAULT_MODEL}</string>
    <key>HII_VOICE_NAME</key>
    <string>${DEFAULT_SPEECH_VOICE}</string>
    <key>HII_VOICE_RATE</key>
    <string>${DEFAULT_SPEECH_RATE}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
  <key>ThrottleInterval</key>
  <integer>15</integer>
</dict>
</plist>
`;
}

function installLaunchd() {
  ensureDirs();
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "ai.hii.voice.plist");
  fs.writeFileSync(plistPath, launchdPlist());
  console.log(`wrote ${plistPath}`);
  console.log("load with: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hii.voice.plist");
}

function launchdPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", "ai.hii.voice.plist");
}

function bootstrapLaunchd() {
  const plistPath = launchdPath();
  if (!fs.existsSync(plistPath)) fs.writeFileSync(plistPath, launchdPlist());
  const target = `gui/${process.getuid()}`;
  const r = spawnSync("launchctl", ["bootstrap", target, plistPath], { encoding: "utf8" });
  if (r.status !== 0 && !String(r.stderr || r.stdout).includes("Bootstrap failed: 5")) {
    throw new Error(sanitize(r.stderr || r.stdout || "launchctl bootstrap failed"));
  }
  const k = spawnSync("launchctl", ["kickstart", "-k", `${target}/ai.hii.voice`], { encoding: "utf8" });
  if (k.status !== 0) throw new Error(sanitize(k.stderr || k.stdout || "launchctl kickstart failed"));
  console.log("HII voice is on");
}

function bootoutLaunchd() {
  const target = `gui/${process.getuid()}`;
  const r = spawnSync("launchctl", ["bootout", target, launchdPath()], { encoding: "utf8" });
  if (r.status !== 0 && !String(r.stderr || r.stdout).includes("No such process")) {
    throw new Error(sanitize(r.stderr || r.stdout || "launchctl bootout failed"));
  }
  const s = status();
  if (s.pid) {
    try { process.kill(s.pid, "SIGTERM"); } catch {}
  }
  console.log("HII voice is off");
}

async function main() {
  const [cmd = "status", ...args] = process.argv.slice(2);
  const noSay = args.includes("--no-say");
  const cleanArgs = args.filter((arg) => arg !== "--no-say");
  if (cmd === "run") {
    const textIndex = cleanArgs.indexOf("--text");
    if (textIndex !== -1) {
      const text = cleanArgs.slice(textIndex + 1).join(" ");
      const command = commandAfterWake(text) || text;
      const result = await handleCommand(command, { source: "text-test", speak: !noSay });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    runListener();
    return;
  }
  if (cmd === "start") return start();
  if (cmd === "on" || cmd === "enable") return bootstrapLaunchd();
  if (cmd === "off" || cmd === "disable") return bootoutLaunchd();
  if (cmd === "restart") {
    try { bootoutLaunchd(); } catch {}
    return bootstrapLaunchd();
  }
  if (cmd === "stop") return stop();
  if (cmd === "status") return printStatus();
  if (cmd === "logs") return printLogs(Number(args[0] ?? 80));
  if (cmd === "install-launchd") return installLaunchd();
  if (cmd === "preview") {
    const previewText = cleanArgs.join(" ") || "HII is listening. I heard your request, checked the local system, and I am ready to help.";
    speak(previewText, { enabled: true });
    console.log(`voice: ${DEFAULT_SPEECH_VOICE}`);
    console.log(`rate: ${DEFAULT_SPEECH_RATE}`);
    return;
  }
  if (cmd === "ask") {
    const text = cleanArgs.join(" ");
    if (!text) {
      console.error("usage: hii voice ask <prompt>");
      process.exit(1);
    }
    const result = await handleCommand(text, { source: "text", speak: !noSay });
    console.log(result.reply);
    return;
  }
  console.error("usage: hii voice <on|off|restart|start|run|stop|status|logs|ask|preview|install-launchd>");
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
