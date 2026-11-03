// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";

const WEIGHT_FILE = /\.safetensors$/i;

export function mergeInstalledModels(ggufModels, mlxModels) {
  const seen = new Set();
  return [...ggufModels, ...mlxModels].flatMap((model) => {
    const id = model.model || model.id;
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ ...model, model: id }];
  });
}

/** Discover complete Hugging Face safetensors snapshots in a Hub cache. */
export function discoverCachedMlxModels(cacheDir, { fsImpl = fs, imported = [] } = {}) {
  let repos;
  try {
    repos = fsImpl.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const discovered = [];
  for (const repoEntry of repos) {
    if (!repoEntry.name.startsWith("models--")) continue;
    const model = repoEntry.name.slice("models--".length).replaceAll("--", "/");
    if (!model.includes("/")) continue;
    const repoPath = path.join(cacheDir, repoEntry.name);
    let snapshotEntries;
    try {
      snapshotEntries = fsImpl.readdirSync(path.join(repoPath, "snapshots"), { withFileTypes: true });
    } catch {
      continue;
    }

    const refs = readRefs(fsImpl, path.join(repoPath, "refs"));
    const candidates = snapshotEntries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => ({ path: path.join(repoPath, "snapshots", entry.name), revision: entry.name }))
      .filter((snapshot) => isCompleteSnapshot(fsImpl, snapshot.path, model, cacheDir))
      .sort((a, b) => Number(refs.has(b.revision)) - Number(refs.has(a.revision)) || b.revision.localeCompare(a.revision));
    const selected = candidates[0];
    if (!selected) continue;
    const weightFiles = listWeightFiles(fsImpl, selected.path, cacheDir);
    discovered.push({
      model,
      logicalModel: model,
      role: "Installed local MLX",
      bestFor: "An installed MLX safetensors model served by the HII native runner",
      backend: "mlx",
      source: "huggingface-cache",
      format: "mlx-safetensors",
      modelPath: selected.path,
      sizeBytes: weightFiles.reduce((sum, file) => sum + file.size, 0),
      installed: true
    });
  }
  for (const item of imported) {
    if (item?.format !== "mlx-safetensors" || !item.model || !item.referencePath || !item.sourcePath) continue;
    try {
      if (!fsImpl.lstatSync(item.referencePath).isSymbolicLink()
        || fsImpl.realpathSync(item.referencePath) !== fsImpl.realpathSync(item.sourcePath)) continue;
      if (!isCompleteSnapshot(fsImpl, item.referencePath, item.model, cacheDir, item.sourcePath)) continue;
      const weightFiles = listWeightFiles(fsImpl, item.referencePath, cacheDir, item.sourcePath);
      const duplicate = discovered.findIndex((entry) => entry.model === item.model);
      if (duplicate >= 0) discovered.splice(duplicate, 1);
      discovered.push({
        model: item.model,
        logicalModel: item.model,
        role: "Imported local MLX",
        bestFor: "An imported MLX model linked into HII's local model index",
        backend: "mlx",
        source: "local-import",
        format: "mlx-safetensors",
        modelPath: item.referencePath,
        sourcePath: item.sourcePath,
        sizeBytes: weightFiles.reduce((sum, file) => sum + file.size, 0),
        installed: true
      });
    } catch {}
  }
  return discovered.sort((a, b) => a.model.localeCompare(b.model));
}

function readRefs(fsImpl, refsPath) {
  const refs = new Set();
  let entries;
  try {
    entries = fsImpl.readdirSync(refsPath, { withFileTypes: true });
  } catch {
    return refs;
  }
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    try {
      const revision = fsImpl.readFileSync(path.join(refsPath, entry.name), "utf8").trim();
      if (revision) refs.add(revision);
    } catch {}
  }
  return refs;
}

function isCompleteSnapshot(fsImpl, snapshotPath, model, cacheDir, importedSource = null) {
  try {
    const configPath = path.join(snapshotPath, "config.json");
    if (!isSafeFile(fsImpl, configPath, cacheDir, importedSource)) return false;
    const config = JSON.parse(fsImpl.readFileSync(configPath, "utf8"));
    if (!isMlxModel(model, config)) return false;
    const indexPath = path.join(snapshotPath, "model.safetensors.index.json");
    let expectedShards = null;
    if (fsImpl.existsSync(indexPath)) {
      if (!isSafeFile(fsImpl, indexPath, cacheDir, importedSource)) return false;
      const index = JSON.parse(fsImpl.readFileSync(indexPath, "utf8"));
      if (!index.weight_map || typeof index.weight_map !== "object") return false;
      expectedShards = [...new Set(Object.values(index.weight_map).filter((name) => typeof name === "string"))];
      if (!expectedShards.length) return false;
    }
    const weights = listWeightFiles(fsImpl, snapshotPath, cacheDir, importedSource);
    if (expectedShards) {
      const available = new Set(weights.map((file) => file.name));
      return expectedShards.every((name) => available.has(name));
    }
    return weights.length === 1 && weights[0].name === "model.safetensors";
  } catch {
    return false;
  }
}

function isMlxModel(model, config) {
  const quantization = config.quantization;
  return model.toLowerCase().startsWith("mlx-community/")
    || Boolean(config.mlx)
    || Boolean(quantization && typeof quantization === "object"
      && Number.isInteger(quantization.bits)
      && Number.isInteger(quantization.group_size));
}

function isSafeFile(fsImpl, filePath, cacheDir, importedSource = null) {
  try {
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return false;
    const realFile = fsImpl.realpathSync(filePath);
    const realCache = fsImpl.realpathSync(cacheDir);
    if (realFile.startsWith(`${realCache}${path.sep}`)) return true;
    if (importedSource) {
      const realSource = fsImpl.realpathSync(importedSource);
      if (realFile.startsWith(`${realSource}${path.sep}`) || realFile === realSource) return true;
      // Hugging Face snapshots commonly use relative links into their sibling blobs directory.
      const sourceParts = path.resolve(importedSource).split(path.sep);
      const snapshotIndex = sourceParts.lastIndexOf("snapshots");
      if (snapshotIndex >= 1) {
        const repoRoot = sourceParts.slice(0, snapshotIndex).join(path.sep) || path.sep;
        const realRepo = fsImpl.realpathSync(repoRoot);
        return realFile.startsWith(`${realRepo}${path.sep}`);
      }
    }
    return false;
  } catch {
    return false;
  }
}

function listWeightFiles(fsImpl, snapshotPath, cacheDir, importedSource = null) {
  let entries;
  try {
    entries = fsImpl.readdirSync(snapshotPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => WEIGHT_FILE.test(entry.name)).flatMap((entry) => {
    try {
      const file = path.join(snapshotPath, entry.name);
      if (!isSafeFile(fsImpl, file, cacheDir, importedSource)) return [];
      const stat = fsImpl.statSync(file);
      return [{ name: entry.name, size: stat.size }];
    } catch {
      return [];
    }
  });
}
