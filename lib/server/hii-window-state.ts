import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type HiiWindowStatus = 'open' | 'minimized' | 'maximized' | 'closed';

export type HiiWindowState = {
  id: string;
  workspaceId: string;
  route: string;
  title: string;
  status: HiiWindowStatus;
  bounds: { x: number; y: number; width: number; height: number };
  scroll: { x: number; y: number };
  viewport: { x: number; y: number; zoom: number };
  focusedNodeId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type WindowStateRow = {
  id: string;
  workspace_id: string;
  route: string;
  title: string;
  status: HiiWindowStatus;
  bounds_json: string;
  scroll_json: string;
  viewport_json: string;
  focused_node_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type WindowStatePage = {
  windows: HiiWindowState[];
  page: {
    limit: number;
    total: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};

export class WindowStateConflictError extends Error {
  readonly current: HiiWindowState;

  constructor(current: HiiWindowState) {
    super(`Window state revision conflict for ${current.id}.`);
    this.name = 'WindowStateConflictError';
    this.current = current;
  }
}

const databases = new Map<string, DatabaseSync>();
const statuses: HiiWindowStatus[] = ['open', 'minimized', 'maximized', 'closed'];

export function windowStateStorePath() {
  return process.env.HII_DB_PATH || path.join(process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii'), 'hii.db');
}

function database() {
  const file = windowStateStorePath();
  const existing = databases.get(file);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const opened = new DatabaseSync(file);
  opened.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(opened);
  databases.set(file, opened);
  return opened;
}

function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS hii_window_states (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      route TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'minimized', 'maximized', 'closed')),
      bounds_json TEXT NOT NULL,
      scroll_json TEXT NOT NULL,
      viewport_json TEXT NOT NULL,
      focused_node_id TEXT,
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hii_window_states_workspace_updated
      ON hii_window_states(workspace_id, updated_at DESC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_hii_window_states_status_updated
      ON hii_window_states(status, updated_at DESC, id ASC);

    CREATE TABLE IF NOT EXISTS hii_window_state_events (
      id TEXT PRIMARY KEY,
      window_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (window_id) REFERENCES hii_window_states(id) ON DELETE CASCADE,
      UNIQUE(window_id, revision)
    );

    CREATE INDEX IF NOT EXISTS idx_hii_window_state_events_window
      ON hii_window_state_events(window_id, revision DESC);

    INSERT OR IGNORE INTO schema_migrations(version) VALUES ('hii-window-state-v1');
  `);
}

function clamp(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function text(value: unknown, maxLength: number) {
  return String(value ?? '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\b\r]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)=)([^\s&]+)/gi, '$1[redacted]')
    .replace(/((?:OPENAI|ANTHROPIC|SUPABASE|STRIPE|GITHUB|VERCEL|CLOUDFLARE|AWS)[A-Z0-9_]*=)([^\s&]+)/g, '$1[redacted]')
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, '$1[redacted]')
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[redacted]')
    .trim()
    .slice(0, maxLength);
}

function identifier(value: unknown, field: string) {
  const normalized = text(value, 128);
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(normalized)) {
    throw new Error(`${field} must contain only letters, numbers, colons, dots, underscores, or hyphens.`);
  }
  return normalized;
}

function normalizeRoute(value: unknown, fallback = '/') {
  const route = text(value, 256) || fallback;
  return route.startsWith('/') ? route : `/${route}`;
}

function normalizeStatus(value: unknown, fallback: HiiWindowStatus): HiiWindowStatus {
  return statuses.includes(value as HiiWindowStatus) ? (value as HiiWindowStatus) : fallback;
}

function normalizeBounds(value: unknown, current?: HiiWindowState['bounds']) {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    x: clamp(raw.x, current?.x ?? 0, -100_000, 100_000),
    y: clamp(raw.y, current?.y ?? 0, -100_000, 100_000),
    width: clamp(raw.width, current?.width ?? 1280, 160, 20_000),
    height: clamp(raw.height, current?.height ?? 800, 100, 20_000)
  };
}

function normalizeScroll(value: unknown, current?: HiiWindowState['scroll']) {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    x: clamp(raw.x, current?.x ?? 0, 0, 10_000_000),
    y: clamp(raw.y, current?.y ?? 0, 0, 10_000_000)
  };
}

function normalizeViewport(value: unknown, current?: HiiWindowState['viewport']) {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    x: clamp(raw.x, current?.x ?? 0, -1_000_000, 1_000_000),
    y: clamp(raw.y, current?.y ?? 0, -1_000_000, 1_000_000),
    zoom: clamp(raw.zoom, current?.zoom ?? 1, 0.05, 8)
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stateFromRow(row: WindowStateRow): HiiWindowState {
  const state: HiiWindowState = {
    id: row.id,
    workspaceId: row.workspace_id,
    route: row.route,
    title: row.title,
    status: row.status,
    bounds: parseJson(row.bounds_json, { x: 0, y: 0, width: 1280, height: 800 }),
    scroll: parseJson(row.scroll_json, { x: 0, y: 0 }),
    viewport: parseJson(row.viewport_json, { x: 0, y: 0, zoom: 1 }),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (row.focused_node_id) state.focusedNodeId = row.focused_node_id;
  return state;
}

function selectWindow(id: string, db = database()) {
  const row = db.prepare('SELECT * FROM hii_window_states WHERE id = ?').get(id) as WindowStateRow | undefined;
  return row ? stateFromRow(row) : null;
}

function decodeCursor(cursor: string | undefined) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { updatedAt?: unknown; id?: unknown };
    if (typeof parsed.updatedAt !== 'string' || typeof parsed.id !== 'string') throw new Error('invalid cursor');
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    throw new Error('Invalid window state cursor.');
  }
}

function encodeCursor(state: HiiWindowState) {
  return Buffer.from(JSON.stringify({ updatedAt: state.updatedAt, id: state.id }), 'utf8').toString('base64url');
}

export async function getWindowState(id: string) {
  return selectWindow(identifier(id, 'Window id'));
}

export async function listWindowStates(options: {
  workspaceId?: string;
  includeClosed?: boolean;
  limit?: number;
  cursor?: string;
} = {}): Promise<WindowStatePage> {
  const workspaceId = options.workspaceId ? identifier(options.workspaceId, 'Workspace id') : null;
  const limit = Math.floor(clamp(options.limit, 40, 1, 100));
  const cursor = decodeCursor(options.cursor);
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (workspaceId) {
    where.push('workspace_id = ?');
    values.push(workspaceId);
  }
  if (!options.includeClosed) where.push("status != 'closed'");
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((database().prepare(`SELECT COUNT(*) AS count FROM hii_window_states ${filter}`).get(...values) as { count: number }).count);

  const pageWhere = [...where];
  const pageValues = [...values];
  if (cursor) {
    pageWhere.push('(updated_at < ? OR (updated_at = ? AND id > ?))');
    pageValues.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }
  const rows = database()
    .prepare(`
      SELECT * FROM hii_window_states
      ${pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, id ASC
      LIMIT ?
    `)
    .all(...pageValues, limit + 1) as unknown as WindowStateRow[];
  const hasMore = rows.length > limit;
  const windows = rows.slice(0, limit).map(stateFromRow);
  return {
    windows,
    page: {
      limit,
      total,
      hasMore,
      nextCursor: hasMore && windows.length ? encodeCursor(windows[windows.length - 1]) : null
    }
  };
}

export async function upsertWindowState(input: unknown): Promise<HiiWindowState> {
  if (!input || typeof input !== 'object') throw new Error('Window state body is required.');
  const raw = input as Record<string, unknown>;
  const id = identifier(raw.id, 'Window id');
  if (raw.baseRevision !== undefined && (!Number.isInteger(raw.baseRevision) || (raw.baseRevision as number) < 0)) {
    throw new Error('baseRevision must be a non-negative integer.');
  }

  const db = database();
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = selectWindow(id, db);
    if (raw.baseRevision !== undefined && raw.baseRevision !== current?.revision) {
      if (current) throw new WindowStateConflictError(current);
      if (raw.baseRevision !== 0) throw new Error('baseRevision must be 0 when creating a window.');
    }

    const now = new Date().toISOString();
    const focusedNodeId = raw.focusedNodeId === null ? '' : text(raw.focusedNodeId ?? current?.focusedNodeId, 128);
    const state: HiiWindowState = {
      id,
      workspaceId: raw.workspaceId !== undefined
        ? identifier(raw.workspaceId, 'Workspace id')
        : current?.workspaceId ?? 'default',
      route: normalizeRoute(raw.route, current?.route),
      title: text(raw.title ?? current?.title ?? 'HII', 160) || 'HII',
      status: normalizeStatus(raw.status, current?.status ?? 'open'),
      bounds: normalizeBounds(raw.bounds, current?.bounds),
      scroll: normalizeScroll(raw.scroll, current?.scroll),
      viewport: normalizeViewport(raw.viewport, current?.viewport),
      revision: (current?.revision ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    };
    if (focusedNodeId) state.focusedNodeId = focusedNodeId;

    db.prepare(`
      INSERT INTO hii_window_states(
        id, workspace_id, route, title, status, bounds_json, scroll_json,
        viewport_json, focused_node_id, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        route = excluded.route,
        title = excluded.title,
        status = excluded.status,
        bounds_json = excluded.bounds_json,
        scroll_json = excluded.scroll_json,
        viewport_json = excluded.viewport_json,
        focused_node_id = excluded.focused_node_id,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `).run(
      state.id,
      state.workspaceId,
      state.route,
      state.title,
      state.status,
      JSON.stringify(state.bounds),
      JSON.stringify(state.scroll),
      JSON.stringify(state.viewport),
      state.focusedNodeId ?? null,
      state.revision,
      state.createdAt,
      state.updatedAt
    );
    db.prepare(`
      INSERT INTO hii_window_state_events(id, window_id, workspace_id, revision, state_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), state.id, state.workspaceId, state.revision, JSON.stringify(state), state.updatedAt);
    db.exec('COMMIT');
    return state;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function closeWindowState(id: string, baseRevision?: number) {
  const current = await getWindowState(id);
  if (!current) throw new Error(`Window state not found: ${id}`);
  return upsertWindowState({ id, status: 'closed', baseRevision });
}
