#!/usr/bin/env node
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const portableDir = path.join(root, ".hii-app");
const nodeRuntime = path.join(portableDir, "bin", "node");
const serverDir = path.join(portableDir, "server");
const port = process.env.PORT || "3042";

try {
  await access(nodeRuntime);
  await access(path.join(serverDir, "server.mjs"));
} catch {
  console.error("Missing .hii-app portable runtime. Run `npm run build:web:tauri` first.");
  process.exit(1);
}

const child = spawn(nodeRuntime, ["server.mjs"], {
  cwd: serverDir,
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
