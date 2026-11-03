import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { exportSkills, importSkills } from './hii-skill-sync.mjs';
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-sync-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const skills = path.join(root, 'source'); const runtime = path.join(root, 'runtime'); fs.mkdirSync(path.join(skills, 'demo/scripts'), { recursive: true }); fs.mkdirSync(runtime); fs.writeFileSync(path.join(skills, 'demo/SKILL.md'), '---\nname: demo\ndescription: demo skill\n---\nRun scripts/demo.sh'); fs.writeFileSync(path.join(skills, 'demo/scripts/demo.sh'), '#!/bin/sh\necho demo\n'); return { root, skills, runtime, bundle: path.join(root, 'bundle') }; }
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function manualBundle(bundle, entries) {
  const skills = [];
  for (const { name, skillMd } of entries) {
    const bytes = Buffer.from(skillMd);
    const files = [{ path: 'SKILL.md', sha256: sha(bytes), bytes: bytes.length, executable: false }];
    const hash = sha(JSON.stringify(files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))));
    const directory = `skills/${name}--${hash}`;
    fs.mkdirSync(path.join(bundle, directory), { recursive: true });
    fs.writeFileSync(path.join(bundle, directory, 'SKILL.md'), bytes);
    skills.push({ name, directory, hash, files, omitted: [] });
  }
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'hii.skills.bundle', skills, skipped: [] }));
}
test('full resources transfer additively; repeated import identical; conflict preserved', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.skills, 'demo/.env'), 'TOKEN=private'); fs.writeFileSync(path.join(f.skills, 'demo/HII_INSTALL.json'), '{}');
  const manifest = exportSkills({ roots: [f.skills], output: f.bundle }); assert.equal(manifest.skills.length, 1); assert.deepEqual(manifest.skills[0].omitted.sort(), ['.env', 'HII_INSTALL.json']);
  let result = importSkills({ bundle: f.bundle, runtime: f.runtime, roots: [] }); assert.equal(result.results[0].status, 'installed');
  const installed = path.join(f.runtime, 'skills/installed/demo'); assert.equal(fs.readFileSync(path.join(installed, 'scripts/demo.sh'), 'utf8'), '#!/bin/sh\necho demo\n');
  result = importSkills({ bundle: f.bundle, runtime: f.runtime, roots: [] }); assert.equal(result.results[0].status, 'identical');
  fs.writeFileSync(path.join(installed, 'SKILL.md'), 'concurrent edit'); result = importSkills({ bundle: f.bundle, runtime: f.runtime, roots: [] }); assert.equal(result.results[0].status, 'conflict-preserved'); assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), 'concurrent edit');
});
test('traversal and tampered content rejected before install', t => {
  const f = fixture(t); const m = exportSkills({ roots: [f.skills], output: f.bundle }); m.skills[0].files[0].path = '../escape'; fs.writeFileSync(path.join(f.bundle, 'manifest.json'), JSON.stringify(m));
  assert.throws(() => importSkills({ bundle: f.bundle, runtime: f.runtime, roots: [] }), /unsafe bundle path/); assert.equal(fs.existsSync(path.join(f.runtime, 'skills/installed/demo')), false);
});
test('symlink exports omitted; malicious bundle symlink rejected', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); fs.symlinkSync('/etc/passwd', path.join(f.skills, 'demo/private')); const m = exportSkills({ roots: [f.skills], output: f.bundle }); assert.ok(m.skills[0].omitted.includes('private'));
  const source = path.join(f.bundle, m.skills[0].directory); fs.unlinkSync(path.join(source, 'SKILL.md')); fs.symlinkSync('/etc/passwd', path.join(source, 'SKILL.md'));
  assert.throws(() => importSkills({ bundle: f.bundle, runtime: f.runtime, roots: [] }), /symlink bundle path/);
});

test('content digest rejects changed script before installation', t => {
  const f = fixture(t); const m = exportSkills({ roots: [f.skills], output: f.bundle });
  fs.writeFileSync(path.join(f.bundle, m.skills[0].directory, 'scripts/demo.sh'), 'changed after export');
  assert.throws(() => importSkills({ bundle: f.bundle, runtime: f.runtime, roots: [] }), /bundle content mismatch/);
  assert.equal(fs.existsSync(path.join(f.runtime, 'skills/installed/demo')), false);
});

