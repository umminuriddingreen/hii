// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildIntelligenceField, planIntelligenceField } from "../../runtime/model-runtime/intelligence-field.mjs";

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
      systems: [{ id: "pc", local: false, status: "pending-agent", capabilities: ["hii.cli"] }],
      resources: { freeMiB: 48_000, minimumHeadroomMiB: 1024 }
    });
    expect(field.models.find((model) => model.model === "fast")?.availability).toBe("ready");
    expect(field.models.find((model) => model.model === "deep")?.availability).toBe("installed");
    expect(field.models.find((model) => model.location === "hosted")?.availability).toBe("configured");
    expect(field.models.find((model) => model.location === "remote")?.availability).toBe("unavailable");
  });

  it("makes a deterministic bounded local plan without mutations", () => {
    const field = buildIntelligenceField({ manifest, platform: "darwin", arch: "arm64", memoryGiB: 64, observedModels: [{ model: "fast", provider: "hii-native" }], runtime: { loadedModel: "fast" }, resources: { freeMiB: 48_000, minimumHeadroomMiB: 1024 } });
    const first = planIntelligenceField(field, { taskClass: "interactive", capabilities: ["tools"], maxModels: 99 });
    const second = planIntelligenceField(field, { taskClass: "interactive", capabilities: ["tools"], maxModels: 99 });
    expect(first).toEqual(second);
    expect(first.chosen[0]).toMatchObject({ model: "fast", action: "reuse" });
    expect(first.chosen).toHaveLength(1);
    expect(first.mutations).toEqual([]);
    expect(first.excluded).toContainEqual({ id: "hosted:cloud", reason: "external transmission requires explicit selection" });
  });

  it("prefers deliberate quality for deep work and includes hosted only explicitly", () => {
    const field = buildIntelligenceField({ manifest, platform: "darwin", arch: "arm64", memoryGiB: 64, installedModels: ["fast", "deep"], resources: { freeMiB: 48_000, minimumHeadroomMiB: 1024 } });
    const plan = planIntelligenceField(field, { taskClass: "deep", capabilities: ["tools"], privacy: "external-ok" });
    expect(plan.chosen[0].action).toBe("spin-up-candidate");
    expect(plan.notice).toContain("no model was started");
  });

  it("excludes a model under observed pressure and reports score provenance", () => {
    const field = buildIntelligenceField({ manifest, platform: "darwin", arch: "arm64", memoryGiB: 64, installedModels: ["deep"], resources: { freeMiB: 500, minimumHeadroomMiB: 1024 } });
    const plan = planIntelligenceField(field, { capabilities: ["tools"] });
    expect(plan).toMatchObject({ action: "wait", chosen: [] });
    expect(plan.excluded.some((entry) => entry.reason.includes("insufficient-headroom"))).toBe(true);
    expect(plan.scores[0].provenance).toMatchObject({ nodeId: expect.any(String), runtime: "mlx" });
  });

  it("retains the current pressure-safe route", () => {
    const field = buildIntelligenceField({ manifest, platform: "darwin", arch: "arm64", memoryGiB: 64, observedModels: [{ model: "fast", provider: "hii-native" }], runtime: { loadedModel: "fast" }, resources: { freeMiB: 8_000, minimumHeadroomMiB: 1024 } });
    const plan = planIntelligenceField(field, { capabilities: ["tools"] });
    expect(plan).toMatchObject({ action: "retain", chosen: [{ model: "fast", action: "reuse" }] });
    expect(plan.provenance[0]).toMatchObject({ nodeId: "mlx:fast", source: "native-model-profiles" });
  });

  it("composes complementary models up to max-models", () => {
    const composed = { ...manifest, selectionCatalog: [
      { ...manifest.selectionCatalog[0], model: "tool", capabilities: ["tools"] },
      { ...manifest.selectionCatalog[1], model: "vision", capabilities: ["vision"] }
    ] };
    const field = buildIntelligenceField({ manifest: composed, platform: "darwin", arch: "arm64", memoryGiB: 64, installedModels: ["tool", "vision"], resources: { freeMiB: 64_000, minimumHeadroomMiB: 1024 } });
    const plan = planIntelligenceField(field, { capabilities: ["tools", "vision"], maxModels: 2 });
    expect(plan.chosen.map((entry) => entry.model).sort()).toEqual(["tool", "vision"]);
  });
});
