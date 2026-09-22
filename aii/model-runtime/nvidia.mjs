import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const runDefault = (command, args) => spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024 });
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wslArgs = (distro, args) => [...(distro ? ["-d", distro] : []), "--exec", ...args];

export function nvidiaOptions(args = []) {
  const result = {};
  for (const [flag, key] of Object.entries({ "--backend": "backend", "--profile": "profile", "--model": "model", "--endpoint": "endpoint", "--gpu": "gpu", "--api-key-file": "apiKeyFile", "--models-config": "modelsConfig", "--context": "contextTokens", "--suite": "suite", "--workload": "workload", "--baseline": "baseline", "--task-id": "taskId", "--owner-pid": "ownerPid", "--task-class": "taskClass" })) {
    const index = args.indexOf(flag);
    if (index >= 0) { if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${flag} requires a value`); result[key] = args[index + 1]; }
  }
  result.dryRun = args.includes("--dry-run");
  result.idleRouter = args.includes("--idle-router");
  return result;
}

function settings(options = {}) {
  const env = options.env || process.env;
  const runtimeRoot = options.runtimeRoot || env.HII_RUNTIME_HOME || path.join(os.homedir(), ".hii");
  const root = options.root || ROOT;
  const platform = options.platform || process.platform;
  const preference = readJson(path.join(runtimeRoot, "config", "inference.json"), {});
  const manifest = options.manifest || readJson(path.join(root, "config/native-model-profiles.json"), {});
  const defaultEndpoint = platform === "win32" ? "http://127.0.0.1:6127" : "http://127.0.0.1:11435";
  // Early NVIDIA builds persisted the Mac MLX port on Windows. Treat that
  // exact managed combination as migration debt; explicit CLI/env endpoints
  // still win and can intentionally select any loopback port.
  const savedEndpoint = platform === "win32"
    && preference.endpoint === "http://127.0.0.1:11435"
    && ["native-cuda", "wsl-cuda", "wsl-vllm"].includes(preference.backend)
    ? defaultEndpoint
    : preference.endpoint;
  const endpoint = String(options.endpoint || env.HII_MODEL_URL || savedEndpoint || defaultEndpoint).replace(/\/$/, "").replace(/\/v1$/, "");
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Model endpoint must be an HTTP(S) origin without credentials, query, or path");
  const managedModelsConfig = path.join(runtimeRoot, "models", platform === "win32" ? "windows" : platform, "models.ini");
  const legacyModelsConfig = platform === "win32" ? "C:\\models\\models.ini" : path.join(runtimeRoot, "models", "models.ini");
  const modelsConfig = options.modelsConfig || env.HII_MODEL_CONFIG || preference.modelsConfig
    || (fs.existsSync(managedModelsConfig) ? managedModelsConfig : fs.existsSync(legacyModelsConfig) ? legacyModelsConfig : managedModelsConfig);
  return { ...options, root, env, runtimeRoot, manifest, endpoint, platform,
    backend: options.backend || env.HII_NVIDIA_BACKEND || (manifest.nvidia?.backends.includes(preference.backend) ? preference.backend : null) || manifest.nvidia?.defaultBackend || "native-cuda",
    profile: options.profile || env.HII_NVIDIA_PROFILE || preference.profile || "adaptive",
    model: options.model || env.HII_MODEL || preference.selectedModel || preference.model || null,
    routingMode: options.routingMode || preference.routingMode || "pinned",
    apiKeyFile: options.apiKeyFile || env.HII_MODEL_API_KEY_FILE || preference.apiKeyFile || null,
    modelsConfig,
    run: options.run || runDefault, fetch: options.fetch || globalThis.fetch,
    stateFile: path.join(runtimeRoot, "daemon", "nvidia-runtime.json") };
}

export function parseGpuCsv(text) {
  return String(text || "").trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [index, uuid, name, driver, total, free, used, utilization] = line.split(/,\s*/);
    return { index: finite(index), uuid, name, driver, totalMiB: finite(total), freeMiB: finite(free), usedMiB: finite(used), utilizationPercent: finite(utilization) };
  });
}

export function readNvidiaModels(file) {
  if (!fs.existsSync(file)) return [];
  const models = []; let current;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) { current = { id: section[1] }; models.push(current); continue; }
    const pair = line.match(/^\s*(model|mmproj|ctx-size)\s*=\s*(.+?)\s*$/);
    if (current && pair) current[pair[1]] = pair[2];
  }
  return models.filter((m) => m.model).map((m) => ({ id: m.id, path: m.model, mmproj: m.mmproj || null, mmprojSizeBytes: m.mmproj && fs.existsSync(m.mmproj) ? fs.statSync(m.mmproj).size : 0, contextTokens: finite(m["ctx-size"]), installed: fs.existsSync(m.model), sizeBytes: fs.existsSync(m.model) ? fs.statSync(m.model).size : null }));
}

export async function nvidiaDoctor(options = {}) {
  const s = settings(options);
  const g = s.run("nvidia-smi", ["--query-gpu=index,uuid,name,driver_version,memory.total,memory.free,memory.used,utilization.gpu", "--format=csv,noheader,nounits"]);
  const gpus = g.status === 0 ? parseGpuCsv(g.stdout) : [];
  const defaultDistro = s.platform === "win32" && !s.env.HII_WSL_DISTRO ? s.run("wsl.exe", ["--exec", "printenv", "WSL_DISTRO_NAME"]) : null;
  const distro = s.env.HII_WSL_DISTRO || (defaultDistro?.status === 0 ? defaultDistro.stdout.trim() : null);
  // WSL --exec does not load the login shell PATH. The driver ships this binary
  // outside /usr/bin; do not mistake a missing PATH entry for an absent GPU.
  const wsl = s.platform === "win32" ? s.run("wsl.exe", wslArgs(distro, [s.env.HII_WSL_NVIDIA_SMI_BIN || "/usr/lib/wsl/lib/nvidia-smi", "--query-gpu=name", "--format=csv,noheader"])) : null;
  let llama = s.env.HII_LLAMA_SERVER_BIN || "llama-server";
  let native = s.run(llama, ["--version"]);
  if (native.status !== 0 && !s.env.HII_LLAMA_SERVER_BIN) {
    const fallback = s.run("llama", ["--version"]);
    if (fallback.status === 0) { llama = "llama"; native = fallback; }
  }
  const wslBinary = s.env.HII_WSL_LLAMA_SERVER_BIN || "llama-server";
  const wslEngine = wsl?.status === 0 ? s.run("wsl.exe", wslArgs(distro, [wslBinary, "--version"])) : null;
  const vllm = wsl?.status === 0 ? s.run("wsl.exe", wslArgs(distro, [s.env.HII_WSL_VLLM_BIN || "vllm", "--version"])) : null;
  return { schemaVersion: 1, kind: "hii.model.doctor", platform: s.platform, gpus,
    telemetry: { available: g.status === 0, perProcessMemory: "unknown", note: "GPU memory includes other applications; per-process accounting is not assumed on WDDM/WSL." },
    backends: { "native-cuda": { available: gpus.length > 0 && native.status === 0, binary: llama }, "wsl-cuda": { available: wslEngine?.status === 0, distro, binary: wslBinary }, "wsl-vllm": { available: vllm?.status === 0, distro, installation: "Explicit preinstalled private environment required; no automatic downloads." } },
    models: s.models || readNvidiaModels(s.modelsConfig), profiles: s.manifest.nvidia?.profiles || {},
    recommendations: gpus.length ? ["Benchmark the same model and context before changing backends.", ...(gpus.some((gpu) => gpu.freeMiB < 2048) ? ["GPU memory is tight. Finish GPU-heavy work or select shared-gpu; HII will not close applications."] : [])] : ["NVIDIA telemetry unavailable; verify the host NVIDIA driver and nvidia-smi."] };
}

export function selectNvidiaProfile({ requested = "adaptive", config, gpus = [], models = [], gpu = 0, current = null, now = Date.now(), task = "interactive" }) {
  const device = gpus.find((g) => String(g.index) === String(gpu) || g.uuid === gpu);
  if (!device) throw new Error(`NVIDIA device ${gpu} is unavailable`);
  let selected = requested;
  let reason = "Explicit operator profile";
  if (requested === "adaptive") {
    selected = device.freeMiB < device.totalMiB * 0.65 ? "shared-gpu" : task === "deep" ? "deep" : "fast";
    reason = selected === "shared-gpu" ? "GPU is shared with other work" : "Adaptive task-boundary selection";
    if (current?.state === "ready" || current?.state === "starting") return { ...current.selection, reason: "Preserving the active runtime; stop explicitly before changing profiles" };
    if (current?.selection && now - Date.parse(current.startedAt) < config.switchCooldownMs) { selected = current.selection.profile; reason = "Model switch cooldown"; }
  }
  const profile = config.profiles[selected];
  if (!profile) throw new Error(`Unknown NVIDIA profile: ${selected}`);
  const model = profile.modelAliases.map((alias) => models.find((m) => m.id === alias && m.installed)).find(Boolean);
  if (!model) throw new Error(`No installed model matches ${selected}; configure HII_MODEL_CONFIG or pass --model with an installed GGUF path`);
  const requiredMiB = Math.ceil((model.sizeBytes + (model.mmprojSizeBytes || 0)) / 1048576) + config.headroomMiB + (selected === "deep" ? 1536 : 768);
  return { profile: selected, settings: profile, model, gpu: device.index, gpuUuid: device.uuid, reason, requiredMiB, freeMiB: device.freeMiB,
    state: device.freeMiB >= requiredMiB ? "available" : "waiting-for-memory", estimateOnly: true };
}

function wslPath(value) {
  if (/^[A-Za-z]:[\\/]/.test(value)) return `/mnt/${value[0].toLowerCase()}/${value.slice(3).replaceAll("\\", "/")}`;
  if (value.startsWith("/")) return value;
  throw new Error("WSL model and key paths must be absolute Windows or Linux paths");
}

export function buildNvidiaLaunchPlan(options = {}) {
  const s = settings(options); const { selection } = options;
  if (!selection) throw new Error("A resolved NVIDIA selection is required");
  if (!s.manifest.nvidia?.backends.includes(s.backend)) throw new Error(`Unknown NVIDIA backend: ${s.backend}`);
  const url = new URL(s.endpoint);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:") throw new Error("Managed engines bind only to loopback HTTP; use the existing authenticated rail for remote access");
  const port = url.port || "80";
  const profile = selection.settings;
  const context = Number(options.contextTokens || profile.contextTokens);
  if (!Number.isInteger(context) || context < 512 || context > 262144) throw new Error("Context must be between 512 and 262144 tokens");
  let command = s.binary || s.env.HII_LLAMA_SERVER_BIN || "llama-server";
  const isWsl = s.backend.startsWith("wsl-");
  if (s.idleRouter) {
    if (isWsl) throw new Error("The idle preset router currently requires native Windows llama.cpp");
    if (!fs.existsSync(s.modelsConfig)) throw new Error(`Model preset registry is missing: ${s.modelsConfig}`);
    if (!/^llama(?:\.exe)?$/i.test(path.basename(command))) throw new Error("The idle preset router requires the unified llama executable");
    const args = ["serve", "--models-preset", s.modelsConfig, "--models-max", "1", "--host", "127.0.0.1", "--port", port, "--no-webui"];
    if (s.apiKeyFile) args.push("--api-key-file", s.apiKeyFile);
    return { command, args, env: {}, backend: s.backend, endpoint: s.endpoint, contextTokens: null, selection, idleRouter: true, secretValuesIncluded: false };
  }
  const modelPath = isWsl ? wslPath(selection.model.path) : selection.model.path;
  let args = ["--model", modelPath, "--alias", selection.model.id, "--host", "127.0.0.1", "--port", port, "--ctx-size", String(context), "--n-gpu-layers", "999", "--flash-attn", "on", "--cache-type-k", profile.kvCacheType, "--cache-type-v", profile.kvCacheType, "--batch-size", String(profile.batchSize), "--ubatch-size", String(profile.microBatchSize), "--parallel", "1", "--no-webui", "--jinja", "--reasoning", "off"];
  if (selection.model.mmproj) args.push("--mmproj", isWsl ? wslPath(selection.model.mmproj) : selection.model.mmproj);
  if (s.apiKeyFile) args.push("--api-key-file", isWsl ? wslPath(s.apiKeyFile) : s.apiKeyFile);
  if (!isWsl && /^llama(?:\.exe)?$/i.test(path.basename(command))) args.unshift("serve");
  if (s.backend === "wsl-vllm") {
    if (!s.env.HII_VLLM_MODEL_PATH?.startsWith("/")) throw new Error("Set HII_VLLM_MODEL_PATH to a preinstalled Linux model directory; GGUF profiles are not assumed compatible with vLLM");
    if (s.apiKeyFile) throw new Error("Authenticated vLLM launch requires a managed authentication proxy; use native/WSL llama for key-file authentication");
    args = ["serve", s.env.HII_VLLM_MODEL_PATH, "--served-model-name", selection.model.id, "--host", "127.0.0.1", "--port", port, "--max-model-len", String(context), "--gpu-memory-utilization", "0.8"];
  }
  if (isWsl) {
    if (s.platform !== "win32") throw new Error("WSL backends require Windows");
    const binary = s.backend === "wsl-vllm" ? s.env.HII_WSL_VLLM_BIN || "vllm" : s.env.HII_WSL_LLAMA_SERVER_BIN || "llama-server";
    args = wslArgs(s.distro || s.env.HII_WSL_DISTRO, ["env", `CUDA_VISIBLE_DEVICES=${selection.gpuUuid || selection.gpu}`, binary, ...args]);
    command = "wsl.exe";
  }
  return { command, args, env: { CUDA_VISIBLE_DEVICES: String(selection.gpuUuid || selection.gpu) }, backend: s.backend, endpoint: s.endpoint, contextTokens: context, selection, secretValuesIncluded: false };
}

function headers(s) {
  if (!s.apiKeyFile) return {};
  const key = fs.readFileSync(s.apiKeyFile, "utf8").trim();
  if (!key) throw new Error("Model API key file is empty");
  return { Authorization: `Bearer ${key}` };
}

async function probe(s) {
  try {
    const response = await s.fetch(`${s.endpoint}/v1/models`, { headers: headers(s), redirect: "error", signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { reachable: true, ready: false, httpStatus: response.status };
    const body = await response.json();
    return { reachable: true, ready: true, models: (body.data || []).map((m) => ({ id: m.id })) };
  } catch { return { reachable: false, ready: false }; }
}

function processIdentity(s, pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (s.platform === "win32") {
    const result = s.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { [pscustomobject]@{ id=$p.ProcessId; started=$p.CreationDate.ToUniversalTime().ToString('o'); executable=$p.ExecutablePath } | ConvertTo-Json -Compress }`]);
    try { return result.status === 0 && result.stdout.trim() ? JSON.parse(result.stdout) : null; } catch { return null; }
  }
  const result = s.run("ps", ["-p", String(pid), "-o", "lstart=,comm="]);
  return result.status === 0 && result.stdout.trim() ? { id: pid, fingerprint: result.stdout.trim() } : null;
}
function linuxIdentity(s, record) {
  if (!record?.linuxPid || !Number.isSafeInteger(record.linuxPid) || record.linuxPid < 1) return null;
  const stat = s.run("wsl.exe", wslArgs(record.distro, ["cat", `/proc/${record.linuxPid}/stat`]));
  if (stat.status !== 0) return null;
  const boot = s.run("wsl.exe", wslArgs(record.distro, ["cat", "/proc/sys/kernel/random/boot_id"]));
  if (boot.status !== 0 || !boot.stdout.trim()) return null;
  // comm can contain spaces and parentheses: fields after its final ')' begin at field 3.
  const suffix = stat.stdout.slice(stat.stdout.lastIndexOf(")") + 2).trim().split(/\s+/);
  return suffix[19] ? { pid: record.linuxPid, startTicks: suffix[19], bootId: boot.stdout.trim(), distro: record.distro } : null;
}
function sameWindowsIdentity(a, b) {
  if (!a || !b || Number(a.id) !== Number(b.id) || !a.started || a.started !== b.started) return false;
  // Win32_Process may withhold ExecutablePath from a non-elevated caller. PID
  // plus the process creation timestamp still identifies the process
  // generation; compare the executable as an additional check when both calls
  // can see it.
  if (a.executable && b.executable) {
    return path.resolve(a.executable).toLowerCase() === path.resolve(b.executable).toLowerCase();
  }
  return true;
}
function ownedIdentity(s, record) {
  if (record?.backend?.startsWith("wsl-")) return sameIdentity(record.linuxIdentity, linuxIdentity(s, record));
  const current = processIdentity(s, record?.pid);
  return s.platform === "win32" ? sameWindowsIdentity(record?.identity, current) : sameIdentity(record?.identity, current);
}
const sameIdentity = (a, b) => Boolean(a && b && JSON.stringify(a) === JSON.stringify(b));
function saveState(s, value) { fs.mkdirSync(path.dirname(s.stateFile), { recursive: true }); const temporary = `${s.stateFile}.${process.pid}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temporary, s.stateFile); }
function recordTransition(s, transition) { fs.mkdirSync(path.dirname(s.stateFile), { recursive: true }); fs.appendFileSync(path.join(path.dirname(s.stateFile), "nvidia-transitions.jsonl"), `${JSON.stringify({ schemaVersion: 1, occurredAt: new Date().toISOString(), ...transition })}\n`, { mode: 0o600 }); }
function savePreference(s, value) {
  const file = path.join(s.runtimeRoot, "config", "inference.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const previous = readJson(file, {});
  const previousModel = previous.selectedModel || previous.model;
  const contextTokens = value.contextTokens || (previous.endpoint === s.endpoint && previousModel === value.model ? previous.contextTokens : null) || null;
  if (contextTokens !== null && (!Number.isInteger(contextTokens) || contextTokens < 512 || contextTokens > 262144)) throw new Error("Context must be between 512 and 262144 tokens");
  const provider = s.platform === "win32" ? "llama.cpp" : "native";
  const { model: _legacyModel, ...preserved } = previous;
  const next = JSON.stringify({ ...preserved, schemaVersion: 2, provider, endpoint: s.endpoint, routingMode: value.routingMode || s.routingMode || "pinned", selectedModel: value.model, apiKeyFile: s.apiKeyFile, modelsConfig: s.modelsConfig, contextTokens, backend: value.backend, profile: s.profile, effectiveProfile: value.profile || null }, null, 2);
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === next) return;
  const stamp = `${Date.now()}.${process.pid}`;
  const temporary = `${file}.${stamp}.tmp`;
  fs.writeFileSync(temporary, next, { mode: 0o600, flag: "wx" });
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.${stamp}.previous`, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temporary, file);
  } catch (error) { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); throw error; }
}

