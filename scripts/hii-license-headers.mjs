#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Apply SPDX license headers to first-party HII entrypoints.
 *
 * Deliberately NOT a whole-tree sweep. The license of record is LICENSE plus
 * NOTICE; headers exist so that a file read in isolation —
 * pasted into an issue, vendored by someone else — still says what it is.
 *
 *   node scripts/hii-license-headers.mjs --check   # exit 1 if anything is missing
 *   node scripts/hii-license-headers.mjs           # write missing headers
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const APACHE = 'Apache-2.0';

/** Entrypoints only. Add a file here when it becomes a boundary someone reads first. */
const targets = [
  ['runtime/daemon/hiid.mjs', APACHE],
  ['cli/src/main.rs', APACHE],
  ['native-runner/src/main.rs', APACHE],
  // Package.swift is deliberately absent: its `// swift-tools-version:` comment
  // must stay on line 1, and this script only makes room for a shebang.
  ['macos/Sources/HiiBar/main.swift', APACHE],
  ['server.mjs', APACHE],
  ['lib/site.ts', APACHE],
  ['lib/server/support.ts', APACHE],
  ['lib/capabilities/types.ts', APACHE],
  ['extensions/hii-stream-mcp/src/index.ts', APACHE]
];

const header = (id) => `// SPDX-License-Identifier: ${id}`;

const check = process.argv.includes('--check');
const incorrect = [];
let wrote = 0;

for (const [relative, id] of targets) {
  const file = path.join(root, relative);
  if (!existsSync(file)) continue;

  const source = await readFile(file, 'utf8');
  const expectedHeader = header(id);
  if (source.includes(expectedHeader)) continue;

  if (check) {
    incorrect.push(`${relative} (expected ${id})`);
    continue;
  }

  // Keep a shebang on line 1 — a header above it breaks execution.
  const shebang = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  const existing = /SPDX-License-Identifier:\s*[^\r\n]+/;
  const next = existing.test(source)
    ? source.replace(existing, expectedHeader)
    : `${source.slice(0, shebang)}${expectedHeader}\n${source.slice(shebang)}`;
  await writeFile(file, next);
  wrote += 1;
  console.log(`header ${id.padEnd(20)} ${relative}`);
}

if (check && incorrect.length) {
  console.error(`Missing or incorrect SPDX headers:\n${incorrect.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}

console.log(check ? 'All SPDX headers present.' : `${wrote} header(s) written.`);
