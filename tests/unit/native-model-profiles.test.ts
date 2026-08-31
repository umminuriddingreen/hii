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
    [48, "48gb+", "mlx-community/Qwen3-4B-Instruct-2507-4bit"]
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
});

describe("HII model management CLI", () => {
  it("uses the current Hugging Face model-list contract", () => {
    const source = fs.readFileSync(path.join(root, "aii", "daemon", "hiid.mjs"), "utf8");
    const search = source.slice(source.indexOf("function searchModels"), source.indexOf("function installModel"));
    expect(search).toContain('"models", "list", "--search"');
    expect(search).not.toContain('"--human-readable"');
    expect(source).toContain("completionTokensPerSecond: Number(completionTokensPerSecond.toFixed(1))");
  });

  it("defaults conversation UX to the direct model and tool stream", () => {
    const source = fs.readFileSync(path.join(root, "cli", "src", "conversation.rs"), "utf8");
    expect(source).toContain("thinking_mode: ThinkingMode::Raw");
    expect(source).toContain("Stream view is active: model tokens, tool calls, results, and receipts.");
  });
});
