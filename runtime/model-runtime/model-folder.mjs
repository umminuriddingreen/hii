// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_DIRS = 10_000;
const WEIGHT_RE = /\.safetensors$/i;
const TOKENIZER_FILES = ["tokenizer.json", "tokenizer.model", "spiece.model", "vocab.json"];
const IMAGE_ONLY_RE = /(?:^|[-_])(stable[-_]?diffusion|diffusion|flux|sdxl|clip|siglip|vae|unet|vit)(?:$|[-_])/i;

/** Resolve HII's model storage location. A configured runtime keeps its historical models/ child. */
export function resolveModelHome({ env = process.env, home, runtime } = {}) {
  const configured = typeof env.HII_MODEL_HOME === "string" ? env.HII_MODEL_HOME.trim() : "";
  if (configured) return path.resolve(configured.replace(/^~(?=$|[\\/])/, home || ""));
  const runtimeRoot = runtime || env.HII_RUNTIME_DIR;
  return path.resolve(runtimeRoot ? path.join(runtimeRoot, "models") : path.join(home || process.env.HOME || ".", "models"));
}

/**
 * Read-only scan of a model folder. Traversal is depth and directory bounded; symlink
 * directories are not followed, preventing cycles and accidental scans outside the folder.
 */
export function scanModelFolder(root, { fsImpl = fs, maxDepth = DEFAULT_MAX_DEPTH, maxDirs = DEFAULT_MAX_DIRS } = {}) {
  if (!root || !Number.isInteger(maxDepth) || maxDepth < 0 || !Number.isInteger(maxDirs) || maxDirs < 1) return [];
  let canonicalRoot;
  try {
    canonicalRoot = fsImpl.realpathSync(root);
    if (!fsImpl.statSync(canonicalRoot).isDirectory()) return [];
  } catch {
    return [];
  }

  const results = [];
  const visited = new Set();
  let dirsVisited = 0;
  const walk = (directory, depth) => {
    if (depth > maxDepth || dirsVisited >= maxDirs) return;
    let canonical;
    try {
      canonical = fsImpl.realpathSync(directory);
      if (!isWithin(canonicalRoot, canonical) || visited.has(canonical)) return;
      visited.add(canonical);
      dirsVisited += 1;
    } catch { return; }

    const components = path.relative(canonicalRoot, canonical).split(path.sep).filter(Boolean);
    if (isHubCachePath(components)) return;

    const mlx = inspectMlxDirectory(canonical, fsImpl);
    if (mlx) {
      results.push(mlx);
      return;
    }

    let entries;
    try { entries = fsImpl.readdirSync(canonical, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.gguf$/i.test(entry.name) || isAuxiliaryGguf(entry.name)) continue;
      const filePath = path.join(canonical, entry.name);
      try {
        const realPath = fsImpl.realpathSync(filePath);
        const stat = fsImpl.statSync(realPath);
        if (!isWithin(canonicalRoot, realPath) || !stat.isFile() || stat.size < 4 || !hasGgufMagic(fsImpl, realPath)) continue;
        results.push({
          model: path.basename(entry.name, path.extname(entry.name)),
          backend: "llama.cpp",
          modelPath: realPath,
          format: "gguf",
          source: "model-folder",
          sizeBytes: stat.size,
          installed: true
        });
      } catch {}
    }
    if (depth === maxDepth || dirsVisited >= maxDirs) return;
    for (const entry of entries) {
      // Do not traverse symlinks: they may point outside the selected folder or form cycles.
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (isCacheDirectory(entry.name)) continue;
      walk(path.join(canonical, entry.name), depth + 1);
      if (dirsVisited >= maxDirs) break;
    }
  };

  walk(canonicalRoot, 0);
  return deduplicate(results).sort((a, b) => a.model.localeCompare(b.model) || a.modelPath.localeCompare(b.modelPath));
}

