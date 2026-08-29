// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['scripts/hii-web-dev-runtime.mjs'], { stdio: 'inherit', env: process.env }),
  spawn('next', ['dev', '--hostname', '127.0.0.1', ...process.argv.slice(2)], {
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
  child.on('exit', (code) => {
    if (code && code !== 0) process.exitCode = code;
    stop();
  });
}
