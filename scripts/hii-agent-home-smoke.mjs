#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, ['--test', path.join(root, 'scripts', 'hii-instance-observation.test.mjs')], {
  cwd: root, encoding: 'utf8', stdio: 'pipe'
});

function run(...args) {
  return execFileSync(process.execPath, [path.join(root, 'scripts', 'hii-cli.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8'
  });
}

const homeRaw = run('home', '--json');
const briefRaw = run('home', '--brief');
const workBriefRaw = run('work', '--brief');
const fullRaw = run('context', '--json');
const nowRaw = run('now', '--json');
const nowFullRaw = run('now', '--json', '--full');
const home = JSON.parse(homeRaw);
const now = JSON.parse(nowRaw);
const guide = JSON.parse(run('agents', 'guide', '--json'));

assert.equal(home.kind, 'hii.agent.home');
assert.equal(home.schemaVersion, 2);
assert.equal(home.identity.repo, root);
assert.equal(typeof home.workspace.clean, 'boolean');
assert.ok(Array.isArray(home.capabilities));
assert.ok(home.capabilities.every((capability) => Object.keys(capability).sort().join(',') === 'id,status'));
assert.ok(home.commands.includes('hii context --json'));
assert.equal(home.activeState.kind, 'hii.active-state');
assert.equal(home.activeState.model, 'white-box operational state');
assert.ok(home.activeState.domains.some((domain) => domain.id === 'systems'));
assert.ok(home.activeState.domains.every((domain) => domain.source && domain.visibility && domain.state));
assert.equal(home.activeState.coverage.registeredDomains, home.activeState.domains.length);
assert.equal(home.activeState.activeInstanceProjection.returned, home.activeState.activeInstances.length);
assert.ok(home.activeState.activeInstances.every((instance) => instance.live === true));
const systems = home.activeState.domains.find((domain) => domain.id === 'systems');
assert.equal(systems.counts.active, home.activeState.activeInstanceProjection.total);
assert.equal(systems.counts.reported, systems.counts.active + systems.counts.dead + systems.counts.stale + systems.counts.unknown);
assert.ok(home.activeState.activeInstanceProjection.total >= home.activeState.activeInstanceProjection.returned);
assert.ok(home.activeState.coverage.exclusions.includes('raw model internals or private chain-of-thought'));
assert.ok(homeRaw.length < fullRaw.length / 2, `home=${homeRaw.length} full=${fullRaw.length}`);
const brief = JSON.parse(briefRaw);
const workBrief = JSON.parse(workBriefRaw);
assert.equal(brief.kind, 'hii.agent.home.brief');
assert.equal(brief.branch, home.workspace.branch);
assert.equal(brief.changes, home.workspace.changes.total);
assert.equal(brief.activeInstances, home.activeState.activeInstanceProjection.total);
assert.equal(brief.activeInstanceSample, home.activeState.activeInstances.length);
assert.deepEqual(brief.activeDomains, home.activeState.domains.filter((domain) => domain.state === 'active').map((domain) => domain.id));
assert.equal(brief.observedDomains, home.activeState.coverage.observed);
assert.ok(brief.nextActions.length <= 3);
assert.ok(briefRaw.length < homeRaw.length / 2, `brief=${briefRaw.length} home=${homeRaw.length}`);
assert.equal(workBrief.kind, 'hii.agent.work.brief');
assert.ok(Array.isArray(workBrief.tasks));
assert.equal(now.schemaVersion, 2);
// `hii now` must summarise rather than dump. The old form of this asserted the
// summary was under exactly half of --full, which turned out to measure the
// machine rather than the product: on a fresh CI checkout both outputs are
// near-empty headers (468 and 486 bytes on the runner) and the ratio is
// meaningless, while on a machine with real history it sat on the line and
// flipped either side of it as receipts accumulated -- 49% one hour, 52% the
// next, with no code change in between.
//
// What is actually worth guarding: the summary never exceeds the full form,
// and where there is history to elide it saves a real fraction of it.
assert.ok(
  nowRaw.length <= nowFullRaw.length,
  `now=${nowRaw.length} full=${nowFullRaw.length}`
);
if (nowFullRaw.length > 2_000) {
  assert.ok(
    nowRaw.length < nowFullRaw.length * 0.75,
    `now=${nowRaw.length} full=${nowFullRaw.length}`
  );
}
assert.equal(guide.kind, 'hii.agent.guide');
assert.ok(guide.guide.join(' ').includes('hii home --json'));
assert.match(guide.guide.join(' '), /Search before reading.*targeted `hii`, `rg`, or `jq`/);
assert.match(run('board', '--help'), /HII BOARD/);

console.log(`agent home: ${homeRaw.length} bytes (${Math.round((homeRaw.length / fullRaw.length) * 100)}% of full context)`);
console.log(`agent home --brief: ${briefRaw.length} bytes (${Math.round((briefRaw.length / fullRaw.length) * 100)}% of full context)`);
console.log(`work --brief: ${workBriefRaw.length} bytes`);
console.log(`now snapshot: ${nowRaw.length} bytes (${Math.round((nowRaw.length / nowFullRaw.length) * 100)}% of full receipts)`);
