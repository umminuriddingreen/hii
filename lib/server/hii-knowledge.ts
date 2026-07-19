import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configureKnowledgeVault,
  ensureKnowledgeVault,
  knowledgeVaultPath,
  listKnowledgeAssets,
  readVaultNote,
  resetKnowledgeVaultForTests,
  restoreVaultNote,
  scanVaultNotes,
  trashVaultNote,
  writeVaultNote,
  type VaultNote
} from './hii-vault.ts';
import { ensureNoteKnowledgeObject, knowledgeSystemSnapshot, resetKnowledgeSystemsForTests } from './hii-knowledge-systems.ts';

export type KnowledgeNote = {
  id: string;
  title: string;
  path: string;
  folder: string;
  content: string;
  pinned: boolean;
  dailyDate: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revision: string;
  kind: string;
  projectId: string;
  aliases: string[];
};

export type KnowledgeNoteSummary = Omit<KnowledgeNote, 'content'> & {
  excerpt: string;
  tags: string[];
  outgoingCount: number;
  backlinkCount: number;
};

export type KnowledgeLink = {
  sourceNoteId: string;
  sourceTitle: string;
  targetTitle: string;
  targetNoteId: string | null;
  targetNoteTitle: string | null;
};

type NoteRow = {
  id: string;
  title: string;
  path: string;
  folder: string;
  content: string;
  pinned: number;
  daily_date: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  metadata_json: string;
};

const databases = new Map<string, DatabaseSync>();
const syncing = new Set<string>();

export function knowledgeDbPath() {
  return process.env.HII_DB_PATH || path.join(process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii'), 'hii.db');
}

function timestamp() {
  return new Date().toISOString();
}

function cleanText(value: unknown, max = 200_000) {
  return String(value ?? '')
    .replace(/[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)=)([^\s]+)/gi, '$1[redacted]')
    .replace(/((?:OPENAI|ANTHROPIC|SUPABASE|STRIPE|GITHUB|VERCEL|CLOUDFLARE|AWS)[A-Z0-9_]*=)([^\s]+)/g, '$1[redacted]')
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, '$1[redacted]')
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[redacted]')
    .slice(0, max);
}

function cleanTitle(value: unknown) {
  return cleanText(value, 180).replace(/[\r\n]+/g, ' ').trim();
}

