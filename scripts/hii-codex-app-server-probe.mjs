#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const pinned = path.join(os.homedir(), ".local", "bin", "codex");
const codex = process.env.HII_CODEX_BIN || (fs.existsSync(pinned) ? pinned : "codex");
const timeoutMs = Number(process.env.HII_CODEX_PROBE_TIMEOUT_MS || 10_000);
const child = spawn(codex, ["app-server", "--listen", "stdio://"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"]
});

let stderr = "";
let settled = false;

function finish(code, payload) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  child.kill("SIGTERM");
  if (payload) console.log(JSON.stringify(payload, null, 2));
  process.exitCode = code;
}

child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-4_000);
});

child.on("error", (error) => {
  finish(1, { ok: false, error: error.message, codex });
});

child.on("exit", (code) => {
  if (!settled) finish(1, { ok: false, error: `app-server exited with ${code}`, stderr: stderr.trim(), codex });
});

const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== 1) return;
  if (message.error) {
    finish(1, { ok: false, error: message.error, codex });
    return;
  }
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  finish(0, {
    ok: true,
    transport: "stdio-jsonl",
    client: "hii_cli",
    codex,
    server: message.result
  });
});

child.stdin.write(`${JSON.stringify({
  method: "initialize",
  id: 1,
  params: {
    clientInfo: {
      name: "hii_cli",
      title: "HII CLI",
      version: "0.1.0"
    }
  }
})}\n`);

const timer = setTimeout(() => {
  finish(1, { ok: false, error: `initialize timed out after ${timeoutMs}ms`, stderr: stderr.trim(), codex });
}, timeoutMs);
