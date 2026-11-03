import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { encodeNativeMessage } from "../../scripts/hii-chrome-native-host.mjs";

const hostScript = resolve(process.cwd(), "scripts/hii-chrome-native-host.mjs");

function decodeNativeMessage(buffer) {
  const length = buffer.readUInt32LE(0);
  return JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
}

function runHost(message, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hostScript], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const response = decodeNativeMessage(Buffer.concat(chunks));
      resolve({ code, response, stderr });
    });
    child.stdin.end(encodeNativeMessage(message));
  });
}

async function fakeHiiCommand() {
  const directory = await mkdtemp(join(tmpdir(), "hii-native-host-test-"));
  const fake = join(directory, "fake-hii.mjs");
  const cmd = join(directory, process.platform === "win32" ? "fake-hii.cmd" : "fake-hii");
  await writeFile(fake, `
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => raw += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(raw);
  console.log(JSON.stringify({
    source: { id: "source:test", title: payload.source.title, url: payload.source.url },
    receiptId: "receipt-test",
    receiptPath: "runtime/runs/cli/receipt-test/receipt.json"
  }));
});
`);
  if (process.platform === "win32") {
    await writeFile(cmd, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  } else {
    await writeFile(cmd, `#!/usr/bin/env sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    await chmod(cmd, 0o755);
  }
  return fake;
}

const payload = {
  schemaVersion: 1,
  kind: "hii.web.capture",
  capturedAt: "2026-09-12T20:00:00.000Z",
  captureId: "capture-1",
  source: { url: "https://example.com/article", title: "Example article" },
  capture: { method: "extension-action", tags: ["browser"] },
  authority: { client: "chrome-extension", localOnly: true }
};

describe("Save to HII native messaging host", () => {
  it("reports local host availability without invoking HII", async () => {
    const { code, response } = await runHost({ type: "ping" }, {
      HII_CHROME_NATIVE_HII: "missing-hii-command"
    });
    expect(code).toBe(0);
    expect(response).toEqual({ ok: true, data: { host: "com.hii.save_to_hii" } });
  });
  it("passes one hii.web.capture payload to the CLI ingest command", async () => {
    const command = await fakeHiiCommand();
    const { code, response } = await runHost({ type: "save-capture", payload }, {
      HII_CHROME_NATIVE_HII: process.execPath,
      HII_CHROME_NATIVE_HII_ARGS: JSON.stringify([command])
    });

    expect(code).toBe(0);
    expect(response).toEqual({
      ok: true,
      data: {
        source: { id: "source:test", title: "Example article", url: "https://example.com/article" },
        receiptId: "receipt-test",
        receiptPath: "runtime/runs/cli/receipt-test/receipt.json"
      }
    });
  });

  it("rejects non-local capture messages before spawning HII", async () => {
    const { code, response } = await runHost({
      type: "save-capture",
      payload: { ...payload, authority: { client: "chrome-extension", localOnly: false } }
    }, { HII_CHROME_NATIVE_HII: "missing-hii-command" });

    expect(code).toBe(1);
    expect(response.ok).toBe(false);
    expect(response.error).toContain("localOnly");
  });

  it("requires account handoff to be a separate explicit boolean", async () => {
    const { code, response } = await runHost({
      type: "save-capture",
      payload,
      shareToAccount: "yes"
    }, { HII_CHROME_NATIVE_HII: "missing-hii-command" });

    expect(code).toBe(1);
    expect(response.ok).toBe(false);
    expect(response.error).toContain("shareToAccount");
  });

  it("ingests bounded browser-library batches locally without account sharing", async () => {
    const command = await fakeHiiCommand();
    const browserPayload = {
      ...payload,
      captureId: "browser-library-history-test",
      capture: { method: "extension-page-index", tags: ["browser", "browser-library", "history"] }
    };
    const { code, response } = await runHost({
      type: "import-browser-library",
      payloads: [browserPayload]
    }, {
      HII_CHROME_NATIVE_HII: process.execPath,
      HII_CHROME_NATIVE_HII_ARGS: JSON.stringify([command])
    });

    expect(code).toBe(0);
    expect(response).toEqual({
      ok: true,
      data: { imported: 1, unchanged: 0, failed: 0, errors: [] }
    });
  });

  it("rejects browser-library cloud handoff and oversized batches", async () => {
    const browserPayload = {
      ...payload,
      capture: { method: "extension-page-index", tags: ["browser-library"] }
    };
    const shared = await runHost({
      type: "import-browser-library",
      payloads: [browserPayload],
      shareToAccount: true
    }, { HII_CHROME_NATIVE_HII: "missing-hii-command" });
    expect(shared.code).toBe(1);
    expect(shared.response.error).toContain("cannot be shared");

    const oversized = await runHost({
      type: "import-browser-library",
      payloads: Array.from({ length: 26 }, (_, index) => ({ ...browserPayload, captureId: `batch-${index}` }))
    }, { HII_CHROME_NATIVE_HII: "missing-hii-command" });
    expect(oversized.code).toBe(1);
    expect(oversized.response.error).toContain("1 to 25");
  });
});
