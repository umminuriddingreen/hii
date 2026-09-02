#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
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

function buildBrowserAdapter() {
  const browser = path.join(root, 'browser');
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: browser,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (build.error) throw new Error(`Unable to start the HII browser build: ${build.error.message}`);
  if (build.status !== 0) throw new Error(`HII browser build exited with ${build.status}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    buildBrowserAdapter();
    const installed = installLauncher();
    console.log(`hii CLI launcher installed: ${installed.destination}`);
    console.log('The launcher executes the release binary directly and builds only when that binary is missing.');
  } catch (error) {
    console.error(`hii CLI launcher install failed: ${error.message}`);
    process.exit(1);
  }
}
