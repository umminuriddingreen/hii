#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PREVIOUS = 'refs/hii/source-update/previous';
const APPLIED = 'refs/hii/source-update/applied';
const ACTIONS = new Set(['status', 'check', 'update', 'rollback']);

function git(repo, args, optional = false, input) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', input, timeout: 120_000, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error || result.status !== 0) {
    if (optional) return null;
    // Git stderr can include credential-bearing remote URLs; do not relay it.
    throw new Error(`git_${args[0].replaceAll('-', '_')}_failed`);
  }
  return result.stdout.trim();
}

function snapshot(repo) {
  const current = git(repo, ['rev-parse', '--verify', 'HEAD']);
  const remote = git(repo, ['rev-parse', '--verify', 'refs/remotes/origin/main'], true);
  const branch = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
  const dirty = Boolean(git(repo, ['status', '--porcelain=v1', '--untracked-files=normal']));
  const counts = remote ? git(repo, ['rev-list', '--left-right', '--count', `${current}...${remote}`]).split(/\s+/).map(Number) : null;
  const [ahead, behind] = counts ?? [null, null];
  const previous = git(repo, ['rev-parse', '--verify', PREVIOUS], true);
  const applied = git(repo, ['rev-parse', '--verify', APPLIED], true);
  const blocked = dirty ? 'dirty_checkout' : branch !== 'main' ? 'main_branch_required'
    : !remote ? 'remote_main_unknown' : ahead > 0 ? 'local_commits_or_divergence' : null;
  return {
    repo, current, remote, branch, dirty, ahead, behind, blocked, previous, applied,
    rollbackAvailable: !dirty && Boolean(previous) && current === applied,
    remoteFresh: false,
  };
}

export function sourceUpdate(action = 'status', requestedRepo = process.cwd()) {
  if (!ACTIONS.has(action)) throw new Error('invalid_action');
  const repo = git(path.resolve(requestedRepo), ['rev-parse', '--show-toplevel']);
  const common = path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']));
  const gitDir = path.resolve(repo, git(repo, ['rev-parse', '--git-dir']));
  const lock = path.join(common, 'hii-source-update.lock');
  let descriptor;
  try {
    descriptor = openSync(lock, 'wx');
  } catch {
    throw new Error('source_update_busy_or_stale_lock');
  }
  try {
    let state = snapshot(repo);
    if (action === 'check' || action === 'update') {
      git(repo, ['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main']);
      state = { ...snapshot(repo), remoteFresh: true };
    }
    let outcome = action === 'status' || action === 'check' ? 'inspected' : 'unchanged';
    if (action === 'update' && !state.blocked && state.behind > 0) {
      const previous = state.current;
      const applied = state.remote;
      // Ref transaction records a durable recovery anchor before moving the checkout.
      git(repo, ['update-ref', '--stdin'], false,
        `start\nupdate ${PREVIOUS} ${previous}\nupdate ${APPLIED} ${applied}\nprepare\ncommit\n`);
      git(repo, ['merge', '--ff-only', '--no-edit', applied]);
      state = { ...snapshot(repo), remoteFresh: true };
      outcome = 'updated';
    } else if (action === 'update' && state.blocked) {
      outcome = 'blocked';
    } else if (action === 'rollback') {
      if (!state.rollbackAvailable) {
        state.blocked = state.dirty ? 'dirty_checkout' : !state.previous ? 'no_recorded_update' : 'head_changed_since_update';
        outcome = 'blocked';
      } else {
        git(repo, ['switch', '--detach', state.previous]);
        state = snapshot(repo);
        outcome = 'rolled_back_detached';
      }
    }
    const report = { action, outcome, ...state, checkedAt: new Date().toISOString() };
    // This is an advisory cache only; git commits/refs are the durable authority.
    try {
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(path.join(gitDir, 'hii-update-status.json'), `${JSON.stringify(report, null, 2)}\n`);
    } catch { /* status cache failure must not undo a completed git operation */ }
    return report;
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const args = process.argv.slice(2);
    const action = args.shift() ?? 'status';
    let repo = process.cwd();
    while (args.length) {
      const flag = args.shift();
      if (flag === '--repo' && args[0]) repo = args.shift();
      else if (flag !== '--json') throw new Error('usage: hii-source-update.mjs status|check|update|rollback [--repo path] [--json]');
    }
    const report = sourceUpdate(action, repo);
    console.log(JSON.stringify(report, null, 2));
    if (report.outcome === 'blocked') process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
