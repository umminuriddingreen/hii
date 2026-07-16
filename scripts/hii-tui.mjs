#!/usr/bin/env node
// HII TUI — conversational terminal surface over the governed hiid runtime.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = path.join(os.homedir(), "hii");
const RUNTIME = process.env.HII_RUNTIME_DIR || path.join(os.homedir(), ".hii");
const HIID = path.join(ROOT, "aii", "daemon", "hiid.mjs");
const RUNS = path.join(RUNTIME, "daemon", "runs");
const BOARD = path.join(RUNTIME, "board", "tasks.jsonl");
const JOBS = path.join(ROOT, ".hii", "capability-jobs.jsonl");
const CHAT_DIR = path.join(RUNTIME, "chat", "sessions");
const sessionId = `hii-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
const sessionFile = path.join(CHAT_DIR, `${sessionId}.jsonl`);

const ESC = "\x1b";
const ansi = {
  altOn: `${ESC}[?1049h`, altOff: `${ESC}[?1049l`, home: `${ESC}[H`, clear: `${ESC}[2J`,
  hide: `${ESC}[?25l`, show: `${ESC}[?25h`, reset: `${ESC}[0m`,
  bold: `${ESC}[1m`, dim: `${ESC}[2m`, blue: `${ESC}[38;5;33m`, green: `${ESC}[38;5;77m`,
  amber: `${ESC}[38;5;214m`, red: `${ESC}[38;5;203m`, gray: `${ESC}[38;5;245m`, white: `${ESC}[38;5;255m`
};
const frames = ["◇", "◈", "◆", "◈"];
const waves = ["▁▂▃▄▅", "▂▃▄▅▆", "▃▄▅▆▇", "▄▅▆▇█", "▃▄▅▆▇", "▂▃▄▅▆"];
const reducedMotion = process.env.HII_MOTION === "off" || process.env.HII_REDUCED_MOTION === "1" || Boolean(process.env.NO_COLOR);

let input = "";
let cursor = 0;
let frame = 0;
let activeRun = null;
let lastRunStatus = null;
let queue = [];
let history = [];
let historyIndex = 0;
let notice = "Type an intent. Enter sends · Ctrl+J newline · /help commands";
let closed = false;
let messages = [{ role: "hii", text: "Think with the workspace. I’ll make context, execution, and proof visible as we work.", status: "ready" }];
let systemCache = { at: 0, git: { branch: "workspace", dirty: 0 }, daemon: { alive: false, autonomy: "reversible-local" } };

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function persist(event) {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
  fs.appendFileSync(sessionFile, `${JSON.stringify({ ts: new Date().toISOString(), sessionId, ...event })}\n`);
}

function strip(value) {
  return String(value || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/((?:api[_-]?key|token|secret|password)=)([^\s]+)/gi, "$1[redacted]");
}

function wrap(text, width) {
  const out = [];
  for (const raw of strip(text).split("\n")) {
    let line = raw;
    if (!line) { out.push(""); continue; }
    while (line.length > width) {
      let cut = line.lastIndexOf(" ", width);
      if (cut < Math.floor(width * 0.55)) cut = width;
      out.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    out.push(line);
  }
  return out;
}

function gitState() {
  const branch = spawnSync("git", ["-C", ROOT, "branch", "--show-current"], { encoding: "utf8" }).stdout?.trim() || "workspace";
  const dirty = spawnSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" }).stdout?.trim().split("\n").filter(Boolean).length || 0;
  return { branch, dirty };
}

function daemonState() {
  const status = readJson(path.join(RUNTIME, "daemon", "status.json"), {});
  return { alive: status.state === "running", autonomy: status.autonomy || "reversible-local" };
}

function systemState() {
  const now = Date.now();
  if (now - systemCache.at > 2000) {
    systemCache = { at: now, git: gitState(), daemon: daemonState() };
  }
  return systemCache;
}

function latestBoardTasks() {
  const byId = new Map();
  for (const item of readJsonl(BOARD)) if (item.id) byId.set(item.id, item);
  return [...byId.values()].filter((item) => ["next", "doing", "blocked"].includes(item.lane));
}

function latestJobs() {
  const byId = new Map();
  for (const item of readJsonl(JOBS)) if (item.id) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

function transcriptLines(width) {
  const lines = [];
  for (const message of messages) {
    const isUser = message.role === "you";
    const label = isUser ? `${ansi.blue}YOU${ansi.reset}` : `${ansi.green}HII${ansi.reset}`;
    const status = message.status && !["ready", "completed"].includes(message.status)
      ? `  ${ansi.dim}${message.status}${ansi.reset}` : "";
    lines.push(`${label}${status}`);
    for (const line of wrap(message.text, width - 4)) lines.push(`  ${line}`);
    if (message.runId) lines.push(`  ${ansi.dim}run ${message.runId}${ansi.reset}`);
    lines.push("");
  }
  return lines;
}

function render() {
  if (closed) return;
  const cols = Math.max(58, process.stdout.columns || 88);
  const rows = Math.max(18, process.stdout.rows || 28);
  const inner = Math.min(cols - 4, 108);
  const { git, daemon } = systemState();
  const pulse = reducedMotion ? "◈" : frames[frame % frames.length];
  const wave = reducedMotion ? "─────" : waves[frame % waves.length];
  const workState = activeRun ? `${ansi.amber}${wave} ${lastRunStatus || "queued"}${ansi.reset}` : `${ansi.green}● ready${ansi.reset}`;
  const header = [
    `${ansi.bold}${ansi.blue}${pulse}${ansi.reset}  ${ansi.bold}HII${ansi.reset}  ${ansi.dim}Human Information Interface${ansi.reset}`,
    `${ansi.dim}${git.branch}${git.dirty ? ` · ${git.dirty} changes` : " · clean"}  │  hiid ${daemon.alive ? "online" : "offline"}  │  ${daemon.autonomy}${ansi.reset}`,
    `${"─".repeat(inner)}`
  ];
  const footerHeight = queue.length ? 7 : 5;
  const room = Math.max(5, rows - header.length - footerHeight);
  const transcript = transcriptLines(inner).slice(-room);
  const queued = queue.length ? [
    `${ansi.dim}queued (${queue.length})${ansi.reset}`,
    ...queue.slice(0, 2).map((item, i) => `  ${i + 1}. ${strip(item).replace(/\s+/g, " ").slice(0, inner - 7)}`)
  ] : [];
  const composerText = input || `${ansi.dim}Message HII or type /help…${ansi.reset}`;
  const composerLines = wrap(composerText, inner - 4).slice(-3);
  const footer = [
    ...queued,
    `${"─".repeat(inner)}`,
    `${workState}  ${ansi.dim}${notice.slice(0, inner - 18)}${ansi.reset}`,
    `${ansi.dim}Enter send  ·  Esc interrupt  ·  ↑ history  ·  Ctrl+D exit${ansi.reset}`,
    `${ansi.blue}❯${ansi.reset} ${composerLines.join("\n  ")}`
  ];
  const content = [...header, ...transcript, ...Array(Math.max(0, room - transcript.length)).fill(""), ...footer];
  const back = !input.includes("\n") && input.length < inner - 4 && cursor < input.length ? `${ESC}[${input.length - cursor}D` : "";
  process.stdout.write(`${ansi.home}${ansi.clear}${content.join("\n")}${ansi.show}${back}`);
}

function cleanRunOutput(file) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, Math.max(0, size - length));
    fs.closeSync(fd);
    const output = strip(buffer.toString("utf8")).trim();
    const afterUsage = output.match(/tokens used\s*\n[\d,]+\s*\n([\s\S]+)$/i)?.[1]?.trim();
    const codexAnswer = output.match(/(?:^|\n)codex\s*\n([\s\S]*?)(?:\ntokens used|$)/i)?.[1]?.trim();
    return afterUsage || codexAnswer || output.slice(-12000) || "The run completed without a final text response.";
  } catch { return "The run completed, but its output could not be read."; }
}

function queueRun(prompt) {
  const framed = [
    "You are responding inside the local HII terminal interface.",
    "Keep the user in control. Make context, actions, verification, and proof explicit.",
    "Do not publish, push, spend, message, delete, or expose secrets without separate explicit authority.",
    `User intent:\n${prompt}`
  ].join("\n\n");
  const result = spawnSync(process.execPath, [HIID, "codex", "run", framed], { cwd: ROOT, encoding: "utf8", env: process.env });
  const id = `${result.stdout || ""}${result.stderr || ""}`.match(/queued\s+(codex-[\w-]+)/)?.[1];
  if (!id) {
    messages.push({ role: "hii", text: strip(result.stderr || result.stdout || "Could not queue the managed HII run."), status: "failed" });
    notice = "run failed to queue";
    return;
  }
  activeRun = id;
  lastRunStatus = "queued";
  messages.push({ role: "hii", text: "Queued with HII. The run is inspectable while it works.", status: "queued", runId: id });
  persist({ type: "run.queued", runId: id, prompt: strip(prompt) });
  notice = "managed run queued · input remains available";
}

function submit(text) {
  const value = text.trim();
  if (!value) return;
  history.push(value);
  historyIndex = history.length;
  input = "";
  cursor = 0;
  if (value.startsWith("/")) { command(value); return; }
  messages.push({ role: "you", text: value, status: "completed" });
  persist({ type: "message", role: "user", text: strip(value) });
  if (activeRun) {
    queue.push(value);
    notice = `queued ${queue.length} follow-up${queue.length === 1 ? "" : "s"}`;
  } else queueRun(value);
}

function command(value) {
  const [name, ...args] = value.slice(1).split(/\s+/);
  if (["quit", "exit", "q"].includes(name)) return close();
  if (name === "clear") { messages = []; notice = "transcript cleared locally"; return; }
  if (name === "help") {
    messages.push({ role: "hii", status: "ready", text: [
      "/now  workspace snapshot     /work  active task queue",
      "/proof  recent receipts      /status  daemon boundary",
      "/stop  stop active run       /clear  clear this view",
      "/exit  close HII             Esc  interrupt current run"
    ].join("\n") });
    return;
  }
  if (name === "now") {
    const git = gitState(); const tasks = latestBoardTasks(); const jobs = latestJobs();
    messages.push({ role: "hii", status: "ready", text: `${git.branch} · ${git.dirty} workspace changes\n${tasks.length} active tasks · ${jobs.filter((j) => j.status === "completed").length} verified receipts` });
    return;
  }
  if (name === "work") {
    const tasks = latestBoardTasks();
    messages.push({ role: "hii", status: "ready", text: tasks.length ? tasks.slice(0, 8).map((t) => `${t.lane === "doing" ? "◐" : t.lane === "blocked" ? "!" : "●"} ${t.lane.padEnd(7)} ${String(t.id).slice(0, 8)}  ${t.title}`).join("\n") : "No active bounded tasks." });
    return;
  }
  if (name === "proof") {
    const jobs = latestJobs().slice(0, 6);
    messages.push({ role: "hii", status: "ready", text: jobs.length ? jobs.map((j) => `${j.status === "completed" ? "✓" : "!"} ${String(j.id).slice(0, 8)}  ${j.status}  ·  ${(j.proofArtifacts || []).length} proof`).join("\n") : "No receipts yet. Completion remains unverified." });
    return;
  }
  if (name === "status") {
    const daemon = daemonState();
    messages.push({ role: "hii", status: "ready", text: `hiid ${daemon.alive ? "online" : "offline"}\nautonomy: ${daemon.autonomy}\napproval required: destructive, external, financial, secret-bearing actions` });
    return;
  }
  if (name === "stop") return stopActive();
  if (name === "resume") {
    messages.push({ role: "hii", status: "ready", text: `Current session: ${sessionId}\nTranscript: ${sessionFile}\nSession picker is the next persistence layer; no session was changed.` });
    return;
  }
  messages.push({ role: "hii", status: "failed", text: `Unknown command /${name}. Type /help.` });
}

function stopActive() {
  if (!activeRun) { notice = "no active run"; return; }
  spawnSync(process.execPath, [HIID, "codex", "stop", activeRun], { cwd: ROOT, stdio: "ignore", env: process.env });
  lastRunStatus = "stopped";
  messages.push({ role: "hii", text: `Stopped ${activeRun}.`, status: "stopped", runId: activeRun });
  persist({ type: "run.stopped", runId: activeRun });
  activeRun = null;
  notice = "run stopped · composer ready";
}

function pollRun() {
  if (!activeRun) return;
  const run = readJson(path.join(RUNS, `${activeRun}.json`), null);
  if (!run) return;
  lastRunStatus = run.status;
  const placeholder = messages.findLast((message) => message.runId === activeRun && ["queued", "running"].includes(message.status));
  if (placeholder) placeholder.status = run.status;
  if (!["completed", "failed", "stopped"].includes(run.status)) return;
  const finishedId = activeRun;
  if (placeholder) {
    placeholder.text = run.status === "completed" ? cleanRunOutput(run.log) : `The managed run ${run.status}. Inspect ${run.log}`;
    placeholder.status = run.status;
  }
  persist({ type: "run.finished", runId: finishedId, status: run.status, log: run.log });
  activeRun = null;
  notice = run.status === "completed" ? "response complete · inspect /proof for receipts" : `run ${run.status}`;
  if (queue.length) queueRun(queue.shift());
}

function onKey(text) {
  if (text === "\u0004") return close();
  if (text === "\u0003") { if (activeRun) stopActive(); else close(); return; }
  if (text === ESC) { stopActive(); return; }
  if (text === "\r") { submit(input); render(); return; }
  if (text === "\n" || text === "\u000a") { input = `${input.slice(0, cursor)}\n${input.slice(cursor)}`; cursor += 1; return; }
  if (text === "\u007f" || text === "\b") { if (cursor > 0) { input = input.slice(0, cursor - 1) + input.slice(cursor); cursor -= 1; } return; }
  if (/^[\x20-\x7e\u00a0-\uffff]$/.test(text)) { input = input.slice(0, cursor) + text + input.slice(cursor); cursor += text.length; }
}

function onInput(chunk) {
  const text = chunk.toString("utf8");
  if (text === `${ESC}[A`) { if (history.length) { historyIndex = Math.max(0, historyIndex - 1); input = history[historyIndex] || ""; cursor = input.length; } return; }
  if (text === `${ESC}[B`) { historyIndex = Math.min(history.length, historyIndex + 1); input = history[historyIndex] || ""; cursor = input.length; return; }
  if (text === `${ESC}[D`) { cursor = Math.max(0, cursor - 1); return; }
  if (text === `${ESC}[C`) { cursor = Math.min(input.length, cursor + 1); return; }
  for (const character of text) onKey(character);
}

function close() {
  if (closed) return;
  closed = true;
  persist({ type: "session.closed" });
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(`${ansi.show}${ansi.reset}${ansi.altOff}\n`);
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("hii chat requires an interactive terminal");
  process.exit(1);
}

process.stdout.write(`${ansi.altOn}${ansi.clear}${ansi.home}${ansi.hide}`);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", onInput);
process.stdout.on("resize", render);
process.on("SIGTERM", close);
process.on("SIGHUP", close);
process.on("exit", () => process.stdout.write(`${ansi.show}${ansi.reset}`));
persist({ type: "session.started", coordinate: ROOT });
render();
setInterval(() => { frame += 1; pollRun(); render(); }, reducedMotion ? 900 : 140);
