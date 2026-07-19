#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const runtime = process.env.HII_RUNTIME_DIR || path.join(os.homedir(), ".hii");
const appServerDir = path.join(runtime, "codex", "app-server");
const socket = path.join(appServerDir, "app-server.sock");
const receipts = path.join(appServerDir, "reads.jsonl");
const args = process.argv.slice(2);

function flag(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const limit = Math.min(positiveInteger(flag("--limit", "10"), 10), 100);
const cwd = flag("--cwd");
const searchTerm = flag("--search");
const json = args.includes("--json");
const timeoutMs = positiveInteger(process.env.HII_CODEX_CLIENT_TIMEOUT_MS, 10_000);

if (!fs.existsSync(socket)) {
  console.error(`Codex app-server socket is missing: ${socket}`);
  console.error("start it with: hii codex app-server start");
  process.exit(1);
}

const websocket = new WebSocket("ws://localhost/rpc", {
  perMessageDeflate: false,
  createConnection: () => net.createConnection({ path: socket })
});
const pending = new Map();
let requestId = 0;
let notificationCount = 0;
const notificationMethods = new Map();

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject, method });
    websocket.send(JSON.stringify({ method, id, params }));
  });
}

function closeWithError(error) {
  for (const item of pending.values()) item.reject(error);
  pending.clear();
  websocket.close();
}

websocket.on("message", (raw) => {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (message.id != null && pending.has(message.id)) {
    const item = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) item.reject(new Error(`${item.method}: ${message.error.message || JSON.stringify(message.error)}`));
    else item.resolve(message.result);
    return;
  }
  if (message.method) {
    notificationCount += 1;
    notificationMethods.set(message.method, (notificationMethods.get(message.method) || 0) + 1);
  }
});

websocket.on("error", closeWithError);

const timer = setTimeout(() => closeWithError(new Error(`Codex app-server request timed out after ${timeoutMs}ms`)), timeoutMs);

try {
  await new Promise((resolve, reject) => {
    websocket.once("open", resolve);
    websocket.once("error", reject);
  });
  const initialized = await request("initialize", {
    clientInfo: { name: "hii_cli", title: "HII CLI", version: "0.1.0" }
  });
  websocket.send(JSON.stringify({ method: "initialized", params: {} }));
  const result = await request("thread/list", {
    limit,
    useStateDbOnly: true,
    ...(cwd ? { cwd } : {}),
    ...(searchTerm ? { searchTerm } : {})
  });
  const threads = Array.isArray(result?.data) ? result.data : [];
  const output = {
    ok: true,
    readOnly: true,
    server: initialized,
    count: threads.length,
    nextCursor: result?.nextCursor ?? null,
    threads: threads.map((thread) => ({
      id: thread.id,
      name: thread.name ?? null,
      cwd: thread.cwd,
      updatedAt: new Date(Number(thread.updatedAt) * 1000).toISOString(),
      status: thread.status,
      modelProvider: thread.modelProvider,
      preview: String(thread.preview || "").replace(/\s+/g, " ").slice(0, 120)
    }))
  };
  fs.mkdirSync(path.dirname(receipts), { recursive: true });
  fs.appendFileSync(receipts, `${JSON.stringify({
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: "codex.thread_list.read",
    actor: "hii_cli",
    readOnly: true,
    useStateDbOnly: true,
    filters: { limit, cwd: cwd || null, search: Boolean(searchTerm) },
    count: threads.length,
    threadRefs: threads.map((thread) => ({ id: thread.id, cwd: thread.cwd, updatedAt: thread.updatedAt })),
    notificationCount,
    notificationMethods: Object.fromEntries(notificationMethods)
  })}\n`);
  if (json) {
    console.log(JSON.stringify(output, null, 2));
  } else if (!threads.length) {
    console.log("No Codex threads matched.");
  } else {
    for (const thread of output.threads) {
      console.log(`${thread.id}  ${thread.updatedAt}  ${thread.cwd}`);
      console.log(`  ${thread.name || thread.preview || "Untitled thread"}`);
    }
    if (output.nextCursor) console.log(`\nMore threads available; returned ${threads.length}.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  websocket.close();
}
