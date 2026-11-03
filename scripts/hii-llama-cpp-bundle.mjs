#!/usr/bin/env node
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

function command(name, args) {
  const result = spawnSync(name, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.error?.message || `${name} ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function parseArgs(args) {
  const options = { runtimeDir: path.join(os.homedir(), ".hii", "runtimes", "llama.cpp"), dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--server") options.server = args[++index];
    else if (arg === "--bench") options.bench = args[++index];
    else if (arg === "--runtime-dir") options.runtimeDir = args[++index];
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function resolveTool(option, fallback) {
  if (option) return path.resolve(option);
  const found = spawnSync("which", [fallback], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0] : null;
}

function isSystemLibrary(dependency) {
  return dependency.startsWith("/System/Library/") || dependency.startsWith("/usr/lib/");
}

function dependencies(binary) {
  return command("otool", ["-L", binary]).split(/\r?\n/).slice(1)
    .map((line) => line.trim().replace(/ \(compatibility version.*$/, ""))
    .filter(Boolean);
}

function rpaths(binary) {
  const lines = command("otool", ["-l", binary]).split(/\r?\n/);
  const paths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "cmd LC_RPATH") continue;
    const match = lines[index + 2]?.match(/^\s*path (.+) \(offset \d+\)$/);
    if (match) paths.push(match[1]);
  }
  return paths;
}

function resolveReference(reference, loader, executableDir) {
  const candidates = [];
  if (reference.startsWith("@loader_path/")) {
    candidates.push(path.resolve(path.dirname(loader), reference.slice("@loader_path/".length)));
  } else if (reference.startsWith("@executable_path/")) {
    candidates.push(path.resolve(executableDir, reference.slice("@executable_path/".length)));
  } else if (reference.startsWith("@rpath/")) {
    const suffix = reference.slice("@rpath/".length);
    for (const rpath of rpaths(loader)) {
      if (rpath.startsWith("@loader_path/")) {
        candidates.push(path.resolve(path.dirname(loader), rpath.slice("@loader_path/".length), suffix));
      } else if (rpath.startsWith("@executable_path/")) {
        candidates.push(path.resolve(executableDir, rpath.slice("@executable_path/".length), suffix));
      } else if (path.isAbsolute(rpath)) {
        candidates.push(path.resolve(rpath, suffix));
      }
    }
  } else if (path.isAbsolute(reference)) {
    candidates.push(reference);
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ? realpathSync(found) : null;
}

function digest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/hii-llama-cpp-bundle.mjs [--server PATH] [--bench PATH] [--runtime-dir PATH] [--dry-run]");
    return;
  }
  if (process.platform !== "darwin") throw new Error("llama.cpp bundling is supported on macOS only");

  const binaries = [
    { name: "llama-server", source: resolveTool(options.server, "llama-server") },
    { name: "llama-bench", source: resolveTool(options.bench, "llama-bench") }
  ];
  for (const binary of binaries) {
    if (!binary.source || !existsSync(binary.source) || !statSync(binary.source).isFile()) {
      throw new Error(`Missing ${binary.name}; pass --${binary.name === "llama-server" ? "server" : "bench"} or install llama.cpp first`);
    }
    binary.source = realpathSync(binary.source);
    if (!command("file", [binary.source]).includes("Mach-O")) throw new Error(`${binary.source} is not a Mach-O binary`);
  }

  const executableDir = path.dirname(binaries[0].source);
  const queue = binaries.map((binary) => ({ ...binary, kind: "executable" }));
  const sources = new Map(queue.map((entry) => [entry.source, entry]));
  for (let index = 0; index < queue.length; index += 1) {
    const loader = queue[index].source;
    for (const reference of dependencies(loader)) {
      if (isSystemLibrary(reference)) continue;
      const source = resolveReference(reference, loader, executableDir);
      if (!source) throw new Error(`Unresolved non-system dependency ${reference} required by ${loader}`);
      if (!sources.has(source)) {
        const name = path.basename(source);
        const existing = [...sources.values()].find((entry) => entry.name === name && entry.source !== source);
        if (existing) throw new Error(`Two distinct dependencies share the name ${name}`);
        const entry = { name, source, kind: "library" };
        sources.set(source, entry);
        queue.push(entry);
      }
    }
  }

  const ggmlBase = [...sources.values()].find((entry) => /^libggml-base(?:\.|-)/.test(entry.name));
  const backendDir = ggmlBase ? path.resolve(path.dirname(ggmlBase.source), "../libexec") : null;
  const plugins = backendDir && existsSync(backendDir)
    ? readdirSync(backendDir).filter((name) => /^libggml-.+\.so$/.test(name)).map((name) => ({
        name,
        source: realpathSync(path.join(backendDir, name)),
        kind: "plugin"
      }))
    : [];
  for (const plugin of plugins) {
    if (sources.has(plugin.source)) continue;
    const collision = [...sources.values()].find((entry) => entry.name === plugin.name && entry.source !== plugin.source);
    if (collision) throw new Error(`Two distinct dependencies share the name ${plugin.name}`);
    sources.set(plugin.source, plugin);
    queue.push(plugin);
  }
  const firstPluginIndex = queue.length - plugins.length;
  for (let index = firstPluginIndex; index < queue.length; index += 1) {
    const loader = queue[index].source;
    for (const reference of dependencies(loader)) {
      if (isSystemLibrary(reference)) continue;
      const source = resolveReference(reference, loader, executableDir);
      if (!source) throw new Error(`Unresolved non-system dependency ${reference} required by ${loader}`);
      if (!sources.has(source)) {
        const name = path.basename(source);
        const existing = [...sources.values()].find((entry) => entry.name === name && entry.source !== source);
        if (existing) throw new Error(`Two distinct dependencies share the name ${name}`);
        const entry = { name, source, kind: "library" };
        sources.set(source, entry);
        queue.push(entry);
      }
    }
  }

  const runtimeDir = path.resolve(options.runtimeDir);
  const plan = {
    runtimeDir,
    binaries: binaries.map(({ name, source }) => ({ name, source, sha256: digest(source) })),
    libraries: [...sources.values()].filter((entry) => entry.kind === "library").map(({ name, source }) => ({ name, source, sha256: digest(source) })),
    backendPlugins: plugins.map(({ name, source }) => ({ name, source, sha256: digest(source) }))
  };
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, ...plan }, null, 2)}\n`);
    return;
  }

  const parent = path.dirname(runtimeDir);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(path.join(parent, ".llama.cpp-staging-"));
  const backup = `${runtimeDir}.previous-${process.pid}`;
  try {
    mkdirSync(path.join(staging, "bin"), { recursive: true });
    mkdirSync(path.join(staging, "lib"), { recursive: true });
    for (const binary of binaries) {
      const output = path.join(staging, "bin", binary.name);
      copyFileSync(binary.source, output);
      chmodSync(output, 0o755);
    }
    for (const entry of sources.values()) {
      if (entry.kind === "library") {
        const output = path.join(staging, "lib", entry.name);
        copyFileSync(entry.source, output);
        chmodSync(output, 0o644);
      } else if (entry.kind === "plugin") {
        const output = path.join(staging, "bin", entry.name);
        copyFileSync(entry.source, output);
        chmodSync(output, 0o644);
      }
    }

    for (const sourceEntry of sources.values()) {
      const output = sourceEntry.kind === "executable"
        ? path.join(staging, "bin", sourceEntry.name)
        : sourceEntry.kind === "plugin"
          ? path.join(staging, "bin", sourceEntry.name)
          : path.join(staging, "lib", sourceEntry.name);
      for (const reference of dependencies(sourceEntry.source)) {
        if (isSystemLibrary(reference)) continue;
        const source = resolveReference(reference, sourceEntry.source, executableDir);
        const dependency = sources.get(source);
        if (!dependency) throw new Error(`Dependency mapping disappeared for ${reference}`);
        const replacement = sourceEntry.kind === "library"
          ? `@loader_path/${dependency.name}`
          : `@loader_path/../lib/${dependency.name}`;
        command("install_name_tool", ["-change", reference, replacement, output]);
      }
      if (sourceEntry.kind === "library") {
        command("install_name_tool", ["-id", `@rpath/${sourceEntry.name}`, output]);
      }
      command("codesign", ["--force", "--sign", "-", output]);
    }

    writeFileSync(path.join(staging, "bundle.json"), `${JSON.stringify({ schema: "hii-llama-cpp-bundle-v1", createdAt: new Date().toISOString(), ...plan }, null, 2)}\n`);
    if (existsSync(runtimeDir)) renameSync(runtimeDir, backup);
    try {
      renameSync(staging, runtimeDir);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, runtimeDir);
      throw error;
    }
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify({ ok: true, installed: true, ...plan }, null, 2)}\n`);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
