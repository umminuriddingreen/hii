// SPDX-License-Identifier: Apache-2.0
/** Read fresh, endpoint-backed model runtime evidence for status surfaces. */
export async function observeModelRuntime({
  endpoint,
  backend = null,
  selectedModel = null,
  executionMachine,
  headers = {},
  fetchImpl = fetch,
  timeoutMs = 1000
}) {
  const result = {
    state: "unreachable",
    loadedModel: null,
    advertisedModels: [],
    selectionMatchesLoaded: null,
    executionMachine: resolveExecutionMachine(endpoint, executionMachine)
  };
  const request = (path) => fetchImpl(`${endpoint.replace(/\/$/, "")}${path}`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });

  const [healthResponse, modelsResponse] = await Promise.all([
    request("/health").catch(() => null),
    request("/v1/models").catch(() => null)
  ]);
  const healthOk = Boolean(healthResponse?.ok);
  if (healthOk) result.state = "ready";
  const health = healthOk ? (await healthResponse.json().catch(() => ({}))) || {} : {};
  const healthModel = [health.loaded_model, health.loadedModel, health.model]
    .find((value) => typeof value === "string" && value.length > 0) || null;
  if (modelsResponse?.ok) {
    const body = (await modelsResponse.json().catch(() => ({}))) || {};
    result.advertisedModels = Array.isArray(body.data)
      ? body.data.map((model) => model?.id).filter((id) => typeof id === "string" && id.length > 0)
      : [];
  }

  result.loadedModel = healthOk
    ? healthModel || (backend === "llama.cpp" && result.advertisedModels.length === 1
      ? result.advertisedModels[0]
      : null)
    : null;
  if (selectedModel && result.loadedModel) {
    result.selectionMatchesLoaded = normalizeModelId(selectedModel) === normalizeModelId(result.loadedModel);
  }
  return result;
}

function normalizeModelId(value) {
  return String(value).trim().replace(/\\/g, "/");
}

function resolveExecutionMachine(endpoint, localMachine) {
  try {
    const host = new URL(endpoint).hostname;
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) return localMachine || host;
    return host || localMachine || null;
  } catch {
    return localMachine || null;
  }
}
