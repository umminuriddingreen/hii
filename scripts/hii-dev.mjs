// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nextBin = fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url));
const childEnv = { ...process.env, HII_ROOT: repo };

const children = [
  spawn(process.execPath, ['scripts/hii-web-dev-runtime.mjs'], { cwd: repo, stdio: 'inherit', env: childEnv }),
  spawn(process.execPath, [nextBin, 'dev', '--hostname', '127.0.0.1', ...process.argv.slice(2)], {
    cwd: repo,
    stdio: 'inherit',
    env: {
      ...childEnv,
      HII_NEXT_DIST_DIR: process.env.HII_NEXT_DIST_DIR || '.next-web-dev',
      NEXT_PUBLIC_HII_TARGET: 'web'
    }
  })
];

function stop(signal = 'SIGTERM') {
  for (const child of children) if (!child.killed) child.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
for (const child of children) {
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
    stop();
  });
  child.on('exit', (code) => {
    if (code && code !== 0) process.exitCode = code;
    stop();
  });
}
