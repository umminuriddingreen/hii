// SPDX-License-Identifier: LicenseRef-BSL-1.1
// Read-only inventory and bounded planning for HII's replaceable model field.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { supportsPlatform } from "./platform.mjs";
import { routeModelTask } from "./pressure-router.mjs";

const stable = (values, key = (value) => value.id) => [...values].sort((a, b) => key(a).localeCompare(key(b)));
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};

function localState(entry, installed, activeModel) {
  if (activeModel === entry.model || activeModel === entry.logicalModel) return "ready";
  if (installed.has(entry.model) || installed.has(entry.logicalModel)) return "installed";
  return "configured";
}

export function buildIntelligenceField({
  manifest,
  platform = process.platform,
  arch = process.arch,
  memoryGiB = Math.round(os.totalmem() / (1024 ** 3)),
  installedModels = [],
  observedModels = [],
  runtime = {},
  preference = {},
  systems = [],
  benchmarks = {},
  leases = [],
  resources = {}
}) {
  const installed = new Set([...installedModels, ...observedModels.map((entry) => entry.model)]);
  const activeModel = runtime.loadedModel || runtime.model || null;
  const local = (manifest.selectionCatalog || [])
    .filter((entry) => supportsPlatform(entry, platform, arch))
    .map((entry) => {
      const availability = localState(entry, installed, activeModel);
      const benchmark = benchmarks[entry.model] || null;
      const resident = availability === "ready";
      return ({
      id: `${entry.backend}:${entry.logicalModel || entry.model}`,
      model: entry.model,
      logicalModel: entry.logicalModel || null,
      provider: entry.backend === "mlx" ? "hii-native" : entry.backend,
      backend: entry.backend,
      location: "local",
      device: "local",
      availability,
      health: resident ? "ready" : availability === "installed" ? "stopped" : "unknown",
      launchable: availability === "installed",
      resident,
      activeGenerations: resident ? (runtime.activeGenerations ?? null) : 0,
      activeLeases: resident ? leases.filter((lease) => lease.nodeIds?.includes(`${entry.backend}:${entry.logicalModel || entry.model}`)).length : 0,
      maxConcurrency: runtime.performance?.maxConcurrentSequences ?? 1,
      tokensPerSecond: benchmark?.completionTokensPerSecond ?? null,
      resources: {
        freeMiB: resources.freeMiB ?? null,
        requiredMiB: resident ? 0 : entry.minimumMemoryGiB == null ? null : entry.minimumMemoryGiB * 1024,
        minimumHeadroomMiB: resources.minimumHeadroomMiB ?? null,
        resident
      },
      selected: preference.model === entry.model || preference.model === entry.logicalModel,
      capabilities: stable(entry.capabilities || [], (value) => value),
      speed: entry.speed || null,
      quality: entry.quality || null,
      minimumMemoryGiB: entry.minimumMemoryGiB ?? null,
      fitsMemory: entry.minimumMemoryGiB == null ? null : memoryGiB >= entry.minimumMemoryGiB,
      externalTransmission: false,
      lifecycle: entry.backend === "llama.cpp" ? "task-boundary-lease" : "explicit-start-stop",
      provenance: { source: "native-model-profiles", observedRuntime: resident, benchmarkMeasuredAt: benchmark?.measuredAt || null }
    }); });
  const hosted = (manifest.hostedCatalog || []).map((entry) => ({
    id: `${entry.provider}:${entry.model}`,
    model: entry.model,
    logicalModel: null,
    provider: entry.provider,
    backend: "hosted",
    location: "hosted",
    device: null,
    availability: "configured",
    health: "available",
    launchable: false,
    resident: false,
    activeGenerations: null,
    activeLeases: 0,
    maxConcurrency: 1,
    tokensPerSecond: null,
    resources: { freeMiB: Number.MAX_SAFE_INTEGER, requiredMiB: 0, minimumHeadroomMiB: 0, resident: false },
    selected: preference.provider === entry.provider && preference.model === entry.model,
    capabilities: stable(entry.capabilities || [], (value) => value),
    speed: null,
    quality: null,
    minimumMemoryGiB: null,
    fitsMemory: null,
    externalTransmission: true,
    lifecycle: "explicit-only",
    provenance: { source: "hostedCatalog", observedRuntime: false, benchmarkMeasuredAt: null }
  }));
  const remote = systems
    .filter((system) => !system.local)
    .map((system) => ({
      id: `remote:${system.id}`,
      model: null,
      logicalModel: null,
      provider: "remote-peer",
      backend: "unknown",
      location: "remote",
      device: system.id,
      availability: system.status === "ready" && (system.capabilities || []).includes("hii.cli") ? "ready" : "unavailable",
      health: system.status === "ready" ? "available" : "unknown",
      launchable: false,
      resident: null,
      activeGenerations: null,
      activeLeases: 0,
      maxConcurrency: 1,
      tokensPerSecond: null,
      resources: { freeMiB: null, requiredMiB: null, minimumHeadroomMiB: null, resident: null },
      selected: false,
      capabilities: stable(system.capabilities || [], (value) => value),
      speed: null,
      quality: null,
      minimumMemoryGiB: null,
      fitsMemory: null,
      externalTransmission: false,
      lifecycle: "remote-explicit",
      reason: system.status === "ready" ? "peer does not advertise a model inventory" : `peer status is ${system.status || "unknown"}`,
      provenance: { source: "systems-registry", observedRuntime: false, benchmarkMeasuredAt: null }
    }));
  const known = new Set(local.map((entry) => entry.model));
  const observed = observedModels.filter((entry) => !known.has(entry.model)).map((entry) => ({
    id: `${entry.provider}:${entry.model}`,
    model: entry.model,
    logicalModel: null,
    provider: entry.provider,
    backend: entry.backend || entry.provider,
    location: "local",
    device: "local",
    availability: activeModel === entry.model ? "ready" : "installed",
    health: activeModel === entry.model ? "ready" : "stopped",
    launchable: true,
    resident: activeModel === entry.model,
    activeGenerations: activeModel === entry.model ? (runtime.activeGenerations ?? null) : 0,
    activeLeases: 0,
    maxConcurrency: runtime.performance?.maxConcurrentSequences ?? 1,
    tokensPerSecond: benchmarks[entry.model]?.completionTokensPerSecond ?? null,
    resources: { freeMiB: resources.freeMiB ?? null, requiredMiB: null, minimumHeadroomMiB: resources.minimumHeadroomMiB ?? null, resident: activeModel === entry.model },
    selected: preference.model === entry.model,
    capabilities: [],
    speed: null,
    quality: null,
    minimumMemoryGiB: null,
    fitsMemory: null,
    externalTransmission: false,
    lifecycle: "provider-managed",
    provenance: { source: "provider-model-list", observedRuntime: true, benchmarkMeasuredAt: benchmarks[entry.model]?.measuredAt || null }
  }));
  const models = stable([...local, ...observed, ...hosted, ...remote]);
  return {
    schemaVersion: 1,
    kind: "hii.intelligence-field",
    readOnly: true,
    host: { platform, arch, memoryGiB },
    active: { model: activeModel, state: runtime.state || "unknown", endpoint: runtime.endpoint || null },
    policy: { hostedTransmission: manifest.hostedTransmission || "explicit-only", switching: "task-boundaries-only", maxConcurrentNodes: manifest.nvidia?.maxConcurrentNodes || 2 },
    leases,
    models,
    counts: models.reduce((counts, model) => ({ ...counts, [model.availability]: (counts[model.availability] || 0) + 1 }), {})
  };
}

