#!/usr/bin/env node
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('hii:install:tauri currently installs the macOS application bundle.');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'HII.app');
const destination = '/Applications/HII.app';
const staging = `/Applications/.HII.app.install-${process.pid}`;

if (!existsSync(source)) {
  console.error(`Build HII first; no signed bundle exists at ${source}`);
  process.exit(1);
}

const verifySource = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', source], {
  stdio: 'inherit'
});
if (verifySource.status !== 0) process.exit(verifySource.status ?? 1);

const copy = spawnSync('ditto', [source, staging], { stdio: 'inherit' });
if (copy.status !== 0) process.exit(copy.status ?? 1);

const verifyStaging = spawnSync(
  'codesign',
  ['--verify', '--deep', '--strict', '--verbose=2', staging],
  { stdio: 'inherit' }
);
if (verifyStaging.status !== 0) process.exit(verifyStaging.status ?? 1);

if (existsSync(destination)) {
  const trash = path.join(homedir(), '.Trash');
  mkdirSync(trash, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-');
  renameSync(destination, path.join(trash, `HII-replaced-${stamp}.app`));
}
renameSync(staging, destination);

const verifyInstalled = spawnSync(
  'codesign',
  ['--verify', '--deep', '--strict', '--verbose=2', destination],
  { stdio: 'inherit' }
);
if (verifyInstalled.status !== 0) process.exit(verifyInstalled.status ?? 1);
console.log(`hii installed signed desktop bundle: ${destination}`);