export async function nvidiaStatus(options = {}) {
  const s = settings(options); const record = readJson(s.stateFile);
  const health = await probe(s);
  const owned = record?.endpoint === s.endpoint && ownedIdentity(s, record);
  let gpus = [];
  try {
    const measured = s.run("nvidia-smi", ["--query-gpu=index,uuid,name,driver_version,memory.total,memory.free,memory.used,utilization.gpu", "--format=csv,noheader,nounits"]);
    if (measured.status === 0) gpus = parseGpuCsv(measured.stdout);
  } catch {}
  const resourceAdvice = nvidiaResourceAdvice(gpus, s.manifest.nvidia?.headroomMiB || 1536);
  const registry = readNvidiaModels(s.modelsConfig);
  const recordedModel = record?.selection?.model;
  const canonicalRecordedId = recordedModel?.id === "explicit"
    ? registry.find((model) => path.resolve(model.path).toLowerCase() === path.resolve(recordedModel.path || "").toLowerCase())?.id || null
    : recordedModel?.id || null;
  const selectedModelId = s.model && health.models?.some((model) => model.id === s.model)
    ? s.model
    : canonicalRecordedId;
  return { schemaVersion: 2, kind: "hii.model.status", endpoint: s.endpoint, backend: owned ? record.backend : health.reachable ? "external-unknown" : s.backend, state: health.ready ? "ready" : owned ? "starting" : health.reachable ? "unavailable" : "stopped", ownership: owned ? "hii" : health.reachable ? "external" : "none", pid: owned ? record.pid : null, selection: owned ? { profile: record.selection?.profile, model: { id: selectedModelId }, gpu: record.selection?.gpu, reason: record.selection?.reason } : null, observedModelIds: health.models?.map((model) => model.id) || [], contextTokens: owned ? record.contextTokens : null, capabilities: { inference: health.ready, managedStop: owned, automaticSwitching: false }, health, resources: { gpus, perProcessMemory: "unknown" }, resourceAdvice };
}