function cleanFolder(value: unknown) {
  return cleanText(value, 320)
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.replace(/[<>:"|?*]/g, '-').trim())
    .filter(Boolean)
    .join('/');
}

function noteFilename(title: string) {
  return `${title.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim() || 'Untitled'}.md`;
}

function normalizePath(value: unknown, title: string, folder: string) {
  const supplied = cleanText(value, 500).replace(/\\/g, '/');
  const parts = supplied
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.replace(/[<>:"|?*]/g, '-').trim())
    .filter(Boolean);
  if (parts.length > 0) {
    const joined = parts.join('/');
    return joined.toLowerCase().endsWith('.md') ? joined : `${joined}.md`;
  }
  return [folder, noteFilename(title)].filter(Boolean).join('/');
}

function noteFromRow(row: NoteRow): KnowledgeNote {
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(row.metadata_json || '{}') as Record<string, unknown>; } catch { /* legacy row */ }
  return {
    id: row.id,
    title: row.title,
    path: row.path,
    folder: row.folder,
    content: row.content,
    pinned: Boolean(row.pinned),
    dailyDate: row.daily_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    revision: typeof metadata.revision === 'string' ? metadata.revision : '',
    kind: typeof metadata.kind === 'string' ? metadata.kind : 'note',
    projectId: typeof metadata.projectId === 'string' ? metadata.projectId : 'shared',
    aliases: Array.isArray(metadata.aliases) ? metadata.aliases.map(String) : []
  };
}

function db() {
  const file = knowledgeDbPath();
  const existing = databases.get(file);
  if (existing) {
    synchronizeVault(existing, file);
    return existing;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(database);
  databases.set(file, database);
  initializeVault(database);
  synchronizeVault(database, file);
  return database;
}

function migrate(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS knowledge_notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      folder TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      daily_date TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_notes_folder ON knowledge_notes(folder);
    CREATE INDEX IF NOT EXISTS idx_knowledge_notes_updated ON knowledge_notes(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_notes_daily ON knowledge_notes(daily_date);

    CREATE TABLE IF NOT EXISTS knowledge_note_versions (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL,
      FOREIGN KEY (note_id) REFERENCES knowledge_notes(id) ON DELETE CASCADE,
      UNIQUE(note_id, version)
    );

    CREATE TABLE IF NOT EXISTS knowledge_tags (
      note_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY(note_id, tag),
      FOREIGN KEY (note_id) REFERENCES knowledge_notes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS knowledge_links (
      source_note_id TEXT NOT NULL,
      target_title TEXT NOT NULL,
      target_note_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(source_note_id, target_title),
      FOREIGN KEY (source_note_id) REFERENCES knowledge_notes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_note_id) REFERENCES knowledge_notes(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_links_target ON knowledge_links(target_note_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_links_title ON knowledge_links(target_title);

    CREATE TABLE IF NOT EXISTS knowledge_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      note_id TEXT,
      actor TEXT NOT NULL,
      summary TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_events_created ON knowledge_events(created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_notes_fts USING fts5(
      note_id UNINDEXED,
      title,
      path,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    INSERT OR IGNORE INTO schema_migrations(version) VALUES ('knowledge-v1');
  `);
}

function emitEvent(database: DatabaseSync, type: string, noteId: string | null, summary: string, metadata: Record<string, unknown> = {}, actor = 'hii.knowledge') {
  database.prepare(`
    INSERT INTO knowledge_events(id, type, note_id, actor, summary, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), type, noteId, actor, cleanText(summary, 1000), JSON.stringify(metadata), timestamp());
}

function extractTags(content: string) {
  const tags = new Set<string>();
  for (const match of content.matchAll(/(?:^|\s)#([a-zA-Z0-9][a-zA-Z0-9/_-]{0,63})/g)) {
    tags.add(match[1].toLowerCase());
  }
  return [...tags].sort();
}

function extractWikiLinks(content: string) {
  const links = new Set<string>();
  for (const match of content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
    const target = cleanTitle(match[1]);
    if (target) links.add(target);
  }
  return [...links];
}

function extractOutline(content: string) {
  return content
    .split('\n')
    .map((line, index) => {
      const match = line.match(/^(#{1,6})\s+(.+)$/);
      return match ? { level: match[1].length, text: cleanTitle(match[2]), line: index + 1 } : null;
    })
    .filter((item): item is { level: number; text: string; line: number } => Boolean(item));
}

function syncFts(database: DatabaseSync, note: KnowledgeNote) {
  database.prepare('DELETE FROM knowledge_notes_fts WHERE note_id = ?').run(note.id);
  if (!note.deletedAt) {
    database.prepare('INSERT INTO knowledge_notes_fts(note_id, title, path, content) VALUES (?, ?, ?, ?)')
      .run(note.id, note.title, note.path, note.content);
  }
}

function syncTagsAndLinks(database: DatabaseSync, note: KnowledgeNote) {
  database.prepare('DELETE FROM knowledge_tags WHERE note_id = ?').run(note.id);
  for (const tag of extractTags(note.content)) {
    database.prepare('INSERT INTO knowledge_tags(note_id, tag) VALUES (?, ?)').run(note.id, tag);
  }
  database.prepare('DELETE FROM knowledge_links WHERE source_note_id = ?').run(note.id);
  for (const targetTitle of extractWikiLinks(note.content)) {
    const target = database.prepare(`
      SELECT id FROM knowledge_notes
      WHERE lower(title) = lower(?) AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT 1
    `).get(targetTitle) as { id?: string } | undefined;
    database.prepare(`
      INSERT INTO knowledge_links(source_note_id, target_title, target_note_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(note.id, targetTitle, target?.id ?? null, timestamp());
  }
  database.prepare(`
    UPDATE knowledge_links
    SET target_note_id = (
      SELECT id FROM knowledge_notes
      WHERE lower(title) = lower(knowledge_links.target_title) AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT 1
    )
  `).run();
}

function writeVersion(database: DatabaseSync, note: KnowledgeNote, source: string) {
  const current = database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM knowledge_note_versions WHERE note_id = ?')
    .get(note.id) as { version: number };
  database.prepare(`
    INSERT INTO knowledge_note_versions(id, note_id, version, title, path, content, created_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), note.id, Number(current.version) + 1, note.title, note.path, note.content, timestamp(), source);
}

function noteMetadata(note: Pick<KnowledgeNote, 'revision' | 'kind' | 'projectId' | 'aliases'>) {
  return JSON.stringify({ revision: note.revision, kind: note.kind, projectId: note.projectId, aliases: note.aliases });
}

function fromVault(note: VaultNote): KnowledgeNote {
  return { ...note, deletedAt: null };
}

function upsertVaultNote(database: DatabaseSync, vaultNote: VaultNote, source = 'vault.scan') {
  const note = fromVault(vaultNote);
  const existingRow = (database.prepare('SELECT * FROM knowledge_notes WHERE id = ? OR path = ? ORDER BY id = ? DESC LIMIT 1')
    .get(note.id, note.path, note.id) as NoteRow | undefined);
  const existing = existingRow ? noteFromRow(existingRow) : null;
  if (existingRow && existingRow.id !== note.id) {
    note.id = existingRow.id;
  }
  database.prepare(`
    INSERT INTO knowledge_notes(id, title, path, folder, content, pinned, daily_date, metadata_json, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      path = excluded.path,
      folder = excluded.folder,
      content = excluded.content,
      pinned = excluded.pinned,
      daily_date = excluded.daily_date,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `).run(
    note.id, note.title, note.path, note.folder, note.content, note.pinned ? 1 : 0,
    note.dailyDate, noteMetadata(note), note.createdAt, note.updatedAt
  );
  syncFts(database, note);
  syncTagsAndLinks(database, note);
  ensureNoteKnowledgeObject(note);
  if (!existing || existing.revision !== note.revision) {
    writeVersion(database, note, existing ? source : 'vault.imported');
  }
  return note;
}

function initializeVault(database: DatabaseSync) {
  const root = ensureKnowledgeVault();
  const migrated = database.prepare("SELECT version FROM schema_migrations WHERE version = 'knowledge-vault-v2'").get();
  if (migrated) return;
  const vaultNotes = scanVaultNotes(root);
  if (vaultNotes.length === 0) {
    const legacyRows = database.prepare('SELECT * FROM knowledge_notes WHERE deleted_at IS NULL ORDER BY created_at').all() as unknown as NoteRow[];
    for (const row of legacyRows) {
      const note = noteFromRow(row);
      writeVaultNote({
        id: note.id,
        title: note.title,
        path: note.path,
        folder: note.folder,
        content: note.content,
        pinned: note.pinned,
        dailyDate: note.dailyDate,
        kind: note.kind,
        projectId: note.projectId === 'shared' ? (note.path.match(/^Projects\/([^/]+)/i)?.[1] || 'shared') : note.projectId,
        aliases: note.aliases,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt
      }, undefined, root);
    }
  }
  database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES ('knowledge-vault-v2')").run();
}

function synchronizeVault(database: DatabaseSync, key = knowledgeDbPath()) {
  if (syncing.has(key)) return;
  syncing.add(key);
  try {
    const notes = scanVaultNotes();
    const liveIds = new Set(notes.map((note) => note.id));
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const note of notes) upsertVaultNote(database, note);
      const indexed = database.prepare("SELECT id, metadata_json FROM knowledge_notes WHERE deleted_at IS NULL").all() as unknown as Array<{ id: string; metadata_json: string }>;
      for (const row of indexed) {
        let revision = '';
        try { revision = String((JSON.parse(row.metadata_json || '{}') as Record<string, unknown>).revision || ''); } catch { /* legacy row */ }
        if (revision && !liveIds.has(row.id)) {
          const deletedAt = timestamp();
          database.prepare('UPDATE knowledge_notes SET deleted_at = ?, updated_at = ? WHERE id = ?').run(deletedAt, deletedAt, row.id);
          database.prepare('DELETE FROM knowledge_notes_fts WHERE note_id = ?').run(row.id);
          database.prepare('UPDATE knowledge_links SET target_note_id = NULL WHERE target_note_id = ?').run(row.id);
        }
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    syncing.delete(key);
  }
}

function uniquePath(database: DatabaseSync, desired: string, excludeId?: string) {
  const extension = desired.toLowerCase().endsWith('.md') ? '.md' : '';
  const stem = extension ? desired.slice(0, -3) : desired;
  let candidate = desired;
  let index = 2;
  while (true) {
    const existing = database.prepare('SELECT id FROM knowledge_notes WHERE path = ?').get(candidate) as { id?: string } | undefined;
    if (!existing || existing.id === excludeId) return candidate;
    candidate = `${stem} ${index}${extension}`;
    index += 1;
  }
}

function getNoteRow(database: DatabaseSync, id: string) {
  return database.prepare('SELECT * FROM knowledge_notes WHERE id = ?').get(id) as NoteRow | undefined;
}

export function createKnowledgeNote(input: {
  title?: unknown;
  content?: unknown;
  folder?: unknown;
  path?: unknown;
  pinned?: unknown;
  dailyDate?: unknown;
  kind?: unknown;
  projectId?: unknown;
  aliases?: unknown;
  actor?: string;
}) {
  const database = db();
  const title = cleanTitle(input.title) || 'Untitled';
  const folder = cleanFolder(input.folder);
  const content = cleanText(input.content);
  const notePath = uniquePath(database, normalizePath(input.path, title, folder));
  const createdAt = timestamp();
  const written = writeVaultNote({
    id: randomUUID(),
    title,
    path: notePath,
    folder: cleanFolder(path.posix.dirname(notePath) === '.' ? folder : path.posix.dirname(notePath)),
    content,
    pinned: Boolean(input.pinned),
    dailyDate: /^\d{4}-\d{2}-\d{2}$/.test(String(input.dailyDate ?? '')) ? String(input.dailyDate) : null,
    kind: cleanText(input.kind, 40) || 'note',
    projectId: cleanText(input.projectId, 120) || notePath.match(/^Projects\/([^/]+)/i)?.[1] || 'shared',
    aliases: Array.isArray(input.aliases) ? input.aliases.map((alias) => cleanTitle(alias)).filter(Boolean).slice(0, 50) : [],
    createdAt,
    updatedAt: createdAt
  });
  const note = fromVault(written);
  database.exec('BEGIN IMMEDIATE');
  try {
    upsertVaultNote(database, written, 'created');
    emitEvent(database, 'note.created', note.id, `Created ${note.path}`, { path: note.path, revision: note.revision, vault: knowledgeVaultPath() }, input.actor);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return getKnowledgeNote(note.id);
}

export function updateKnowledgeNote(id: string, input: {
  title?: unknown;
  content?: unknown;
  folder?: unknown;
  path?: unknown;
  pinned?: unknown;
  kind?: unknown;
  projectId?: unknown;
  aliases?: unknown;
  ifMatch?: unknown;
  actor?: string;
}) {
  const database = db();
  const row = getNoteRow(database, id);
  if (!row) throw new Error(`Note not found: ${id}`);
  const existing = noteFromRow(row);
  const expected = cleanText(input.ifMatch, 100);
  const matches = !expected || (expected.length === 64 ? expected === existing.revision : expected === existing.updatedAt);
  if (!matches) {
    const error = new Error('This note changed after it was opened. Refresh before saving.') as Error & { code?: string };
    error.code = 'CONFLICT';
    throw error;
  }
  const title = input.title === undefined ? existing.title : cleanTitle(input.title) || existing.title;
  const folder = input.folder === undefined ? existing.folder : cleanFolder(input.folder);
  const desiredPath = input.path === undefined
    ? (title === existing.title && folder === existing.folder ? existing.path : normalizePath('', title, folder))
    : normalizePath(input.path, title, folder);
  const written = writeVaultNote({
    ...existing,
    title,
    folder: cleanFolder(path.posix.dirname(desiredPath) === '.' ? folder : path.posix.dirname(desiredPath)),
    path: uniquePath(database, desiredPath, id),
    content: input.content === undefined ? existing.content : cleanText(input.content),
    pinned: input.pinned === undefined ? existing.pinned : Boolean(input.pinned),
    kind: input.kind === undefined ? existing.kind : cleanText(input.kind, 40) || existing.kind,
    projectId: input.projectId === undefined ? existing.projectId : cleanText(input.projectId, 120) || existing.projectId,
    aliases: input.aliases === undefined ? existing.aliases : Array.isArray(input.aliases) ? input.aliases.map((alias) => cleanTitle(alias)).filter(Boolean).slice(0, 50) : existing.aliases,
    updatedAt: timestamp()
  }, existing.path);
  const next = fromVault(written);
  database.exec('BEGIN IMMEDIATE');
  try {
    upsertVaultNote(database, written, 'saved');
    emitEvent(database, 'note.updated', id, `Saved ${next.path}`, { previousPath: existing.path, path: next.path, revision: next.revision }, input.actor);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return getKnowledgeNote(id);
}

export function trashKnowledgeNote(id: string, actor = 'hii.knowledge') {
  const database = db();
  const row = getNoteRow(database, id);
  if (!row) throw new Error(`Note not found: ${id}`);
  const deletedAt = timestamp();
  trashVaultNote(noteFromRow(row));
  database.prepare('UPDATE knowledge_notes SET deleted_at = ?, updated_at = ? WHERE id = ?').run(deletedAt, deletedAt, id);
  const note = noteFromRow({ ...row, deleted_at: deletedAt, updated_at: deletedAt });
  syncFts(database, note);
  database.prepare('UPDATE knowledge_links SET target_note_id = NULL WHERE target_note_id = ?').run(id);
  emitEvent(database, 'note.trashed', id, `Moved ${note.path} to trash`, {}, actor);
  return note;
}

export function restoreKnowledgeNote(id: string, actor = 'hii.knowledge') {
  const database = db();
  const row = getNoteRow(database, id);
  if (!row) throw new Error(`Note not found: ${id}`);
  const updatedAt = timestamp();
  const restored = restoreVaultNote(noteFromRow(row));
  const note = { ...fromVault(restored), updatedAt };
  database.prepare('UPDATE knowledge_notes SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(updatedAt, id);
  upsertVaultNote(database, { ...restored, updatedAt }, 'restored');
  syncFts(database, note);
  syncTagsAndLinks(database, note);
  emitEvent(database, 'note.restored', id, `Restored ${note.path}`, {}, actor);
  return getKnowledgeNote(id);
}

export function restoreKnowledgeVersion(noteId: string, version: number, ifMatch?: string, actor = 'hii.knowledge') {
  const database = db();
  const snapshot = database.prepare(`
    SELECT title, path, content FROM knowledge_note_versions
    WHERE note_id = ? AND version = ?
  `).get(noteId, version) as { title?: string; path?: string; content?: string } | undefined;
  if (!snapshot?.title || snapshot.content === undefined) throw new Error(`Version ${version} was not found.`);
  const note = updateKnowledgeNote(noteId, {
    title: snapshot.title,
    path: snapshot.path,
    content: snapshot.content,
    ifMatch,
    actor
  });
  emitEvent(database, 'note.version_restored', noteId, `Restored version ${version}`, { version }, actor);
  return note;
}

export function getKnowledgeNote(id: string) {
  const database = db();
  const row = getNoteRow(database, id);
  if (!row) return null;
  const note = noteFromRow(row);
  const tags = (database.prepare('SELECT tag FROM knowledge_tags WHERE note_id = ? ORDER BY tag').all(id) as Array<{ tag: string }>).map((item) => item.tag);
  const outgoing = database.prepare(`
    SELECT l.source_note_id, s.title AS source_title, l.target_title, l.target_note_id, t.title AS target_note_title
    FROM knowledge_links l
    JOIN knowledge_notes s ON s.id = l.source_note_id
    LEFT JOIN knowledge_notes t ON t.id = l.target_note_id
    WHERE l.source_note_id = ? ORDER BY l.target_title COLLATE NOCASE
  `).all(id) as unknown as Array<{ source_note_id: string; source_title: string; target_title: string; target_note_id: string | null; target_note_title: string | null }>;
  const backlinks = database.prepare(`
    SELECT l.source_note_id, s.title AS source_title, l.target_title, l.target_note_id, t.title AS target_note_title
    FROM knowledge_links l
    JOIN knowledge_notes s ON s.id = l.source_note_id
    LEFT JOIN knowledge_notes t ON t.id = l.target_note_id
    WHERE l.target_note_id = ? AND s.deleted_at IS NULL ORDER BY s.updated_at DESC
  `).all(id) as unknown as Array<{ source_note_id: string; source_title: string; target_title: string; target_note_id: string | null; target_note_title: string | null }>;
  const versions = database.prepare(`
    SELECT id, version, title, path, created_at AS createdAt, source
    FROM knowledge_note_versions WHERE note_id = ? ORDER BY version DESC LIMIT 50
  `).all(id) as unknown as Array<{ id: string; version: number; title: string; path: string; createdAt: string; source: string }>;
  const mapLink = (link: typeof outgoing[number]): KnowledgeLink => ({
    sourceNoteId: link.source_note_id,
    sourceTitle: link.source_title,
    targetTitle: link.target_title,
    targetNoteId: link.target_note_id,
    targetNoteTitle: link.target_note_title
  });
  return { note, tags, outgoing: outgoing.map(mapLink), backlinks: backlinks.map(mapLink), versions, outline: extractOutline(note.content) };
}

function summaryFromRow(database: DatabaseSync, row: NoteRow): KnowledgeNoteSummary {
  const tags = (database.prepare('SELECT tag FROM knowledge_tags WHERE note_id = ? ORDER BY tag').all(row.id) as Array<{ tag: string }>).map((item) => item.tag);
  const counts = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM knowledge_links WHERE source_note_id = ?) AS outgoing,
      (SELECT COUNT(*) FROM knowledge_links WHERE target_note_id = ?) AS backlinks
  `).get(row.id, row.id) as { outgoing: number; backlinks: number };
  const { content: _content, ...note } = noteFromRow(row);
  return {
    ...note,
    excerpt: row.content.replace(/[#>*_`\[\]-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180),
    tags,
    outgoingCount: Number(counts.outgoing),
    backlinkCount: Number(counts.backlinks)
  };
}

export function listKnowledgeNotes(options: { includeDeleted?: boolean; folder?: string; tag?: string; limit?: number } = {}) {
  const database = db();
  const where = [options.includeDeleted ? '1 = 1' : 'n.deleted_at IS NULL'];
  const params: SQLInputValue[] = [];
  if (options.folder !== undefined) {
    where.push('n.folder = ?');
    params.push(cleanFolder(options.folder));
  }
  if (options.tag) {
    where.push('EXISTS (SELECT 1 FROM knowledge_tags kt WHERE kt.note_id = n.id AND kt.tag = ?)');
    params.push(cleanText(options.tag, 64).toLowerCase());
  }
  params.push(Math.min(Math.max(options.limit ?? 500, 1), 2000));
  const rows = database.prepare(`
    SELECT n.* FROM knowledge_notes n
    WHERE ${where.join(' AND ')}
    ORDER BY n.pinned DESC, n.updated_at DESC LIMIT ?
  `).all(...params) as unknown as NoteRow[];
  return rows.map((row) => summaryFromRow(database, row));
}

function ftsQuery(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/["*:^(){}\[\]]/g, ''))
    .filter(Boolean)
    .map((term) => `"${term}"*`)
    .join(' AND ');
}

export function searchKnowledge(query: string, limit = 50) {
  const database = db();
  const normalized = ftsQuery(cleanText(query, 500));
  if (!normalized) return [];
  return database.prepare(`
    SELECT n.id, n.title, n.path, n.folder, n.updated_at AS updatedAt,
      snippet(knowledge_notes_fts, 3, '‹', '›', ' … ', 24) AS excerpt,
      bm25(knowledge_notes_fts, 8.0, 4.0, 1.0) AS rank
    FROM knowledge_notes_fts
    JOIN knowledge_notes n ON n.id = knowledge_notes_fts.note_id
    WHERE knowledge_notes_fts MATCH ? AND n.deleted_at IS NULL
    ORDER BY rank LIMIT ?
  `).all(normalized, Math.min(Math.max(limit, 1), 100));
}

export function knowledgeGraph() {
  const database = db();
  const nodes = database.prepare(`
    SELECT n.id, n.title, n.folder, n.pinned, n.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM knowledge_links l WHERE l.source_note_id = n.id OR l.target_note_id = n.id) AS degree
    FROM knowledge_notes n WHERE n.deleted_at IS NULL ORDER BY n.updated_at DESC
  `).all() as unknown as Array<{ id: string; title: string; folder: string; pinned: number; updatedAt: string; degree: number }>;
  const edges = database.prepare(`
    SELECT source_note_id AS source, target_note_id AS target, target_title AS targetTitle
    FROM knowledge_links WHERE target_note_id IS NOT NULL
  `).all() as unknown as Array<{ source: string; target: string; targetTitle: string }>;
  const unresolved = database.prepare(`
    SELECT source_note_id AS source, target_title AS targetTitle
    FROM knowledge_links WHERE target_note_id IS NULL
  `).all() as unknown as Array<{ source: string; targetTitle: string }>;
  return { nodes, edges, unresolved };
}

export function knowledgeWorkspace() {
  const database = db();
  const notes = listKnowledgeNotes();
  const assets = listKnowledgeAssets();
  const systems = knowledgeSystemSnapshot();
  const folders = database.prepare(`
    SELECT folder, COUNT(*) AS count FROM knowledge_notes
    WHERE deleted_at IS NULL GROUP BY folder ORDER BY folder COLLATE NOCASE
  `).all() as unknown as Array<{ folder: string; count: number }>;
  const tags = database.prepare(`
    SELECT t.tag, COUNT(*) AS count FROM knowledge_tags t
    JOIN knowledge_notes n ON n.id = t.note_id
    WHERE n.deleted_at IS NULL GROUP BY t.tag ORDER BY count DESC, t.tag
  `).all() as unknown as Array<{ tag: string; count: number }>;
  const trash = database.prepare('SELECT COUNT(*) AS count FROM knowledge_notes WHERE deleted_at IS NOT NULL').get() as { count: number };
  const events = database.prepare(`
    SELECT id, type, note_id AS noteId, actor, summary, created_at AS createdAt
    FROM knowledge_events ORDER BY created_at DESC LIMIT 30
  `).all() as unknown as Array<{ id: string; type: string; noteId: string | null; actor: string; summary: string; createdAt: string }>;
  const projects = [...new Set([
    ...notes.map((note) => note.projectId).filter((project) => project && project !== 'shared'),
    ...assets.map((asset) => asset.projectId).filter((project) => project && project !== 'Shared')
  ])].sort((a, b) => a.localeCompare(b)).map((projectId) => ({
    id: projectId,
    name: projectId,
    noteCount: notes.filter((note) => note.projectId === projectId || note.path.startsWith(`Projects/${projectId}/`)).length,
    assetCount: assets.filter((asset) => asset.projectId === projectId).length,
    objectCount: systems.objects.filter((object) => object.projectId === projectId).length
  }));
  return {
    dbPath: knowledgeDbPath(),
    vaultPath: knowledgeVaultPath(),
    authority: 'markdown-vault',
    notes,
    projects,
    assets,
    systems: systems.stats,
    folders,
    tags,
    trashCount: Number(trash.count),
    events,
    stats: {
      notes: notes.length,
      folders: folders.length,
      tags: tags.length,
      links: Number((database.prepare('SELECT COUNT(*) AS count FROM knowledge_links').get() as { count: number }).count),
      words: notes.reduce((sum, note) => sum + note.excerpt.split(/\s+/).filter(Boolean).length, 0),
      assets: assets.length,
      objects: systems.stats.objects
    }
  };
}

export function openDailyNote(date = new Date().toISOString().slice(0, 10), actor = 'hii.knowledge') {
  const database = db();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Daily note date must use YYYY-MM-DD.');
  const existing = database.prepare('SELECT id FROM knowledge_notes WHERE daily_date = ? AND deleted_at IS NULL LIMIT 1').get(date) as { id?: string } | undefined;
  if (existing?.id) return getKnowledgeNote(existing.id);
  return createKnowledgeNote({
    title: date,
    folder: 'Daily',
    dailyDate: date,
    actor,
    content: `# ${date}\n\n## Focus\n\n- [ ] \n\n## Notes\n\n\n## Proof\n\n`
  });
}

export function importKnowledgeNotes(files: Array<{ name?: unknown; path?: unknown; content?: unknown }>, actor = 'hii.knowledge') {
  if (!Array.isArray(files) || files.length === 0) throw new Error('At least one Markdown file is required.');
  if (files.length > 200) throw new Error('Import is limited to 200 files per request.');
  return files.map((file) => {
    const suppliedPath = normalizePath(file.path || file.name, cleanTitle(file.name) || 'Imported note', 'Imports');
    const base = path.posix.basename(suppliedPath, '.md');
    const folder = cleanFolder(path.posix.dirname(suppliedPath) === '.' ? 'Imports' : path.posix.dirname(suppliedPath));
    return createKnowledgeNote({ title: base, path: [folder, path.posix.basename(suppliedPath)].filter(Boolean).join('/'), folder, content: file.content, actor });
  });
}

export function exportKnowledgeWorkspace() {
  const notes = listKnowledgeNotes({ limit: 2000 }).map((summary) => getKnowledgeNote(summary.id)?.note).filter(Boolean);
  return {
    schemaVersion: 2,
    exportKind: 'hii.knowledge.workspace',
    exportedAt: timestamp(),
    localOnly: true,
    authority: 'markdown-vault',
    vaultPath: knowledgeVaultPath(),
    notes,
    assets: listKnowledgeAssets(),
    graph: knowledgeGraph(),
    systems: knowledgeSystemSnapshot(),
    guardrails: ['Local export only.', 'No content was uploaded or published.', 'Review note contents before external sharing.']
  };
}

export function exportKnowledgeNote(id: string) {
  return getKnowledgeNote(id)?.note ?? null;
}

export function resetKnowledgeDbForTests() {
  for (const database of databases.values()) database.close();
  databases.clear();
  syncing.clear();
  resetKnowledgeVaultForTests();
  resetKnowledgeSystemsForTests();
}

export function configureKnowledgeWorkspaceVault(root: unknown) {
  const config = configureKnowledgeVault(root);
  const database = db();
  synchronizeVault(database);
  emitEvent(database, 'vault.configured', null, `Configured Markdown vault at ${config.root}`, { root: config.root });
  return { config, workspace: knowledgeWorkspace() };
}

export function rebuildKnowledgeIndex() {
  const database = db();
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DELETE FROM knowledge_notes_fts; DELETE FROM knowledge_tags; DELETE FROM knowledge_links;');
    database.prepare('UPDATE knowledge_notes SET deleted_at = ?').run(timestamp());
    for (const note of scanVaultNotes()) upsertVaultNote(database, note, 'vault.rebuild');
    emitEvent(database, 'vault.rebuilt', null, 'Rebuilt the knowledge index from canonical Markdown files', { vault: knowledgeVaultPath() });
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return knowledgeWorkspace();
}
