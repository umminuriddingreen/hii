const DEFAULT_POLICY = Object.freeze({
  cooldownMs: 60_000,
  hysteresis: 12,
  maxConcurrentNodes: 2,
  minimumHeadroomMiB: 1024,
});

const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const list = (value) => Array.isArray(value) ? [...new Set(value.map(String))].sort() : [];

function normalizeNode(node) {
  const requiredMiB = Math.max(0, number(node.resources?.requiredMiB));
  const freeMiB = Math.max(0, number(node.resources?.freeMiB));
  return {
    ...node,
    id: String(node.id || ""),
    health: node.health || "unknown",
    capabilities: list(node.capabilities),
    models: list(node.models),
    activeLeases: Math.max(0, number(node.activeLeases)),
    maxConcurrency: Math.max(1, number(node.maxConcurrency, 1)),
    activeGenerations: Math.max(0, number(node.activeGenerations)),
    resources: { ...node.resources, requiredMiB, freeMiB },
  };
}

function activeLease(leases, taskId) {
  return (leases || []).find((lease) => lease.taskId === taskId && ["active", "generating"].includes(lease.state));
}

export function scoreModelNode(rawNode, request = {}, state = {}, options = {}) {
  const policy = { ...DEFAULT_POLICY, ...options };
  const node = normalizeNode(rawNode);
  const required = list(request.capabilities);
  const missing = required.filter((capability) => !node.capabilities.includes(capability));
  const capabilityFit = missing.length === 0 || (request.allowComposition && required.some((capability) => node.capabilities.includes(capability)));
  const healthScore = { ready: 40, available: 25, degraded: 8, stopped: node.launchable ? 15 : -100 }[node.health] ?? -100;
  const resident = node.resources.resident ?? ["ready", "degraded"].includes(node.health);
  const availableMiB = node.resources.freeMiB - (resident ? 0 : node.resources.requiredMiB);
  const requiredHeadroom = number(request.minimumHeadroomMiB, policy.minimumHeadroomMiB);
  const capacityAvailable = node.activeLeases < node.maxConcurrency;
  const modelFit = !request.model || node.models.includes(String(request.model));
  const eligible = Boolean(node.id) && capabilityFit && modelFit && healthScore > 0
    && capacityAvailable && node.activeGenerations === 0 && availableMiB >= requiredHeadroom;
  const current = list(state.currentNodeIds).includes(node.id);
  const modelMatch = modelFit;
  const headroomScore = Math.min(30, Math.max(-30, availableMiB / 512));
  const performanceScore = Math.min(25, Math.max(0, number(node.tokensPerSecond) / 2));
  const localityScore = node.locality === "local" ? 8 : node.locality === "peer" ? 4 : 0;
  const capabilityScore = required.length * 10;
  const modelScore = request.model ? (modelMatch ? 25 : -35) : 0;
  const pressurePenalty = node.activeLeases * 12;
  const hysteresisScore = current ? number(policy.hysteresis) : 0;
  const score = healthScore + headroomScore + performanceScore + localityScore
    + capabilityScore + modelScore + hysteresisScore - pressurePenalty;
  return {
    id: node.id,
    eligible,
    score: Number(score.toFixed(3)),
    missingCapabilities: missing,
    reasons: [
      ...(healthScore <= 0 ? [`health:${node.health}`] : []),
      ...(!capacityAvailable ? ["concurrency-exhausted"] : []),
      ...(node.activeGenerations > 0 ? ["generation-in-flight"] : []),
      ...(availableMiB < requiredHeadroom ? ["insufficient-headroom"] : []),
      ...(missing.length ? [`missing:${missing.join(",")}`] : []),
      ...(!modelFit ? ["model-unavailable"] : []),
    ],
    breakdown: { health: healthScore, headroom: headroomScore, performance: performanceScore, locality: localityScore, capabilities: capabilityScore, model: modelScore, hysteresis: hysteresisScore, pressure: -pressurePenalty },
    provenance: { nodeId: node.id, runtime: node.runtime || null, endpoint: node.endpoint || null, modelMatch, observedAt: node.observedAt || null },
  };
}

