import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import { resolveModelSelectionEntry, selectConsumerModelProfile } from "../../runtime/model-runtime/profiles.mjs";
import { buildNvidiaLaunchPlan } from "../../runtime/model-runtime/nvidia.mjs";
import { detectModelPlatform, supportsPlatform } from "../../runtime/model-runtime/platform.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const profiles = path.join(root, "config", "native-model-profiles.json");

describe("native consumer model profiles", () => {
  it.each([
    [8, "8gb", "Qwen/Qwen3-4B"],
    [16, "16gb", "Qwen/Qwen3-8B"],
    [24, "24-32gb", "Qwen/Qwen3-14B"],
    [48, "48gb+", "mlx-community/Qwen3.5-35B-A3B-4bit"]
  ])("maps %i GiB to %s", (memoryGiB, tier, model) => {
    expect(selectConsumerModelProfile(profiles, memoryGiB, "darwin", "arm64")).toMatchObject({ tier, model });
  });

  it.each([
    [16, "windows-16-24gb", "qwen3.5-9b-balanced"],
    [64, "windows-32gb+", "qwen3.8-27b-agent"]
  ])("maps %i GiB Windows hosts to %s", (memoryGiB, tier, model) => {
    expect(selectConsumerModelProfile(profiles, memoryGiB, "win32", "x64")).toMatchObject({
      tier,
      model,
      backend: "llama.cpp"
    });
  });

  it("keeps every automatic tier quantized for consumer memory", () => {
    for (const memoryGiB of [8, 16, 24, 48, 128]) {
      expect(selectConsumerModelProfile(profiles, memoryGiB, "darwin", "arm64").quant).toBe("4");
    }
  });

  it("defines a bounded utility-per-wait gate", () => {
    const manifest = JSON.parse(fs.readFileSync(profiles, "utf8"));
    expect(manifest.performanceGate).toEqual({
      maxWallMs: 120000,
      minCompletionTokensPerSecond: 8,
      requiresCompletion: true
    });
  });

  it("offers explicit HII-owned model choices without an external recommender", () => {
    const manifest = JSON.parse(fs.readFileSync(profiles, "utf8"));
    expect(manifest.selectionCatalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ aliases: expect.arrayContaining(["fast"]), speed: "fastest" }),
      expect.objectContaining({ aliases: expect.arrayContaining(["balanced"]), model: "mlx-community/Qwen3.5-9B-MLX-4bit" }),
      expect.objectContaining({ aliases: expect.arrayContaining(["quality"]), quality: "highest local" }),
      expect.objectContaining({ model: "qwen3.6-35b-a3b-agent", backend: "llama.cpp", source: "preset" })
    ]));
    expect(manifest.selectionCatalogDoc).toContain("never downloads");
    expect(JSON.stringify(manifest)).not.toContain("llmfit");
  });

  it("resolves the logical Qwen3.8 27B agent model to the native platform format", () => {
    const manifest = JSON.parse(fs.readFileSync(profiles, "utf8"));
    expect(resolveModelSelectionEntry(manifest, "qwen3.8-27b-agent", "darwin", "arm64")).toMatchObject({
      model: "mlx-community/Qwen3.8-27B-4bit",
      logicalModel: "qwen3.8-27b-agent",
      backend: "mlx",
      capabilities: ["chat", "tools", "vision"]
    });
    expect(resolveModelSelectionEntry(manifest, "qwen3.8-27b-agent", "win32", "x64")).toMatchObject({
      model: "qwen3.8-27b-agent",
      logicalModel: "qwen3.8-27b-agent",
      backend: "llama.cpp",
      source: "preset",
      capabilities: ["chat", "tools", "vision"]
    });
    expect(resolveModelSelectionEntry(manifest, "mlx-community/Qwen3.8-27B-4bit", "win32", "x64")).toBeNull();
  });

  it("defines an RTX 5080-sized agent profile with full GPU residency", () => {
    const manifest = JSON.parse(fs.readFileSync(profiles, "utf8"));
    expect(manifest.nvidia.profiles.agent).toEqual({
      modelAliases: ["qwen3.8-27b-agent"],
      contextTokens: 16384,
      batchSize: 1024,
      microBatchSize: 256,
      kvCacheType: "q4_0",
      cpuOffload: false
    });

    const selection = {
      settings: manifest.nvidia.profiles.agent,
      model: { id: "qwen3.8-27b-agent", path: "C:\\models\\qwen3.8-27b-agent.gguf" },
      gpu: 0,
      gpuUuid: "GPU-5080"
    };
    const plan = buildNvidiaLaunchPlan({
      manifest,
      selection,
      platform: "win32",
      backend: "native-cuda",
      endpoint: "http://127.0.0.1:6127",
      binary: "llama-server.exe"
    });
    expect(plan.contextTokens).toBe(16384);
    expect(plan.args).toEqual(expect.arrayContaining([
      "--n-gpu-layers", "999",
      "--cache-type-k", "q4_0",
      "--cache-type-v", "q4_0"
    ]));
  });

  it("detects Windows and Apple Silicon model compatibility explicitly", () => {
    expect(detectModelPlatform({ platform: "win32", arch: "x64", release: "Windows", env: {} })).toMatchObject({
      id: "windows",
      runtimeFamily: "llama.cpp",
      modelFormat: "gguf",
      supported: true
    });
    expect(detectModelPlatform({ platform: "darwin", arch: "arm64", release: "Darwin", env: {} })).toMatchObject({
      id: "macos",
      runtimeFamily: "mlx",
      modelFormat: "mlx-safetensors",
      supported: true
    });
    expect(supportsPlatform({ platforms: ["darwin"], architectures: ["arm64"] }, "win32", "x64")).toBe(false);
  });

  it("offers Ox Alpha only as an explicit external HII-tool model", () => {
    const manifest = JSON.parse(fs.readFileSync(profiles, "utf8"));
    expect(manifest.hostedTransmission).toBe("explicit-only");
    expect(manifest.hostedCatalog).toContainEqual(expect.objectContaining({
      provider: "ox-alpha-web",
      model: "z-ai/glm-5.3-flash",
      aliases: expect.arrayContaining(["ox-alpha"]),
      externalTransmission: true,
      capabilities: expect.arrayContaining(["hii-tools"])
    }));
  });
});

