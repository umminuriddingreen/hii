#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1

//! One-shot JSON-in, JSONL-out adapter for HII's Rust model stream.

import { stdin, stdout } from "node:process";
import { streamOxAlphaDom, type OxAlphaBrowserEvent, type OxAlphaBrowserRequest } from "./oxalpha.js";

let input = "";
stdin.setEncoding("utf8");
for await (const chunk of stdin) input += chunk;

function emit(event: OxAlphaBrowserEvent): void {
  stdout.write(`${JSON.stringify(event)}\n`);
}

try {
  const request = JSON.parse(input) as OxAlphaBrowserRequest;
  await streamOxAlphaDom(request, emit);
} catch (error) {
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
