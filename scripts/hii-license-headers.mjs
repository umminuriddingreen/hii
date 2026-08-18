#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1
/**
 * Apply SPDX license headers to first-party HII entrypoints.
 *
 * Deliberately NOT a whole-tree sweep. The license of record is NOTICE plus the
 * per-directory LICENSE files; headers exist so that a file read in isolation —
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

const BSL = 'LicenseRef-BSL-1.1';
const APACHE = 'Apache-2.0';

/** Entrypoints only. Add a file here when it becomes a boundary someone reads first. */
const targets = [
  ['aii/daemon/hiid.mjs', BSL],
  ['cli/src/main.rs', BSL],
  ['native-runner/src/main.rs', BSL],
  ['src-tauri/src/main.rs', BSL],
  // Package.swift is deliberately absent: its `// swift-tools-version:` comment
  // must stay on line 1, and this script only makes room for a shebang.
  ['macos/Sources/HiiBar/main.swift', BSL],
  ['server.mjs', BSL],
  ['app/layout.tsx', BSL],
  ['app/page.tsx', BSL],
  ['lib/server/support.ts', BSL],
  ['lib/capabilities/types.ts', APACHE],
  ['extensions/hii-stream-mcp/src/index.ts', APACHE]
];

const header = (id) => `// SPDX-License-Identifier: ${id}`;

const check = process.argv.includes('--check');
const missing = [];
let wrote = 0;

for (const [relative, id] of targets) {
  const file = path.join(root, relative);
  if (!existsSync(file)) continue;

  const source = await readFile(file, 'utf8');
  if (source.includes('SPDX-License-Identifier:')) continue;

  if (check) {
    missing.push(relative);
    continue;
  }

  // Keep a shebang on line 1 — a header above it breaks execution.
  const shebang = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  const next = `${source.slice(0, shebang)}${header(id)}\n${source.slice(shebang)}`;
  await writeFile(file, next);
  wrote += 1;
  console.log(`header ${id.padEnd(20)} ${relative}`);
}

if (check && missing.length) {
  console.error(`Missing SPDX headers:\n${missing.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}

console.log(check ? 'All SPDX headers present.' : `${wrote} header(s) written.`);
