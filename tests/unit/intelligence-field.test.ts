// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildIntelligenceField, planIntelligenceField } from "../../aii/model-runtime/intelligence-field.mjs";

const manifest = {
  hostedTransmission: "explicit-only",
  selectionCatalog: [
    { model: "fast", aliases: [], backend: "mlx", platforms: ["darwin"], architectures: ["arm64"], capabilities: ["chat", "tools"], speed: "fastest", quality: "strong", minimumMemoryGiB: 8 },
    { model: "deep", aliases: [], backend: "mlx", platforms: ["darwin"], architectures: ["arm64"], capabilities: ["chat", "tools"], speed: "moderate", quality: "highest local", minimumMemoryGiB: 32 }
  ],
  hostedCatalog: [{ provider: "hosted", model: "cloud", capabilities: ["chat", "tools"], externalTransmission: true }]
};

describe("intelligence field", () => {
  it("separates ready, installed, configured, hosted, and unverified remote state", () => {
    const field = buildIntelligenceField({
      manifest, platform: "darwin", arch: "arm64", memoryGiB: 64,
      installedModels: ["deep"], observedModels: [{ model: "fast", provider: "hii-native" }], runtime: { loadedModel: "fast", state: "ready" },
      systems: [{ id: "pc", local: false, status: "pending-agent", capabilities: ["hii.cli"] }]
    });
    expect(field.models.find((model) => model.model === "fast")?.availability).toBe("ready");
    expect(field.models.find((model) => model.model === "deep")?.availability).toBe("installed");
    expect(field.models.find((model) => model.location === "hosted")?.availability).toBe("configured");
    expect(field.models.find((model) => model.location === "remote")?.availability).toBe("unavailable");
  });

  it("makes a deterministic bounded local plan without mutations", () => {
    const field = buildIntelligenceField({ manifest, platform: "darwin", arch: "arm64", memoryGiB: 64, observedModels: [{ model: "fast", provider: "hii-native" }], runtime: { loadedModel: "fast" } });
    const first = planIntelligenceField(field, { taskClass: "interactive", capabilities: ["tools"], maxModels: 99 });
    const second = planIntelligenceField(field, { taskClass: "interactive", capabilities: ["tools"], maxModels: 99 });
    expect(first).toEqual(second);
    expect(first.chosen[0]).toMatchObject({ model: "fast", action: "reuse" });
    expect(first.chosen).toHaveLength(2);
    expect(first.mutations).toEqual([]);
    expect(first.excluded).toContainEqual({ id: "hosted:cloud", reason: "external transmission requires explicit selection" });
  });

  it("prefers deliberate quality for deep work and includes hosted only explicitly", () => {
    const field = buildIntelligenceField({ manifest, platform: "darwin", arch: "arm64", memoryGiB: 64, installedModels: ["fast", "deep"] });
    const plan = planIntelligenceField(field, { taskClass: "deep", capabilities: ["tools"], privacy: "external-ok" });
    expect(plan.chosen[0].model).toBe("deep");
    expect(plan.notice).toContain("no model was started");
  });
});