describe("HII model management CLI", () => {
  it("uses the current Hugging Face model-list contract", () => {
    const source = fs.readFileSync(path.join(root, "runtime", "daemon", "hiid.mjs"), "utf8");
    const search = source.slice(source.indexOf("function searchModels"), source.indexOf("function installModel"));
    expect(search).toContain('"models", "list", "--search"');
    expect(search).not.toContain('"--human-readable"');
    expect(source).toContain("completionTokensPerSecond: Number(completionTokensPerSecond.toFixed(1))");
    expect(source).toContain('const sub = args[0] || "recommend"');
    expect(source).toContain('else if (sub === "recommend" || sub === "choose")');
    expect(source).toContain("benchmarkStore.results[status.model] = report");
    expect(source).toContain('routing: ["hii-native", "approved-hosted"]');
    expect(source).toContain('status.loadedModel = health.loaded_model || health.model');
    expect(source).toContain('HOST_PLATFORM.nodePlatform === "win32"');
    expect(source).toContain('sub === "discover" || sub === "find"');
  });

  it("defaults to the readable conversation view and keeps the direct stream available", () => {
    const source = fs.readFileSync(path.join(root, "cli", "src", "conversation.rs"), "utf8");
    const settings = fs.readFileSync(path.join(root, "cli", "src", "settings.rs"), "utf8");
    expect(settings).toContain('"conversation".into()');
    expect(source).toContain("Self::thinking_mode_for(&configured_view).unwrap_or(ThinkingMode::Conversation)");
    expect(source).toContain("readable replies, tool calls, results, and receipts are appended progressively");
    expect(source).toContain('"assistant.stream.delta"');
  });
});
