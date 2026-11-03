import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseGpuCsv, selectNvidiaProfile, buildNvidiaLaunchPlan, nvidiaOptions, nvidiaDoctor, nvidiaStart, nvidiaStop, nvidiaStatus, nvidiaBench, assessNvidiaBenchmark, nvidiaResourceAdvice, nvidiaPrepareTask, nvidiaFinishTask } from "../runtime/model-runtime/nvidia.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "config/native-model-profiles.json"), "utf8"));
const config = manifest.nvidia;
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hii-nvidia-test-"));
const managedModelsConfig = path.join(runtimeRoot, "models", "windows", "models.ini");
fs.mkdirSync(path.dirname(managedModelsConfig), { recursive: true });
fs.writeFileSync(managedModelsConfig, "version = 1\n");
const gpus = parseGpuCsv("0, GPU-test, RTX test, 591.01, 16384, 14000, 2384, 0\n1, GPU-second, RTX second, 591.01, 24576, 24000, 576, N/A");
const models = [ { id: "qwen3.5-9b-balanced", path: "C:\\Models with spaces\\9b.gguf", installed: true, sizeBytes: 6 * 1024 ** 3, mmproj: "C:\\Models with spaces\\vision.gguf" }, { id: "qwen3.8-27b-agent", path: "C:\\models\\27b.gguf", installed: true, sizeBytes: 13 * 1024 ** 3 } ];
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok ${passed} - ${name}`); }
const base = { root, runtimeRoot, manifest, env: {}, platform: "win32", endpoint: "http://127.0.0.1:6127" };
const unavailable = async () => { throw new Error("offline"); };
const selection = selectNvidiaProfile({ config, gpus, models });
try {
  await test("per-device telemetry preserves unknown values", () => { assert.equal(gpus.length, 2); assert.equal(gpus[1].utilizationPercent, null); });
  await test("adaptive selects small model while deep remains explicit", () => { assert.equal(selection.profile, "fast"); assert.equal(selectNvidiaProfile({ config, gpus, models, task: "deep" }).profile, "deep"); });
  await test("GPU UUID selects independent device", () => assert.equal(selectNvidiaProfile({ config, gpus, models, gpu: "GPU-second" }).gpu, 1));
  await test("pressure returns retryable memory wait", () => { const chosen = selectNvidiaProfile({ config, gpus: [{ ...gpus[0], freeMiB: 2000 }], models }); assert.equal(chosen.profile, "shared-gpu"); assert.equal(chosen.state, "waiting-for-memory"); });
  await test("active model never changes implicitly", () => { const selected = selectNvidiaProfile({ config, gpus, models, current: { state: "ready", selection: { ...selection, profile: "deep" } } }); assert.equal(selected.profile, "deep"); });
  await test("missing weights never trigger installation", () => assert.throws(() => selectNvidiaProfile({ config, gpus, models: [] }), /No installed model/));
  await test("native launch uses bounded context flash attention and single slot", () => { const plan = buildNvidiaLaunchPlan({ ...base, selection }); assert(plan.args.includes("--flash-attn")); assert.equal(plan.args[plan.args.indexOf("--parallel") + 1], "1"); assert.equal(plan.args[plan.args.indexOf("--mmproj") + 1], models[0].mmproj); });
  await test("bare HII starts an idle one-model router without loading weights", () => { const plan = buildNvidiaLaunchPlan({ ...base, selection, idleRouter: true, binary: "llama" }); assert.deepEqual(plan.args.slice(0, 5), ["serve", "--models-preset", managedModelsConfig, "--models-max", "1"]); assert(!plan.args.includes("--model")); assert.equal(plan.idleRouter, true); });
  await test("WSL paths and arguments preserve spaces without shell interpolation", () => { const plan = buildNvidiaLaunchPlan({ ...base, backend: "wsl-cuda", selection }); assert(plan.args.includes("/mnt/c/Models with spaces/9b.gguf")); assert(!plan.args.includes("Ubuntu")); assert(plan.args.includes("CUDA_VISIBLE_DEVICES=GPU-test")); });
  await test("managed launch cannot expose unauthenticated network listener", () => assert.throws(() => buildNvidiaLaunchPlan({ ...base, endpoint: "http://0.0.0.0:8181", selection }), /loopback/));
  await test("invalid context is rejected", () => assert.throws(() => buildNvidiaLaunchPlan({ ...base, contextTokens: "NaN", selection }), /Context/));
  await test("vLLM does not assume GGUF compatibility", () => assert.throws(() => buildNvidiaLaunchPlan({ ...base, backend: "wsl-vllm", selection }), /preinstalled Linux/));
  await test("CLI option values cannot silently disappear", () => { assert.throws(() => nvidiaOptions(["--backend", "--json"]), /requires/); assert.equal(nvidiaOptions(["--profile", "deep", "--dry-run"]).dryRun, true); });
  await test("doctor discovers default WSL distribution without installs", async () => {
    const calls = [];
    const report = await nvidiaDoctor({ ...base, models, run(command, args) { calls.push([command, args]); if (args.includes("WSL_DISTRO_NAME")) return { status: 0, stdout: "Ubuntu-24.04\n" }; return { status: 0, stdout: command === "nvidia-smi" ? "0, GPU-test, RTX test, 591.01, 16384, 14000, 2384, 0" : "version 1" }; } });
    assert.equal(report.backends["wsl-cuda"].distro, "Ubuntu-24.04"); assert.equal(report.backends["wsl-cuda"].available, true); assert(!JSON.stringify(calls).includes("install"));
    assert(JSON.stringify(calls).includes("/usr/lib/wsl/lib/nvidia-smi"), "WSL GPU discovery must not depend on a login-shell PATH");
  });
  await test("dry run does not write configuration or launch", async () => { const report = await nvidiaStart({ ...base, fetch: unavailable, dryRun: true, inventory: { gpus, models, backends: { "native-cuda": { available: true } } } }); assert.equal(report.dryRun, true); assert(!fs.existsSync(path.join(runtimeRoot, "config/inference.json"))); });
  await test("external runtime adopted without engine launch or ownership claim", async () => {
    const report = await nvidiaStart({ ...base, fetch: async () => new Response(JSON.stringify({ data: [{ id: "existing-model" }] })), run() { throw new Error("must not launch or inspect unrelated processes"); } });
    assert.equal(report.ownership, "external"); assert.equal(report.reused, true); assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot, "config/inference.json"))).selectedModel, "existing-model");
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot, "config/inference.json"))).schemaVersion, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot, "config/inference.json"))).contextTokens, null);
  });
  await test("preference updates atomically preserve a rollback snapshot", async () => {
    await nvidiaStart({ ...base, contextTokens: 16384, fetch: async () => new Response(JSON.stringify({ data: [{ id: "existing-model" }] })), run: () => ({ status: 1 }) });
    const snapshots = fs.readdirSync(path.join(runtimeRoot, "config")).filter((name) => name.endsWith(".previous"));
    const preference = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "config/inference.json")));
    assert.equal(snapshots.length, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot, "config", snapshots[0]))).contextTokens, null); assert.equal(preference.contextTokens, 16384); assert.equal(preference.endpoint, "http://127.0.0.1:6127"); assert.equal(preference.provider, "llama.cpp"); assert.equal(preference.modelsConfig, managedModelsConfig);
  });
  await test("stop does not signal external runtime", async () => assert.equal((await nvidiaStop(base)).stopped, false));
  await test("PID reuse cannot terminate a different Windows process", async () => {
    fs.mkdirSync(path.join(runtimeRoot, "daemon"), { recursive: true });
    const file = path.join(runtimeRoot, "daemon/nvidia-runtime.json");
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, endpoint: base.endpoint, backend: "native-cuda", identity: { id: 999999, started: "old", executable: "engine.exe" } }));
    const report = await nvidiaStop({ ...base, run: () => ({ status: 0, stdout: JSON.stringify({ id: 999999, started: "new", executable: "engine.exe" }) }) });
    assert.equal(report.stopped, false); assert.match(report.reason, /identity/); fs.unlinkSync(file);
  });
  await test("WSL reboot identity cannot terminate a reused Linux PID", async () => {
    const file = path.join(runtimeRoot, "daemon/nvidia-runtime.json");
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, linuxPid: 99, distro: "Ubuntu-24.04", endpoint: base.endpoint, backend: "wsl-cuda", linuxIdentity: { pid: 99, startTicks: "10", bootId: "old-boot", distro: "Ubuntu-24.04" } }));
    const calls = [];
    const report = await nvidiaStop({ ...base, run: (command, args) => { calls.push(args); return { status: 0, stdout: args.includes("/proc/sys/kernel/random/boot_id") ? "new-boot" : `99 (llama (server)) ${Array(19).fill("0").join(" ")} 10 0` }; } });
    assert.equal(report.stopped, false); assert(!calls.some((args) => args.includes("kill"))); fs.unlinkSync(file);
  });
  await test("authentication failure is visible without response body", async () => { const status = await nvidiaStatus({ ...base, fetch: async () => new Response("secret body", { status: 401 }) }); assert.equal(status.state, "unavailable"); assert.equal(status.health.httpStatus, 401); assert(!JSON.stringify(status).includes("secret body")); });
  await test("benchmark records real streaming latency and server metrics only", async () => {
    const fetch = async (url) => url.endsWith("/v1/models") ? new Response(JSON.stringify({ data: [{ id: "test-model" }] })) : new Response('data: {"choices":[{"delta":{"content":"{\\"sum\\":42,\\"status\\":\\"ok\\"}"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":9}}\n\ndata: [DONE]\n\n');
    const report = await nvidiaBench({ ...base, fetch }); assert.equal(report.quality.passed, true); assert(report.firstTokenMs >= 0); assert.equal(report.completionTokensPerSecond, null); assert.equal(report.promotionEligible, false);
  });
  await test("quick suite validates long context and fragmented tool calls without execution", async () => {
    let requests = 0;
    const fetch = async (url, init) => {
      if (url.endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "test-model" }] }));
      requests++; const request = JSON.parse(init.body);
      const chunks = request.tools ? [ { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "add_integers", arguments: '{"a":19,' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"b":23}' } }] }, finish_reason: "tool_calls" }] } ] : [{ choices: [{ delta: { content: request.messages[0].content.includes("HII-731") ? '{"first":"HII-731","last":"END-294"}' : '{"sum":42,"status":"ok"}' }, finish_reason: "stop" }] }];
      return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(""));
    };
    const report = await nvidiaBench({ ...base, fetch, suite: "quick" }); assert.equal(requests, 6); assert.equal(report.quality.passed, true); assert.equal(report.coldStartMeasured, false); assert.equal(report.promotion.eligible, false); assert(fs.existsSync(report.artifact));
  });
  await test("measured gate rejects quality regressions and incomparable contexts", () => {
    const baseline = { suite: "quick", model: "same-weights", backend: "native-cuda", quality: { passed: true }, samples: ["short", "long", "tool"].flatMap((workload) => [0, 1].map((repetition) => ({ workload, repetition, workloadVersion: 1, contextTokens: 8192, loadCondition: repetition ? "repeat" : "unknown", wallMs: 100, quality: { passed: true } }))) };
    const candidate = structuredClone(baseline); for (const sample of candidate.samples) sample.wallMs = 80;
    assert.equal(assessNvidiaBenchmark(candidate, baseline).eligible, true);
    candidate.samples[0].quality.passed = false; assert.equal(assessNvidiaBenchmark(candidate, baseline).eligible, false);
    candidate.samples[0].quality.passed = true; candidate.samples[0].contextTokens = 16384; assert.equal(assessNvidiaBenchmark(candidate, baseline).eligible, false);
    candidate.samples[0].contextTokens = 8192; candidate.backend = "external-unknown"; assert.equal(assessNvidiaBenchmark(candidate, baseline).eligible, false);
  });
  await test("pressure advice uses observed memory without changing route", () => { const advice = nvidiaResourceAdvice([{ ...gpus[0], freeMiB: 500 }]); assert.equal(advice.state, "memory-pressure"); assert.equal(advice.automaticAction, false); assert.equal(nvidiaResourceAdvice([]).state, "unknown"); });
  const taskBase = { ...base, backend: "native-cuda", profile: "adaptive", ownerPid: 4242, run: () => ({ status: 0, stdout: JSON.stringify({ id: 4242, started: "process-generation-one", executable: "hii.exe" }) }), inventory: { gpus, models, backends: { "native-cuda": { available: true } } } };
  const active = { state: "ready", ownership: "hii", pid: 1111, contextTokens: 16384, selection: { profile: "deep", model: { id: models[1].id }, gpu: 0 } };
  await test("task lease serializes owned work and requires matching release", async () => {
    const options = { ...taskBase, taskId: "task-one", getStatus: async () => active };
    const first = await nvidiaPrepareTask(options); assert.equal(first.ok, true); assert.equal(first.changed, false); assert.match(first.reason, /evidence/);
    const second = await nvidiaPrepareTask({ ...options, taskId: "task-two" }); assert.equal(second.ok, false); assert.equal(second.state, "busy");
    assert.equal((await nvidiaFinishTask({ ...options, taskId: "task-two" })).released, false);
    assert.equal((await nvidiaFinishTask(options)).released, true);
  });
  await test("external task retains external runtime without switch operations", async () => {
    const options = { ...taskBase, taskId: "external-task", getStatus: async () => ({ ...active, ownership: "external" }), stopRuntime: () => assert.fail("external engine must never stop") };
    const report = await nvidiaPrepareTask(options); assert.equal(report.ok, true); assert.equal(report.changed, false); assert.match(report.reason, /External/); await nvidiaFinishTask(options);
  });
  const evidenceBase = { suite: "quick", model: models[0].id, backend: "native-cuda", quality: { passed: true }, samples: ["short", "long", "tool"].flatMap((workload) => [0, 1].map((repetition) => ({ workload, repetition, profile: "fast", workloadVersion: 1, contextTokens: 16384, loadCondition: repetition ? "repeat" : "unknown", wallMs: 100, quality: { passed: true } }))) };
  const evidenceCandidate = structuredClone(evidenceBase); evidenceCandidate.samples.forEach((sample) => { sample.wallMs = 75; });
  const baselineFile = path.join(runtimeRoot, "baseline.json"); const candidateFile = path.join(runtimeRoot, "candidate.json");
  fs.writeFileSync(baselineFile, JSON.stringify(evidenceBase)); fs.writeFileSync(candidateFile, JSON.stringify(evidenceCandidate));
  const evidence = { baseline: baselineFile, candidate: candidateFile };
  await test("qualified switch still refuses an in-flight request", async () => {
    const options = { ...taskBase, taskId: "inflight-task", evidence, getStatus: async () => active, idleCheck: async () => false, stopRuntime: () => assert.fail("in-flight engine must not stop") };
    const report = await nvidiaPrepareTask(options); assert.equal(report.ok, true); assert.equal(report.changed, false); assert.match(report.reason, /in flight/); await nvidiaFinishTask(options);
  });
  await test("measured idle task-boundary switch waits for readiness and keeps adaptive preference", async () => {
    let switched = false; let stopped = false;
    const options = { ...taskBase, taskId: "switch-task", evidence, idleCheck: async () => true, getStatus: async () => switched ? { ...active, pid: 2222, contextTokens: 16384, selection: { profile: "fast", model: { id: models[0].id }, gpu: 0 } } : active, stopRuntime: async () => { stopped = true; return { stopped: true }; }, startRuntime: async () => { assert(stopped); switched = true; return { state: "starting" }; } };
    const report = await nvidiaPrepareTask(options); assert.equal(report.ok, true); assert.equal(report.changed, true); assert.equal(report.model, models[0].id);
    const pref = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "config/inference.json"))); assert.equal(pref.profile, "adaptive"); assert.equal(pref.effectiveProfile, "fast"); await nvidiaFinishTask(options);
  });
  console.log(`NVIDIA runtime: ${passed} checks passed`);
} finally { fs.rmSync(runtimeRoot, { recursive: true, force: true }); }
