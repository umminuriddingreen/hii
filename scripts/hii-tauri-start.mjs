#!/usr/bin/env node
import { cp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextDir = path.join(root, ".next");
const tauriNextDir = path.join(root, ".next-tauri");
const port = process.env.PORT || "3042";

async function readBuildId(dir) {
  try {
    return (await readFile(path.join(dir, "BUILD_ID"), "utf8")).trim();
  } catch {
    return null;
  }
}

const tauriBuildId = await readBuildId(tauriNextDir);

if (!tauriBuildId) {
  console.error("Missing .next-tauri/BUILD_ID. Run `npm run build:web:tauri` before starting the Tauri app.");
  process.exit(1);
}

await rm(nextDir, { recursive: true, force: true });
await cp(tauriNextDir, nextDir, {
  recursive: true,
  force: true,
  verbatimSymlinks: true
});

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: port,
    HOST: "127.0.0.1",
    HII_TAURI: "1",
    NODE_ENV: "production"
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
