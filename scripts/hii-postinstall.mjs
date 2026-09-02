#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1

/**
 * Make the bundled node-pty spawn helper executable after an install.
 *
 * npm restores prebuilt binaries without their executable bit, so the first
 * terminal a user opens fails with EACCES. This ran as an inline `chmod … ||
 * true`, which is not a command `cmd.exe` understands — it failed `npm ci` on
 * Windows before a single dependency was linked. Permission bits are a POSIX
 * concept, so the whole step is a no-op there.
 */

import { chmodSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds');

let entries = [];
try {
  entries = readdirSync(prebuilds);
} catch {
  // node-pty is optional for anyone who never opens a terminal.
  process.exit(0);
}

for (const entry of entries) {
  const helper = path.join(prebuilds, entry, 'spawn-helper');
  try {
    if (statSync(helper).isFile()) chmodSync(helper, 0o755);
  } catch {
    // A prebuild for another platform has no helper; that is not an error.
  }
}
