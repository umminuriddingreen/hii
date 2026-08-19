// SPDX-License-Identifier: LicenseRef-BSL-1.1

//! Runs the local NDJSON browser worker over standard input and output.

import { createInterface } from "node:readline";
import { ProtocolFailure, type ProtocolRequest, type ProtocolResponse } from "./protocol.js";
import { BrowserWorker } from "./worker.js";

const worker = new BrowserWorker();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  if (!line.trim()) continue;
  let request: ProtocolRequest;
  try {
    request = JSON.parse(line) as ProtocolRequest;
    if (!request || typeof request.id !== "string" || typeof request.method !== "string") throw new Error("invalid envelope");
  } catch {
    write({ id: "invalid", ok: false, error: { code: "invalid_request", message: "request must be one JSON object per line" } });
    continue;
  }
  try {
    const result = await worker.dispatch(request);
    write({ id: request.id, ok: true, result });
  } catch (error) {
    const detail = error instanceof ProtocolFailure
      ? error.detail
      : { code: "browser_failure" as const, message: error instanceof Error ? error.message : String(error) };
    write({ id: request.id, ok: false, error: detail });
  }
}

await worker.close();

function write(response: ProtocolResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
