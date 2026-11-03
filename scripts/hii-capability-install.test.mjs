import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installCapability } from './hii-capability-install.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-capability-install-'));
  const workspace = path.join(root, 'workspace');
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(workspace, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, runtime };
}

function mockRun(expected, action = () => undefined) {
  const calls = [];
  const runCommand = (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, expected[calls.length - 1].command);
    assert.deepEqual(args, expected[calls.length - 1].args);
    return action(command, args, options) || { status: 0, stdout: '', stderr: '' };
  };
  return { calls, runCommand };
}

test('model installs use daemon argv without shell interpolation and reject unsupported source text', (t) => {
  const f = fixture(t);
  const daemon = path.join(process.cwd(), 'runtime', 'daemon', 'hiid.mjs');
  const mock = mockRun([{ command: 'node', args: [daemon, 'model-runtime', 'install', 'org/model-name'] }]);
  const receipt = installCapability({ ...f, kind: 'model', source: 'org/model-name' }, { runCommand: mock.runCommand });
  assert.equal(receipt.verifiedBy, 'hii-model-runtime');
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].options.env.HII_RUNTIME_DIR, fs.realpathSync(f.runtime));
  assert.throws(() => installCapability({ ...f, kind: 'model', source: 'org/model;touch /tmp/x' }, { runCommand: mock.runCommand }), /owner\/repository/);
});

test('GGUF download is constrained to runtime model directory and returns a content receipt', (t) => {
  const f = fixture(t);
  let cacheRoot;
  const calls = [];
  const runCommand = (command, args) => {
    calls.push({ command, args });
    assert.equal(command, 'hf');
    if (args[0] === 'download') {
      assert.deepEqual(args.slice(0, 4), ['download', 'org/model', 'folder/weights.gguf', '--cache-dir']);
      cacheRoot = args[4];
      const repoCache = path.join(cacheRoot, 'models--org--model');
      const revision = 'a'.repeat(40);
      const snapshot = path.join(repoCache, 'snapshots', revision, 'folder');
      fs.mkdirSync(path.join(repoCache, 'refs'), { recursive: true });
      fs.writeFileSync(path.join(repoCache, 'refs', 'main'), revision);
      fs.mkdirSync(snapshot, { recursive: true });
      const sharedBlob = path.join(cacheRoot, 'blobs', 'fixture-shared-hash');
      fs.mkdirSync(path.dirname(sharedBlob), { recursive: true });
      fs.writeFileSync(sharedBlob, Buffer.concat([Buffer.from('GGUF'), Buffer.from('fixture weights')]));
      fs.symlinkSync(path.relative(snapshot, sharedBlob), path.join(snapshot, 'weights.gguf'));
    } else assert.deepEqual(args, ['cache', 'verify', 'org/model', '--cache-dir', cacheRoot]);
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = installCapability({ ...f, kind: 'model', source: 'org/model', file: 'folder/weights.gguf' }, { runCommand });
  const destination = path.join(fs.realpathSync(f.runtime), 'models', 'gguf', 'folder', 'weights.gguf');
  assert.equal(result.path, destination);
  assert.equal(result.sha256.length, 64);
  assert.equal(calls.length, 2);
  assert.throws(() => installCapability({ ...f, kind: 'model', source: 'org/model', file: '../escape.gguf' }), /safe relative path/);
});

test('local skill import stages atomically with provenance and never executes hooks', (t) => {
  const f = fixture(t);
  const skill = path.join(f.workspace, 'draft-skill');
  fs.mkdirSync(skill);
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Fixture skill\n');
  fs.writeFileSync(path.join(skill, 'install.sh'), 'echo should-not-run');
  const result = installCapability({ ...f, kind: 'skill', source: 'draft-skill' });
  const installed = path.join(fs.realpathSync(f.runtime), 'skills', 'installed', 'draft-skill');
  assert.equal(result.path, installed);
  assert.equal(fs.readFileSync(path.join(installed, 'install.sh'), 'utf8'), 'echo should-not-run');
  assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'HII_INSTALL.json'), 'utf8')).installHooksExecuted, false);
  assert.throws(() => installCapability({ ...f, kind: 'skill', source: 'draft-skill' }), /refusing overwrite/);
});

