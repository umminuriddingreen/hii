#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { syncIndexedCapture } from "./hii-browser-snapshot-sync.mjs";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

async function readFrame(stream) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.length;
    if (total > MAX_MESSAGE_BYTES + 4) {
      throw new Error(`native message exceeds ${MAX_MESSAGE_BYTES} bytes`);
    }
  }
  const buffer = Buffer.concat(chunks, total);
  if (buffer.length < 4) throw new Error("native message missing length header");
  return buffer;
}

export async function readNativeMessage(stream = process.stdin) {
  const frame = await readFrame(stream);
  const length = frame.readUInt32LE(0);
  if (length > MAX_MESSAGE_BYTES) {
    throw new Error(`native message exceeds ${MAX_MESSAGE_BYTES} bytes`);
  }
  if (frame.length < length + 4) {
    throw new Error("native message ended before the frame was complete");
  }
  const body = frame.subarray(4, 4 + length);
  return JSON.parse(body.toString("utf8"));
}

export function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function writeNativeMessage(message, stream = process.stdout) {
  stream.write(encodeNativeMessage(message));
}

function hiiCommand() {
  const command = process.env.HII_CHROME_NATIVE_HII || process.env.HII_CLI || "hii";
  const args = process.env.HII_CHROME_NATIVE_HII_ARGS
    ? JSON.parse(process.env.HII_CHROME_NATIVE_HII_ARGS)
    : [];
  return { command, args };
}

function validateMessage(message) {
  if (message?.type !== "save-capture") {
    throw new Error("expected save-capture native message");
  }
  const payload = message.payload;
  if (payload?.kind !== "hii.web.capture" || payload?.schemaVersion !== 1) {
    throw new Error("expected hii.web.capture schemaVersion 1 payload");
  }
  if (payload?.authority?.localOnly !== true) {
    throw new Error("Save to HII native host only accepts localOnly captures");
  }
  return payload;
}

export function ingestCapture(payload) {
  return new Promise((resolve, reject) => {
    const { command, args } = hiiCommand();
    const child = spawn(command, [...args, "info", "ingest-web", "--input", "-", "--json"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `hii exited ${code}`).trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`hii returned invalid JSON: ${error.message}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function handleNativeMessage(message) {
  if (message?.type === "ping") return { ok: true, data: { host: "com.hii.save_to_hii" } };
  const payload = validateMessage(message);
  const data = await ingestCapture(payload);
  if (payload.capture?.method !== "extension-page-index") return { ok: true, data };
  const sync = await syncIndexedCapture(payload);
  return { ok: true, data: { ...data, browserSync: sync } };
}

async function main() {
  try {
    const message = await readNativeMessage();
    writeNativeMessage(await handleNativeMessage(message));
  } catch (error) {
    writeNativeMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
