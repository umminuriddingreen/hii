import fs from "node:fs";
import path from "node:path";

function walk(directory, results, root = directory) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, results, root);
    else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(".gguf")) {
      let stat;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      if (!stat.isFile()) continue;
      results.push({
        id: path.basename(entry.name, path.extname(entry.name)),
        modelPath: fullPath,
        relativePath: path.relative(root, fullPath),
        sizeBytes: stat.size
      });
    }
  }
}

/** Find installed GGUF files in HII-managed and explicitly configured model folders. */
export function discoverGgufModels(directories = []) {
  const discovered = new Map();
  for (const directory of [...new Set(directories.filter(Boolean).map((value) => path.resolve(value)))]) {
    const files = [];
    walk(directory, files, directory);
    for (const file of files) {
      const key = path.resolve(file.modelPath);
      if (!discovered.has(key)) discovered.set(key, file);
    }
  }
  const files = [...discovered.values()];
  const counts = new Map();
  for (const file of files) counts.set(file.id, (counts.get(file.id) || 0) + 1);
  return files
    .map((file) => ({ ...file, id: counts.get(file.id) > 1
      ? file.relativePath.replace(/\.gguf$/i, "").replace(/[\\/]+/g, "__")
      : file.id }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function resolveGgufModel(models, value) {
  const requested = String(value || "").trim();
  if (!requested) return null;
  return models.find((model) => model.id === requested
    || model.modelPath === requested
    || path.basename(model.modelPath) === requested) || null;
}

/** Prefer HII's staged llama.cpp bundle, then the operator-configured or PATH binary. */
export function resolveMacLlamaServerBin({ configuredPath, bundledPath, pathPath } = {}) {
  for (const candidate of [configuredPath, bundledPath, pathPath]) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export function selectMacGguf(models, {
  llamaAvailable,
  requestedModel = null,
  preferredModel = null
} = {}) {
  if (!models.length) return null;
  if (requestedModel) return resolveGgufModel(models, requestedModel);
  if (preferredModel) return resolveGgufModel(models, preferredModel);
  return llamaAvailable ? models[0] : null;
}

export function selectDefaultMacGguf(models, llamaAvailable, preferredModel = null) {
  return selectMacGguf(models, { llamaAvailable, preferredModel });
}

export function buildMacLlamaLaunchPlan({ binary, modelPath, modelId, endpoint, contextTokens = 16384 }) {
  if (!binary || !modelPath || !modelId || !endpoint) throw new Error("llama.cpp requires a binary, installed GGUF, model ID, and endpoint");
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Managed llama.cpp must bind to loopback HTTP");
  }
  const context = Number(contextTokens);
  if (!Number.isInteger(context) || context < 512 || context > 262144) throw new Error("Context must be between 512 and 262144 tokens");
  return {
    command: binary,
    args: ["--model", modelPath, "--alias", modelId, "--host", "127.0.0.1", "--port", url.port || "80", "--ctx-size", String(context), "--n-gpu-layers", "999", "--flash-attn", "on", "--parallel", "1", "--jinja", "--reasoning", "off", "--no-webui"],
    endpoint: url.origin,
    backend: "llama.cpp",
    model: modelId,
    modelPath,
    contextTokens: context
  };
}

export function isLlamaServerCommand(command, binary = "llama-server") {
  const value = String(command || "").toLowerCase();
  const expected = path.basename(binary).toLowerCase();
  return value.split(/\s+/).some((part) => path.basename(part.replace(/^['"]|['"]$/g, "")) === expected);
}
