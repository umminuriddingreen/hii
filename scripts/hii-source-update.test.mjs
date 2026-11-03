import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceUpdate } from './hii-source-update.mjs';

function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hii-source-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'origin.git');
  const author = path.join(root, 'author');
  const client = path.join(root, 'client');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', remote, author);
  git(author, 'config', 'user.email', 'test@example.invalid');
  git(author, 'config', 'user.name', 'Test');
  writeFileSync(path.join(author, 'tracked.txt'), 'initial');
  git(author, 'add', '.');
  git(author, 'commit', '-m', 'initial');
  git(author, 'push', 'origin', 'main');
  git(root, 'clone', remote, client);
  git(client, 'config', 'user.email', 'test@example.invalid');
  git(client, 'config', 'user.name', 'Test');
  const initial = git(client, 'rev-parse', 'HEAD');
  const advance = () => {
    writeFileSync(path.join(author, 'tracked.txt'), 'updated');
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'next');
    git(author, 'push', 'origin', 'main');
    return git(author, 'rev-parse', 'HEAD');
  };
  return { root, remote, author, client, initial, advance };
}

test('status does not fetch; explicit check discovers update; fast-forward and detached rollback preserve main', (t) => {
  const f = fixture(t);
  const next = f.advance();
  assert.equal(sourceUpdate('status', f.client).behind, 0);
  assert.equal(sourceUpdate('check', f.client).behind, 1);
  const update = sourceUpdate('update', f.client);
  assert.equal(update.outcome, 'updated');
  assert.equal(update.current, next);
  assert.equal(update.previous, f.initial);
  assert.equal(update.rollbackAvailable, true);
  assert.equal(sourceUpdate('update', f.client).previous, f.initial);
  const rollback = sourceUpdate('rollback', f.client);
  assert.equal(rollback.outcome, 'rolled_back_detached');
  assert.equal(rollback.current, f.initial);
  assert.equal(rollback.branch, null);
  assert.equal(git(f.client, 'rev-parse', 'main'), next);
  assert.equal(sourceUpdate('rollback', f.client).outcome, 'blocked');
});

for (const untracked of [false, true]) {
  test(`update preserves ${untracked ? 'untracked' : 'tracked dirty'} files`, (t) => {
    const f = fixture(t);
    f.advance();
    const file = path.join(f.client, untracked ? 'private-draft.txt' : 'tracked.txt');
    writeFileSync(file, 'local draft');
    const result = sourceUpdate('update', f.client);
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.blocked, 'dirty_checkout');
    assert.equal(result.current, f.initial);
    assert.equal(readFileSync(file, 'utf8'), 'local draft');
  });
}

test('diverged main and non-main branches are refused', (t) => {
  const f = fixture(t);
  f.advance();
  writeFileSync(path.join(f.client, 'local.txt'), 'local');
  git(f.client, 'add', '.');
  git(f.client, 'commit', '-m', 'local');
  const local = git(f.client, 'rev-parse', 'HEAD');
  assert.equal(sourceUpdate('update', f.client).blocked, 'local_commits_or_divergence');
  assert.equal(git(f.client, 'rev-parse', 'HEAD'), local);
  git(f.client, 'switch', '-c', 'work');
  assert.equal(sourceUpdate('update', f.client).blocked, 'main_branch_required');
});

test('rollback refuses dirty state and head changed since update', (t) => {
  const f = fixture(t);
  f.advance();
  sourceUpdate('update', f.client);
  writeFileSync(path.join(f.client, 'draft.txt'), 'draft');
  assert.equal(sourceUpdate('rollback', f.client).blocked, 'dirty_checkout');
  git(f.client, 'add', '.');
  git(f.client, 'commit', '-m', 'later local work');
  const local = git(f.client, 'rev-parse', 'HEAD');
  assert.equal(sourceUpdate('rollback', f.client).blocked, 'head_changed_since_update');
  assert.equal(git(f.client, 'rev-parse', 'HEAD'), local);
});

test('missing recovery anchor refuses rollback and preserves checkout', (t) => {
  const f = fixture(t);
  assert.equal(sourceUpdate('rollback', f.client).blocked, 'no_recorded_update');
  assert.equal(git(f.client, 'rev-parse', 'HEAD'), f.initial);
});

test('busy lock refuses overlapping commands without deleting the existing lock', (t) => {
  const f = fixture(t);
  const lock = path.join(f.client, '.git', 'hii-source-update.lock');
  writeFileSync(lock, 'other owner');
  assert.throws(() => sourceUpdate('check', f.client), /source_update_busy_or_stale_lock/);
  assert.equal(readFileSync(lock, 'utf8'), 'other owner');
});
