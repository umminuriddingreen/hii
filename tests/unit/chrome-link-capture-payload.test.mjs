import { describe, expect, it } from "vitest";

import { buildWebCapture } from "../../extensions/chrome-link-capture/capture-payload.js";

const fixed = {
  capturedAt: "2026-09-12T20:00:00.000Z",
  captureId: "capture-1"
};

describe("Save to HII capture payload", () => {
  it("builds an explicit page capture", () => {
    expect(buildWebCapture({
      ...fixed,
      url: "https://example.com/article",
      title: "Example article",
      method: "extension-action",
      note: "Use this in the brief",
      tags: ["browser", " research ", "browser"]
    })).toEqual({
      schemaVersion: 1,
      kind: "hii.web.capture",
      capturedAt: fixed.capturedAt,
      captureId: fixed.captureId,
      source: {
        url: "https://example.com/article",
        title: "Example article"
      },
      capture: {
        method: "extension-action",
        domain: "example.com",
        tags: ["browser", "research"],
        note: "Use this in the brief"
      },
      authority: {
        client: "chrome-extension",
        localOnly: true
      }
    });
  });

  it("keeps selected text separate from the user note", () => {
    const payload = buildWebCapture({
      ...fixed,
      url: "https://example.com/source",
      title: "Source",
      method: "context-selection",
      selectedText: "The selected source text.",
      tags: ["browser"]
    });

    expect(payload.capture.selectedText).toBe("The selected source text.");
    expect(Object.hasOwn(payload.capture, "note")).toBe(false);
    expect(payload.source).toEqual({
      url: "https://example.com/source",
      title: "Source"
    });
  });

  it("carries explicitly saved page text through the existing local ingest contract", () => {
    const payload = buildWebCapture({
      ...fixed,
      url: "https://example.com/page",
      title: "Page",
      method: "extension-action",
      contentText: "Visible page text",
      browserName: "Helium",
      browserTabId: 42,
      tags: ["browser"]
    });
    expect(payload.content).toEqual({ text: "Visible page text" });
    expect(payload.capture.method).toBe("extension-action");
    expect(payload.capture.browserName).toBe("Helium");
    expect(payload.capture.browserTabId).toBe(42);
    expect(payload.capture.metrics).toEqual({ contentChars: 17 });
    expect(payload.authority.localOnly).toBe(true);
  });

  it("separates browser event time from ingest time and keeps metrics bounded", () => {
    const payload = buildWebCapture({
      ...fixed,
      url: "https://www.google.com/search?q=spatial+agents",
      method: "extension-page-index",
      occurredAt: "2026-09-11T18:30:00Z",
      sourceKind: "history",
      metrics: { visitCount: 8, typedCount: 2, contentChars: -1, ignored: 9 },
      search: { provider: "Google", query: "spatial agents" }
    });
    expect(payload.capturedAt).toBe(fixed.capturedAt);
    expect(payload.capture).toMatchObject({
      occurredAt: "2026-09-11T18:30:00.000Z",
      sourceKind: "history",
      domain: "www.google.com",
      metrics: { visitCount: 8, typedCount: 2 },
      search: { provider: "Google", query: "spatial agents" }
    });
    expect(Object.hasOwn(payload.capture, "location")).toBe(false);
  });
});