export function planIntelligenceField(field, requirements = {}) {
  const taskClass = requirements.taskClass || "interactive";
  const maxModels = Math.max(1, Math.min(Number(requirements.maxModels) || 1, 4));
  const capabilities = stable(requirements.capabilities || [], (value) => value);
  const localOnly = requirements.privacy !== "external-ok";
  const excluded = [];
  const candidates = field.models.filter((model) => {
    if (model.availability === "unavailable") { excluded.push({ id: model.id, reason: model.reason || "unavailable" }); return false; }
    if (localOnly && model.externalTransmission) { excluded.push({ id: model.id, reason: "external transmission requires explicit selection" }); return false; }
    if (model.location === "remote" && !model.model) { excluded.push({ id: model.id, reason: "remote peer does not advertise a model inventory" }); return false; }
    return true;
  });
  const currentNodeIds = field.models.filter((model) => model.resident).map((model) => model.id);
  const decision = routeModelTask({
    nodes: candidates.map((model) => ({
      ...model,
      runtime: model.backend,
      endpoint: model.resident ? field.active?.endpoint || null : null,
      locality: model.location === "remote" ? "peer" : model.location,
      models: [model.model, model.logicalModel].filter(Boolean)
    })),
    request: { taskId: requirements.taskId || "plan", capabilities, model: requirements.model || null, allowComposition: maxModels > 1 },
    state: { currentNodeIds, lastSwitchAt: field.active?.lastSwitchAt || null },
    leases: field.leases || [],
    policy: { maxConcurrentNodes: maxModels, minimumHeadroomMiB: requirements.minimumHeadroomMiB ?? 1024 }
  });
  const byId = new Map(field.models.map((model) => [model.id, model]));
  const chosen = decision.nodeIds.map((id) => byId.get(id)).filter(Boolean);
  for (const score of decision.scores || []) if (!score.eligible) excluded.push({ id: score.id, reason: score.reasons.join(",") || "pressure policy excluded candidate" });
  return {
    schemaVersion: 1,
    kind: "hii.intelligence-field.plan",
    readOnly: true,
    taskClass,
    requirements: { privacy: localOnly ? "local" : "external-ok", capabilities, maxModels },
    action: decision.action,
    reason: decision.reason,
    chosen: chosen.map((model, index) => ({ order: index + 1, ...model, action: model.resident ? "reuse" : "spin-up-candidate" })),
    excluded: stable(excluded),
    scores: decision.scores || [],
    provenance: decision.provenance.map((entry) => ({ ...byId.get(entry.nodeId)?.provenance, ...entry })),
    bounded: true,
    mutations: [],
    notice: chosen.length ? "Plan only; no model was started, stopped, downloaded, or selected." : "No pressure-safe model route satisfies the bounded requirements."
  };
}

