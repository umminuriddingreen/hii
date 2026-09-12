import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import { selectConsumerModelProfile } from "../../aii/model-runtime/profiles.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const profiles = path.join(root, "config", "native-model-profiles.json");

describe("native consumer model profiles", () => {
  it.each([
    [8, "8gb", "Qwen/Qwen3-4B"],
    [16, "16gb", "Qwen/Qwen3-8B"],
    [24, "24-32gb", "Qwen/Qwen3-14B"],
    [48, "48gb+", "mlx-community/Qwen3.5-35B-A3B-4bit"]
  ])("maps %i GiB to %s", (memoryGiB, tier, model) => {
    expect(selectConsumerModelProfile(profiles, memoryGiB)).toMatchObject({ tier, model });
  });

  it("keeps every automatic tier quantized for consumer memory", () => {
    for (const memoryGiB of [8, 16, 24, 48, 128]) {
      expect(selectConsumerModelProfile(profiles, memoryGiB).quant).toBe("4");
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
      expect.objectContaining({ aliases: expect.arrayContaining(["quality"]), quality: "highest local" })
    ]));
    expect(manifest.selectionCatalogDoc).toContain("never downloads");
    expect(JSON.stringify(manifest)).not.toContain("llmfit");
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
    const source = fs.readFileSync(path.join(root, "aii", "daemon", "hiid.mjs"), "utf8");
    const search = source.slice(source.indexOf("function searchModels"), source.indexOf("function installModel"));
    expect(search).toContain('"models", "list", "--search"');
    expect(search).not.toContain('"--human-readable"');
    expect(source).toContain("completionTokensPerSecond: Number(completionTokensPerSecond.toFixed(1))");
    expect(source).toContain('const sub = args[0] || "recommend"');
    expect(source).toContain('else if (sub === "recommend" || sub === "choose")');
    expect(source).toContain("benchmarkStore.results[status.model] = report");
    expect(source).toContain('routing: ["hii-native", "approved-hosted"]');
    expect(source).toContain('status.loadedModel = health.loaded_model || health.model');
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
