// SPDX-License-Identifier: LicenseRef-BSL-1.1

//! Proves the complete Rust-to-Playwright intent, verification, and receipt path.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("Rust governs the browser slice and writes a verified causal receipt", async () => {
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === "/items") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Items</title></head><body><main>
        <h1>Available items</h1>
        <button aria-label="Open Alpha details | $12.00 | available" onclick="location.href='/details/alpha'">Alpha</button>
        <button aria-label="Open Beta details | $8.00 | available" onclick="location.href='/details/beta'">Beta</button>
        <button aria-label="Open Gamma details | $5.00 | unavailable" disabled>Gamma</button>
      </main></body></html>`);
      return;
    }
    if (path === "/details/beta") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><head><title>Beta</title></head><body><main><h1>Item details Beta</h1></main></body></html>");
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  const runtime = await mkdtemp(resolve(tmpdir(), "hii-web-vertical-"));
  try {
    const repository = resolve(process.cwd(), "..");
    const binary = resolve(process.cwd(), process.env.HII_BIN ?? "../target/debug/hii");
    const browserd = resolve(process.cwd(), "dist/src/main.js");
    const { stdout } = await execute(binary, [
      "web",
      "vertical-test",
      "--url",
      `http://127.0.0.1:${address.port}/items`,
      "--browserd",
      browserd,
      "--json",
    ], {
      cwd: repository,
      env: { ...process.env, HII_RUNTIME_DIR: runtime },
      maxBuffer: 1_000_000,
    });
    const result = JSON.parse(stdout) as {
      case: { status: string; outcome: string; receipt: { verification: Array<{ passed: boolean }> } };
      receiptPath: string;
    };
    assert.equal(result.case.status, "succeeded");
    assert.equal(result.case.outcome, "Beta details opened");
    assert.equal(result.case.receipt.verification.every(item => item.passed), true);
    const persisted = JSON.parse(await readFile(result.receiptPath, "utf8")) as { status: string };
    assert.equal(persisted.status, "succeeded");
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    await rm(runtime, { recursive: true, force: true });
  }
});
