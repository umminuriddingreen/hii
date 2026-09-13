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
});
