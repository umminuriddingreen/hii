import os from "node:os";

const PLATFORM_ALIASES = new Map([
  ["win32", "win32"],
  ["windows", "win32"],
  ["darwin", "darwin"],
  ["mac", "darwin"],
  ["macos", "darwin"],
  ["linux", "linux"]
]);

export function normalizePlatform(value = process.platform) {
  return PLATFORM_ALIASES.get(String(value || "").trim().toLowerCase()) || String(value || "unknown");
}

export function detectModelPlatform(options = {}) {
  const platform = normalizePlatform(options.platform ?? process.platform);
  const arch = options.arch ?? process.arch;
  const release = options.release ?? os.release();
  const env = options.env ?? process.env;
  const isWsl = platform === "linux"
    && (Boolean(env.WSL_DISTRO_NAME) || /microsoft/i.test(release));
  const id = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform;
  const runtimeFamily = platform === "win32"
    ? "llama.cpp"
    : platform === "darwin" && arch === "arm64"
      ? "mlx"
      : "unsupported";
  const modelFormat = runtimeFamily === "llama.cpp"
    ? "gguf"
    : runtimeFamily === "mlx"
      ? "mlx-safetensors"
      : null;

  return {
    id,
    nodePlatform: platform,
    arch,
    release,
    isWsl,
    runtimeFamily,
    modelFormat,
    supported: runtimeFamily !== "unsupported"
  };
}

export function supportsPlatform(entry, platform = process.platform, arch = process.arch) {
  const platforms = Array.isArray(entry?.platforms) ? entry.platforms.map(normalizePlatform) : [];
  const architectures = Array.isArray(entry?.architectures) ? entry.architectures : [];
  return (platforms.length === 0 || platforms.includes(normalizePlatform(platform)))
    && (architectures.length === 0 || architectures.includes(arch));
}
