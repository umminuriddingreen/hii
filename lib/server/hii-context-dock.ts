import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type ContextProject = {
  id: string;
  name: string;
  rootPath: string;
  approvedRoot: boolean;
  pinned: boolean;
  excluded: boolean;
  gitRevision: string | null;
  lastScannedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ContextInventoryItem = {
  sourcePath: string;
  absolutePath: string;
  kind: 'markdown' | 'text' | 'code' | 'config';
  format: string;
  sizeBytes: number;
  freshnessAt: string;
};

export type ContextSearchHit = {
  chunkId: string;
  projectId: string;
  sourceId: string;
  documentId: string;
  rootPath: string;
  sourcePath: string;
  kind: ContextInventoryItem['kind'];
  format: string;
  excerpt: string;
  lineStart: number;
  lineEnd: number;
  pageStart: number | null;
  pageEnd: number | null;
  freshnessAt: string;
  contentHash: string;
  chunkContentHash: string;
  gitRevision: string | null;
  approvedRoot: boolean;
  pinned: boolean;
  excluded: boolean;
  rank: number;
};

type ProjectRow = {
  id: string;
  name: string;
  root_path: string;
  approved_root: number;
  pinned: number;
  excluded: number;
  git_revision: string | null;
  last_scanned_at: string | null;
  created_at: string;
  updated_at: string;
};

type SourceStateRow = {
  id: string;
  pinned: number;
  excluded: number;
};

const databases = new Map<string, DatabaseSync>();
const ignoredDirectories = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.svelte-kit',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'vendor'
]);
const secretFileNames = /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const codeExtensions = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.dart', '.ex', '.exs', '.go', '.h', '.hpp', '.html',
  '.java', '.js', '.jsx', '.kt', '.kts', '.lua', '.m', '.mm', '.php', '.py', '.rb', '.rs',
  '.scss', '.sh', '.sql', '.svelte', '.swift', '.ts', '.tsx', '.vue', '.zig'
]);
const configExtensions = new Set(['.conf', '.ini', '.json', '.jsonc', '.plist', '.properties', '.toml', '.xml', '.yaml', '.yml']);
const textExtensions = new Set(['.csv', '.log', '.rst', '.text', '.txt']);
const configFileNames = new Set([
  'dockerfile', 'gemfile', 'justfile', 'makefile', 'package-lock.json', 'package.json',
  'pnpm-lock.yaml', 'tsconfig.json', 'vite.config.js', 'vite.config.ts', 'yarn.lock'
]);

