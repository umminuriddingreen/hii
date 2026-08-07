import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ObjectProjection,
  OperationalObject,
  OperationalOperation,
  OperationalRelation,
  OperationalSpaceSnapshot
} from '../operational-graph/types.ts';
import type { WorkspaceDoc, WorkspaceNode } from '../workspace/types.ts';

const databases = new Map<string, DatabaseSync>();

export function operationalObjectDbPath() {
  return process.env.HII_DB_PATH || path.join(process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii'), 'hii.db');
}

function database() {
  const file = operationalObjectDbPath();
  const existing = databases.get(file);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = new DatabaseSync(file);
  next.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(next);
  databases.set(file, next);
  return next;
}

function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS operational_objects (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      type TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      properties_json TEXT NOT NULL DEFAULT '{}',
      provenance_json TEXT NOT NULL DEFAULT '{}',
      owner_actor_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_operational_objects_space ON operational_objects(space_id, deleted_at, type);

    CREATE TABLE IF NOT EXISTS operational_relations (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      type TEXT NOT NULL,
      from_object_id TEXT NOT NULL,
      to_object_id TEXT NOT NULL,
      properties_json TEXT NOT NULL DEFAULT '{}',
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY (from_object_id) REFERENCES operational_objects(id),
      FOREIGN KEY (to_object_id) REFERENCES operational_objects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_operational_relations_space ON operational_relations(space_id, deleted_at, type);
    CREATE INDEX IF NOT EXISTS idx_operational_relations_from ON operational_relations(from_object_id);
    CREATE INDEX IF NOT EXISTS idx_operational_relations_to ON operational_relations(to_object_id);

    CREATE TABLE IF NOT EXISTS operational_operations (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      device_id TEXT,
      type TEXT NOT NULL,
      target_id TEXT,
      base_version INTEGER,
      lamport INTEGER NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      authority_grant_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_operations_lamport ON operational_operations(space_id, lamport);

    CREATE TABLE IF NOT EXISTS object_projections (
      space_id TEXT NOT NULL,
      object_id TEXT NOT NULL,
      projection TEXT NOT NULL,
      state_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (space_id, object_id, projection),
      FOREIGN KEY (object_id) REFERENCES operational_objects(id) ON DELETE CASCADE
    );

    INSERT OR IGNORE INTO schema_migrations(version) VALUES ('operational-objects-v1');
  `);
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function objectId(spaceId: string, legacyId: string) {
  return `workspace:${spaceId}:object:${legacyId}`;
}

function relationId(spaceId: string, legacyId: string) {
  return `workspace:${spaceId}:relation:${legacyId}`;
}

function semanticProperties(node: WorkspaceNode) {
  return {
    legacyId: node.id,
    nodeType: node.type,
    payload: node.payload,
    ...(node.object ? { spatialObject: node.object } : {}),
    ...(node.objectRef ? { externalObjectRef: node.objectRef } : {}),
    ...(node.frameId ? { frameId: node.frameId } : {})
  };
}

/**
 * Mirror a legacy workspace document into the universal object graph.
 *
 * The JSON workspace remains intact as the rollback/export source during the
 * transition. Replaying the same workspace revision is idempotent.
 */
export function projectWorkspaceIntoOperationalGraph(
  spaceId: string,
  workspace: WorkspaceDoc,
  actorId = 'hii:workspace-store'
) {
  const db = database();
  const now = workspace.updatedAt || new Date().toISOString();
  const source = { system: 'hii-workspace-json', spaceId, revision: workspace.revision };
  db.exec('BEGIN IMMEDIATE');
  try {
    const activeObjectIds = workspace.nodes.map((node) => objectId(spaceId, node.id));
    const activeRelationIds = workspace.links.map((link) => relationId(spaceId, link.id));
    const upsertObject = db.prepare(`
      INSERT INTO operational_objects
        (id, space_id, type, schema_version, properties_json, provenance_json, owner_actor_id, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        properties_json = excluded.properties_json,
        provenance_json = excluded.provenance_json,
        owner_actor_id = excluded.owner_actor_id,
        updated_at = excluded.updated_at,
        deleted_at = NULL
    `);
    const upsertProjection = db.prepare(`
      INSERT INTO object_projections (space_id, object_id, projection, state_json, updated_at)
      VALUES (?, ?, 'workspace-spatial', ?, ?)
      ON CONFLICT(space_id, object_id, projection) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `);
    for (const node of workspace.nodes) {
      const id = objectId(spaceId, node.id);
      upsertObject.run(
        id,
        spaceId,
        node.object?.kind || node.type,
        JSON.stringify(semanticProperties(node)),
        JSON.stringify(source),
        node.object?.owner || actorId,
        node.createdAt,
        node.updatedAt,
      );
      upsertProjection.run(
        spaceId,
        id,
        JSON.stringify({ x: node.x, y: node.y, w: node.w, h: node.h, z: node.z }),
        node.updatedAt
      );
    }

    const upsertRelation = db.prepare(`
      INSERT INTO operational_relations
        (id, space_id, type, from_object_id, to_object_id, properties_json, provenance_json, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        from_object_id = excluded.from_object_id,
        to_object_id = excluded.to_object_id,
        properties_json = excluded.properties_json,
        provenance_json = excluded.provenance_json,
        updated_at = excluded.updated_at,
        deleted_at = NULL
    `);
    for (const link of workspace.links) {
      upsertRelation.run(
        relationId(spaceId, link.id),
        spaceId,
        link.label?.trim() || 'CONNECTED_TO',
        objectId(spaceId, link.fromId),
        objectId(spaceId, link.toId),
        JSON.stringify({ legacyId: link.id, arrow: link.arrow || 'end' }),
        JSON.stringify(source),
        now,
        now
      );
    }

    if (activeObjectIds.length) {
      const placeholders = activeObjectIds.map(() => '?').join(', ');
      db.prepare(`UPDATE operational_objects SET deleted_at = ?, updated_at = ? WHERE space_id = ? AND id LIKE ? AND deleted_at IS NULL AND id NOT IN (${placeholders})`)
        .run(now, now, spaceId, `workspace:${spaceId}:object:%`, ...activeObjectIds);
    } else {
      db.prepare('UPDATE operational_objects SET deleted_at = ?, updated_at = ? WHERE space_id = ? AND id LIKE ? AND deleted_at IS NULL')
        .run(now, now, spaceId, `workspace:${spaceId}:object:%`);
    }
    if (activeRelationIds.length) {
      const placeholders = activeRelationIds.map(() => '?').join(', ');
      db.prepare(`UPDATE operational_relations SET deleted_at = ?, updated_at = ? WHERE space_id = ? AND id LIKE ? AND deleted_at IS NULL AND id NOT IN (${placeholders})`)
        .run(now, now, spaceId, `workspace:${spaceId}:relation:%`, ...activeRelationIds);
    } else {
      db.prepare('UPDATE operational_relations SET deleted_at = ?, updated_at = ? WHERE space_id = ? AND id LIKE ? AND deleted_at IS NULL')
        .run(now, now, spaceId, `workspace:${spaceId}:relation:%`);
    }

    const operationId = `workspace:${spaceId}:revision:${workspace.revision}`;
    const operationExists = db.prepare('SELECT 1 FROM operational_operations WHERE id = ?').get(operationId);
    if (!operationExists) {
      const nextLamport = Number(
        (db.prepare('SELECT COALESCE(MAX(lamport), 0) + 1 AS value FROM operational_operations WHERE space_id = ?').get(spaceId) as { value: number }).value
      );
      db.prepare(`
        INSERT INTO operational_operations
          (id, space_id, actor_id, type, target_id, base_version, lamport, payload_json, created_at)
        VALUES (?, ?, ?, 'PROJECT_WORKSPACE_REVISION', ?, ?, ?, ?, ?)
      `).run(
        operationId,
        spaceId,
        actorId,
        `workspace:${spaceId}`,
        Math.max(0, workspace.revision - 1),
        nextLamport,
        JSON.stringify({ revision: workspace.revision, objectCount: workspace.nodes.length, relationCount: workspace.links.length }),
        now
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

type ObjectRow = { id: string; space_id: string; type: string; schema_version: number; properties_json: string; provenance_json: string; owner_actor_id: string | null; created_at: string; updated_at: string; deleted_at: string | null };
type RelationRow = { id: string; space_id: string; type: string; from_object_id: string; to_object_id: string; properties_json: string; provenance_json: string; created_at: string; updated_at: string; deleted_at: string | null };
type ProjectionRow = { space_id: string; object_id: string; projection: string; state_json: string; updated_at: string };
type OperationRow = { id: string; space_id: string; actor_id: string; device_id: string | null; type: string; target_id: string | null; base_version: number | null; lamport: number; payload_json: string; authority_grant_id: string | null; created_at: string };

export function readOperationalSpace(spaceId: string): OperationalSpaceSnapshot {
  const db = database();
  const objects = db.prepare('SELECT * FROM operational_objects WHERE space_id = ? ORDER BY created_at, id').all(spaceId) as unknown as ObjectRow[];
  const relations = db.prepare('SELECT * FROM operational_relations WHERE space_id = ? ORDER BY created_at, id').all(spaceId) as unknown as RelationRow[];
  const projections = db.prepare('SELECT * FROM object_projections WHERE space_id = ? ORDER BY object_id, projection').all(spaceId) as unknown as ProjectionRow[];
  const operations = db.prepare('SELECT * FROM operational_operations WHERE space_id = ? ORDER BY lamport, id').all(spaceId) as unknown as OperationRow[];
  return {
    spaceId,
    objects: objects.map((row): OperationalObject => ({ id: row.id, spaceId: row.space_id, type: row.type, schemaVersion: row.schema_version, properties: parseRecord(row.properties_json), provenance: parseRecord(row.provenance_json), ownerActorId: row.owner_actor_id, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at })),
    relations: relations.map((row): OperationalRelation => ({ id: row.id, spaceId: row.space_id, type: row.type, fromObjectId: row.from_object_id, toObjectId: row.to_object_id, properties: parseRecord(row.properties_json), provenance: parseRecord(row.provenance_json), createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at })),
    projections: projections.map((row): ObjectProjection => ({ spaceId: row.space_id, objectId: row.object_id, projection: row.projection, state: parseRecord(row.state_json), updatedAt: row.updated_at })),
    operations: operations.map((row): OperationalOperation => ({ id: row.id, spaceId: row.space_id, actorId: row.actor_id, deviceId: row.device_id, type: row.type, targetId: row.target_id, baseVersion: row.base_version, lamport: row.lamport, payload: parseRecord(row.payload_json), authorityGrantId: row.authority_grant_id, createdAt: row.created_at }))
  };
}

export function resetOperationalObjectStoreForTests() {
  for (const db of databases.values()) db.close();
  databases.clear();
}