test('namespace conflict policy installs stable content aliases and is idempotent', t => {
  const f = fixture(t);
  const secondRoot = path.join(f.root, 'second-source');
  fs.mkdirSync(path.join(f.skills, 'demo/resources'), { recursive: true });
  fs.mkdirSync(path.join(secondRoot, 'demo/resources'), { recursive: true });
  fs.writeFileSync(path.join(f.skills, 'demo/SKILL.md'), 'original skill');
  fs.writeFileSync(path.join(f.skills, 'demo/resources/origin.txt'), 'original resource');
  fs.writeFileSync(path.join(secondRoot, 'demo/SKILL.md'), 'other skill variant');
  fs.writeFileSync(path.join(secondRoot, 'demo/resources/origin.txt'), 'variant resource');
  const manifest = exportSkills({ roots: [f.skills, secondRoot], output: f.bundle });
  assert.equal(manifest.skills.length, 2);

  const first = importSkills({ bundle: f.bundle, runtime: f.runtime, roots: [], conflicts: 'namespace' });
  assert.deepEqual(first.results.map(({ status }) => status), ['installed', 'installed']);
  const alias = `demo--sync-${manifest.skills[1].hash.slice(0, 12)}`;
  assert.equal(first.results[1].installedName, alias);
  assert.equal(fs.readFileSync(path.join(f.runtime, 'skills/installed/demo/SKILL.md'), 'utf8'), 'original skill');
  assert.equal(fs.readFileSync(path.join(f.runtime, 'skills/installed', alias, 'resources/origin.txt'), 'utf8'), 'variant resource');

  const second = importSkills({ bundle: f.bundle, runtime: f.runtime, roots: [], conflicts: 'namespace' });
  assert.deepEqual(second.results.map(({ status }) => status), ['identical', 'identical-namespaced']);
  assert.equal(second.results[1].installedName, alias);
});

test('export excludes incompatible SKILL.md while keeping other skills portable', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.skills, 'empty'), { recursive: true });
  fs.writeFileSync(path.join(f.skills, 'empty/SKILL.md'), '');
  fs.mkdirSync(path.join(f.skills, 'large'), { recursive: true });
  fs.writeFileSync(path.join(f.skills, 'large/SKILL.md'), 'x'.repeat(16 * 1024 * 1024 + 1));
  const manifest = exportSkills({ roots: [f.skills], output: f.bundle });
  assert.deepEqual(manifest.skills.map(({ name }) => name), ['demo']);
  assert.deepEqual(manifest.skipped.map(({ name }) => name).sort(), ['empty', 'large']);
});

test('import records incompatible skills and continues with eligible skills', t => {
  const f = fixture(t);
  manualBundle(f.bundle, [
    { name: 'empty', skillMd: '' },
    { name: 'large', skillMd: 'x'.repeat(16 * 1024 * 1024 + 1) },
    { name: 'valid', skillMd: 'valid instructions' },
  ]);
  const result = importSkills({ bundle: f.bundle, runtime: f.runtime, roots: [] });
  assert.deepEqual(result.results.map(({ status }) => status), [
    'unsupported', 'unsupported', 'installed',
  ]);
  assert.equal(fs.existsSync(path.join(f.runtime, 'skills/installed/empty')), false);
  assert.equal(fs.existsSync(path.join(f.runtime, 'skills/installed/large')), false);
  assert.equal(fs.existsSync(path.join(f.runtime, 'skills/installed/valid')), true);
  assert.equal(fs.existsSync(result.receiptPath), true);
});

test('one installer failure gets a per-skill result and does not stop later imports', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const validRoot = path.join(f.root, 'valid-source');
  fs.mkdirSync(path.join(validRoot, 'valid'), { recursive: true });
  fs.writeFileSync(path.join(validRoot, 'valid/SKILL.md'), 'valid skill');
  const bundle = path.join(f.root, 'mixed-bundle');
  exportSkills({ roots: [f.skills, validRoot], output: bundle });
  const installed = path.join(f.runtime, 'skills/installed');
  fs.mkdirSync(installed, { recursive: true });
  fs.symlinkSync(path.join(f.root, 'protected'), path.join(installed, 'demo'));

  const result = importSkills({ bundle, runtime: f.runtime, roots: [] });
  assert.deepEqual(result.results.map(({ status }) => status), ['install-failed', 'installed']);
  assert.equal(fs.existsSync(path.join(f.runtime, 'skills/installed/valid/SKILL.md')), true);
  assert.equal(fs.existsSync(result.receiptPath), true);
});
