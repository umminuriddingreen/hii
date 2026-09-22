// SPDX-License-Identifier: LicenseRef-BSL-1.1
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { install, makePlan, parseArgs, runSync, scheduleStatus } from './hii-codex-sync-schedule.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hii-codex-sync-schedule-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const launcher = path.join(bin, 'hii');
  const launcherLog = path.join(root, 'launcher-args');
  writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${launcherLog}'\nexit 0\n`);
  chmodSync(launcher, 0o755);
  const launchctlPath = path.join(root, 'launchctl');
  const loaded = path.join(root, 'loaded');
  writeFileSync(launchctlPath, `#!/bin/sh\nif [ "$1" = print ]; then\n  if [ -f '${loaded}' ]; then printf 'state = running\\nruns = 3\\nlast exit code = 0\\n'; exit 0; fi\n  exit 113\nfi\nif [ "$1" = bootstrap ]; then touch '${loaded}'; exit 0; fi\nexit 2\n`);
  chmodSync(launchctlPath, 0o755);
  const plan = makePlan({ home, launcher, launchctlPath, uid: 501 });
  return { home, launcher, launcherLog, loaded, plan };
}

test('macOS plan runs only the installed CLI every 15 minutes', () => {
  const plan = makePlan({ home: '/Users/Owner', launcher: '/Users/Owner/bin/hii', uid: 501 });
  assert.deepEqual(plan.programArguments, ['/Users/Owner/bin/hii', 'update', 'sync']);
  assert.equal(plan.intervalSeconds, 900);
  assert.match(plan.plist, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.match(plan.plist, /<key>RunAtLoad<\/key><false\/>/);
  assert.match(plan.plist, /<string>\/Users\/Owner\/bin\/hii<\/string>/);
  assert.doesNotMatch(plan.plist, /hii-codex-sync-schedule\.mjs|scripts\//);
});

test('fixture install registers once and status reports actual launchd state', (t) => {
  const { plan } = fixture(t);
  const installed = install(plan);
  assert.equal(installed.installed, true);
  assert.equal(installed.loaded, true);
  assert.equal(installed.plistExists, true);
  assert.equal(readFileSync(plan.plistPath, 'utf8'), plan.plist);
  assert.equal(scheduleStatus(plan).lastRunCount, 3);
  assert.equal(scheduleStatus(plan).lastExitCode, 0);
  assert.throws(() => install(plan), /already exists; it was not replaced/);
});

test('fixture runner calls installed launcher with update sync', (t) => {
  const { plan, launcherLog } = fixture(t);
  assert.deepEqual(runSync(plan), { kind: 'hii-codex-sync', executable: plan.launcher, args: ['update', 'sync'], exitCode: 0, signal: null, failedToRun: false });
  assert.equal(readFileSync(launcherLog, 'utf8').trim(), 'update sync');
});

test('existing plist is preserved, and a loaded job without a plist is not replaced', (t) => {
  const { plan, loaded } = fixture(t);
  mkdirSync(path.dirname(plan.plistPath), { recursive: true });
  writeFileSync(plan.plistPath, 'keep-me');
  assert.throws(() => install(plan), /plist already exists; it was not replaced/);
  assert.equal(readFileSync(plan.plistPath, 'utf8'), 'keep-me');
  rmSync(plan.plistPath);
  writeFileSync(loaded, '');
  assert.throws(() => install(plan), /job already exists; it was not replaced/);
  assert.equal(scheduleStatus(plan).installed, false);
});

test('dry run and argument validation do not require an installed launcher', () => {
  const plan = makePlan({ home: '/tmp/isolated', launcher: '/tmp/missing-hii', uid: 501 });
  assert.equal(install(plan, true).dryRun, true);
  assert.equal(scheduleStatus(plan, true).dryRun, true);
  assert.deepEqual(runSync(plan, true).args, ['update', 'sync']);
  assert.throws(() => makePlan({ platform: 'linux', home: '/tmp', launcher: '/tmp/hii', uid: 1 }));
  assert.throws(() => parseArgs(['install', '--replace']));
  assert.equal(parseArgs(['status', '--dry-run']).dryRun, true);
});
