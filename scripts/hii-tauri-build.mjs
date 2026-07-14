#!/usr/bin/env node
import { access, chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextDir = path.join(root, ".next");
const portableDir = path.join(root, ".hii-app");
const serverDir = path.join(portableDir, "server");
const runtimeDir = path.join(portableDir, "bin");

await rm(nextDir, { recursive: true, force: true });
await rm(portableDir, { recursive: true, force: true });

const build = spawnSync("npm", ["run", "build:web"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, HII_TAURI: "1" }
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const standaloneDir = path.join(nextDir, "standalone");
try {
  await access(path.join(standaloneDir, "server.js"));
} catch {
  console.error("Missing Next.js standalone server output.");
  process.exit(1);
}

await cp(standaloneDir, serverDir, {
  recursive: true,
  force: true,
  verbatimSymlinks: true
});

await cp(path.join(nextDir, "static"), path.join(serverDir, ".next", "static"), {
  recursive: true,
  force: true
});
await cp(path.join(root, "public"), path.join(serverDir, "public"), {
  recursive: true,
  force: true
});
await cp(path.join(root, "server.mjs"), path.join(serverDir, "server.mjs"), { force: true });
await cp(path.join(root, "server"), path.join(serverDir, "server"), { recursive: true, force: true });
await cp(path.join(root, "node_modules", "next"), path.join(serverDir, "node_modules", "next"), {
  recursive: true,
  force: true
});
await cp(path.join(root, "node_modules", "ws"), path.join(serverDir, "node_modules", "ws"), {
  recursive: true,
  force: true
});
await cp(path.join(root, "node_modules", "node-pty"), path.join(serverDir, "node_modules", "node-pty"), {
  recursive: true,
  force: true
});
await mkdir(path.join(serverDir, "aii", "capabilities"), { recursive: true });
await cp(
  path.join(root, "aii", "capabilities", "registry.json"),
  path.join(serverDir, "aii", "capabilities", "registry.json"),
  { force: true }
);

async function voltaRuntimes() {
  const base = path.join(os.homedir(), ".volta", "tools", "image", "node");
  try {
    const versions = (await readdir(base)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return versions.map((version) => path.join(base, version, "bin", "node"));
  } catch {
    return [];
  }
}

function runtimeWorks(candidate) {
  const probe = spawnSync(candidate, ["-e", "require('node:sqlite'); process.stdout.write(process.arch)"], {
    encoding: "utf8"
  });
  if (probe.status !== 0 || probe.stdout.trim() !== process.arch) return false;
  if (process.platform === "darwin") {
    const links = spawnSync("otool", ["-L", candidate], { encoding: "utf8" });
    if (links.status !== 0 || /@rpath\/libnode|\/opt\/homebrew\//.test(links.stdout)) return false;
  }
  return true;
}

const runtimeCandidates = [process.env.HII_NODE_RUNTIME, ...(await voltaRuntimes()), process.execPath].filter(Boolean);
const nodeRuntime = runtimeCandidates.find(runtimeWorks);
if (!nodeRuntime) {
  console.error("No portable Node runtime with node:sqlite support was found. Set HII_NODE_RUNTIME to a monolithic Node binary.");
  process.exit(1);
}

await mkdir(runtimeDir, { recursive: true });
const bundledNode = path.join(runtimeDir, "node");
await cp(nodeRuntime, bundledNode, { force: true });
await chmod(bundledNode, 0o755);
await chmod(path.join(serverDir, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"), 0o755).catch(() => {});

console.log(`hii portable runtime: ${nodeRuntime}`);
console.log(`hii app resources: ${path.relative(root, portableDir)}`);
