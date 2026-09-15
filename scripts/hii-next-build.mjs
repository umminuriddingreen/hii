#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const next = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'next.cmd' : 'next');
const target = process.argv.includes('--desktop') ? 'desktop' : 'web';
const args = ['build', ...process.argv.slice(2).filter((arg) => arg !== '--desktop')];

const result = spawnSync(next, args, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    NEXT_PUBLIC_HII_TARGET: target,
  },
});

if (result.error) {
  console.error(`Unable to start Next.js: ${result.error.message}`);
}
process.exit(result.status ?? 1);
