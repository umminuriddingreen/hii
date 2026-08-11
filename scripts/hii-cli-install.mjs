#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalLauncher = path.join(root, 'scripts', 'hii-launcher.sh');

export function installLauncher(options = {}) {
  const source = options.source || canonicalLauncher;
  const destination = options.destination
    || process.env.HII_LAUNCHER_PATH
    || path.join(homedir(), 'bin', 'hii');
  const destinationDirectory = path.dirname(destination);
  const staging = path.join(destinationDirectory, `.hii-launcher-${process.pid}.tmp`);

  if (!existsSync(source)) {
    throw new Error(`canonical HII launcher is missing: ${source}`);
  }

  mkdirSync(destinationDirectory, { recursive: true });
  try {
    copyFileSync(source, staging);
    chmodSync(staging, 0o755);
    renameSync(staging, destination);
  } finally {
    rmSync(staging, { force: true });
  }

  return { source, destination };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const installed = installLauncher();
    console.log(`hii CLI launcher installed: ${installed.destination}`);
    console.log('The launcher runs the current local HII source and rebuilds automatically whenever CLI source changes.');
  } catch (error) {
    console.error(`hii CLI launcher install failed: ${error.message}`);
    process.exit(1);
  }
}