export function contextDockDbPath() {
  return process.env.HII_DB_PATH || path.join(process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii'), 'hii.db');
}

function timestamp() {
  return new Date().toISOString();
}

function hash(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function stableId(kind: string, ...parts: string[]) {
  return `${kind}_${hash(parts.join('\u0000')).slice(0, 32)}`;
}

function cleanText(value: unknown, max = 2_000_000) {
  return String(value ?? '')
    .replace(/[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)=)([^\s]+)/gi, '$1[redacted]')
    .replace(/((?:OPENAI|ANTHROPIC|SUPABASE|STRIPE|GITHUB|VERCEL|CLOUDFLARE|AWS)[A-Z0-9_]*=)([^\s]+)/g, '$1[redacted]')
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, '$1[redacted]')
    .replace(/(--(?:api-key|token|secret|password|auth|key)\s+)([^\s]+)/gi, '$1[redacted]')
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[redacted]')
    .replace(/(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/g, '[redacted]')
    .slice(0, max);
}

function cleanName(value: unknown, fallback: string) {
  return cleanText(value, 180).replace(/[\r\n]+/g, ' ').trim() || fallback;
}

function normalizeRelativePath(value: string) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function projectFromRow(row: ProjectRow): ContextProject {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    approvedRoot: Boolean(row.approved_root),
    pinned: Boolean(row.pinned),
    excluded: Boolean(row.excluded),
    gitRevision: row.git_revision,
    lastScannedAt: row.last_scanned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function db() {
  const file = contextDockDbPath();
  const existing = databases.get(file);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(database);
  databases.set(file, database);
  return database;
}

function migrate(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS context_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      approved_root INTEGER NOT NULL DEFAULT 0 CHECK (approved_root IN (0, 1)),
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
      git_revision TEXT,
      last_scanned_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      absolute_path TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_format TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      freshness_at TEXT NOT NULL,
      content_hash TEXT,
      git_revision TEXT,
      approved_root INTEGER NOT NULL DEFAULT 1 CHECK (approved_root IN (0, 1)),
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
      discovered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES context_projects(id) ON DELETE CASCADE,
      UNIQUE(project_id, source_path)
    );

    CREATE INDEX IF NOT EXISTS idx_context_sources_project_path ON context_sources(project_id, source_path);
    CREATE INDEX IF NOT EXISTS idx_context_sources_state ON context_sources(project_id, excluded, pinned);

    CREATE TABLE IF NOT EXISTS context_documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_id TEXT NOT NULL UNIQUE,
      source_path TEXT NOT NULL,
      content TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      page_start INTEGER,
      page_end INTEGER,
      freshness_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      git_revision TEXT,
      approved_root INTEGER NOT NULL DEFAULT 1 CHECK (approved_root IN (0, 1)),
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
      extracted_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES context_projects(id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES context_sources(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_context_documents_project ON context_documents(project_id, source_path);

    CREATE TABLE IF NOT EXISTS context_chunks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      source_path TEXT NOT NULL,
      content TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      page_start INTEGER,
      page_end INTEGER,
      freshness_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      git_revision TEXT,
      approved_root INTEGER NOT NULL DEFAULT 1 CHECK (approved_root IN (0, 1)),
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES context_projects(id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES context_sources(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES context_documents(id) ON DELETE CASCADE,
      UNIQUE(document_id, ordinal)
    );

    CREATE INDEX IF NOT EXISTS idx_context_chunks_project_source ON context_chunks(project_id, source_path, ordinal);
    CREATE INDEX IF NOT EXISTS idx_context_chunks_state ON context_chunks(project_id, excluded, pinned);

    CREATE TABLE IF NOT EXISTS context_scan_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      root_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      git_revision TEXT,
      files_discovered INTEGER NOT NULL DEFAULT 0,
      files_indexed INTEGER NOT NULL DEFAULT 0,
      files_excluded INTEGER NOT NULL DEFAULT 0,
      chunks_indexed INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (project_id) REFERENCES context_projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_context_scan_events_project ON context_scan_events(project_id, started_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS context_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      project_id UNINDEXED,
      source_path UNINDEXED,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    INSERT OR IGNORE INTO schema_migrations(version) VALUES ('context-dock-v1');
  `);
}

function resolveApprovedRoot(rootPath: unknown) {
  const supplied = String(rootPath ?? '').trim();
  if (!supplied) throw new Error('An explicit project root is required.');
  const resolved = fs.realpathSync(path.resolve(supplied));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Approved project root is not a directory: ${resolved}`);
  return resolved;
}

function sourceDescriptor(filePath: string): Pick<ContextInventoryItem, 'kind' | 'format'> | null {
  const base = path.basename(filePath).toLowerCase();
  if (secretFileNames.test(base)) return null;
  const extension = path.extname(base).toLowerCase();
  if (extension === '.md' || extension === '.mdx') return { kind: 'markdown', format: extension.slice(1) };
  if (textExtensions.has(extension)) return { kind: 'text', format: extension.slice(1) };
  if (codeExtensions.has(extension)) return { kind: 'code', format: extension.slice(1) };
  if (configExtensions.has(extension) || configFileNames.has(base)) {
    return { kind: 'config', format: extension ? extension.slice(1) : base };
  }
  return null;
}

function isExplicitlyExcluded(sourcePath: string, exclusions: string[]) {
  return exclusions.some((entry) => {
    const normalized = normalizeRelativePath(entry).replace(/^\/+|\/+$/g, '');
    return normalized && (sourcePath === normalized || sourcePath.startsWith(`${normalized}/`));
  });
}

export function inventoryContextRoot(input: {
  rootPath: string;
  approved: true;
  exclusions?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
}) {
  if (input.approved !== true) throw new Error('Context inventory requires an explicitly approved project root.');
  const rootPath = resolveApprovedRoot(input.rootPath);
  const maxFiles = Math.min(Math.max(input.maxFiles ?? 20_000, 1), 100_000);
  const maxFileBytes = Math.min(Math.max(input.maxFileBytes ?? 1_500_000, 1), 10_000_000);
  const exclusions = (input.exclusions ?? []).map(String);
  const inventory: ContextInventoryItem[] = [];

  function walk(directory: string) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (inventory.length >= maxFiles) throw new Error(`Context inventory exceeded the ${maxFiles} file limit.`);
      const absolutePath = path.join(directory, entry.name);
      const sourcePath = normalizeRelativePath(path.relative(rootPath, absolutePath));
      if (isExplicitlyExcluded(sourcePath, exclusions)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const descriptor = sourceDescriptor(absolutePath);
      if (!descriptor) continue;
      const stat = fs.statSync(absolutePath);
      if (stat.size > maxFileBytes) continue;
      inventory.push({
        sourcePath,
        absolutePath,
        ...descriptor,
        sizeBytes: stat.size,
        freshnessAt: stat.mtime.toISOString()
      });
    }
  }

  walk(rootPath);
  return inventory.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath, 'en'));
}

function gitRevision(rootPath: string) {
  try {
    return execFileSync('git', ['-C', rootPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000
    }).trim() || null;
  } catch {
    return null;
  }
}

function readExtractableFile(filePath: string) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.includes(0)) return null;
  const raw = bytes.toString('utf8').replace(/\r\n?/g, '\n');
  return {
    content: cleanText(raw),
    contentHash: hash(bytes)
  };
}

