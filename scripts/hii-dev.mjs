// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const nextBin = fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url));

const children = [
  spawn(process.execPath, ['scripts/hii-web-dev-runtime.mjs'], { stdio: 'inherit', env: process.env }),
  spawn(process.execPath, [nextBin, 'dev', '--hostname', '127.0.0.1', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...process.env,
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
