import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stringify } from 'yaml';
import {
  createKnowledgeNote,
  exportKnowledgeNote,
  knowledgeDbPath,
  knowledgeWorkspace,
  listKnowledgeNotes
} from './hii-knowledge.ts';
import { parseVaultMarkdown } from './hii-vault.ts';
import { removeKnowledgeObjectsByExternalRefs } from './hii-knowledge-systems.ts';

export type ImportFileKind = 'markdown' | 'text' | 'json' | 'csv' | 'base';

export type KnowledgeImportFile = {
  sourcePath: string;
  sourceKind: ImportFileKind;
  contentHash: string;
  sizeBytes: number;
  modifiedAt: string;
  noteId: string;
  title: string;
  projectId: string;
  frontmatter: Record<string, unknown>;
  wikiLinks: string[];
};

export type KnowledgeImportManifest = {
  schemaVersion: 1;
  sourceRoot: string;
  generatedAt: string;
  files: KnowledgeImportFile[];
  excluded: Array<{ sourcePath: string; reason: string }>;
  conflicts: Array<{ kind: 'duplicate-id' | 'duplicate-title'; value: string; paths: string[] }>;
  totals: { files: number; bytes: number; markdown: number; links: number; excluded: number };
};

const supported = new Map<string, ImportFileKind>([
  ['.md', 'markdown'], ['.markdown', 'markdown'], ['.txt', 'text'], ['.json', 'json'], ['.csv', 'csv'], ['.base', 'base']
]);
const excludedDirectories = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.hii']);
const excludedNames = new Set(['.DS_Store']);

function runtimeDir() {
  return process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
}

function secretsVaultPath() {
  return path.join(runtimeDir(), 'vault.json');
}

