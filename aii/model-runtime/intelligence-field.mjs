// SPDX-License-Identifier: LicenseRef-BSL-1.1
// Read-only inventory and bounded planning for HII's replaceable model field.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { supportsPlatform } from "./platform.mjs";

const stable = (values, key = (value) => value.id) => [...values].sort((a, b) => key(a).localeCompare(key(b)));
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};

function localState(entry, installed, activeModel) {
  if (activeModel === entry.model || activeModel === entry.logicalModel) return "ready";
  if (installed.has(entry.model) || installed.has(entry.logicalModel)) return "installed";
  return "configured";
}

function rank(model, taskClass) {
  const state = { ready: 0, installed: 20, configured: 40, unavailable: 100 }[model.availability] ?? 100;
  const speed = { fastest: 0, fast: 4, moderate: 10 }[model.speed] ?? 8;
  const quality = { "highest local": 0, "highest utility": 0, deliberate: 3, strong: 7, everyday: 12 }[model.quality] ?? 10;
  const task = taskClass === "interactive" ? speed * 2 + quality : quality * 2 + speed;
  return state + task;
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
  systems = []
}) {
  const installed = new Set([...installedModels, ...observedModels.map((entry) => entry.model)]);
  const activeModel = runtime.loadedModel || runtime.model || null;
  const local = (manifest.selectionCatalog || [])
    .filter((entry) => supportsPlatform(entry, platform, arch))
    .map((entry) => ({
      id: `${entry.backend}:${entry.logicalModel || entry.model}`,
      model: entry.model,
      logicalModel: entry.logicalModel || null,
      provider: entry.backend === "mlx" ? "hii-native" : entry.backend,
      backend: entry.backend,
      location: "local",
      device: "local",
      availability: localState(entry, installed, activeModel),
      selected: preference.model === entry.model || preference.model === entry.logicalModel,
      capabilities: stable(entry.capabilities || [], (value) => value),
      speed: entry.speed || null,
      quality: entry.quality || null,
      minimumMemoryGiB: entry.minimumMemoryGiB ?? null,
      fitsMemory: entry.minimumMemoryGiB == null ? null : memoryGiB >= entry.minimumMemoryGiB,
      externalTransmission: false,
      lifecycle: entry.backend === "llama.cpp" ? "task-boundary-lease" : "explicit-start-stop"
    }));
  const hosted = (manifest.hostedCatalog || []).map((entry) => ({
    id: `${entry.provider}:${entry.model}`,
    model: entry.model,
    logicalModel: null,
    provider: entry.provider,
    backend: "hosted",
    location: "hosted",
    device: null,
    availability: "configured",
    selected: preference.provider === entry.provider && preference.model === entry.model,
    capabilities: stable(entry.capabilities || [], (value) => value),
    speed: null,
    quality: null,
    minimumMemoryGiB: null,
    fitsMemory: null,
    externalTransmission: true,
    lifecycle: "explicit-only"
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
      selected: false,
      capabilities: stable(system.capabilities || [], (value) => value),
      speed: null,
      quality: null,
      minimumMemoryGiB: null,
      fitsMemory: null,
      externalTransmission: false,
      lifecycle: "remote-explicit",
      reason: system.status === "ready" ? "peer does not advertise a model inventory" : `peer status is ${system.status || "unknown"}`
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
    selected: preference.model === entry.model,
    capabilities: [],
    speed: null,
    quality: null,
    minimumMemoryGiB: null,
    fitsMemory: null,
    externalTransmission: false,
    lifecycle: "provider-managed"
  }));
  const models = stable([...local, ...observed, ...hosted, ...remote]);
  return {
    schemaVersion: 1,
    kind: "hii.intelligence-field",
    readOnly: true,
    host: { platform, arch, memoryGiB },
    active: { model: activeModel, state: runtime.state || "unknown", endpoint: runtime.endpoint || null },
    policy: { hostedTransmission: manifest.hostedTransmission || "explicit-only", switching: "task-boundaries-only" },
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
  const eligible = field.models.filter((model) => {
    if (model.availability === "unavailable") { excluded.push({ id: model.id, reason: model.reason || "unavailable" }); return false; }
    if (model.fitsMemory === false) { excluded.push({ id: model.id, reason: "does not fit host memory" }); return false; }
    if (localOnly && model.externalTransmission) { excluded.push({ id: model.id, reason: "external transmission requires explicit selection" }); return false; }
    const missing = capabilities.find((capability) => !model.capabilities.includes(capability));
    if (missing) { excluded.push({ id: model.id, reason: `missing ${missing} capability` }); return false; }
    if (model.location === "remote" && !model.model) { excluded.push({ id: model.id, reason: "remote peer does not advertise a model inventory" }); return false; }
    return true;
  });
  const ordered = stable(eligible, (model) => `${String(rank(model, taskClass)).padStart(3, "0")}:${model.id}`);
  const chosen = ordered.slice(0, maxModels);
  return {
    schemaVersion: 1,
    kind: "hii.intelligence-field.plan",
    readOnly: true,
    taskClass,
    requirements: { privacy: localOnly ? "local" : "external-ok", capabilities, maxModels },
    chosen: chosen.map((model, index) => ({ order: index + 1, ...model, action: model.availability === "ready" ? "reuse" : "spin-up-candidate" })),
    excluded: stable(excluded),
    bounded: true,
    mutations: [],
    notice: chosen.length ? "Plan only; no model was started, stopped, downloaded, or selected." : "No model satisfies the bounded requirements."
  };
}

export async function inspectIntelligenceField({ root, runtimeRoot, platform, arch, fetchImpl = globalThis.fetch }) {
  const manifest = readJson(path.join(root, "config", "native-model-profiles.json"), {});
  const runtime = readJson(path.join(runtimeRoot, "model-runtime", "status.json"), {});
  const preference = readJson(path.join(runtimeRoot, "config", "model.json"), {});
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
  return buildIntelligenceField({ manifest, platform, arch, installedModels, observedModels, runtime, preference, systems });
}
