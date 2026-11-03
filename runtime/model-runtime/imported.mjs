// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const REGISTRY = "imports.json";

export function readImportedModels(modelHome, { fsImpl = fs } = {}) {
  const file = path.join(modelHome, REGISTRY);
  if (!fsImpl.existsSync(file)) return [];
  try {
    const value = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (value.schemaVersion !== 1 || !Array.isArray(value.models) || value.models.some((entry) => !entry || typeof entry.model !== "string" || typeof entry.referencePath !== "string" || typeof entry.sourcePath !== "string")) {
      throw new Error("invalid model import registry schema");
    }
    return value.models;
  } catch (error) {
    throw new Error(`cannot read HII model import registry: ${error.message}`);
  }
}

export function importLocalModel(sourcePath, { modelHome, hfCache, model = null, existingModels = [], fsImpl = fs } = {}) {
  if (!sourcePath || !modelHome || !hfCache) throw new Error("source path, model home, and Hugging Face cache are required");
  return withRegistryLock(modelHome, fsImpl, () => importLocalModelLocked(sourcePath, { modelHome, hfCache, model, existingModels, fsImpl }));
}

function importLocalModelLocked(sourcePath, { modelHome, hfCache, model = null, existingModels = [], fsImpl = fs }) {
  const source = path.resolve(sourcePath);
  const stat = fsImpl.statSync(source);
  const imports = readImportedModels(modelHome, { fsImpl });
  if (stat.isFile() && path.extname(source).toLowerCase() === ".gguf") {
    const id = safeModelId(model || path.basename(source, path.extname(source)));
    if (id.includes("/")) throw new Error("GGUF import IDs cannot contain a slash");
    validateGguf(source, fsImpl);
    if (existingModels.includes(id)) throw new Error(`${id} already exists in HII's local model inventory`);
    const destination = path.join(modelHome, "gguf-imports", `${id}.gguf`);
    assertUnclaimed(imports, id, destination, fsImpl);
    fsImpl.mkdirSync(path.dirname(destination), { recursive: true });
    fsImpl.symlinkSync(source, destination, "file");
    const entry = { model: id, format: "gguf", sourcePath: source, referencePath: destination, importedAt: new Date().toISOString() };
    try { writeRegistry(modelHome, [...imports, entry], fsImpl); }
    catch (error) { fsImpl.unlinkSync(destination); throw error; }
    return entry;
  }
  if (!stat.isDirectory()) throw new Error("import supports a GGUF file or an MLX model directory");
  const configPath = path.join(source, "config.json");
  if (!fsImpl.existsSync(configPath) || !safeModelFile(configPath, source, fsImpl)) throw new Error("MLX directory must contain a readable config.json");
  const config = JSON.parse(fsImpl.readFileSync(configPath, "utf8"));
  const files = fsImpl.readdirSync(source);
  const weights = files.filter((name) => /^model(?:-\d+-of-\d+)?\.safetensors$/i.test(name));
  if (!weights.length) throw new Error("MLX directory must contain model.safetensors or indexed model shards");
  const indexPath = path.join(source, "model.safetensors.index.json");
  if (fsImpl.existsSync(indexPath)) {
    const index = JSON.parse(fsImpl.readFileSync(indexPath, "utf8"));
    const required = new Set(Object.values(index.weight_map || {}).filter((name) => typeof name === "string"));
    if (!required.size || [...required].some((name) => !weights.includes(name) || !nonemptyFile(path.join(source, name), fsImpl))) {
      throw new Error("MLX directory is missing one or more indexed safetensors shards");
    }
  } else if (!weights.includes("model.safetensors") || !nonemptyFile(path.join(source, "model.safetensors"), fsImpl)) {
    throw new Error("MLX directory must contain model.safetensors or a complete shard index");
  }
  for (const name of weights) {
    if (!nonemptyFile(path.join(source, name), fsImpl) || !safeModelFile(path.join(source, name), source, fsImpl)) {
      throw new Error(`MLX weight file is missing or points outside its source cache: ${name}`);
    }
  }
  if (!isMlxCompatible(model || "", config)) throw new Error("directory is not identified as an MLX model; use an mlx-community model or an MLX quantization config");
  const id = safeModelId(model || `local-import/${slug(path.basename(source))}`);
  const repo = path.join(hfCache, `models--${id.replaceAll("/", "--")}`);
  if (fsImpl.existsSync(repo)) throw new Error(`${id} already has an HII Hugging Face cache entry; choose a different --model ID to preserve the existing model`);
  const revision = `local-${createHash("sha256").update(fsImpl.realpathSync(source)).digest("hex").slice(0, 12)}`;
  const destination = path.join(repo, "snapshots", revision);
  assertUnclaimed(imports, id, destination, fsImpl);
  fsImpl.mkdirSync(path.dirname(destination), { recursive: true });
  fsImpl.mkdirSync(path.join(repo, "refs"), { recursive: true });
  fsImpl.symlinkSync(fsImpl.realpathSync(source), destination, "dir");
  try { fsImpl.writeFileSync(path.join(repo, "refs", "main"), revision, { flag: "wx" }); }
  catch (error) { fsImpl.unlinkSync(destination); cleanupEmptyDirectories(fsImpl, [path.join(repo, "snapshots"), path.join(repo, "refs"), repo]); throw error; }
  const entry = { model: id, format: "mlx-safetensors", sourcePath: fsImpl.realpathSync(source), referencePath: destination, importedAt: new Date().toISOString() };
  try {
    writeRegistry(modelHome, [...imports, entry], fsImpl);
  } catch (error) {
    fsImpl.unlinkSync(destination);
    try { fsImpl.unlinkSync(path.join(repo, "refs", "main")); } catch {}
    cleanupEmptyDirectories(fsImpl, [path.dirname(destination), path.join(repo, "refs"), repo]);
    throw error;
  }
  return entry;
}

