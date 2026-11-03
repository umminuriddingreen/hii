import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, stat, readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTextFiles, parseArgs, shellQuote } from './hii-live-workspace.mjs';

const SCRIPT = fileURLToPath(new URL('./hii-live-workspace.mjs', import.meta.url));
const VIM_HELPER = fileURLToPath(new URL('./hii-live-workspace.vim', import.meta.url));

test('shell quoting preserves apostrophes and whitespace as one argument', () => {
  assert.equal(shellQuote("a path/that's safe"), "'a path/that'\\''s safe'");
});

test('argument parser requires paths and validates options', () => {
  assert.throws(() => parseArgs([]), /--directory PATH --binary PATH/);
  assert.deepEqual(parseArgs(['--directory', '/tmp/a b', '--binary', '/tmp/hii', '--detached', '--json']), {
    directory: '/tmp/a b', binary: '/tmp/hii', detached: true, json: true,
  });
  assert.throws(() => parseArgs(['--other']), /unknown option/);
});

test('file scan includes readable text and excludes binary, oversized, and out-of-root symlink files', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'hii-live-test-'));
  const root = path.join(base, 'project');
  await mkdir(root);
  await writeFile(path.join(root, 'a space.txt'), 'hello\n');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([65, 0, 66]));
  await writeFile(path.join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  const outside = path.join(base, 'outside.txt');
  await writeFile(outside, 'secret');
  await symlink(outside, path.join(root, 'escape.txt'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const files = await listTextFiles(root, ['a space.txt', 'binary.bin', 'large.txt', 'escape.txt'].join('\0') + '\0');
  assert.deepEqual(files.map(file => file.relative), ['a space.txt']);
  assert.equal(files[0].size, (await stat(path.join(root, 'a space.txt'))).size);
});

test('detached launch starts an idle fake HII, Bash, Vim, and watcher without attaching', async t => {
  const probe = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return t.skip('tmux is unavailable');
  const base = await mkdtemp(path.join(os.tmpdir(), 'hii-live-smoke-'));
  const root = path.join(base, "project's code");
  const home = path.join(base, 'home');
  const session = `hii-live-test-${process.pid}`;
  const stateDir = path.join(home, '.hii', 'live-workspaces', session);
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  const fake = path.join(base, "fake hii's bin");
  await writeFile(fake, '#!/bin/bash\nsleep 30\n', { mode: 0o755 });
  spawnSync('git', ['init', '-q'], { cwd: root });
  await writeFile(path.join(root, 'first file.txt'), 'one\n');
  t.after(() => {
    spawnSync('tmux', ['kill-session', '-t', session], { encoding: 'utf8' });
    return Promise.all([rm(stateDir, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]);
  });
  const launched = spawnSync(process.execPath, [SCRIPT, '--directory', root, '--binary', fake, '--detached', '--session', session, '--json'], {
    encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 10000,
  });
  assert.equal(launched.status, 0, launched.stderr);
  const result = JSON.parse(launched.stdout);
  assert.equal(result.session, session);
  assert.equal(result.root, await (await import('node:fs/promises')).realpath(root));
  const panes = spawnSync('tmux', ['list-panes', '-t', `${session}:0`, '-F', '#{pane_current_command}'], { encoding: 'utf8' });
  assert.equal(panes.status, 0, panes.stderr);
  assert.equal(panes.stdout.trim().split('\n').length, 3);
  const windows = spawnSync('tmux', ['list-windows', '-t', session, '-F', '#{window_name}'], { encoding: 'utf8' });
  assert.match(windows.stdout, /watcher/);
  await new Promise(resolve => setTimeout(resolve, 1100));
  const state = JSON.parse(await readFile(result.state, 'utf8'));
  assert.equal(state.file, await (await import('node:fs/promises')).realpath(path.join(root, 'first file.txt')));
  assert.equal(state.activity[0].changed[0], 'first file.txt');
});

test('headless Vim helper opens the selected file and resolves symlinks before enforcing the root', async t => {
  const probe = spawnSync('vim', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return t.skip('vim is unavailable');
  const base = await mkdtemp(path.join(os.tmpdir(), 'hii-live-vim-'));
  const root = path.join(base, 'project');
  await mkdir(root);
  const sample = path.join(root, 'sample file.txt');
  const outside = path.join(base, 'outside.txt');
  await writeFile(sample, 'inside\n');
  await writeFile(outside, 'outside\n');
  await symlink(outside, path.join(root, 'escape.txt'));
  const state = path.join(base, 'state.json');
  const proof = path.join(base, 'opened.txt');
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, HII_LIVE_ROOT: root, HII_LIVE_STATE: state, HII_LIVE_PROOF: proof };
  const runVim = () => spawnSync('vim', ['-Nu', 'NONE', '-n', '-R', '-es', '-S', VIM_HELPER, '-c', 'call writefile([expand("%:p")], $HII_LIVE_PROOF)', '-c', 'qa!'], { encoding: 'utf8', env, timeout: 5000 });
  await writeFile(state, JSON.stringify({ file: sample }));
  let result = runVim();
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(proof, 'utf8')).trim(), await (await import('node:fs/promises')).realpath(sample));
  await writeFile(state, JSON.stringify({ file: path.join(root, 'escape.txt') }));
  result = runVim();
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual((await readFile(proof, 'utf8')).trim(), await (await import('node:fs/promises')).realpath(outside));
});

test('Vim timer reloads edits and follows a newer workspace state file', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'hii-live-reload-'));
  const root = path.join(base, 'project');
  await mkdir(root);
  const first = path.join(root, 'first.txt');
  const second = path.join(root, 'second.txt');
  const state = path.join(base, 'state.json');
  const proof = path.join(base, 'snapshot.txt');
  const driver = path.join(base, 'capture.vim');
  await writeFile(first, 'before\n');
  await writeFile(second, 'second content\n');
  await writeFile(state, JSON.stringify({ file: first }));
  await writeFile(driver, [
    'function! CaptureLive(timer) abort',
    '  call writefile([expand("%:p"), join(getline(1, "$"), "\\n")], $HII_LIVE_PROOF)',
    'endfunction',
    "call timer_start(100, function('CaptureLive'), {'repeat': -1})",
    'sleep 3000m',
    'qa!',
    '',
  ].join('\n'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const child = spawn('vim', ['-Nu', 'NONE', '-n', '-R', '-es', '-S', VIM_HELPER, '-S', driver], {
    stdio: 'ignore', env: { ...process.env, HII_LIVE_ROOT: root, HII_LIVE_STATE: state, HII_LIVE_PROOF: proof },
  });
  await new Promise(resolve => setTimeout(resolve, 350));
  await writeFile(first, 'after edit\n');
  const changedStat = await stat(first);
  await writeFile(state, JSON.stringify({ file: first, fileMeta: { mtimeMs: changedStat.mtimeMs, ctimeMs: changedStat.ctimeMs, size: changedStat.size, ino: changedStat.ino } }));
  await new Promise(resolve => setTimeout(resolve, 1050));
  const refreshed = await readFile(proof, 'utf8');
  assert.match(refreshed, /after edit/);
  await writeFile(state, JSON.stringify({ file: second }));
  const exit = await Promise.race([
    new Promise(resolve => child.once('close', code => resolve(code))),
    new Promise(resolve => setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 5000)),
  ]);
  assert.notEqual(exit, 'timeout', 'headless Vim should exit after its bounded timer');
  assert.equal(exit, 0);
  const final = await readFile(proof, 'utf8');
  assert.match(final, /second content/);
  assert.equal(final.trimEnd().split('\n')[0], await (await import('node:fs/promises')).realpath(second));
});
