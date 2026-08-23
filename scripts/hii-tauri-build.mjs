#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageCli } from './hii-stage-cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauri = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');

// A release bundle always carries a freshly built CLI; see hii-stage-cli.mjs.
console.log(`hii staged CLI for bundling: ${path.relative(root, stageCli({ rebuild: true }))}`);
const requestedArgs = process.argv.slice(2);
const args = requestedArgs.some((arg) => arg === '--bundles' || arg === '-b')
  ? ['build', ...requestedArgs]
  : ['build', '--bundles', process.platform === 'win32' ? 'nsis' : 'app', ...requestedArgs];
// Updater artifacts are always produced, so every build needs the minisign key.
// Default to the local one so `npm run build:tauri` stays a single command.
const defaultKey = path.join(homedir(), '.hii', 'keys', 'hii-updater.key');
const signingKey = process.env.TAURI_SIGNING_PRIVATE_KEY
  || (existsSync(defaultKey) ? defaultKey : '');
if (!signingKey) {
  console.error([
    `No updater signing key at ${defaultKey}.`,
    'Generate one with: npx tauri signer generate -w ~/.hii/keys/hii-updater.key',
    'Its public half must match plugins.updater.pubkey in src-tauri/tauri.conf.json.'
  ].join('\n'));
  process.exit(2);
}

const build = spawnSync(tauri, args, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: signingKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? ''
  }
});
if (build.error) console.error(`Unable to start the Tauri build: ${build.error.message}`);
if (build.status !== 0) process.exit(build.status ?? 1);

if (process.platform === 'darwin' && !process.env.APPLE_SIGNING_IDENTITY) {
  // A local build is ad-hoc signed so it runs on this machine. Release builds are
  // signed by Tauri with APPLE_SIGNING_IDENTITY; re-signing here would strip that.
  const bundle = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'HII.app');
  const sign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', bundle], {
    cwd: root,
    stdio: 'inherit'
  });
  if (sign.status !== 0) process.exit(sign.status ?? 1);
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], {
    cwd: root,
    stdio: 'inherit'
  });
  if (verify.status !== 0) process.exit(verify.status ?? 1);
  console.log(`hii signed desktop bundle: ${path.relative(root, bundle)}`);
}
