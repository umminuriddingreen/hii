import { describe, expect, it } from "vitest";
import { routeModelTask, scoreModelNode } from "../../aii/model-runtime/pressure-router.mjs";

const mac = { id: "mac-mlx", runtime: "mlx", locality: "local", health: "ready", capabilities: ["tools"], models: ["qwen"], tokensPerSecond: 22, maxConcurrency: 1, resources: { freeMiB: 20_000, requiredMiB: 17_000 } };
const pc = { id: "pc-llama", runtime: "llama.cpp", locality: "peer", health: "ready", capabilities: ["tools", "vision"], models: ["qwen"], tokensPerSecond: 33, maxConcurrency: 1, resources: { freeMiB: 16_000, requiredMiB: 14_000 } };

describe("model pressure router", () => {
  it("scores deterministic candidates using capability, health, headroom, and pressure", () => {
    const first = scoreModelNode(pc, { model: "qwen", capabilities: ["tools"] });
    const pressured = scoreModelNode({ ...pc, activeLeases: 1 }, { model: "qwen", capabilities: ["tools"] });
    expect(first.eligible).toBe(true);
    expect(pressured).toMatchObject({ eligible: false, reasons: ["concurrency-exhausted"] });
    expect(first.score).toBeGreaterThan(pressured.score);
  });

  it("honors a proven resident safe floor while reporting observed memory pressure", () => {
    const resident = { ...pc, resources: { ...pc.resources, freeMiB: 200, minimumHeadroomMiB: 128 } };
    expect(scoreModelNode(resident, { capabilities: ["tools"] })).toMatchObject({
      eligible: true,
      reasons: ["memory-pressure-observed"],
      breakdown: { projectedHeadroomMiB: 200, headroomThresholdMiB: 128, memoryPressure: true },
    });
  });

  it("routes to the best arbitrary registered node and returns provenance", () => {
    const result = routeModelTask({ nodes: [mac, pc], request: { taskId: "t1", model: "qwen", capabilities: ["tools"] }, now: 100_000 });
    expect(result).toMatchObject({ action: "route", nodeIds: ["pc-llama"], reason: "highest-pressure-adjusted-score" });
    expect(result.provenance[0]).toMatchObject({ nodeId: "pc-llama", runtime: "llama.cpp" });
  });

  it("retains an active task lease and never reroutes a generation", () => {
    const result = routeModelTask({ nodes: [mac, pc], request: { taskId: "t1", capabilities: ["tools"] }, leases: [{ taskId: "t1", nodeIds: ["mac-mlx"], state: "generating" }] });
    expect(result).toMatchObject({ action: "retain", nodeIds: ["mac-mlx"], reason: "generation-in-flight" });
  });

  it("uses cooldown and hysteresis to prevent route thrashing", () => {
    const result = routeModelTask({ nodes: [mac, pc], request: { taskId: "t2", capabilities: ["tools"] }, state: { currentNodeIds: ["mac-mlx"], lastSwitchAt: "1970-01-01T00:01:35.000Z" }, now: 100_000, policy: { cooldownMs: 10_000 } });
    expect(result).toMatchObject({ action: "retain", nodeIds: ["mac-mlx"], reason: "switch-cooldown" });
  });

  it("waits when headroom or health make every candidate unsafe", () => {
    const result = routeModelTask({ nodes: [{ ...mac, health: "offline" }, { ...pc, resources: { freeMiB: 500, requiredMiB: 14_000 } }], request: { taskId: "t3", capabilities: ["tools"] } });
    expect(result).toMatchObject({ action: "wait", nodeIds: [], reason: "no-eligible-route" });
  });

  it("can plan startup for a stopped registered node, but not an unlaunchable one", () => {
    const launchable = { ...mac, health: "stopped", launchable: true };
    expect(routeModelTask({ nodes: [launchable], request: { taskId: "start", capabilities: ["tools"] } })).toMatchObject({ action: "route", nodeIds: ["mac-mlx"] });
    expect(scoreModelNode({ ...launchable, launchable: false }, { capabilities: ["tools"] }).eligible).toBe(false);
  });

  it("treats an explicitly requested model as a routing requirement", () => {
    expect(scoreModelNode(mac, { model: "another-model", capabilities: ["tools"] })).toMatchObject({ eligible: false, reasons: ["model-unavailable"] });
  });

  it("composes bounded complementary nodes for an intelligence field", () => {
    const toolNode = { ...mac, capabilities: ["tools"] };
    const visionNode = { ...pc, capabilities: ["vision"] };
    const result = routeModelTask({ nodes: [toolNode, visionNode], request: { taskId: "t4", capabilities: ["tools", "vision"], allowComposition: true }, policy: { maxConcurrentNodes: 2 } });
    expect(result).toMatchObject({ action: "route", nodeIds: ["pc-llama", "mac-mlx"] });
  });

  it("prefers the smallest covering field and scores only matched capabilities", () => {
    const all = { ...pc, id: "all", tokensPerSecond: 1 };
    const vision = { ...pc, capabilities: ["vision"] };
    const result = routeModelTask({ nodes: [mac, vision, all], request: { taskId: "minimal", capabilities: ["tools", "vision"], allowComposition: true }, policy: { maxConcurrentNodes: 2 } });
    expect(result.nodeIds).toEqual(["all"]);
    const partial = scoreModelNode({ ...mac, capabilities: ["tools"] }, { capabilities: ["tools", "vision"], allowComposition: true });
    expect(partial.breakdown.capabilities).toBe(10);
  });

  it("does not switch unrelated routes while any generation is in flight", () => {
    const busyMac = { ...mac, activeGenerations: 1 };
    const result = routeModelTask({ nodes: [busyMac, pc], request: { taskId: "new", capabilities: ["tools"] }, state: { currentNodeIds: ["mac-mlx"] } });
    expect(result).toMatchObject({ action: "wait", reason: "generation-in-flight" });
  });
});
