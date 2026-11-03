import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSkills, importSkill } from './hii-agent-setup.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-agent-setup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const runtime = path.join(home, '.hii');
  const workspace = path.join(root, 'repo');
  fs.mkdirSync(workspace, { recursive: true });
  const add = (relative, body = '# Skill\n') => {
    const dir = path.join(home, relative);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
    return dir;
  };
  return { root, home, runtime, workspace, add };
}

test('discovers immediate personal skills, deduplicates paths and marks name collisions', (t) => {
  const f = fixture(t);
  f.add('.pi/agent/skills/Sketch');
  f.add('.hermes/skills/sketch');
  const valid = f.add('.codex/skills/review');
  const unsafe = f.add('.claude/skills/unsafe name');
  fs.mkdirSync(path.join(f.home, '.agents/skills'), { recursive: true });
  fs.symlinkSync(valid, path.join(f.home, '.agents/skills/linked'), 'dir');
  fs.mkdirSync(path.join(f.home, '.codex/skills/without-skill'));
  fs.mkdirSync(path.join(f.home, '.codex/skills/nested'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.codex/skills/nested/child.txt'), 'ignored');
  const sources = discoverSkills({ home: f.home, runtime: f.runtime });
  assert.deepEqual(sources.map(({ tool, name, status }) => ({ tool, name, status })), [
    { tool: 'pi', name: 'sketch', status: 'conflict' },
    { tool: 'hermes', name: 'sketch', status: 'conflict' },
    { tool: 'codex', name: 'review', status: 'available' },
  ]);
  assert.equal(sources.some((source) => source.path === unsafe), false);
  assert.equal(sources.length, 3);
});

test('marks an existing HII install as conflict and reports tool and absolute path', (t) => {
  const f = fixture(t);
  const source = f.add('.claude/skills/notes');
  fs.mkdirSync(path.join(f.runtime, 'skills', 'installed', 'notes'), { recursive: true });
  const [item] = discoverSkills({ home: f.home, runtime: f.runtime });
  assert.deepEqual(item, { tool: 'claude', name: 'notes', path: fs.realpathSync(source), status: 'conflict' });
});

test('imports only a selected skill through the existing installer without hooks or replacement', (t) => {
  const f = fixture(t);
  const source = f.add('.codex/skills/build-check', '# Build check\n');
  const receipt = importSkill({ source, runtime: f.runtime, workspace: f.workspace, home: f.home });
  assert.equal(receipt.kind, 'skill');
  assert.equal(receipt.name, 'build-check');
  assert.equal(receipt.sourceTool, 'codex');
  assert.equal(receipt.requestedWorkspace, f.workspace);
  assert.equal(receipt.installHooksExecuted, false);
  assert.equal(JSON.parse(fs.readFileSync(receipt.receiptPath, 'utf8')).sourcePath, fs.realpathSync(source));
  assert.equal(fs.readFileSync(path.join(receipt.path, 'SKILL.md'), 'utf8'), '# Build check\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(receipt.path, 'HII_INSTALL.json'), 'utf8')).installHooksExecuted, false);
  assert.throws(() => importSkill({ source, runtime: f.runtime, workspace: f.workspace, home: f.home }), /name conflict/);
});

test('refuses skills containing symlinks or credential and tool configuration files', (t) => {
  const f = fixture(t);
  const source = f.add('.codex/skills/unsafe');
  fs.writeFileSync(path.join(source, '.env'), 'must not be read or copied');
  assert.throws(() => importSkill({ source, runtime: f.runtime, workspace: f.workspace, home: f.home }), /credential/);
  fs.rmSync(path.join(source, '.env'));
  fs.symlinkSync(path.join(source, 'SKILL.md'), path.join(source, 'alias.md'));
  assert.throws(() => importSkill({ source, runtime: f.runtime, workspace: f.workspace, home: f.home }), /symlink/);
  assert.equal(fs.existsSync(path.join(f.runtime, 'skills', 'installed', 'unsafe')), false);
});