function hash(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function safeRoot(input: unknown) {
  const supplied = String(input ?? '').trim();
  if (!supplied) throw new Error('An explicit source vault is required.');
  const resolved = fs.realpathSync(path.resolve(supplied));
  const home = fs.realpathSync(os.homedir());
  if (!fs.statSync(resolved).isDirectory()) throw new Error('The source vault must be a directory.');
  if (resolved === path.parse(resolved).root || resolved === home || resolved === path.resolve(runtimeDir())) {
    throw new Error('Choose a dedicated source vault, not the filesystem, home, or HII runtime root.');
  }
  return resolved;
}

function normalizeRelative(root: string, absolute: string) {
  const relative = path.relative(root, absolute).split(path.sep).join('/').normalize('NFC');
  if (!relative || relative === '..' || relative.startsWith('../')) throw new Error('Import path escaped the approved root.');
  return relative;
}

function stableNoteId(root: string, relative: string, metadata: Record<string, unknown>) {
  if (typeof metadata.hii_id === 'string' && metadata.hii_id.trim()) return metadata.hii_id.trim();
  if (typeof metadata.id === 'string' && metadata.id.trim()) return metadata.id.trim();
  return `import-${hash(`${root}\0${relative.toLowerCase()}`).slice(0, 32)}`;
}

function wikiLinks(content: string) {
  return [...new Set([...content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)]
    .map((match) => match[1].trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function titleFor(relative: string, metadata: Record<string, unknown>) {
  if (typeof metadata.title === 'string' && metadata.title.trim()) return metadata.title.trim();
  return path.posix.basename(relative, path.posix.extname(relative));
}

function projectFor(relative: string, metadata: Record<string, unknown>) {
  if (typeof metadata.project === 'string' && metadata.project.trim()) return metadata.project.trim();
  const first = relative.split('/')[0];
  return first && relative.includes('/') ? first : 'shared';
}

function manifestHash(manifest: KnowledgeImportManifest) {
  return hash(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    sourceRoot: manifest.sourceRoot,
    files: manifest.files.map(({ sourcePath, sourceKind, contentHash, sizeBytes, modifiedAt, noteId }) => ({ sourcePath, sourceKind, contentHash, sizeBytes, modifiedAt, noteId })),
    excluded: manifest.excluded
  }));
}

function database() {
  knowledgeWorkspace();
  const result = new DatabaseSync(knowledgeDbPath());
  result.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return result;
}

export function buildKnowledgeImportManifest(sourceRoot: unknown): KnowledgeImportManifest {
  const root = safeRoot(sourceRoot);
  const files: KnowledgeImportFile[] = [];
  const excluded: KnowledgeImportManifest['excluded'] = [];

  function walk(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelative(root, absolute);
      if (entry.isSymbolicLink()) {
        excluded.push({ sourcePath: relative, reason: 'symbolic-link' });
        continue;
      }
      if (entry.isDirectory()) {
        if (excludedDirectories.has(entry.name)) excluded.push({ sourcePath: `${relative}/`, reason: 'application-or-hidden-state' });
        else walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (excludedNames.has(entry.name)) {
        excluded.push({ sourcePath: relative, reason: 'operating-system-metadata' });
        continue;
      }
      const sourceKind = supported.get(path.extname(entry.name).toLowerCase());
      if (!sourceKind) {
        excluded.push({ sourcePath: relative, reason: 'unsupported-file-type' });
        continue;
      }
      const bytes = fs.readFileSync(absolute);
      const stat = fs.statSync(absolute);
      const raw = bytes.toString('utf8');
      const parsed = sourceKind === 'markdown' ? parseVaultMarkdown(raw) : { metadata: {} as Record<string, unknown>, content: raw };
      files.push({
        sourcePath: relative,
        sourceKind,
        contentHash: hash(bytes),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        noteId: stableNoteId(root, relative, parsed.metadata),
        title: titleFor(relative, parsed.metadata),
        projectId: projectFor(relative, parsed.metadata),
        frontmatter: parsed.metadata,
        wikiLinks: sourceKind === 'markdown' ? wikiLinks(parsed.content) : []
      });
    }
  }
  walk(root);

  const conflicts: KnowledgeImportManifest['conflicts'] = [];
  for (const [kind, selector] of [['duplicate-id', (file: KnowledgeImportFile) => file.noteId], ['duplicate-title', (file: KnowledgeImportFile) => file.title.toLowerCase()]] as const) {
    const grouped = new Map<string, string[]>();
    for (const file of files) grouped.set(selector(file), [...(grouped.get(selector(file)) ?? []), file.sourcePath]);
    for (const [value, paths] of grouped) if (paths.length > 1) conflicts.push({ kind, value, paths });
  }
  return {
    schemaVersion: 1,
    sourceRoot: root,
    generatedAt: new Date().toISOString(),
    files,
    excluded,
    conflicts,
    totals: {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      markdown: files.filter((file) => file.sourceKind === 'markdown').length,
      links: files.reduce((sum, file) => sum + file.wikiLinks.length, 0),
      excluded: excluded.length
    }
  };
}

export function planKnowledgeImport(sourceRoot: unknown) {
  const manifest = buildKnowledgeImportManifest(sourceRoot);
  const planHash = manifestHash(manifest);
  const approvalToken = randomBytes(24).toString('base64url');
  const approvalHash = hash(approvalToken);
  const db = database();
  try {
    const existing = db.prepare('SELECT id, status, summary_json FROM knowledge_import_batches WHERE plan_hash = ?').get(planHash) as { id: string; status: string; summary_json: string } | undefined;
    if (existing) {
      const summary = JSON.parse(existing.summary_json || '{}') as Record<string, unknown>;
      if (existing.status === 'completed') return { batchId: existing.id, planHash, approvalToken: null, status: existing.status, manifest, summary, idempotent: true };
      db.prepare("UPDATE knowledge_import_batches SET summary_json = ? WHERE id = ?").run(JSON.stringify({ ...summary, approvalHash }), existing.id);
      return { batchId: existing.id, planHash, approvalToken, status: existing.status, manifest, idempotent: true };
    }
    const batchId = randomUUID();
    db.prepare(`
      INSERT INTO knowledge_import_batches(id, source_root, plan_hash, status, manifest_json, summary_json, created_at)
      VALUES (?, ?, ?, 'planned', ?, ?, ?)
    `).run(batchId, manifest.sourceRoot, planHash, JSON.stringify(manifest), JSON.stringify({ approvalHash }), new Date().toISOString());
    return { batchId, planHash, approvalToken, status: 'planned', manifest, idempotent: false };
  } finally {
    db.close();
  }
}

function tokenMatches(expectedHash: string, token: unknown) {
  const actual = Buffer.from(hash(String(token ?? '')), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function noteContent(root: string, file: KnowledgeImportFile) {
  const raw = fs.readFileSync(path.join(root, ...file.sourcePath.split('/')), 'utf8');
  if (file.sourceKind === 'markdown') return parseVaultMarkdown(raw).content;
  return raw;
}

export function executeKnowledgeImport(batchId: unknown, planHashInput: unknown, approvalToken: unknown) {
  const id = String(batchId ?? '');
  const db = database();
  let batch: { id: string; source_root: string; plan_hash: string; status: string; manifest_json: string; summary_json: string } | undefined;
  try {
    batch = db.prepare('SELECT * FROM knowledge_import_batches WHERE id = ?').get(id) as typeof batch;
    if (!batch) throw new Error('Import batch not found.');
    if (batch.status === 'completed') return verifyKnowledgeImport(id);
    if (batch.status !== 'planned' && batch.status !== 'failed') throw new Error(`Import batch is ${batch.status}.`);
    if (batch.plan_hash !== String(planHashInput ?? '')) throw new Error('Import plan hash changed. Generate a new plan.');
    const summary = JSON.parse(batch.summary_json || '{}') as { approvalHash?: string };
    if (!summary.approvalHash || !tokenMatches(summary.approvalHash, approvalToken)) throw new Error('Explicit import approval token is required.');
    const current = buildKnowledgeImportManifest(batch.source_root);
    if (manifestHash(current) !== batch.plan_hash) throw new Error('The source vault changed after planning. Generate a new import plan.');
    db.prepare("UPDATE knowledge_import_batches SET status = 'importing' WHERE id = ?").run(id);
  } finally {
    db.close();
  }

  const manifest = JSON.parse(batch!.manifest_json) as KnowledgeImportManifest;
  const imported: Array<{ sourcePath: string; noteId: string; revision: string }> = [];
  try {
    for (const file of manifest.files) {
      const detail = createKnowledgeNote({
        id: file.noteId,
        title: file.title,
        path: file.sourceKind === 'markdown' ? file.sourcePath : `${file.sourcePath}.md`,
        folder: path.posix.dirname(file.sourcePath) === '.' ? '' : path.posix.dirname(file.sourcePath),
        content: noteContent(manifest.sourceRoot, file),
        kind: file.sourceKind === 'markdown' ? 'note' : 'source',
        projectId: file.projectId,
        aliases: Array.isArray(file.frontmatter.aliases) ? file.frontmatter.aliases.map(String) : [],
        createdAt: file.modifiedAt,
        updatedAt: file.modifiedAt,
        sourceMetadata: {
          importBatchId: id,
          sourceRoot: manifest.sourceRoot,
          sourcePath: file.sourcePath,
          sourceKind: file.sourceKind,
          sourceHash: file.contentHash,
          originalFrontmatter: file.frontmatter
        },
        actor: 'hii.knowledge.import'
      });
      if (!detail) throw new Error(`Imported note was not readable: ${file.sourcePath}`);
      imported.push({ sourcePath: file.sourcePath, noteId: detail.note.id, revision: detail.note.revision });
      const sourceBytes = fs.readFileSync(path.join(manifest.sourceRoot, ...file.sourcePath.split('/')));
      const writeDb = database();
      try {
        writeDb.prepare(`
          INSERT OR REPLACE INTO knowledge_import_files(
            batch_id, source_path, source_kind, content_hash, size_bytes, modified_at,
            note_id, content_blob, metadata_json, imported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, file.sourcePath, file.sourceKind, file.contentHash, file.sizeBytes, file.modifiedAt,
          detail.note.id, sourceBytes, JSON.stringify({ importedRevision: detail.note.revision, frontmatter: file.frontmatter }), new Date().toISOString());
      } finally {
        writeDb.close();
      }
    }
    const finishDb = database();
    try {
      const summary = { imported: imported.length, files: manifest.totals.files, bytes: manifest.totals.bytes, links: manifest.totals.links, excluded: manifest.totals.excluded };
      finishDb.prepare("UPDATE knowledge_import_batches SET status = 'completed', summary_json = ?, completed_at = ? WHERE id = ?")
        .run(JSON.stringify(summary), new Date().toISOString(), id);
    } finally {
      finishDb.close();
    }
    return verifyKnowledgeImport(id);
  } catch (error) {
    const failDb = database();
    try {
      failDb.prepare("UPDATE knowledge_import_batches SET status = 'failed', summary_json = ? WHERE id = ?")
        .run(JSON.stringify({ imported: imported.length, error: error instanceof Error ? error.message : String(error) }), id);
    } finally {
      failDb.close();
    }
    throw error;
  }
}

export function knowledgeImportStatus(batchId?: unknown) {
  const db = database();
  try {
    if (batchId) return db.prepare('SELECT id, source_root AS sourceRoot, plan_hash AS planHash, status, summary_json AS summaryJson, created_at AS createdAt, completed_at AS completedAt, rolled_back_at AS rolledBackAt FROM knowledge_import_batches WHERE id = ?').get(String(batchId));
    return db.prepare('SELECT id, source_root AS sourceRoot, plan_hash AS planHash, status, summary_json AS summaryJson, created_at AS createdAt, completed_at AS completedAt, rolled_back_at AS rolledBackAt FROM knowledge_import_batches ORDER BY created_at DESC').all();
  } finally {
    db.close();
  }
}

export function verifyKnowledgeImport(batchId: unknown) {
  const id = String(batchId ?? '');
  const db = database();
  try {
    const batch = db.prepare('SELECT * FROM knowledge_import_batches WHERE id = ?').get(id) as { status: string; manifest_json: string; source_root: string } | undefined;
    if (!batch) throw new Error('Import batch not found.');
    const manifest = JSON.parse(batch.manifest_json) as KnowledgeImportManifest;
    const rows = db.prepare('SELECT source_path, content_hash, size_bytes, note_id, metadata_json FROM knowledge_import_files WHERE batch_id = ?').all(id) as unknown as Array<{ source_path: string; content_hash: string; size_bytes: number; note_id: string; metadata_json: string }>;
    const byPath = new Map(rows.map((row) => [row.source_path, row]));
    const missing: string[] = [];
    const mismatched: string[] = [];
    for (const file of manifest.files) {
      const row = byPath.get(file.sourcePath);
      if (!row) missing.push(file.sourcePath);
      else if (row.content_hash !== file.contentHash || Number(row.size_bytes) !== file.sizeBytes) mismatched.push(file.sourcePath);
    }
    const noteIds = new Set(rows.map((row) => row.note_id).filter(Boolean));
    const liveIds = new Set(listKnowledgeNotes({ includeDeleted: true, limit: 2000 }).map((note) => note.id));
    const missingNotes = [...noteIds].filter((noteId) => !liveIds.has(noteId));
    return {
      batchId: id,
      status: batch.status,
      sourceRoot: batch.source_root,
      expectedFiles: manifest.files.length,
      storedFiles: rows.length,
      notes: noteIds.size,
      missing,
      mismatched,
      missingNotes,
      ok: batch.status === 'completed' && missing.length === 0 && mismatched.length === 0 && missingNotes.length === 0
    };
  } finally {
    db.close();
  }
}

export function rollbackKnowledgeImport(batchId: unknown) {
  const id = String(batchId ?? '');
  const db = database();
  try {
    const batch = db.prepare('SELECT status FROM knowledge_import_batches WHERE id = ?').get(id) as { status: string } | undefined;
    if (!batch) throw new Error('Import batch not found.');
    if (batch.status === 'rolled_back') return { batchId: id, status: 'rolled_back', removed: 0, retained: 0 };
    const rows = db.prepare('SELECT note_id, metadata_json FROM knowledge_import_files WHERE batch_id = ? AND note_id IS NOT NULL').all(id) as unknown as Array<{ note_id: string; metadata_json: string }>;
    let removed = 0;
    let retained = 0;
    const removedNoteIds: string[] = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const metadata = JSON.parse(row.metadata_json || '{}') as { importedRevision?: string };
        const note = exportKnowledgeNote(row.note_id);
        if (!note || note.revision !== metadata.importedRevision) {
          retained += 1;
          continue;
        }
        db.prepare('DELETE FROM knowledge_notes_fts WHERE note_id = ?').run(row.note_id);
        db.prepare('DELETE FROM knowledge_notes WHERE id = ?').run(row.note_id);
        removedNoteIds.push(row.note_id);
        removed += 1;
      }
      db.prepare("UPDATE knowledge_import_batches SET status = 'rolled_back', rolled_back_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const systems = removeKnowledgeObjectsByExternalRefs(removedNoteIds.map((noteId) => `note:${noteId}`));
    return { batchId: id, status: 'rolled_back', removed, retained, systems };
  } finally {
    db.close();
  }
}

function exportFrontmatter(note: ReturnType<typeof exportKnowledgeNote>, original: Record<string, unknown> = {}) {
  if (!note) return '';
  return `---\n${stringify({
    ...original,
    hii_id: note.id,
    hii_kind: note.kind,
    project: note.projectId,
    title: note.title,
    pinned: note.pinned,
    aliases: note.aliases,
    daily_date: note.dailyDate,
    created_at: note.createdAt,
    updated_at: note.updatedAt
  }).trim()}\n---\n`;
}

export function exportKnowledgeVault(destination: unknown) {
  const target = path.resolve(String(destination ?? ''));
  if (!String(destination ?? '').trim()) throw new Error('An explicit export destination is required.');
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) throw new Error('Export destination must be empty.');
  fs.mkdirSync(target, { recursive: true });
  const db = database();
  const metadataById = new Map<string, Record<string, unknown>>();
  try {
    const metadataRows = db.prepare('SELECT id, metadata_json FROM knowledge_notes').all() as unknown as Array<{ id: string; metadata_json: string }>;
    for (const row of metadataRows) {
      try {
        const metadata = JSON.parse(row.metadata_json || '{}') as { originalFrontmatter?: Record<string, unknown> };
        metadataById.set(row.id, metadata.originalFrontmatter || {});
      } catch {
        metadataById.set(row.id, {});
      }
    }
  } finally {
    db.close();
  }
  const notes = listKnowledgeNotes({ limit: 2000 });
  for (const summary of notes) {
    const note = exportKnowledgeNote(summary.id);
    if (!note) continue;
    const output = path.resolve(target, ...note.path.split('/'));
    if (!output.startsWith(`${target}${path.sep}`)) throw new Error('Export path escaped the destination.');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${exportFrontmatter(note, metadataById.get(note.id))}${note.content}`);
  }
  const sourceDb = database();
  let restoredSources = 0;
  try {
    const files = sourceDb.prepare("SELECT source_path, source_kind, content_blob FROM knowledge_import_files WHERE source_kind != 'markdown' ORDER BY source_path").all() as unknown as Array<{ source_path: string; source_kind: string; content_blob: Uint8Array }>;
    for (const file of files) {
      const output = path.resolve(target, ...file.source_path.split('/'));
      if (!output.startsWith(`${target}${path.sep}`)) throw new Error('Source export path escaped the destination.');
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, file.content_blob);
      restoredSources += 1;
    }
  } finally {
    sourceDb.close();
  }
  const receipt = { schemaVersion: 1, kind: 'hii.knowledge.export', authority: 'hii-database', exportedAt: new Date().toISOString(), destination: target, notes: notes.length, restoredSources };
  fs.writeFileSync(path.join(target, 'hii-export-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function assertSecretsVaultUntouched(beforeHash: string) {
  const current = fs.existsSync(secretsVaultPath()) ? hash(fs.readFileSync(secretsVaultPath())) : '';
  return { path: secretsVaultPath(), beforeHash, currentHash: current, unchanged: beforeHash === current };
}
