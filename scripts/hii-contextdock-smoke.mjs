#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-contextdock-'));
const projectRoot = path.join(directory, 'approved-project');
fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
process.env.HII_DB_PATH = path.join(directory, 'hii.db');

fs.writeFileSync(path.join(projectRoot, 'README.md'), [
  '# Context Dock',
  '',
  'Local context keeps provenance for the deterministic atlas phrase.',
  'OPENAI_API_KEY=super-secret-value'
].join('\n'));
fs.writeFileSync(path.join(projectRoot, 'notes.txt'), 'The deterministic atlas phrase is searchable in local text.\n');
fs.writeFileSync(path.join(projectRoot, 'src', 'index.ts'), [
  'export const proof = "deterministic atlas phrase";',
  'export const localOnly = true;'
].join('\n'));
fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'context-dock-fixture', private: true }, null, 2));
fs.writeFileSync(path.join(projectRoot, '.env'), 'STRIPE_SECRET_KEY=must-never-be-indexed\n');

execFileSync('git', ['init', '-q'], { cwd: projectRoot });
execFileSync('git', ['add', 'README.md', 'notes.txt', 'src/index.ts', 'package.json'], { cwd: projectRoot });
execFileSync('git', ['-c', 'user.name=HII Smoke', '-c', 'user.email=hii-smoke@localhost', 'commit', '-qm', 'fixture'], { cwd: projectRoot });

const contextDock = await import('../lib/server/hii-context-dock.ts');

try {
  assert.throws(
    () => contextDock.createContextProject({ rootPath: projectRoot, approved: false }),
    /explicit approval/
  );

  const project = contextDock.createContextProject({
    name: 'Approved smoke project',
    rootPath: projectRoot,
    approved: true
  });
  assert.equal(project.approvedRoot, true);
  assert.equal(project.rootPath, fs.realpathSync(projectRoot));

  const firstInventory = contextDock.inventoryContextRoot({ rootPath: projectRoot, approved: true });
  const secondInventory = contextDock.inventoryContextRoot({ rootPath: projectRoot, approved: true });
  assert.deepEqual(firstInventory.map((item) => item.sourcePath), [
    'package.json',
    'README.md',
    'src/index.ts',
    'notes.txt'
  ].sort((left, right) => left.localeCompare(right, 'en')));
  assert.deepEqual(firstInventory, secondInventory);
  assert.equal(firstInventory.some((item) => item.sourcePath === '.env'), false);

  const scan = contextDock.scanContextProject(project.id);
  assert.equal(scan.filesDiscovered, 4);
  assert.equal(scan.filesIndexed, 4);
  assert.ok(scan.chunksIndexed >= 4);
  assert.match(scan.gitRevision, /^[a-f0-9]{40}$/);
  assert.equal(scan.localOnly, true);

  const firstSearch = contextDock.searchContext(project.id, 'deterministic atlas');
  assert.equal(firstSearch.length, 3);
  for (const hit of firstSearch) {
    assert.equal(hit.projectId, project.id);
    assert.equal(hit.rootPath, project.rootPath);
    assert.ok(hit.sourcePath);
    assert.ok(hit.lineStart >= 1);
    assert.ok(hit.lineEnd >= hit.lineStart);
    assert.equal(hit.pageStart, null);
    assert.equal(hit.pageEnd, null);
    assert.match(hit.freshnessAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(hit.contentHash, /^[a-f0-9]{64}$/);
    assert.match(hit.chunkContentHash, /^[a-f0-9]{64}$/);
    assert.equal(hit.gitRevision, scan.gitRevision);
    assert.equal(hit.approvedRoot, true);
    assert.equal(hit.excluded, false);
  }
  assert.equal(contextDock.searchContext(project.id, 'super secret value').length, 0);
  assert.equal(contextDock.searchContext(project.id, 'must never indexed').length, 0);

  const state = contextDock.contextProjectState(project.id);
  const codeSource = state.sources.find((source) => source.sourcePath === 'src/index.ts');
  assert.ok(codeSource);
  contextDock.setContextSourceState(codeSource.id, { pinned: true });
  assert.equal(contextDock.searchContext(project.id, 'deterministic atlas')[0].sourcePath, 'src/index.ts');
  contextDock.setContextSourceState(codeSource.id, { excluded: true });
  assert.equal(contextDock.searchContext(project.id, 'deterministic atlas').some((hit) => hit.sourcePath === 'src/index.ts'), false);
  contextDock.setContextSourceState(codeSource.id, { excluded: false });

  const stableHit = contextDock.searchContext(project.id, 'deterministic atlas')
    .find((hit) => hit.sourcePath === 'src/index.ts');
  contextDock.scanContextProject(project.id);
  const rescannedHit = contextDock.searchContext(project.id, 'deterministic atlas')
    .find((hit) => hit.sourcePath === 'src/index.ts');
  assert.equal(rescannedHit.chunkId, stableHit.chunkId);

  const removed = contextDock.deleteContextProjectDerivedData(project.id);
  assert.equal(removed.projectId, project.id);
  assert.equal(removed.rootPath, project.rootPath);
  assert.ok(removed.removedChunks >= 4);
  assert.equal(removed.sourceFilesTouched, false);
  assert.equal(contextDock.getContextProject(project.id), null);
  assert.equal(contextDock.contextProjectState(project.id), null);
  assert.equal(contextDock.searchContext(project.id, 'deterministic atlas').length, 0);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8').includes('deterministic atlas phrase'), true);

  const database = new DatabaseSync(process.env.HII_DB_PATH, { readOnly: true });
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type IN ('table', 'shadow') AND name LIKE 'context_%'
    ORDER BY name
  `).all().map((row) => row.name);
  for (const table of [
    'context_projects',
    'context_sources',
    'context_documents',
    'context_chunks',
    'context_scan_events',
    'context_chunks_fts'
  ]) assert.ok(tables.includes(table), `missing ${table}`);
  assert.ok(database.prepare("SELECT 1 FROM schema_migrations WHERE version = 'context-dock-v1'").get());
  assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_chunks_fts').get().count, 0);
  database.close();

  console.log('HII Context Dock smoke');
  console.log('status:      ok');
  console.log('database:    self-migrating SQLite + WAL + FTS5 verified');
  console.log('inventory:   approved-root deterministic local traversal verified');
  console.log('extraction:  Markdown/text/code/config + redaction + Git provenance verified');
  console.log('search:      deterministic provenance hits + pin/exclusion state verified');
  console.log('recovery:    derived project index deletion preserves source files verified');
  console.log('network:     no network or embeddings used');
} finally {
  contextDock.resetContextDockDbForTests();
  fs.rmSync(directory, { recursive: true, force: true });
}
