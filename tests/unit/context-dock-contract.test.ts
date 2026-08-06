import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const contextDock = readFileSync(resolve(root, 'lib/server/hii-context-dock.ts'), 'utf8');
const smoke = readFileSync(resolve(root, 'scripts/hii-contextdock-smoke.mjs'), 'utf8');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

describe('Context Dock foundation contract', () => {
  it('uses the canonical self-migrating HII SQLite store', () => {
    expect(contextDock).toContain("from 'node:sqlite'");
    expect(contextDock).toContain("'.hii'), 'hii.db'");
    expect(contextDock).toContain('PRAGMA journal_mode = WAL');
    expect(contextDock).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
    expect(contextDock).toContain("VALUES ('context-dock-v1')");
    for (const table of [
      'context_projects',
      'context_sources',
      'context_documents',
      'context_chunks',
      'context_scan_events'
    ]) expect(contextDock).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
  });

  it('keeps inventory local, explicit, deterministic, and provenance preserving', () => {
    expect(contextDock).toContain("input.approved !== true");
    expect(contextDock).toContain("entry.isSymbolicLink()");
    expect(contextDock).toContain("localeCompare(right.name, 'en')");
    expect(contextDock).toContain("execFileSync('git', ['-C', rootPath, 'rev-parse', 'HEAD']");
    expect(contextDock).toContain('source_path TEXT NOT NULL');
    expect(contextDock).toContain('line_start INTEGER NOT NULL');
    expect(contextDock).toContain('page_start INTEGER');
    expect(contextDock).toContain('freshness_at TEXT NOT NULL');
    expect(contextDock).toContain('content_hash TEXT NOT NULL');
    expect(contextDock).toContain('git_revision TEXT');
    expect(contextDock).toContain('approved_root INTEGER NOT NULL');
    expect(contextDock).toContain('pinned INTEGER NOT NULL');
    expect(contextDock).toContain('excluded INTEGER NOT NULL');
    expect(contextDock).not.toMatch(/fetch\(|https?:\/\//);
    expect(contextDock.toLowerCase()).not.toContain('embedding');
  });

  it('provides deterministic FTS5 search with provenance on every hit', () => {
    expect(contextDock).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS context_chunks_fts USING fts5');
    expect(contextDock).toContain('export function searchContext');
    expect(contextDock).toContain('ORDER BY c.pinned DESC, rank ASC, c.source_path COLLATE NOCASE ASC, c.line_start ASC, c.id ASC');
    for (const field of [
      'rootPath', 'sourcePath', 'lineStart', 'lineEnd', 'pageStart', 'pageEnd',
      'freshnessAt', 'contentHash', 'gitRevision', 'approvedRoot', 'pinned', 'excluded'
    ]) expect(contextDock).toContain(`${field}:`);
  });

  it('can remove derived project data without mutating the approved source root', () => {
    expect(contextDock).toContain('export function deleteContextProjectDerivedData');
    expect(contextDock).toContain("DELETE FROM context_chunks_fts WHERE project_id = ?");
    expect(contextDock).toContain("DELETE FROM context_projects WHERE id = ?");
    expect(contextDock).toContain('sourceFilesTouched: false');
  });

  it('wires an isolated behavioral smoke check', () => {
    expect(packageJson.scripts['hii:contextdock:check']).toBe('node --experimental-strip-types scripts/hii-contextdock-smoke.mjs');
    expect(smoke).toContain('process.env.HII_DB_PATH');
    expect(smoke).toContain('fs.mkdtempSync');
    expect(smoke).toContain('deterministic provenance hits + pin/exclusion state verified');
    expect(smoke).toContain('derived project index deletion preserves source files verified');
  });
});
