#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1

/**
 * Syntax-check the shell scripts HII ships, where a shell exists to do it.
 *
 * `bash -n` is the real check and it stays the real check on macOS, Linux, and
 * CI. Windows runners have no `bash` on PATH outside Git Bash, and these are
 * POSIX installer scripts that Windows never executes -- so a missing shell is
 * "not applicable", not a failure. Skipping keeps `npm run ci:product` able to
 * run on a Windows runner at all.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const scripts = process.argv.slice(2);
if (!scripts.length) {
  console.error('usage: hii-shell-syntax-check.mjs <script.sh> [...]');
  process.exit(2);
}

const probe = spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' });
if (probe.error || probe.status !== 0) {
  console.log(`hii skipped shell syntax check (no bash on ${process.platform}): ${scripts.join(' ')}`);
  process.exit(0);
}

for (const script of scripts) {
  const source = readFileSync(script, 'utf8').replace(/\r\n?/g, '\n');
  const check = spawnSync('bash', ['-n'], { input: source, stdio: ['pipe', 'inherit', 'inherit'] });
  if (check.status !== 0) process.exit(check.status ?? 1);
}
console.log(`hii shell syntax ok: ${scripts.join(' ')}`);
