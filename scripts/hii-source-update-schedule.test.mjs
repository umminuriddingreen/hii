// SPDX-License-Identifier: LicenseRef-BSL-1.1
import assert from 'node:assert/strict';
import test from 'node:test';
import { install, makePlan, parseArgs, runUpdate, scheduleStatus } from './hii-source-update-schedule.mjs';

test('Windows preserves path spaces and PowerShell metacharacters as literal arguments', () => {
  const repo = "C:\\Users\\Owner's Space\\hii & $(Write-Output bad)";
  const plan = makePlan({ platform: 'win32', repo, node: 'C:\\Program Files\\nodejs\\node.exe', home: "C:\\Users\\Owner's Space" });
  assert.deepEqual(plan.updaterArgs, [`${repo}\\scripts\\hii-source-update.mjs`, 'update', '--repo', repo]);
  const payload = plan.taskArguments.split(' ').at(-1);
  const runner = Buffer.from(payload, 'base64').toString('utf16le');
  assert.ok(runner.includes("'C:\\Program Files\\nodejs\\node.exe'"));
  assert.ok(runner.includes("'C:\\Users\\Owner''s Space\\hii & $(Write-Output bad)'"));
  assert.match(plan.installScript, /-RunLevel Limited/);
  assert.match(plan.installScript, /-MultipleInstances IgnoreNew -Hidden/);
  assert.match(plan.installScript, /AddMinutes\(15\)/);
  assert.doesNotMatch(plan.installScript, /-Force/);
});

test('macOS plist keeps argv separate and XML escapes every path', () => {
  const repo = '/Users/Owner Space/hii & <other>';
  const plan = makePlan({ platform: 'darwin', repo, node: '/opt/Node Space/node', home: '/Users/Owner Space', uid: 501 });
  assert.equal(plan.domain, 'gui/501');
  assert.ok(plan.plist.includes('<string>/opt/Node Space/node</string>'));
  assert.ok(plan.plist.includes('hii &amp; &lt;other&gt;'));
  assert.ok(plan.plist.includes('<key>StartInterval</key><integer>900</integer>'));
  assert.ok(plan.plist.includes('<key>RunAtLoad</key><false/>'));
  assert.deepEqual(plan.programArguments.slice(-3), ['run', '--repo', repo]);
});

test('dry runs do not inspect nonexistent files, create plists or call schedulers', () => {
  for (const platform of ['darwin', 'win32']) {
    const plan = makePlan({ platform, repo: platform === 'win32' ? 'Z:\\does not exist\\hii' : '/does not exist/hii', node: platform === 'win32' ? 'Z:\\missing\\node.exe' : '/missing/node', home: platform === 'win32' ? 'Z:\\missing' : '/missing', uid: 501 });
    assert.equal(install(plan, true).dryRun, true);
    assert.equal(scheduleStatus(plan, true).dryRun, true);
    assert.deepEqual(runUpdate(plan, true).args, plan.updaterArgs);
  }
});

test('schedule identities are stable and scoped to user and repository', () => {
  const config = { platform: 'darwin', repo: '/Users/a/hii', node: '/usr/local/bin/node', home: '/Users/a', uid: 501 };
  assert.equal(makePlan(config).label, makePlan(config).label);
  assert.notEqual(makePlan(config).label, makePlan({ ...config, repo: '/Users/a/hii-other' }).label);
  assert.notEqual(makePlan(config).label, makePlan({ ...config, home: '/Users/b' }).label);
});

test('invalid invocation and relative executable are rejected', () => {
  assert.throws(() => parseArgs(['remove']));
  assert.throws(() => parseArgs(['install', '--repo']));
  assert.throws(() => parseArgs(['install', '--replace']));
  assert.equal(parseArgs(['status', '--dry-run']).dryRun, true);
  assert.throws(() => makePlan({ platform: 'darwin', repo: '/hii', node: 'node', home: '/Users/a', uid: 501 }));
});