function chunkDocument(content: string, maxLines = 80, maxCharacters = 8_000) {
  const lines = content.split('\n');
  const chunks: Array<{ content: string; lineStart: number; lineEnd: number }> = [];
  let current: string[] = [];
  let lineStart = 1;

  const flush = (lineEnd: number) => {
    if (current.length === 0) return;
    const chunk = current.join('\n').trimEnd();
    if (chunk.trim()) chunks.push({ content: chunk, lineStart, lineEnd });
    current = [];
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.length > maxCharacters) {
      flush(lineNumber - 1);
      for (let offset = 0; offset < line.length; offset += maxCharacters) {
        const content = line.slice(offset, offset + maxCharacters);
        if (content.trim()) chunks.push({ content, lineStart: lineNumber, lineEnd: lineNumber });
      }
      lineStart = lineNumber + 1;
      return;
    }
    const projected = current.reduce((sum, item) => sum + item.length + 1, 0) + line.length;
    if (current.length > 0 && (current.length >= maxLines || projected > maxCharacters)) {
      flush(lineNumber - 1);
      lineStart = lineNumber;
    }
    if (current.length === 0) lineStart = lineNumber;
    current.push(line);
  });
  flush(lines.length);
  return chunks;
}

function getProjectRow(database: DatabaseSync, projectId: string) {
  return database.prepare('SELECT * FROM context_projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
}

export function createContextProject(input: {
  name?: unknown;
  rootPath: string;
  approved: true;
  pinned?: boolean;
  excluded?: boolean;
}) {
  if (input.approved !== true) throw new Error('Context Dock requires explicit approval for the project root.');
  const database = db();
  const rootPath = resolveApprovedRoot(input.rootPath);
  const id = stableId('project', rootPath);
  const now = timestamp();
  const name = cleanName(input.name, path.basename(rootPath));
  database.prepare(`
    INSERT INTO context_projects(id, name, root_path, approved_root, pinned, excluded, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(root_path) DO UPDATE SET
      name = excluded.name,
      approved_root = 1,
      pinned = excluded.pinned,
      excluded = excluded.excluded,
      updated_at = excluded.updated_at
  `).run(id, name, rootPath, input.pinned ? 1 : 0, input.excluded ? 1 : 0, now, now);
  const row = database.prepare('SELECT * FROM context_projects WHERE root_path = ?').get(rootPath) as ProjectRow;
  return projectFromRow(row);
}

export function getContextProject(projectId: string) {
  const row = getProjectRow(db(), projectId);
  return row ? projectFromRow(row) : null;
}

/** Remove only Context Dock's derived records; never mutate the source root. */
export function deleteContextProjectDerivedData(projectId: string) {
  const database = db();
  const project = getContextProject(projectId);
  if (!project) throw new Error(`Context project not found: ${projectId}`);

  database.exec('BEGIN IMMEDIATE');
  try {
    const indexedChunks = database.prepare('SELECT COUNT(*) AS count FROM context_chunks WHERE project_id = ?')
      .get(projectId) as { count: number };
    database.prepare('DELETE FROM context_chunks_fts WHERE project_id = ?').run(projectId);
    database.prepare('DELETE FROM context_projects WHERE id = ?').run(projectId);
    database.exec('COMMIT');
    return {
      projectId,
      rootPath: project.rootPath,
      removedChunks: Number(indexedChunks.count),
      sourceFilesTouched: false,
      localOnly: true as const
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function deleteSourceIndex(database: DatabaseSync, sourceId: string) {
  database.prepare(`
    DELETE FROM context_chunks_fts
    WHERE chunk_id IN (SELECT id FROM context_chunks WHERE source_id = ?)
  `).run(sourceId);
}

export function scanContextProject(projectId: string, options: {
  exclusions?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
} = {}) {
  const database = db();
  const projectRow = getProjectRow(database, projectId);
  if (!projectRow) throw new Error(`Context project not found: ${projectId}`);
  const project = projectFromRow(projectRow);
  if (!project.approvedRoot) throw new Error('The project root is not approved.');
  if (project.excluded) throw new Error('The context project is excluded.');

  const revision = gitRevision(project.rootPath);
  const startedAt = timestamp();
  const eventId = randomUUID();
  database.prepare(`
    INSERT INTO context_scan_events(id, project_id, root_path, status, git_revision, started_at)
    VALUES (?, ?, ?, 'running', ?, ?)
  `).run(eventId, project.id, project.rootPath, revision, startedAt);

  try {
    const inventory = inventoryContextRoot({
      rootPath: project.rootPath,
      approved: true,
      exclusions: [],
      maxFiles: options.maxFiles,
      maxFileBytes: options.maxFileBytes
    });
    const seen = new Set<string>();
    let filesIndexed = 0;
    let filesExcluded = 0;
    let chunksIndexed = 0;

    for (const item of inventory) {
      const sourceId = stableId('source', project.id, item.sourcePath);
      seen.add(sourceId);
      const existing = database.prepare('SELECT id, pinned, excluded FROM context_sources WHERE id = ?')
        .get(sourceId) as SourceStateRow | undefined;
      const explicitlyExcluded = isExplicitlyExcluded(item.sourcePath, options.exclusions ?? []);
      const excluded = explicitlyExcluded || Boolean(existing?.excluded);
      const pinned = Boolean(existing?.pinned);
      const extracted = excluded ? null : readExtractableFile(item.absolutePath);
      const now = timestamp();

      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`
          INSERT INTO context_sources(
            id, project_id, source_path, absolute_path, source_kind, source_format,
            size_bytes, freshness_at, content_hash, git_revision, approved_root,
            pinned, excluded, discovered_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
          ON CONFLICT(project_id, source_path) DO UPDATE SET
            absolute_path = excluded.absolute_path,
            source_kind = excluded.source_kind,
            source_format = excluded.source_format,
            size_bytes = excluded.size_bytes,
            freshness_at = excluded.freshness_at,
            content_hash = COALESCE(excluded.content_hash, context_sources.content_hash),
            git_revision = excluded.git_revision,
            approved_root = 1,
            pinned = excluded.pinned,
            excluded = excluded.excluded,
            updated_at = excluded.updated_at
        `).run(
          sourceId, project.id, item.sourcePath, item.absolutePath, item.kind, item.format,
          item.sizeBytes, item.freshnessAt, extracted?.contentHash ?? null, revision, pinned ? 1 : 0,
          excluded ? 1 : 0, now, now
        );

        if (excluded || !extracted) {
          deleteSourceIndex(database, sourceId);
          database.prepare('UPDATE context_documents SET excluded = 1, pinned = ? WHERE source_id = ?')
            .run(pinned ? 1 : 0, sourceId);
          database.prepare('UPDATE context_chunks SET excluded = 1, pinned = ? WHERE source_id = ?')
            .run(pinned ? 1 : 0, sourceId);
          filesExcluded += 1;
          database.exec('COMMIT');
          continue;
        }

        const documentId = stableId('document', sourceId);
        const lineEnd = Math.max(extracted.content.split('\n').length, 1);
        database.prepare(`
          INSERT INTO context_documents(
            id, project_id, source_id, source_path, content, line_start, line_end,
            page_start, page_end, freshness_at, content_hash, git_revision,
            approved_root, pinned, excluded, extracted_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?, ?, 1, ?, 0, ?)
          ON CONFLICT(source_id) DO UPDATE SET
            source_path = excluded.source_path,
            content = excluded.content,
            line_start = 1,
            line_end = excluded.line_end,
            page_start = NULL,
            page_end = NULL,
            freshness_at = excluded.freshness_at,
            content_hash = excluded.content_hash,
            git_revision = excluded.git_revision,
            approved_root = 1,
            pinned = excluded.pinned,
            excluded = 0,
            extracted_at = excluded.extracted_at
        `).run(
          documentId, project.id, sourceId, item.sourcePath, extracted.content, lineEnd,
          item.freshnessAt, extracted.contentHash, revision, pinned ? 1 : 0, now
        );

        deleteSourceIndex(database, sourceId);
        database.prepare('DELETE FROM context_chunks WHERE source_id = ?').run(sourceId);
        const chunks = chunkDocument(extracted.content);
        chunks.forEach((chunk, ordinal) => {
          const chunkId = stableId('chunk', documentId, String(ordinal), hash(chunk.content));
          const chunkHash = hash(chunk.content);
          database.prepare(`
            INSERT INTO context_chunks(
              id, project_id, source_id, document_id, ordinal, source_path, content,
              line_start, line_end, page_start, page_end, freshness_at, content_hash,
              git_revision, approved_root, pinned, excluded, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 1, ?, 0, ?)
          `).run(
            chunkId, project.id, sourceId, documentId, ordinal, item.sourcePath, chunk.content,
            chunk.lineStart, chunk.lineEnd, item.freshnessAt, chunkHash, revision, pinned ? 1 : 0, now
          );
          database.prepare('INSERT INTO context_chunks_fts(chunk_id, project_id, source_path, content) VALUES (?, ?, ?, ?)')
            .run(chunkId, project.id, item.sourcePath, chunk.content);
        });
        filesIndexed += 1;
        chunksIndexed += chunks.length;
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }

    const staleSources = database.prepare('SELECT id FROM context_sources WHERE project_id = ?')
      .all(project.id) as unknown as Array<{ id: string }>;
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const source of staleSources) {
        if (seen.has(source.id)) continue;
        deleteSourceIndex(database, source.id);
        database.prepare('DELETE FROM context_sources WHERE id = ?').run(source.id);
      }
      const completedAt = timestamp();
      database.prepare(`
        UPDATE context_projects
        SET git_revision = ?, last_scanned_at = ?, updated_at = ? WHERE id = ?
      `).run(revision, completedAt, completedAt, project.id);
      database.prepare(`
        UPDATE context_scan_events
        SET status = 'completed', files_discovered = ?, files_indexed = ?, files_excluded = ?,
          chunks_indexed = ?, completed_at = ? WHERE id = ?
      `).run(inventory.length, filesIndexed, filesExcluded, chunksIndexed, completedAt, eventId);
      database.exec('COMMIT');
      return {
        eventId,
        projectId: project.id,
        rootPath: project.rootPath,
        gitRevision: revision,
        filesDiscovered: inventory.length,
        filesIndexed,
        filesExcluded,
        chunksIndexed,
        completedAt,
        localOnly: true as const
      };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    const completedAt = timestamp();
    database.prepare(`
      UPDATE context_scan_events SET status = 'failed', error = ?, completed_at = ? WHERE id = ?
    `).run(cleanText(error instanceof Error ? error.message : error, 1000), completedAt, eventId);
    throw error;
  }
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

export function searchContext(projectId: string, query: string, limit = 50): ContextSearchHit[] {
  const database = db();
  const project = getProjectRow(database, projectId);
  if (!project || !project.approved_root || project.excluded) return [];
  const normalized = ftsQuery(cleanText(query, 500));
  if (!normalized) return [];
  const rows = database.prepare(`
    SELECT
      c.id AS chunkId,
      c.project_id AS projectId,
      c.source_id AS sourceId,
      c.document_id AS documentId,
      p.root_path AS rootPath,
      c.source_path AS sourcePath,
      s.source_kind AS kind,
      s.source_format AS format,
      snippet(context_chunks_fts, 3, '‹', '›', ' … ', 32) AS excerpt,
      c.line_start AS lineStart,
      c.line_end AS lineEnd,
      c.page_start AS pageStart,
      c.page_end AS pageEnd,
      c.freshness_at AS freshnessAt,
      s.content_hash AS contentHash,
      c.content_hash AS chunkContentHash,
      c.git_revision AS gitRevision,
      c.approved_root AS approvedRoot,
      c.pinned AS pinned,
      c.excluded AS excluded,
      bm25(context_chunks_fts, 0.0, 0.0, 0.0, 1.0) AS rank
    FROM context_chunks_fts
    JOIN context_chunks c ON c.id = context_chunks_fts.chunk_id
    JOIN context_sources s ON s.id = c.source_id
    JOIN context_projects p ON p.id = c.project_id
    WHERE context_chunks_fts MATCH ? AND c.project_id = ?
      AND p.approved_root = 1 AND p.excluded = 0
      AND s.approved_root = 1 AND s.excluded = 0
      AND c.approved_root = 1 AND c.excluded = 0
    ORDER BY c.pinned DESC, rank ASC, c.source_path COLLATE NOCASE ASC, c.line_start ASC, c.id ASC
    LIMIT ?
  `).all(normalized, projectId, Math.min(Math.max(limit, 1), 200)) as unknown as Array<Omit<ContextSearchHit, 'approvedRoot' | 'pinned' | 'excluded'> & {
    approvedRoot: number;
    pinned: number;
    excluded: number;
  }>;
  return rows.map((row) => ({
    ...row,
    rank: Number(row.rank),
    approvedRoot: Boolean(row.approvedRoot),
    pinned: Boolean(row.pinned),
    excluded: Boolean(row.excluded)
  }));
}

export function setContextSourceState(sourceId: string, patch: { pinned?: boolean; excluded?: boolean }) {
  const database = db();
  const source = database.prepare('SELECT id, pinned, excluded FROM context_sources WHERE id = ?')
    .get(sourceId) as SourceStateRow | undefined;
  if (!source) throw new Error(`Context source not found: ${sourceId}`);
  const pinned = patch.pinned === undefined ? Boolean(source.pinned) : Boolean(patch.pinned);
  const excluded = patch.excluded === undefined ? Boolean(source.excluded) : Boolean(patch.excluded);
  const now = timestamp();
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('UPDATE context_sources SET pinned = ?, excluded = ?, updated_at = ? WHERE id = ?')
      .run(pinned ? 1 : 0, excluded ? 1 : 0, now, sourceId);
    database.prepare('UPDATE context_documents SET pinned = ?, excluded = ? WHERE source_id = ?')
      .run(pinned ? 1 : 0, excluded ? 1 : 0, sourceId);
    database.prepare('UPDATE context_chunks SET pinned = ?, excluded = ? WHERE source_id = ?')
      .run(pinned ? 1 : 0, excluded ? 1 : 0, sourceId);
    deleteSourceIndex(database, sourceId);
    if (!excluded) {
      const chunks = database.prepare('SELECT id, project_id, source_path, content FROM context_chunks WHERE source_id = ? ORDER BY ordinal')
        .all(sourceId) as unknown as Array<{ id: string; project_id: string; source_path: string; content: string }>;
      for (const chunk of chunks) {
        database.prepare('INSERT INTO context_chunks_fts(chunk_id, project_id, source_path, content) VALUES (?, ?, ?, ?)')
          .run(chunk.id, chunk.project_id, chunk.source_path, chunk.content);
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { sourceId, pinned, excluded, updatedAt: now };
}

export function contextProjectState(projectId: string) {
  const database = db();
  const row = getProjectRow(database, projectId);
  if (!row) return null;
  const sources = database.prepare(`
    SELECT id, source_path AS sourcePath, source_kind AS kind, source_format AS format,
      size_bytes AS sizeBytes, freshness_at AS freshnessAt, content_hash AS contentHash,
      git_revision AS gitRevision, approved_root AS approvedRoot, pinned, excluded
    FROM context_sources WHERE project_id = ?
    ORDER BY source_path COLLATE NOCASE ASC
  `).all(projectId) as unknown as Array<Record<string, SQLInputValue>>;
  const lastScan = database.prepare(`
    SELECT id, status, root_path AS rootPath, git_revision AS gitRevision,
      files_discovered AS filesDiscovered, files_indexed AS filesIndexed,
      files_excluded AS filesExcluded, chunks_indexed AS chunksIndexed,
      error, started_at AS startedAt, completed_at AS completedAt
    FROM context_scan_events WHERE project_id = ? ORDER BY started_at DESC LIMIT 1
  `).get(projectId);
  return {
    project: projectFromRow(row),
    sources: sources.map((source) => ({
      ...source,
      approvedRoot: Boolean(source.approvedRoot),
      pinned: Boolean(source.pinned),
      excluded: Boolean(source.excluded)
    })),
    lastScan: lastScan ?? null,
    dbPath: contextDockDbPath(),
    localOnly: true
  };
}

export function resetContextDockDbForTests() {
  for (const database of databases.values()) database.close();
  databases.clear();
}