export function nvidiaResourceAdvice(gpus, headroomMiB = 1536) {
  if (!gpus.length) return { state: "unknown", action: "Run model doctor; GPU telemetry is unavailable", automaticAction: false };
  const tight = gpus.filter((gpu) => gpu.freeMiB !== null && gpu.freeMiB < headroomMiB);
  const shared = gpus.filter((gpu) => gpu.freeMiB !== null && gpu.freeMiB < gpu.totalMiB * 0.3);
  return tight.length ? { state: "memory-pressure", devices: tight.map((gpu) => gpu.index), action: "Wait for GPU-heavy work to finish before launching another model or Create job", automaticAction: false }
    : shared.length ? { state: "shared", devices: shared.map((gpu) => gpu.index), action: "Keep the active model loaded; consider shared-gpu at the next explicit restart", automaticAction: false }
      : { state: "headroom-available", action: "Keep the active model; benchmark before changing its profile", automaticAction: false };
}

export async function nvidiaStart(options = {}) {
  const s = settings(options); const existing = await nvidiaStatus(s);
  if (existing.ownership !== "none") {
    if (!s.dryRun && existing.health.ready) {
      const model = s.model || existing.selection?.model?.id || existing.health.models[0]?.id;
      const canonicalAliasMatch = existing.ownership === "hii"
        && existing.selection?.model?.id === s.model
        && existing.health.models.some((m) => m.id === "explicit");
      if (s.model && !existing.health.models.some((m) => m.id === s.model) && !canonicalAliasMatch) throw new Error("Requested model is not advertised by the existing endpoint; it was not changed");
      savePreference(s, { model, contextTokens: Number(s.contextTokens) || existing.contextTokens, backend: existing.ownership === "hii" ? existing.backend : "external", profile: existing.selection?.profile });
    }
    return { ...existing, reused: true, reason: "Existing runtime preserved; no model or service was changed" };
  }
  const inventory = options.inventory || await nvidiaDoctor(s);
  s.distro = inventory.backends[s.backend]?.distro || s.env.HII_WSL_DISTRO;
  s.binary = inventory.backends[s.backend]?.binary;
  const config = s.manifest.nvidia;
  let models = inventory.models;
  let requested = s.profile;
  if (s.model) {
    const known = models.find((m) => m.id === s.model);
    if (known) models = [known];
    else if (fs.existsSync(s.model)) {
      const absolute = path.resolve(s.model);
      const id = path.basename(absolute, path.extname(absolute)).replace(/[^A-Za-z0-9._-]+/g, "-");
      models = [{ id, path: absolute, installed: true, sizeBytes: fs.statSync(absolute).size }];
    }
    else throw new Error("Requested model is not installed; no download was attempted");
    requested = requested === "adaptive" ? "fast" : requested;
  }
  const effective = s.model ? { ...config, profiles: Object.fromEntries(Object.entries(config.profiles).map(([k, v]) => [k, { ...v, modelAliases: [models[0].id] }])) } : config;
  const selection = selectNvidiaProfile({ requested, config: effective, gpus: inventory.gpus, models, gpu: s.gpu || 0, current: readJson(s.stateFile) });
  const plan = buildNvidiaLaunchPlan({ ...s, selection });
  if (s.dryRun) return { ...plan, dryRun: true, backendAvailable: inventory.backends[s.backend]?.available === true };
  if (!inventory.backends[s.backend]?.available) throw new Error(`${s.backend} is not installed or GPU-ready; run model doctor. No installation was attempted.`);
  if (!s.idleRouter && selection.state === "waiting-for-memory") return { state: "waiting-for-memory", queued: false, retryable: true, selection, reason: "Insufficient estimated GPU headroom; finish GPU-heavy work and retry. No process was started." };
  fs.mkdirSync(path.dirname(s.stateFile), { recursive: true });
  const lockFile = `${s.stateFile}.lock`;
  let lock;
  try { lock = fs.openSync(lockFile, "wx"); } catch { throw new Error("Another runtime start is in progress; retry after it finishes"); }
  try {
    const check = await nvidiaStatus(s); if (check.ownership !== "none") return { ...check, reused: true };
    const log = path.join(path.dirname(s.stateFile), "nvidia-runtime.log");
    const out = fs.openSync(log, "a");
    const linuxPidFile = `${s.stateFile}.${process.pid}.${Date.now()}.linux-pid`;
    let child;
    try {
      let args = plan.args;
      if (s.backend.startsWith("wsl-")) {
        const pidFile = wslPath(linuxPidFile);
        const boundary = args.indexOf("--exec") + 1;
        args = args.slice(0, boundary).concat(["sh", "-c", 'umask 077; printf "%s\\n" "$$" > "$1"; shift; exec "$@"', "hii-engine", pidFile], args.slice(boundary));
      }
      child = spawn(plan.command, args, { env: { ...s.env, ...plan.env }, detached: true, windowsHide: true, stdio: ["ignore", out, out] });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", () => reject(new Error("Model engine could not start; inspect doctor and configured binary path"))); });
    } finally { fs.closeSync(out); }
    const identity = processIdentity(s, child.pid);
    if (!identity) { child.kill(); throw new Error("Could not verify the started process identity; launch canceled"); }
    child.unref();
    const record = { schemaVersion: 1, pid: child.pid, identity, backend: s.backend, endpoint: s.endpoint, selection, contextTokens: plan.contextTokens, startedAt: new Date().toISOString(), state: "starting", log };
    if (s.backend.startsWith("wsl-")) {
      record.distro = s.distro || null;
      for (let i = 0; i < 30; i++) {
        try { record.linuxPid = Number(fs.readFileSync(linuxPidFile, "utf8").trim()); } catch {}
        record.linuxIdentity = linuxIdentity(s, record);
        if (record.linuxIdentity) break;
        await wait(100);
      }
      if (!record.linuxIdentity) { child.kill(); throw new Error("WSL child identity could not be verified; launch canceled"); }
      fs.unlinkSync(linuxPidFile);
    }
    saveState(s, record);
    savePreference(s, { model: selection.model.id, contextTokens: plan.contextTokens, backend: s.backend, profile: selection.profile });
    return { ...record, ownership: "hii", idleRouter: Boolean(s.idleRouter), reason: s.idleRouter ? "Idle router starting; weights load only when a model request arrives" : "Engine starting; model status reports readiness" };
  } finally { fs.closeSync(lock); fs.unlinkSync(lockFile); }
}

