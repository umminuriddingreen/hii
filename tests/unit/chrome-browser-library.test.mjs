import { describe, expect, it } from "vitest";

import {
  buildLibraryCapture,
  committedSearchFromUrl,
  chunks,
  flattenBookmarks,
  inspectImportUrl
} from "../../extensions/chrome-link-capture/browser-library.js";

describe("HII Companion browser library", () => {
  it("allows ordinary web pages but excludes credentials, browser pages, sign-in, and payment URLs", () => {
    expect(inspectImportUrl("https://example.com/research?q=trees")).toMatchObject({
      allowed: true,
      url: "https://example.com/research?q=trees"
    });
    expect(inspectImportUrl("chrome://history")).toEqual({ allowed: false, reason: "browser_internal_or_non_web" });
    expect(inspectImportUrl("https://accounts.example.com/signin")).toEqual({ allowed: false, reason: "sign_in_or_payment" });
    expect(inspectImportUrl("https://shop.example.com/checkout")).toEqual({ allowed: false, reason: "sign_in_or_payment" });
    expect(inspectImportUrl("https://example.com/callback?access_token=secret")).toEqual({ allowed: false, reason: "credential_like_url_parameter" });
  });

  it("flattens bookmark folders while preserving local provenance", () => {
    expect(flattenBookmarks([{
      id: "0",
      title: "Bookmarks bar",
      children: [{ id: "1", title: "Research", children: [{ id: "2", title: "Source", url: "https://example.com" }] }]
    }])).toEqual([{
      id: "2",
      title: "Source",
      url: "https://example.com",
      folderPath: "Bookmarks bar / Research",
      dateAdded: undefined,
      dateLastUsed: undefined
    }]);
  });

  it("builds stable local-only payloads for unchanged browser records", async () => {
    const input = {
      category: "history",
      url: "https://example.com/article#section",
      title: "Example",
      observedAt: "2026-09-21T16:00:00.000Z",
      itemTimestamp: Date.parse("2026-09-20T12:00:00.000Z"),
      metadata: { provenance: "Chrome history", visitCount: 3 }
    };
    const first = await buildLibraryCapture(input);
    const repeated = await buildLibraryCapture({ ...input, observedAt: "2026-09-21T17:00:00.000Z" });
    expect(repeated.payload.captureId).toBe(first.payload.captureId);
    expect(first.payload.captureId).toMatch(/^browser-library-history-[a-f0-9]{40}$/);
    expect(first.payload.capture).toMatchObject({
      method: "extension-page-index",
      sourceKind: "history",
      occurredAt: "2026-09-20T12:00:00.000Z",
      metrics: { visitCount: 3, contentChars: 0 },
      tags: ["browser", "browser-library", "history"]
    });
    expect(first.payload.authority).toEqual({ client: "chrome-extension", localOnly: true });
    expect(first.payload.capturedAt).toBe("2026-09-21T16:00:00.000Z");
    expect(first.payload.source.url).toBe("https://example.com/article");
  });

  it("extracts only committed searches from allowlisted search-result URLs", () => {
    expect(committedSearchFromUrl("https://www.google.com/search?q=spatial+agents")).toEqual({
      provider: "Google",
      query: "spatial agents"
    });
    expect(committedSearchFromUrl("https://example.com/?q=private")).toBeUndefined();
    expect(committedSearchFromUrl("https://accounts.google.com/signin?q=private")).toBeUndefined();
  });

  it("bounds native-host batches", () => {
    expect(chunks(Array.from({ length: 41 }, (_, index) => index))).toEqual([
      Array.from({ length: 20 }, (_, index) => index),
      Array.from({ length: 20 }, (_, index) => index + 20),
      [40]
    ]);
  });
});
