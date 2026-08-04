#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(...args) {
  return execFileSync(process.execPath, [path.join(root, 'scripts', 'hii-cli.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8'
  });
}

const homeRaw = run('home', '--json');
const fullRaw = run('context', '--json');
const nowRaw = run('now', '--json');
const nowFullRaw = run('now', '--json', '--full');
const home = JSON.parse(homeRaw);
const now = JSON.parse(nowRaw);
const guide = JSON.parse(run('agents', 'guide', '--json'));

assert.equal(home.kind, 'hii.agent.home');
assert.equal(home.identity.repo, root);
assert.equal(typeof home.workspace.clean, 'boolean');
assert.ok(Array.isArray(home.capabilities));
assert.ok(home.capabilities.every((capability) => Object.keys(capability).sort().join(',') === 'id,status'));
assert.ok(home.commands.includes('hii context --json'));
assert.ok(homeRaw.length < fullRaw.length / 2, `home=${homeRaw.length} full=${fullRaw.length}`);
assert.equal(now.schemaVersion, 2);
assert.ok(nowRaw.length < nowFullRaw.length / 2, `now=${nowRaw.length} full=${nowFullRaw.length}`);
assert.equal(guide.kind, 'hii.agent.guide');
assert.ok(guide.guide.join(' ').includes('hii home --json'));
assert.match(run('board', '--help'), /HII BOARD/);

console.log(`agent home: ${homeRaw.length} bytes (${Math.round((homeRaw.length / fullRaw.length) * 100)}% of full context)`);
console.log(`now snapshot: ${nowRaw.length} bytes (${Math.round((nowRaw.length / nowFullRaw.length) * 100)}% of full receipts)`);