export async function inspectIntelligenceField({ root, runtimeRoot, platform, arch, fetchImpl = globalThis.fetch }) {
  const manifest = readJson(path.join(root, "config", "native-model-profiles.json"), {});
  const runtime = readJson(path.join(runtimeRoot, "model-runtime", "status.json"), {});
  const preference = readJson(path.join(runtimeRoot, "config", "model.json"), {});
  const benchmarks = readJson(path.join(runtimeRoot, "model-runtime", "benchmarks.json"), { results: {} }).results || {};
  const lease = readJson(path.join(runtimeRoot, "daemon", "nvidia-task.json"), null);
  const systems = readJson(path.join(runtimeRoot, "systems.json"), { systems: [] }).systems || [];
  const installedModels = [];
  for (const entry of manifest.selectionCatalog || []) {
    if (entry.source === "preset") continue;
    const cache = path.join(runtimeRoot, "models", "huggingface", "hub", `models--${String(entry.model).replaceAll("/", "--")}`);
    if (fs.existsSync(path.join(cache, "refs")) || fs.existsSync(path.join(cache, "snapshots"))) installedModels.push(entry.model);
  }
  const observedModels = [];
  const endpoints = [runtime.endpoint, "http://127.0.0.1:11434", "http://127.0.0.1:1234"].filter(Boolean);
  await Promise.all([...new Set(endpoints)].map(async (endpoint) => {
    try {
      const ollama = endpoint.endsWith(":11434");
      const response = await fetchImpl(`${endpoint}${ollama ? "/api/tags" : "/v1/models"}`, { signal: AbortSignal.timeout(750) });
      if (!response.ok) return;
      const body = await response.json();
      for (const item of ollama ? body.models || [] : body.data || []) {
        const id = item.name || item.id;
        if (id) observedModels.push({
          model: String(id),
          provider: ollama ? "ollama" : endpoint === runtime.endpoint ? (runtime.backend || "openai-compatible") : "openai-compatible",
          backend: ollama ? "ollama" : null
        });
      }
    } catch {}
  }));
  return buildIntelligenceField({
    manifest, platform, arch, installedModels, observedModels, runtime, preference, systems, benchmarks,
    leases: lease ? [{ ...lease, nodeIds: lease.nodeIds || [] }] : [],
    resources: { freeMiB: Math.round(os.freemem() / (1024 ** 2)), minimumHeadroomMiB: manifest.nvidia?.headroomMiB ?? 1024 }
  });
}