export async function nvidiaStop(options = {}) {
  const s = settings(options); const record = readJson(s.stateFile);
  if (!record || record.endpoint !== s.endpoint) return { stopped: false, reason: "No HII-owned engine recorded for this endpoint" };
  if (!ownedIdentity(s, record)) return { stopped: false, reason: "Process identity no longer matches; nothing was signaled" };
  if (record.backend.startsWith("wsl-")) {
    const stopped = s.run("wsl.exe", wslArgs(record.distro, ["kill", "-TERM", String(record.linuxPid)]));
    if (stopped.status !== 0) throw new Error("WSL engine did not accept termination; distro was left running");
  } else process.kill(record.pid, "SIGTERM");
  for (let attempt = 0; attempt < 30; attempt++) { if (!ownedIdentity(s, record)) { saveState(s, { ...record, state: "stopped", stoppedAt: new Date().toISOString() }); return { stopped: true, pid: record.pid }; } await wait(100); }
  return { stopped: false, state: "stopping", reason: "Stop requested; engine has not exited yet" };
}

export async function nvidiaBench(options = {}) {
  if (options.suite) {
    if (options.suite !== "quick") throw new Error("Supported benchmark suite: quick");
    const samples = [];
    for (const workload of ["short", "long", "tool"]) {
      for (let repetition = 0; repetition < 2; repetition++) {
        const result = await nvidiaBench({ ...options, suite: null, workload });
        samples.push({ ...result, repetition, loadCondition: repetition === 0 ? "initial-state-unknown" : "repeated-request-no-intervening-model-switch" });
      }
    }
    const report = { schemaVersion: 1, kind: "hii.model.benchmark-suite", suite: "quick", measuredAt: new Date().toISOString(), model: samples[0].model, backend: samples[0].backend, samples, quality: { passed: samples.every((sample) => sample.quality.passed) }, coldStartMeasured: false, note: "Two requests per workload. Initial model loading/cache state is unknown; repeated requests may reuse cache. No throughput or cold-start estimate is invented." };
    const baseline = options.baseline ? readJson(options.baseline) : null;
    report.promotion = assessNvidiaBenchmark(report, baseline);
    const s = settings(options);
    const file = path.join(s.runtimeRoot, "daemon", `nvidia-suite-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
    return { ...report, artifact: file };
  }
  const s = settings(options); const status = await nvidiaStatus(s);
  if (!status.health.ready) throw new Error("Model endpoint is not ready or authentication failed");
  const model = s.model || status.health.models[0]?.id;
  if (!model) throw new Error("Choose a model with --model");
  const workload = options.workload || "short";
  if (!["short", "long", "tool"].includes(workload)) throw new Error("Benchmark workload must be short, long, or tool");
  const tools = workload === "tool" ? [{ type: "function", function: { name: "add_integers", description: "Add two integers", parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"], additionalProperties: false } } }] : null;
  const messages = [{ role: "user", content: workload === "tool" ? "Call add_integers with a=19 and b=23. Do not calculate it yourself." : workload === "long" ? `The first marker is HII-731.\n${Array.from({ length: 512 }, (_, index) => `Reference ${index}: retain provenance and ignore irrelevant material.`).join("\n")}\nThe last marker is END-294. Return only a JSON object with first and last set to those two marker strings.` : 'Return only this JSON object: {"sum":42,"status":"ok"}' }];
  const started = performance.now(); let firstTokenMs = null; let content = ""; let usage = null; let timings = null; let finishReason = null;
  const toolCalls = new Map();
  const response = await s.fetch(`${s.endpoint}/v1/chat/completions`, { method: "POST", headers: { ...headers(s), "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(120000), body: JSON.stringify({ model, messages, ...(tools ? { tools, tool_choice: { type: "function", function: { name: "add_integers" } } } : {}), temperature: 0, max_tokens: 128, stream: true, stream_options: { include_usage: true }, chat_template_kwargs: { enable_thinking: false } }) });
  if (!response.ok) throw new Error(`Benchmark request failed (HTTP ${response.status}); response body omitted to protect credentials`);
  const decoder = new TextDecoder(); let pending = "";
  const consume = (line) => {
    if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") return;
    const chunk = JSON.parse(line.slice(5)); const text = chunk.choices?.[0]?.delta?.content;
    if (text) { if (firstTokenMs === null) firstTokenMs = performance.now() - started; content += text; }
    for (const delta of chunk.choices?.[0]?.delta?.tool_calls || []) {
      if (firstTokenMs === null) firstTokenMs = performance.now() - started;
      const call = toolCalls.get(delta.index ?? 0) || { name: "", arguments: "" };
      call.name += delta.function?.name || ""; call.arguments += delta.function?.arguments || ""; toolCalls.set(delta.index ?? 0, call);
    }
    usage = chunk.usage || usage; timings = chunk.timings || timings; finishReason = chunk.choices?.[0]?.finish_reason || finishReason;
  };
  for await (const bytes of response.body) { pending += decoder.decode(bytes, { stream: true }); const lines = pending.split(/\r?\n/); pending = lines.pop(); for (const line of lines) consume(line); }
  pending += decoder.decode(); if (pending.trim()) consume(pending);
  const wallMs = performance.now() - started;
  let passed = false;
  try {
    if (workload === "tool") { const call = [...toolCalls.values()][0]; const args = JSON.parse(call?.arguments || ""); passed = toolCalls.size === 1 && call.name === "add_integers" && args.a === 19 && args.b === 23 && Object.keys(args).length === 2; }
    else { const value = JSON.parse(content.trim()); passed = workload === "long" ? value.first === "HII-731" && value.last === "END-294" : value.sum === 42 && value.status === "ok"; }
  } catch {}
  passed = passed && ["stop", "tool_calls"].includes(finishReason);
  const result = { schemaVersion: 1, kind: "hii.model.benchmark", model, backend: status.ownership === "hii" ? status.backend : "external-unknown", endpoint: s.endpoint, measuredAt: new Date().toISOString(), workload, workloadVersion: 1, profile: status.selection?.profile || null, contextTokens: status.contextTokens, firstTokenMs, wallMs, completionTokens: usage?.completion_tokens ?? null, promptTokens: usage?.prompt_tokens ?? null, completionTokensPerSecond: timings?.predicted_per_second ?? null, promptTokensPerSecond: timings?.prompt_per_second ?? null, throughputMeasured: Boolean(timings?.predicted_per_second), loadCondition: "unknown-existing-endpoint", quality: { passed, finishReason }, promotionEligible: false, note: "One correctness/latency sample; tool calls are validated without execution. Not a backend comparison or automatic promotion." };
  const file = path.join(s.runtimeRoot, "daemon", "nvidia-benchmarks.jsonl"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  return result;
}

export function assessNvidiaBenchmark(candidate, baseline, improvementThreshold = 0.15) {
  const reject = (reason) => ({ eligible: false, automaticAdoption: false, reason });
  if (!baseline) return reject("No baseline supplied; pass --baseline with a prior quick-suite artifact");
  if (candidate.suite !== "quick" || baseline.suite !== "quick" || candidate.model !== baseline.model) return reject("Compare the same model and benchmark suite");
  if (candidate.backend === "external-unknown" || baseline.backend === "external-unknown") return reject("Engine identity is unverified for an external endpoint; results are informational");
  if (!candidate.quality?.passed || !baseline.quality?.passed) return reject("Every baseline and candidate workload must pass correctness");
  const comparisons = [];
  for (const workload of ["short", "long", "tool"]) {
    const c = candidate.samples?.filter((s) => s.workload === workload) || [];
    const b = baseline.samples?.filter((s) => s.workload === workload) || [];
    if (c.length < 2 || b.length !== c.length) return reject("Two matching repetitions are required for every workload");
    if (c.some((s, i) => !s.quality?.passed || !b[i].quality?.passed || s.workloadVersion !== b[i].workloadVersion || s.contextTokens !== b[i].contextTokens || !s.contextTokens || s.repetition !== b[i].repetition || s.loadCondition !== b[i].loadCondition || !Number.isFinite(s.wallMs) || !Number.isFinite(b[i].wallMs) || s.wallMs <= 0 || b[i].wallMs <= 0)) return reject("Workload, context, repetition, measured timing, and correctness evidence must match");
    const average = (rows) => rows.reduce((sum, row) => sum + row.wallMs, 0) / rows.length;
    comparisons.push({ workload, baselineWallMs: average(b), candidateWallMs: average(c), improvement: 1 - average(c) / average(b) });
  }
  const eligible = comparisons.every((c) => c.improvement >= -0.05) && comparisons.some((c) => c.improvement >= improvementThreshold);
  return { eligible, automaticAdoption: false, metric: "completed-request-wall-time", improvementThreshold, comparisons, reason: eligible ? "Candidate meets the measured gate; explicit operator adoption required" : "Needs at least 15% improvement on one workload with no workload slower by over 5%" };
}

function taskIdentity(s) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(s.taskId || "")) throw new Error("prepare/finish-task requires a bounded --task-id");
  const ownerPid = Number(s.ownerPid || process.ppid);
  const owner = processIdentity(s, ownerPid);
  if (!owner) throw new Error("Task owner process identity could not be verified");
  return { ownerPid, owner };
}

async function serverIdle(s) {
  if (s.idleCheck) return s.idleCheck();
  try {
    const response = await s.fetch(`${s.endpoint}/slots`, { headers: headers(s), redirect: "error", signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const slots = await response.json();
    return Array.isArray(slots) && slots.length > 0 && slots.every((slot) => slot.is_processing === false);
  } catch { return false; }
}

export async function nvidiaPrepareTask(options = {}) {
  const result = await prepareNvidiaTask(options);
  return { ...result, ok: result.acquired === true && result.state === "ready" };
}

async function prepareNvidiaTask(options = {}) {
  const s = settings(options); const identity = taskIdentity(s);
  const leaseFile = path.join(s.runtimeRoot, "daemon", "nvidia-task.json");
  fs.mkdirSync(path.dirname(leaseFile), { recursive: true });
  const guard = `${leaseFile}.lock`; let lock;
  try { lock = fs.openSync(guard, "wx"); } catch { return { acquired: false, state: "busy", retryable: true, reason: "A task boundary transition is already in progress" }; }
  const getStatus = s.getStatus || nvidiaStatus;
  try {
    const previous = readJson(leaseFile);
    if (previous && sameIdentity(previous.owner, processIdentity(s, previous.ownerPid))) {
      return { acquired: previous.taskId === s.taskId && sameIdentity(previous.owner, identity.owner), state: "busy", taskId: previous.taskId, retryable: true, reason: "The current task retains its runtime until finish-task" };
    }
    if (previous) fs.unlinkSync(leaseFile);
    const status = await getStatus(s);
    if (status.state !== "ready") return { acquired: false, state: status.state, retryable: true, reason: "Inference is not ready; no runtime was changed" };
    const lease = { schemaVersion: 1, taskId: s.taskId, ...identity, acquiredAt: new Date().toISOString(), endpoint: s.endpoint, runtimePid: status.pid };
    fs.writeFileSync(leaseFile, JSON.stringify(lease, null, 2), { flag: "wx", mode: 0o600 });
    let result = { acquired: true, taskId: s.taskId, state: "ready", changed: false, model: status.selection?.model?.id || status.health?.models?.[0]?.id || null, contextTokens: status.contextTokens, resourceAdvice: status.resourceAdvice, reason: "Active model retained" };
    if (status.ownership !== "hii" || s.profile !== "adaptive") return { ...result, reason: status.ownership === "hii" ? "Explicit model/profile preserved" : "External engine retained; HII does not own its lifecycle" };
    const inventory = s.inventory || await nvidiaDoctor(s);
    let desired;
    try { desired = selectNvidiaProfile({ requested: "adaptive", config: s.manifest.nvidia, gpus: inventory.gpus, models: inventory.models, gpu: s.gpu || status.selection?.gpu || 0, task: s.taskClass === "deep" ? "deep" : "interactive" }); }
    catch { return { ...result, reason: "No installed adaptive candidate; active model retained" }; }
    result = { ...result, recommendedProfile: desired.profile };
    if (desired.profile === status.selection?.profile && desired.model.id === result.model) return result;
    if (desired.state !== "available") return { ...result, reason: "Candidate lacks estimated GPU headroom; active model retained" };
    const record = readJson(s.stateFile, {});
    if (Date.now() - Date.parse(record.startedAt || "") < s.manifest.nvidia.switchCooldownMs) return { ...result, reason: "Model switch cooldown; active model retained" };
    const entry = s.evidence || readJson(path.join(s.runtimeRoot, "config", "nvidia-profile-evidence.json"), {})[desired.profile];
    const candidate = entry?.candidate ? readJson(entry.candidate) : null;
    const baseline = entry?.baseline ? readJson(entry.baseline) : null;
    if (!candidate || !assessNvidiaBenchmark(candidate, baseline).eligible || candidate.backend !== s.backend || candidate.model !== desired.model.id || !candidate.samples.every((sample) => sample.profile === desired.profile && sample.contextTokens === desired.settings.contextTokens)) return { ...result, reason: "No matching measured promotion evidence; active model retained" };
    if (!await serverIdle(s)) return { ...result, reason: "Engine idle state is unverified or a request is in flight; active model retained" };
    const stopped = await (s.stopRuntime || nvidiaStop)(s);
    if (!stopped.stopped) return { ...result, reason: "Previous engine did not stop; no replacement launched" };
    const startOptions = { ...s, profile: desired.profile, model: undefined, inventory };
    let started;
    try { started = await (s.startRuntime || nvidiaStart)(startOptions); }
    catch { started = { state: "failed" }; }
    if (!["starting", "ready"].includes(started.state) || started.reused) {
      recordTransition(s, { taskId: s.taskId, outcome: "start-failed", previousModel: result.model, requestedModel: desired.model.id, reason: "Measured task-boundary replacement could not start" });
      fs.unlinkSync(leaseFile);
      return { acquired: false, taskId: s.taskId, state: "unavailable", changed: true, retryable: true, reason: "Measured replacement could not start; task was not sent. Use model start to recover." };
    }
    const deadline = Date.now() + (s.readyTimeoutMs ?? 120000);
    while (Date.now() < deadline) {
      const ready = await getStatus(s);
      if (ready.state === "ready" && ready.ownership === "hii" && ready.selection?.model?.id === desired.model.id) {
        savePreference(s, { model: desired.model.id, contextTokens: desired.settings.contextTokens, backend: s.backend, profile: desired.profile });
        recordTransition(s, { taskId: s.taskId, outcome: "ready", previousModel: result.model, model: desired.model.id, backend: s.backend, profile: desired.profile, reason: "Measured promotion evidence, GPU headroom, cooldown and engine idle state verified" });
        fs.writeFileSync(leaseFile, JSON.stringify({ ...lease, runtimePid: ready.pid, switchedFrom: result.model }, null, 2), { mode: 0o600 });
        return { ...result, changed: true, model: desired.model.id, contextTokens: desired.settings.contextTokens, reason: "Applied measured profile at an idle task boundary" };
      }
      await wait(250);
    }
    fs.unlinkSync(leaseFile);
    recordTransition(s, { taskId: s.taskId, outcome: "loading-timeout", previousModel: result.model, requestedModel: desired.model.id });
    return { acquired: false, state: "starting", changed: true, retryable: true, reason: "Replacement is still loading; retry after model status reports ready" };
  } catch (error) {
    const current = readJson(leaseFile);
    if (current?.taskId === s.taskId && sameIdentity(current.owner, identity.owner)) fs.unlinkSync(leaseFile);
    throw error;
  } finally { fs.closeSync(lock); fs.unlinkSync(guard); }
}

export async function nvidiaFinishTask(options = {}) {
  const s = settings(options); const identity = taskIdentity(s);
  const file = path.join(s.runtimeRoot, "daemon", "nvidia-task.json");
  const lease = readJson(file);
  if (!lease) return { released: false, reason: "No task lease exists" };
  if (lease.taskId !== s.taskId || !sameIdentity(lease.owner, identity.owner)) return { released: false, reason: "Task lease belongs to another task or process generation" };
  fs.unlinkSync(file);
  return { released: true, taskId: s.taskId };
}
