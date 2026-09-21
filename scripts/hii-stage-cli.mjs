#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1

/**
 * Stage the `hii` CLI into `src-tauri/resources/` so Tauri bundles it.
 *
 * The desktop app is a window onto the CLI — every agent run shells out to it.
 * Without a bundled copy the app resolves the binary from developer-machine
 * paths, so it launches for anyone and then fails at the first agent run on
 * every computer except the one that built this repository.
 *
 * Tauri's build script validates `bundle.resources` before compiling, so this
 * runs from `dev:desktop` and `build:desktop` — the `beforeDevCommand` and
 * `beforeBuildCommand` — and not only on the release path.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.platform === 'win32' ? 'hii.exe' : 'hii';
const staged = path.join(root, 'src-tauri', 'resources', binary);

/** Release builds must not ship a stale CLI; dev only needs the file to exist. */
const release = process.argv.includes('--release') || process.env.NODE_ENV === 'production';

export function stageCli({ rebuild = true } = {}) {
  const built = path.join(root, 'target', 'release', binary);

  if (rebuild || !existsSync(built)) {
    const build = spawnSync('cargo', ['build', '--release', '-p', 'hii-cli'], {
      cwd: root,
      stdio: 'inherit'
    });
    if (build.error) throw new Error(`Unable to start the HII CLI build: ${build.error.message}`);
    if (build.status !== 0) process.exit(build.status ?? 1);
  }

  if (!existsSync(built)) {
    throw new Error(`HII CLI missing after build: ${path.relative(root, built)}`);
  }

  const fresh = existsSync(staged) && statSync(staged).mtimeMs >= statSync(built).mtimeMs;
  if (!fresh) {
    mkdirSync(path.dirname(staged), { recursive: true });
    copyFileSync(built, staged);
    if (process.platform !== 'win32') chmodSync(staged, 0o755);
  }
  return staged;
}

// Dev keeps an existing release binary rather than paying for a cargo build on
// every `tauri dev`; a release build always recompiles so the bundle is current.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log(`hii staged CLI for bundling: ${path.relative(root, stageCli({ rebuild: release }))}`);
}
