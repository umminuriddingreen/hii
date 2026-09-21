#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { removeTestTreeSync } from './lib/test-temp.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-contextdock-'));
const projectRoot = path.join(directory, 'approved-project');
fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
process.env.HII_DB_PATH = path.join(directory, 'hii.db');

function makeTextPdf(pageTexts) {
  const objects = new Map();
  const pageObjectIds = pageTexts.map((_, index) => 3 + index * 2);
  const fontId = 3 + pageTexts.length * 2;
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(2, `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`);
  pageTexts.forEach((text, index) => {
    const pageId = pageObjectIds[index];
    const contentId = pageId + 1;
    const escaped = text.replace(/([\\()])/g, '\\$1');
    const stream = `BT /F1 14 Tf 72 720 Td (${escaped}) Tj ET`;
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let id = 1; id <= fontId; id += 1) {
    offsets[id] = Buffer.byteLength(pdf);
    pdf += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${fontId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= fontId; id += 1) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

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
fs.writeFileSync(path.join(projectRoot, 'reference.pdf'), makeTextPdf([
  'PDF provenance alpha belongs to page one.',
  'PDF provenance beta belongs to page two.'
]));
fs.writeFileSync(path.join(projectRoot, 'opaque.bin'), Buffer.from([0, 1, 2, 3]));

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

  const stagedServer = path.join(directory, 'staged', 'server');
  const stagedWorker = path.join(stagedServer, 'scripts', 'hii-context-extractor.py');
  fs.mkdirSync(path.dirname(stagedWorker), { recursive: true });
  fs.writeFileSync(stagedWorker, '# staged worker fixture\n');
  const simulatedBundleModule = pathToFileURL(
    path.join(stagedServer, 'build', 'server', 'chunks', 'chunks', 'context-dock.js')
  ).href;
  assert.equal(contextDock.contextExtractorWorkerPath(simulatedBundleModule), stagedWorker);

  const firstInventory = contextDock.inventoryContextRoot({ rootPath: projectRoot, approved: true });
  const secondInventory = contextDock.inventoryContextRoot({ rootPath: projectRoot, approved: true });
  assert.deepEqual(firstInventory.map((item) => item.sourcePath), [
    'package.json',
    'README.md',
    'reference.pdf',
    'src/index.ts',
    'notes.txt'
  ].sort((left, right) => left.localeCompare(right, 'en')));
  assert.deepEqual(firstInventory, secondInventory);
  assert.equal(firstInventory.some((item) => item.sourcePath === '.env'), false);

  const scan = contextDock.scanContextProject(project.id);
  const scanned = contextDock
    .inventoryContextRoot({ rootPath: project.rootPath, approved: true })
    .map((item) => item.sourcePath);
  const scanDetail = `walked ${JSON.stringify(scanned)}; issues ${JSON.stringify(scan.extractionIssues)}`;
  assert.equal(scan.filesDiscovered, 5, `discovery: ${scanDetail}`);
  // A missing pdftotext lands here: the PDF is discovered, reported as an
  // unavailable capability, and not indexed. That is correct behaviour on a
  // machine without poppler, and the wrong outcome for this gate — so name it.
  assert.equal(scan.filesIndexed, 5, `indexing: ${scanDetail}`);
  assert.equal(scan.filesExcluded, 0);
  assert.equal(scan.filesSkipped, 0);
  assert.deepEqual(scan.extractionIssues, []);
  assert.ok(scan.chunksIndexed >= 6);
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
  assert.equal(firstInventory.some((item) => item.sourcePath === 'opaque.bin'), false);

  const pdfHit = contextDock.searchContext(project.id, 'provenance beta')[0];
  assert.equal(pdfHit.sourcePath, 'reference.pdf');
  assert.equal(pdfHit.kind, 'pdf');
  assert.equal(pdfHit.format, 'pdf');
  assert.equal(pdfHit.pageStart, 2);
  assert.equal(pdfHit.pageEnd, 2);
  assert.ok(pdfHit.lineStart >= 1);
  assert.ok(pdfHit.lineEnd >= pdfHit.lineStart);

  const workerPath = path.resolve('scripts/hii-context-extractor.py');
  const python = process.env.HII_PYTHON || (process.platform === 'win32'
    ? execFileSync('where.exe', ['python'], { encoding: 'utf8' }).split(/\r?\n/).map((candidate) => candidate.trim()).find((candidate) => candidate && !candidate.toLowerCase().includes('windowsapps'))
    : execFileSync('which', ['python3'], { encoding: 'utf8' }).trim());
  assert.ok(python, 'Python 3 executable not found');
  const workerArgs = [workerPath];
  const unavailable = JSON.parse(execFileSync(python, workerArgs, {
    encoding: 'utf8',
    input: JSON.stringify({ protocolVersion: 1, operation: 'extract_pdf', path: path.join(projectRoot, 'reference.pdf') }),
    env: { ...process.env, PATH: '' }
  }));
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.code, 'pdf_text_extractor_unavailable');
  const malformedPdf = path.join(projectRoot, 'malformed.pdf');
  fs.writeFileSync(malformedPdf, '%PDF-not-valid');
  const failed = JSON.parse(execFileSync(python, workerArgs, {
    encoding: 'utf8',
    input: JSON.stringify({ protocolVersion: 1, operation: 'extract_pdf', path: malformedPdf })
  }));
  assert.equal(failed.status, 'error');
  assert.equal(failed.code, 'extractor_failed');
  const imageOnlyPdf = path.join(projectRoot, 'image-only.pdf');
  fs.writeFileSync(imageOnlyPdf, makeTextPdf(['']));
  const ocrUnavailable = JSON.parse(execFileSync(python, workerArgs, {
    encoding: 'utf8',
    input: JSON.stringify({ protocolVersion: 1, operation: 'extract_pdf', path: imageOnlyPdf })
  }));
  assert.equal(ocrUnavailable.status, 'unavailable');
  assert.equal(ocrUnavailable.code, 'pdf_ocr_unavailable');
  fs.rmSync(malformedPdf);
  fs.rmSync(imageOnlyPdf);

  const fakeWorker = path.join(directory, 'fake-extractor.py');
  fs.writeFileSync(fakeWorker, [
    'import json, os',
    'status = os.environ["HII_FAKE_EXTRACTOR_STATUS"]',
    'code = os.environ["HII_FAKE_EXTRACTOR_CODE"]',
    'print(json.dumps({"protocolVersion": 1, "status": status, "code": code, "message": "fixture extraction issue", "capability": "pdf_text"}))'
  ].join('\n'));
  const originalWorker = process.env.HII_CONTEXT_EXTRACTOR_WORKER;
  process.env.HII_CONTEXT_EXTRACTOR_WORKER = fakeWorker;
  for (const fixture of [
    { status: 'unavailable', code: 'pdf_text_extractor_unavailable' },
    { status: 'unavailable', code: 'pdf_ocr_unavailable' },
    { status: 'error', code: 'extractor_failed' }
  ]) {
    process.env.HII_FAKE_EXTRACTOR_STATUS = fixture.status;
    process.env.HII_FAKE_EXTRACTOR_CODE = fixture.code;
    const issueScan = contextDock.scanContextProject(project.id);
    assert.equal(issueScan.filesIndexed, 4);
    assert.equal(issueScan.filesExcluded, 0);
    assert.equal(issueScan.filesSkipped, 1);
    assert.deepEqual(issueScan.extractionIssues, [{
      sourcePath: 'reference.pdf',
      status: fixture.status,
      code: fixture.code,
      message: 'fixture extraction issue',
      capability: 'pdf_text'
    }]);
    const pdfSource = contextDock.contextProjectState(project.id).sources
      .find((source) => source.sourcePath === 'reference.pdf');
    assert.ok(pdfSource);
    assert.equal(pdfSource.excluded, false);
    assert.equal(contextDock.searchContext(project.id, 'provenance beta').length, 0);
  }
  if (originalWorker === undefined) delete process.env.HII_CONTEXT_EXTRACTOR_WORKER;
  else process.env.HII_CONTEXT_EXTRACTOR_WORKER = originalWorker;
  delete process.env.HII_FAKE_EXTRACTOR_STATUS;
  delete process.env.HII_FAKE_EXTRACTOR_CODE;
  const recoveredScan = contextDock.scanContextProject(project.id);
  assert.equal(recoveredScan.filesIndexed, 5);
  assert.equal(recoveredScan.filesSkipped, 0);
  assert.equal(contextDock.searchContext(project.id, 'provenance beta')[0].pageStart, 2);

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
  assert.ok(removed.removedChunks >= 6);
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
  console.log('extraction:  Markdown/text/code/config + PDF page provenance + explicit worker failures verified');
  console.log('search:      deterministic provenance hits + pin/exclusion state verified');
  console.log('recovery:    derived project index deletion preserves source files verified');
  console.log('network:     no network or embeddings used');
} finally {
  contextDock.resetContextDockDbForTests();
  removeTestTreeSync(directory);
}