test('local skill subdirectory imports only that contained skill', (t) => {
  const f = fixture(t);
  const parent = path.join(f.workspace, 'bundle');
  const skill = path.join(parent, 'skills', 'nested-skill');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Nested skill\n');
  fs.writeFileSync(path.join(parent, 'SKILL.md'), '# Parent should not be imported\n');
  const result = installCapability({ ...f, kind: 'skill', source: 'bundle', file: 'skills/nested-skill' });
  assert.equal(result.name, 'nested-skill');
  assert.equal(fs.readFileSync(path.join(result.path, 'SKILL.md'), 'utf8'), '# Nested skill\n');
  assert.throws(() => installCapability({ ...f, kind: 'skill', source: 'bundle', file: '../outside' }), /safe relative path/);
});

test('skill install uses the selected portable skills root', (t) => {
  const f = fixture(t);
  const skill = path.join(f.workspace, 'portable-skill');
  const skills = path.join(f.root, 'external-library', 'skills');
  fs.mkdirSync(skill);
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Portable skill\n');
  fs.mkdirSync(skills, { recursive: true });

  const result = installCapability({ ...f, skills, kind: 'skill', source: 'portable-skill' });
  assert.equal(result.path, path.join(fs.realpathSync(skills), 'installed', 'portable-skill'));
  assert.equal(fs.existsSync(path.join(f.runtime, 'skills', 'installed', 'portable-skill')), false);
});

test('skill import rejects workspace escape, symlinks, and missing or oversized manifests', (t) => {
  const f = fixture(t);
  assert.throws(() => installCapability({ ...f, kind: 'skill', source: '../outside' }), /workspace-local|GitHub/);
  const linked = path.join(f.workspace, 'linked');
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(f.workspace, 'SKILL.md'), '# x');
  fs.symlinkSync(path.join(f.workspace, 'SKILL.md'), path.join(linked, 'SKILL.md'));
  assert.throws(() => installCapability({ ...f, kind: 'skill', source: 'linked' }), /symlink/);
  fs.rmSync(linked, { recursive: true, force: true });
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(linked, 'SKILL.md'), 'x'.repeat(64 * 1024 + 1));
  assert.throws(() => installCapability({ ...f, kind: 'skill', source: 'linked' }), /64 KiB/);
});

test('tool install is formula-only and requires Homebrew verification', (t) => {
  const f = fixture(t);
  if (process.platform !== 'darwin') {
    assert.throws(() => installCapability({ ...f, kind: 'tool', source: 'ripgrep' }), /only on macOS/);
    return;
  }
  const mock = mockRun([
    { command: 'brew', args: ['install', '--formula', 'ripgrep'] },
    { command: 'brew', args: ['list', '--formula', '--versions', 'ripgrep'] },
  ], (_command, args) => ({ status: 0, stdout: args[0] === 'list' ? 'ripgrep 14.1.1' : '', stderr: '' }));
  assert.equal(installCapability({ ...f, kind: 'tool', source: 'ripgrep' }, { runCommand: mock.runCommand }).verified, 'ripgrep 14.1.1');
  assert.throws(() => installCapability({ ...f, kind: 'tool', source: 'https://example.com/x' }, { runCommand: mock.runCommand }), /formula name/);
});

test('failed child process is surfaced with exit status and output', (t) => {
  const f = fixture(t);
  const runCommand = () => ({ status: 7, stdout: '', stderr: 'download failed' });
  assert.throws(() => installCapability({ ...f, kind: 'model', source: 'org/model' }, { runCommand }), /exit 7\): download failed/);
});

test('CLI writes a detailed receipt and prints a concise local-skill summary', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.workspace, 'my-skill'));
  fs.writeFileSync(path.join(f.workspace, 'my-skill', 'SKILL.md'), '# CLI fixture\n');
  const script = path.join(process.cwd(), 'scripts', 'hii-capability-install.mjs');
  const result = spawnSync(process.execPath, [
    script,
    '--runtime', f.runtime,
    '--workspace', f.workspace,
    'skill',
    'my-skill',
  ], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Imported skill my-skill .*no install hooks were executed\. Receipt: .*install-[a-f0-9-]+\.json\n$/);
  assert.doesNotMatch(result.stdout, /^\s*\{/);
  const receiptPath = result.stdout.match(/Receipt: (.+)$/m)[1];
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.kind, 'skill');
  assert.equal(receipt.source, 'my-skill');
  assert.equal(receipt.installHooksExecuted, false);
});