export function removeImportedModel(model, { modelHome, fsImpl = fs } = {}) {
  return withRegistryLock(modelHome, fsImpl, () => removeImportedModelLocked(model, { modelHome, fsImpl }));
}

function removeImportedModelLocked(model, { modelHome, fsImpl }) {
  const imports = readImportedModels(modelHome, { fsImpl });
  const entry = imports.find((candidate) => candidate.model === model);
  if (!entry) return null;
  const linkStat = fsImpl.lstatSync(entry.referencePath);
  if (!linkStat.isSymbolicLink()) throw new Error(`import reference was replaced; refusing to remove ${entry.referencePath}`);
  if (fsImpl.readlinkSync(entry.referencePath) !== entry.sourcePath) throw new Error(`import reference target changed; refusing to remove ${entry.referencePath}`);
  fsImpl.unlinkSync(entry.referencePath);
  if (entry.format === "mlx-safetensors") {
    const repo = path.dirname(path.dirname(entry.referencePath));
    const ref = path.join(repo, "refs", "main");
    try {
      if (fsImpl.readFileSync(ref, "utf8").trim() === path.basename(entry.referencePath)) fsImpl.unlinkSync(ref);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    cleanupEmptyDirectories(fsImpl, [path.dirname(entry.referencePath), path.join(repo, "refs"), repo]);
  }
  const next = imports.filter((candidate) => candidate !== entry);
  writeRegistry(modelHome, next, fsImpl);
  return { ...entry, removedReference: true, sourcePreserved: fsImpl.existsSync(entry.sourcePath) };
}

export function normalizeModelCommand(args) {
  const aliases = { list: "installed", ls: "installed", pull: "install", load: "use", unload: "stop", ps: "status", serve: "start", rm: "remove" };
  const requested = args[0] || "recommend";
  if (requested === "unload" && args.length > 1) throw new Error("usage: hii model unload (stop the selected runtime; choose models with `hii model use`)");
  return [aliases[requested] || requested, ...args.slice(1)];
}

function safeModelId(value) {
  const id = String(value || "").trim();
  if (!/^[\w.-]+(?:\/[\w.-]+)?$/.test(id) || id.startsWith(".") || id.includes("..")) {
    throw new Error("model ID must contain only letters, numbers, dots, dashes, underscores, and at most one slash");
  }
  return id;
}

function slug(value) {
  return String(value).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}

function isMlxCompatible(id, config) {
  const quantization = config?.quantization;
  return /^mlx-community\//i.test(id) || Boolean(config?.mlx)
    || Boolean(quantization && Number.isInteger(quantization.bits) && Number.isInteger(quantization.group_size));
}

function assertUnclaimed(imports, id, destination, fsImpl = fs) {
  if (imports.some((entry) => entry.model === id)) throw new Error(`${id} is already imported in HII`);
  try { fsImpl.lstatSync(destination); throw new Error(`import destination already exists: ${destination}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function validateGguf(file, fsImpl) {
  if (!nonemptyFile(file, fsImpl)) throw new Error("GGUF file is empty or unreadable");
  const descriptor = fsImpl.openSync(file, "r");
  try {
    const header = Buffer.alloc(4);
    const bytes = fsImpl.readSync(descriptor, header, 0, 4, 0);
    if (bytes !== 4 || header.toString("ascii") !== "GGUF") throw new Error("file is not a valid GGUF model (missing GGUF header)");
  } finally { fsImpl.closeSync(descriptor); }
}

function nonemptyFile(file, fsImpl) {
  try { const stat = fsImpl.statSync(file); return stat.isFile() && stat.size > 0; } catch { return false; }
}

function safeModelFile(file, source, fsImpl) {
  try {
    const realFile = fsImpl.realpathSync(file);
    const realSource = fsImpl.realpathSync(source);
    if (realFile === realSource || realFile.startsWith(`${realSource}${path.sep}`)) return true;
    const parts = path.resolve(realSource).split(path.sep);
    const snapshotIndex = parts.lastIndexOf("snapshots");
    if (snapshotIndex >= 1) {
      const repo = parts.slice(0, snapshotIndex).join(path.sep) || path.sep;
      const realRepo = fsImpl.realpathSync(repo);
      return realFile.startsWith(`${realRepo}${path.sep}`);
    }
    return false;
  } catch { return false; }
}

function withRegistryLock(modelHome, fsImpl, operation) {
  fsImpl.mkdirSync(modelHome, { recursive: true });
  const lock = path.join(modelHome, `${REGISTRY}.lock`);
  try { fsImpl.mkdirSync(lock); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("another model import or removal is in progress; retry shortly");
    throw error;
  }
  try { return operation(); }
  finally { fsImpl.rmdirSync(lock); }
}

function cleanupEmptyDirectories(fsImpl, directories) {
  for (const directory of directories) {
    try { fsImpl.rmdirSync(directory); } catch (error) { if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT" && error.code !== "EEXIST") throw error; }
  }
}

function writeRegistry(modelHome, models, fsImpl) {
  fsImpl.mkdirSync(modelHome, { recursive: true });
  const file = path.join(modelHome, REGISTRY);
  const temporary = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, models }, null, 2)}\n`, { flag: "wx" });
  try { fsImpl.renameSync(temporary, file); } catch (error) { fsImpl.rmSync(temporary, { force: true }); throw error; }
}
