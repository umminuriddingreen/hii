import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(scripts, 'hii-cli.mjs');

function runInRoot(root, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HII_ROOT: root, HII_RUNTIME_DIR: path.join(root, 'runtime'), HII_AGENT_ID: 'git-diagnostics-test' },
    timeout: 15000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /fatal:|not a git repository|ambiguous argument/, 'expected Git diagnostics to stay out of user-facing stderr');
  return result.stdout;
}

function withTempRoot(prefix, callback) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  try { return callback(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('home marks an unversioned packaged directory as unknown, not clean', () => {
  withTempRoot('hii-unversioned-runtime-', (root) => {
  const home = JSON.parse(runInRoot(root, ['home', '--json']));
  assert.equal(home.workspace.branch, 'unknown');
  assert.equal(home.workspace.clean, null);
  assert.equal(home.workspace.gitAvailable, false);
  assert.equal(home.workspace.changes.total, null);
  assert.equal(home.activeState.domains.find(({ id }) => id === 'workspace').state, 'unknown');
  assert.equal(home.activeState.domains.find(({ id }) => id === 'workspace').visibility, 'unavailable');

  const brief = JSON.parse(runInRoot(root, ['home', '--brief']));
  assert.equal(brief.gitAvailable, false);
  assert.equal(brief.clean, null);
  assert.equal(brief.changes, null);
  });
});

test('health and human home report unavailable source status without Git fatal text', () => {
  withTempRoot('hii-unversioned-runtime-', (root) => {
  const health = runInRoot(root, ['health', '--text']);
  assert.match(health, /git:\s+unavailable/);
  assert.doesNotMatch(health, /fatal:|clean/);

  const home = runInRoot(root, ['home']);
  assert.match(home, /git:\s+unavailable \(source status unknown\)/);
  assert.doesNotMatch(home, /fatal:|\(clean\)|0 changes/);
  for (const args of [['context'], ['probe'], ['now']]) {
    const output = runInRoot(root, args);
    assert.match(output, /unavailable \(source status unknown\)|source status unknown/);
    assert.doesNotMatch(output, /fatal:|\(clean\)|0 dirty|0 changes/);
  }
  });
});

test('committed clean and dirty source repositories retain truthful worktree status', () => {
  withTempRoot('hii-versioned-source-', (root) => {
    execFileSync('git', ['-C', root, 'init', '-q']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'HII Test']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'hii-test@example.invalid']);
    const tracked = path.join(root, 'tracked.txt');
    writeFileSync(tracked, 'initial\n');
    execFileSync('git', ['-C', root, 'add', 'tracked.txt']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'fixture']);

    const clean = JSON.parse(runInRoot(root, ['home', '--json']));
    assert.equal(clean.workspace.gitAvailable, true);
    assert.equal(clean.workspace.clean, true);
    assert.equal(clean.workspace.changes.total, 0);

    writeFileSync(tracked, 'modified\n');
    const dirty = JSON.parse(runInRoot(root, ['home', '--json']));
    assert.equal(dirty.workspace.gitAvailable, true);
    assert.equal(dirty.workspace.clean, false);
    assert.equal(dirty.workspace.changes.modified, 1);
  });
});

test('an unborn Git repository is unavailable for source revision diagnostics', () => {
  withTempRoot('hii-unborn-source-', (root) => {
    execFileSync('git', ['-C', root, 'init', '-q']);
    const home = JSON.parse(runInRoot(root, ['home', '--json']));
    assert.equal(home.workspace.gitAvailable, false);
    assert.equal(home.workspace.clean, null);
    assert.equal(home.workspace.changes.total, null);
  });
});
