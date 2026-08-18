#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1

/**
 * Build the HII menu bar app (`macos/`) and assemble a real `.app` bundle.
 *
 * SwiftPM emits a bare Mach-O executable, which cannot be an `LSUIElement`
 * agent app — macOS needs `Contents/Info.plist` to know there is no Dock icon
 * and no main window. So this script does the bundling SwiftPM does not:
 *
 *   macos/.build/HII Bar.app/Contents/
 *     Info.plist
 *     MacOS/HiiBar
 *     Resources/hii          <- staged CLI, mirroring scripts/hii-stage-cli.mjs
 *
 * Staging the CLI into the bundle is not optional. `CLILocator` looks in
 * `Contents/Resources` before any developer path precisely so a copied or
 * downloaded app still finds a `hii` to run.
 *
 *   node scripts/hii-bar-build.mjs                # debug build, reuse existing CLI
 *   node scripts/hii-bar-build.mjs --release      # release build + fresh CLI
 *   node scripts/hii-bar-build.mjs --test         # swift test only
 *   node scripts/hii-bar-build.mjs --run          # build, bundle, then launch
 *   node scripts/hii-bar-build.mjs --no-cli       # skip CLI staging
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = path.join(root, 'macos');
const argv = process.argv.slice(2);
const release = argv.includes('--release');
const configuration = release ? 'release' : 'debug';
const appName = 'HII Bar.app';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform !== 'darwin') {
  console.error('hii bar is a macOS menu bar app; this script only runs on macOS.');
  process.exit(1);
}

if (argv.includes('--test')) {
  run('swift', ['test', '--package-path', packageDir]);
  process.exit(0);
}

run('swift', ['build', '--package-path', packageDir, '-c', configuration]);

const binary = path.join(packageDir, '.build', configuration, 'HiiBar');
if (!existsSync(binary)) throw new Error(`HiiBar missing after build: ${binary}`);

const app = path.join(packageDir, '.build', appName);
const contents = path.join(app, 'Contents');
rmSync(app, { recursive: true, force: true });
mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
mkdirSync(path.join(contents, 'Resources'), { recursive: true });
copyFileSync(path.join(packageDir, 'Resources', 'Info.plist'), path.join(contents, 'Info.plist'));
copyFileSync(binary, path.join(contents, 'MacOS', 'HiiBar'));

// SwiftPM emits the SwiftUI/AppKit resource bundles alongside the binary.
for (const bundle of ['HiiBar_HiiBar.bundle', 'HiiBar_HiiBarCore.bundle']) {
  const source = path.join(packageDir, '.build', configuration, bundle);
  if (existsSync(source)) cpSync(source, path.join(contents, 'Resources', bundle), { recursive: true });
}

if (!argv.includes('--no-cli')) {
  const { stageCli } = await import('./hii-stage-cli.mjs');
  const staged = stageCli({ rebuild: release });
  copyFileSync(staged, path.join(contents, 'Resources', 'hii'));
  console.log(`hii bar bundled CLI: ${path.relative(root, staged)}`);
}

// Ad-hoc signature: unsigned bundles get killed by Gatekeeper on first launch
// on Apple silicon. This is a local-development signature, not distribution.
run('codesign', ['--force', '--deep', '--sign', '-', app]);

console.log(`hii bar built: ${path.relative(root, app)}`);

if (argv.includes('--run')) {
  run('open', ['-n', app]);
}