function inspectMlxDirectory(directory, fsImpl) {
  try {
    const configPath = path.join(directory, "config.json");
    const configStat = fsImpl.statSync(configPath);
    if (!configStat.isFile() || configStat.size <= 0) return null;
    const config = JSON.parse(fsImpl.readFileSync(configPath, "utf8"));
    if (!isMlxConfig(config, path.basename(directory)) || isImageOnlyConfig(config)) return null;
    const entries = fsImpl.readdirSync(directory, { withFileTypes: true });
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    if (!TOKENIZER_FILES.some((name) => names.has(name)) && !(names.has("vocab.json") && names.has("merges.txt"))) return null;
    const weights = entries.filter((entry) => entry.isFile() && WEIGHT_RE.test(entry.name));
    if (!weights.length) return null;

    const indexPath = path.join(directory, "model.safetensors.index.json");
    if (names.has("model.safetensors.index.json")) {
      const index = JSON.parse(fsImpl.readFileSync(indexPath, "utf8"));
      const expected = index?.weight_map && [...new Set(Object.values(index.weight_map).filter((name) => typeof name === "string"))];
      if (!expected?.length || expected.some((name) => !names.has(name))) return null;
    } else if (!names.has("model.safetensors")) {
      if (!hasCompleteNumberedShards(weights.map((entry) => entry.name))) return null;
    }
    const sizeBytes = weights.reduce((sum, entry) => sum + fsImpl.statSync(path.join(directory, entry.name)).size, 0);
    if (sizeBytes <= 0) return null;
    return {
      model: inferMlxModel(config, path.basename(directory)),
      backend: "mlx",
      modelPath: fsImpl.realpathSync(directory),
      format: "mlx-safetensors",
      source: "model-folder",
      sizeBytes,
      installed: true
    };
  } catch {
    return null;
  }
}

function isMlxConfig(config, directoryName) {
  const q = config?.quantization;
  return directoryName.startsWith("mlx-community--")
    || Boolean(config?.mlx)
    || Boolean(q && Number.isInteger(q.bits) && Number.isInteger(q.group_size))
    || Array.isArray(config?.architectures) && config.architectures.some((name) => /Mlx|MLX/.test(name));
}

function isImageOnlyConfig(config) {
  const identity = [config?.model_type, ...(Array.isArray(config?.architectures) ? config.architectures : [])].filter(Boolean).join(" ");
  return IMAGE_ONLY_RE.test(identity) && !/(?:ForCausalLM|ForConditionalGeneration|TextGeneration)/i.test(identity);
}

function inferMlxModel(config, directoryName) {
  const configured = typeof config?._name_or_path === "string" ? config._name_or_path.trim() : "";
  if (configured && !path.isAbsolute(configured) && !configured.startsWith(".")) return configured.replaceAll("\\", "/");
  const normalized = directoryName.replaceAll("--", "/");
  return normalized.includes("/") ? normalized : `local/${normalized}`;
}

function isHubCachePath(components) {
  return components.some((name, i) => name === "blobs" || name === "snapshots"
    || (name === "hub" && components[i - 1] === "huggingface")
    || name.startsWith("models--"));
}

function isCacheDirectory(name) {
  return name === "blobs" || name === "snapshots" || name === "hub" || name.startsWith("models--");
}

function isAuxiliaryGguf(name) {
  return /(?:^|[-_.])(mmproj|projector|clip|vision[-_]?projector)(?:[-_.]|$)/i.test(name);
}

function hasGgufMagic(fsImpl, filePath) {
  let fd;
  try {
    fd = fsImpl.openSync(filePath, "r");
    const magic = Buffer.alloc(4);
    return fsImpl.readSync(fd, magic, 0, 4, 0) === 4 && magic.toString("ascii") === "GGUF";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch {}
    }
  }
}

function hasCompleteNumberedShards(names) {
  const matches = names.map((name) => /^(?:model[-_])?(\d{5})-of-(\d{5})\.safetensors$/i.exec(name)).filter(Boolean);
  if (!matches.length || matches.length !== names.length) return false;
  const totals = new Set(matches.map((match) => Number(match[2])));
  if (totals.size !== 1) return false;
  const total = [...totals][0];
  return total === matches.length && new Set(matches.map((match) => Number(match[1]))).size === total
    && matches.every((match) => Number(match[1]) >= 1 && Number(match[1]) <= total);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function deduplicate(models) {
  const seen = new Set();
  return models.filter((model) => {
    const key = `${model.format}\0${model.modelPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
