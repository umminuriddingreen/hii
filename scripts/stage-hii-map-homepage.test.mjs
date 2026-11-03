import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stageHiiMapHomepage } from './stage-hii-map-homepage.mjs';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hii-map-stage-test-'));
  const dist = path.join(root, 'dist');
  const output = path.join(root, 'out');
  const backup = path.join(root, 'external', 'homepage-original.html');
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  mkdirSync(path.join(dist, 'cesium', 'Workers'), { recursive: true });
  mkdirSync(path.join(output, 'assets'), { recursive: true });
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>HII Map</title><script type="module" src="/assets/map.js"></script>');
  writeFileSync(path.join(dist, 'assets', 'map.js'), 'map build one');
  writeFileSync(path.join(dist, 'cesium', 'Workers', 'createTaskProcessorWorker.js'), 'worker asset');
  writeFileSync(path.join(output, 'index.html'), '<!doctype html><title>Old HII homepage</title>');
  writeFileSync(path.join(output, 'docs.html'), 'keep existing route');
  writeFileSync(path.join(output, 'assets', 'old-hash.js'), 'keep existing asset');
  return {
    root,
    dist,
    distDirectory: dist,
    output,
    outputDirectory: output,
    backup,
    backupPath: backup,
  };
}

test('stages the map document and runtime without deleting existing site files', (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));

  const result = stageHiiMapHomepage(paths);

  assert.equal(readFileSync(result.index, 'utf8'), readFileSync(path.join(paths.dist, 'index.html'), 'utf8'));
  assert.equal(readFileSync(path.join(paths.output, 'docs.html'), 'utf8'), 'keep existing route');
  assert.equal(readFileSync(path.join(paths.output, 'workspace.html'), 'utf8'), '<!doctype html><title>Old HII homepage</title>');
  assert.equal(readFileSync(path.join(paths.output, 'assets', 'old-hash.js'), 'utf8'), 'keep existing asset');
  assert.equal(readFileSync(path.join(paths.output, 'assets', 'map.js'), 'utf8'), 'map build one');
  assert.equal(readFileSync(path.join(paths.output, 'cesium', 'Workers', 'createTaskProcessorWorker.js'), 'utf8'), 'worker asset');
  assert.equal(readFileSync(paths.backup, 'utf8'), '<!doctype html><title>Old HII homepage</title>');
});

test('does not replace an existing workspace.html route', (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));
  writeFileSync(path.join(paths.output, 'workspace.html'), 'existing workspace page');

  stageHiiMapHomepage(paths);

  assert.equal(readFileSync(path.join(paths.output, 'workspace.html'), 'utf8'), 'existing workspace page');
});

test('does not overwrite the preserved original homepage on a later staging run', (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));
  stageHiiMapHomepage(paths);
  writeFileSync(path.join(paths.dist, 'index.html'), '<!doctype html><title>HII Map Updated</title>');

  stageHiiMapHomepage(paths);

  assert.equal(readFileSync(paths.backup, 'utf8'), '<!doctype html><title>Old HII homepage</title>');
  assert.equal(readFileSync(path.join(paths.output, 'index.html'), 'utf8'), '<!doctype html><title>HII Map Updated</title>');
});

test('rejects a non-map dist before changing the current homepage', (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));
  writeFileSync(path.join(paths.dist, 'index.html'), '<!doctype html><title>Other page</title>');

  assert.throws(() => stageHiiMapHomepage(paths), /title must identify the page as HII Map/);
  assert.equal(readFileSync(path.join(paths.output, 'index.html'), 'utf8'), '<!doctype html><title>Old HII homepage</title>');
});
