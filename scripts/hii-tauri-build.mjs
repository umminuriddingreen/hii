#!/usr/bin/env node
import { cp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextDir = path.join(root, ".next");
const tauriNextDir = path.join(root, ".next-tauri");

await rm(nextDir, { recursive: true, force: true });
await rm(tauriNextDir, { recursive: true, force: true });

const build = spawnSync("npm", ["run", "build:web"], {
  cwd: root,
  stdio: "inherit",
  env: process.env
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

await cp(nextDir, tauriNextDir, {
  recursive: true,
  force: true,
  verbatimSymlinks: true
});

console.log(`hii tauri sidecar build copied ${path.relative(root, nextDir)} -> ${path.relative(root, tauriNextDir)}`);
