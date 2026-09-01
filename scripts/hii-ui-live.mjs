#!/usr/bin/env node
// Point the installed HII app at a live dev server so interface work shows up
// with HMR, without rebuilding or reinstalling the Tauri app.
//
//   node scripts/hii-ui-live.mjs            # follow http://127.0.0.1:3042
//   node scripts/hii-ui-live.mjs --serve    # also run next dev, restore on exit
//   node scripts/hii-ui-live.mjs --off      # go back to the installed/baked UI
//   node scripts/hii-ui-live.mjs --bundled  # prefer this app's baked UI; keep old bundles for rollback
//   node scripts/hii-ui-live.mjs --status
//
// The app reads ~/.hii/ui/state.json at startup and whenever ui_channel_set_live
// runs, so a running app follows immediately on its next launch.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const channelDir = process.env.HII_UI_DIR || path.join(os.homedir(), '.hii', 'ui');
const statePath = path.join(channelDir, 'state.json');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  const value = process.argv[index + 1];
  return index >= 0 && value && !value.startsWith('--') ? value : fallback;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(channelDir, { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function describe(state) {
  const mode = state.mode || 'bundled';
  const target =
    mode === 'live' ? state.liveUrl : mode === 'installed' ? `bundle ${state.version}` : 'app bundle';
  return `${mode} → ${target}`;
}

const state = readState();

if (process.argv.includes('--status')) {
  console.log(`HII UI channel: ${describe(state)}`);
  console.log(`state: ${statePath}`);
  process.exit(0);
}

if (process.argv.includes('--off')) {
  state.mode = state.version ? 'installed' : 'bundled';
  state.liveUrl = null;
  writeState(state);
  console.log(`HII UI channel: ${describe(state)} (restart HII to load it)`);
  process.exit(0);
}

if (process.argv.includes('--bundled')) {
  state.mode = 'bundled';
  state.liveUrl = null;
  state.version = null;
  state.pendingVersion = null;
  state.autoApply = false;
  writeState(state);
  console.log(`HII UI channel: ${describe(state)} (installed bundles preserved for rollback; restart HII)`);
  process.exit(0);
}

const url = arg('url', `http://127.0.0.1:${arg('port', '3042')}`);
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(url) && !/^https:\/\//.test(url)) {
  console.error('A live URL must be loopback http or https.');
  process.exit(1);
}

const previous = { mode: state.mode || 'bundled', liveUrl: state.liveUrl ?? null };
writeState({ ...state, mode: 'live', liveUrl: url });
console.log(`HII UI channel: live → ${url}`);
console.log('Launch (or relaunch) HII and it loads the dev server with HMR.');

if (!process.argv.includes('--serve')) {
  process.exit(0);
}

const dev = spawn('npm', ['run', 'dev:desktop'], { stdio: 'inherit', cwd: path.resolve(import.meta.dirname, '..') });

let restored = false;
const restore = () => {
  if (restored) return;
  restored = true;
  writeState({ ...readState(), ...previous });
  console.log(`\nHII UI channel restored: ${describe(readState())}`);
};

process.on('SIGINT', () => dev.kill('SIGINT'));
process.on('SIGTERM', () => dev.kill('SIGTERM'));
dev.on('exit', (code) => {
  restore();
  process.exit(code ?? 0);
});
process.on('exit', restore);