function covers(nodes, capabilities) {
  const supplied = new Set(nodes.flatMap((node) => node.capabilities));
  return capabilities.every((capability) => supplied.has(capability));
}

function coveringRoute(eligible, byId, capabilities, limit) {
  let best = null;
  const visit = (start, picked) => {
    if (picked.length && covers(picked.map((id) => byId.get(id)), capabilities)) {
      const score = picked.reduce((sum, id) => sum + eligible.find((candidate) => candidate.id === id).score, 0);
      const key = [...picked].sort().join("\0");
      if (!best || score > best.score || (score === best.score && (picked.length < best.ids.length || (picked.length === best.ids.length && key < best.key)))) best = { ids: [...picked], score, key };
      return;
    }
    if (picked.length >= limit) return;
    for (let index = start; index < eligible.length; index += 1) visit(index + 1, [...picked, eligible[index].id]);
  };
  visit(0, []);
  return best?.ids || [];
}

export function routeModelTask(input = {}) {
  const policy = { ...DEFAULT_POLICY, ...(input.policy || {}) };
  const request = { ...(input.request || {}), capabilities: list(input.request?.capabilities) };
  const state = input.state || {};
  const nodes = (input.nodes || []).map(normalizeNode);
  const lease = activeLease(input.leases, request.taskId);
  if (lease) {
    const retained = list(lease.nodeIds);
    return { action: "retain", nodeIds: retained, reason: lease.state === "generating" ? "generation-in-flight" : "active-task-lease", lease, scores: [], provenance: retained.map((id) => ({ nodeId: id, source: "task-lease" })) };
  }

  const scores = nodes.map((node) => scoreModelNode(node, request, state, policy))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const eligible = scores.filter((score) => score.eligible);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let selected = request.allowComposition
    ? coveringRoute(eligible, byId, request.capabilities, Math.max(1, number(policy.maxConcurrentNodes, 1)))
    : eligible.length ? [eligible[0].id] : [];
  if (!selected.length || !covers(selected.map((id) => byId.get(id)), request.capabilities)) {
    return { action: "wait", nodeIds: [], reason: "no-eligible-route", scores, provenance: [] };
  }

  const current = list(state.currentNodeIds).filter((id) => byId.has(id));
  const currentScores = current.map((id) => scores.find((score) => score.id === id)).filter((score) => score?.eligible);
  const now = number(input.now, Date.now());
  const lastSwitchAt = Date.parse(state.lastSwitchAt || "");
  const coolingDown = Number.isFinite(lastSwitchAt) && now - lastSwitchAt < policy.cooldownMs;
  if (currentScores.length && covers(currentScores.map((score) => byId.get(score.id)), request.capabilities)) {
    const bestCurrent = currentScores.reduce((sum, score) => sum + score.score, 0);
    const bestSelected = selected.map((id) => scores.find((score) => score.id === id).score).reduce((sum, score) => sum + score, 0);
    if (coolingDown || bestSelected < bestCurrent + policy.hysteresis) selected = currentScores.map((score) => score.id).sort();
  }

  const switching = selected.some((id) => !current.includes(id)) || current.some((id) => !selected.includes(id));
  const otherGeneration = nodes.some((node) => node.activeGenerations > 0 && !selected.includes(node.id));
  if (switching && otherGeneration) return { action: "wait", nodeIds: current, reason: "generation-in-flight", scores, provenance: current.map((id) => ({ nodeId: id, source: "current-route" })) };
  return {
    action: switching ? "route" : "retain",
    nodeIds: selected,
    reason: switching ? "highest-pressure-adjusted-score" : coolingDown ? "switch-cooldown" : "hysteresis",
    scores,
    provenance: selected.map((id) => scores.find((score) => score.id === id).provenance),
  };
}
