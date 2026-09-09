import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type CanonicalSource,
  type ObjectProjection,
  type OperationalObject,
  type OperationalOperation,
  type OperationalRelation,
  type OperationalSpaceSnapshot,
  type ProvenanceClass,
  type RelationType
} from '../operational-graph/types.ts';
import { workspaceNodeTransform3D, type WorkspaceDoc, type WorkspaceNode } from '../workspace/types.ts';

const databases = new Map<string, DatabaseSync>();

export function operationalObjectDbPath() {
  return process.env.HII_DB_PATH || path.join(process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii'), 'hii.db');
}

export function operationalDatabase() {
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

const database = operationalDatabase;

/** Columns already present, so a rerun of an additive migration is a no-op. */
function columnNames(db: DatabaseSync, table: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function addColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  if (columnNames(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

  // --- v2: versioned mutations ---------------------------------------------
  // Purely additive with defaults, so an existing v1 database keeps every row
  // and every id. Each ALTER is guarded by the column check above, which is
  // what makes rerunning the migration a no-op rather than an error.
  addColumn(db, 'operational_objects', 'semantic_version', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'operational_objects', 'canonical_source', "TEXT NOT NULL DEFAULT 'workspace-json'");
  addColumn(db, 'operational_objects', 'provenance_class', "TEXT NOT NULL DEFAULT 'migration'");

  addColumn(db, 'operational_relations', 'relation_version', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'operational_relations', 'canonical_source', "TEXT NOT NULL DEFAULT 'workspace-json'");
  addColumn(db, 'operational_relations', 'provenance_class', "TEXT NOT NULL DEFAULT 'migration'");

  addColumn(db, 'object_projections', 'projection_version', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'object_projections', 'canonical_source', "TEXT NOT NULL DEFAULT 'workspace-json'");
  addColumn(db, 'object_projections', 'deleted_at', 'TEXT');

  addColumn(db, 'operational_operations', 'result_version', 'INTEGER');
  addColumn(db, 'operational_operations', 'idempotency_key', 'TEXT');
  addColumn(db, 'operational_operations', 'operation_hash', 'TEXT');
  addColumn(db, 'operational_operations', 'provenance_class', 'TEXT');
  addColumn(db, 'operational_operations', 'authority_json', "TEXT NOT NULL DEFAULT '{}'");
  addColumn(db, 'operational_operations', 'interaction_id', 'TEXT');
  addColumn(db, 'operational_operations', 'interaction_sequence', 'INTEGER');
  addColumn(db, 'operational_operations', 'causation_event_id', 'TEXT');

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_operations_idempotency
      ON operational_operations(space_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_operations_interaction_sequence
      ON operational_operations(interaction_id, interaction_sequence)
      WHERE interaction_id IS NOT NULL AND interaction_sequence IS NOT NULL;
    INSERT OR IGNORE INTO schema_migrations(version) VALUES ('operational-objects-v2-versioned-mutations');
  `);
}

export function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function workspaceObjectId(spaceId: string, legacyId: string) {
  return `workspace:${spaceId}:object:${legacyId}`;
}

export function workspaceRelationId(spaceId: string, legacyId: string) {
  return `workspace:${spaceId}:relation:${legacyId}`;
}

const objectId = workspaceObjectId;
const relationId = workspaceRelationId;

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
 * Where an object sits, in the only domain allowed to change when it moves.
 *
 * `projectionVersion` is bumped by presentation alone, so a drag - in 2D or in
 * 3D - must never touch `semanticVersion`. That split is what keeps a move from
 * invalidating the semantic context an approved run was reviewed against.
 *
 * `z` here is paint order, not depth. Depth is `transform.position.z`, and the
 * two are unrelated: reading paint order as depth would scatter every card
 * along the view axis by how recently it was touched.
 */
function projectionState(node: WorkspaceNode) {
  const transform = workspaceNodeTransform3D(node);
  return {
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
    z: node.z,
    rotation: Number.isFinite(node.rotation) ? node.rotation : 0,
    position: transform.position,
    quaternion: transform.rotation,
    scale: transform.scale,
    size: transform.size
  };
}

/**
 * A stable string for comparing two versions of the same record.
 *
 * Key order in a JS object follows insertion, and a workspace round-trip can
 * reorder it, so a raw `JSON.stringify` comparison would report a change where
 * there is none and bump the version on every save.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/**
 * Mirror a legacy workspace document into the universal object graph.
 *
 * The JSON workspace remains the authority and the rollback/export source during
 * the transition. Reconciliation is deterministic: a version is bumped only when
 * that version's own domain actually changed, so replaying a revision is a
 * no-op, dragging a node leaves its semantic version alone, and editing its
 * content leaves its projection version alone.
 */
export function projectWorkspaceIntoOperationalGraph(
  spaceId: string,
  workspace: WorkspaceDoc,
  actorId = 'hii:workspace-store'
) {
  const db = database();
  const now = workspace.updatedAt || new Date().toISOString();
  const source = { system: 'hii-workspace-json', spaceId, revision: workspace.revision };
  const sourceJson = JSON.stringify(source);
  db.exec('BEGIN IMMEDIATE');
  try {
    const activeObjectIds = workspace.nodes.map((node) => objectId(spaceId, node.id));
    const activeRelationIds = workspace.links.map((link) => relationId(spaceId, link.id));

    const existingObjects = new Map(
      (
        db
          .prepare(
            'SELECT id, type, properties_json, owner_actor_id, semantic_version, deleted_at FROM operational_objects WHERE space_id = ?'
          )
          .all(spaceId) as unknown as {
          id: string;
          type: string;
          properties_json: string;
          owner_actor_id: string | null;
          semantic_version: number;
          deleted_at: string | null;
        }[]
      ).map((row) => [row.id, row])
    );
    const existingProjections = new Map(
      (
        db
          .prepare(
            "SELECT object_id, state_json, projection_version, deleted_at FROM object_projections WHERE space_id = ? AND projection = 'workspace-spatial'"
          )
          .all(spaceId) as unknown as {
          object_id: string;
          state_json: string;
          projection_version: number;
          deleted_at: string | null;
        }[]
      ).map((row) => [row.object_id, row])
    );

    const insertObject = db.prepare(`
      INSERT INTO operational_objects
        (id, space_id, type, schema_version, semantic_version, canonical_source, provenance_class,
         properties_json, provenance_json, owner_actor_id, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, 1, ?, 'workspace-json', 'authored', ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        semantic_version = excluded.semantic_version,
        canonical_source = 'workspace-json',
        provenance_class = 'authored',
        properties_json = excluded.properties_json,
        provenance_json = excluded.provenance_json,
        owner_actor_id = excluded.owner_actor_id,
        updated_at = excluded.updated_at,
        deleted_at = NULL
    `);
    const upsertProjection = db.prepare(`
      INSERT INTO object_projections
        (space_id, object_id, projection, projection_version, canonical_source, state_json, updated_at, deleted_at)
      VALUES (?, ?, 'workspace-spatial', ?, 'workspace-json', ?, ?, NULL)
      ON CONFLICT(space_id, object_id, projection) DO UPDATE SET
        projection_version = excluded.projection_version,
        canonical_source = 'workspace-json',
        state_json = excluded.state_json,
        updated_at = excluded.updated_at,
        deleted_at = NULL
    `);

    for (const node of workspace.nodes) {
      const id = objectId(spaceId, node.id);
      const type = node.object?.kind || node.type;
      const owner = node.object?.owner || actorId;
      const properties = canonicalJson(semanticProperties(node));
      const previous = existingObjects.get(id);
      const semanticChanged =
        !previous ||
        previous.deleted_at !== null ||
        previous.type !== type ||
        previous.owner_actor_id !== owner ||
        canonicalJson(parseRecord(previous.properties_json)) !== properties;
      const semanticVersion = previous
        ? previous.semantic_version + (semanticChanged ? 1 : 0)
        : 1;
      insertObject.run(
        id,
        spaceId,
        type,
        semanticVersion,
        properties,
        sourceJson,
        owner,
        node.createdAt,
        node.updatedAt
      );

      const state = canonicalJson(projectionState(node));
      const previousProjection = existingProjections.get(id);
      const projectionChanged =
        !previousProjection ||
        previousProjection.deleted_at !== null ||
        canonicalJson(parseRecord(previousProjection.state_json)) !== state;
      upsertProjection.run(
        spaceId,
        id,
        previousProjection
          ? previousProjection.projection_version + (projectionChanged ? 1 : 0)
          : 1,
        state,
        node.updatedAt
      );
    }

    const existingRelations = new Map(
      (
        db
          .prepare(
            'SELECT id, type, properties_json, from_object_id, to_object_id, relation_version, deleted_at FROM operational_relations WHERE space_id = ?'
          )
          .all(spaceId) as unknown as {
          id: string;
          type: string;
          properties_json: string;
          from_object_id: string;
          to_object_id: string;
          relation_version: number;
          deleted_at: string | null;
        }[]
      ).map((row) => [row.id, row])
    );
    const upsertRelation = db.prepare(`
      INSERT INTO operational_relations
        (id, space_id, type, from_object_id, to_object_id, relation_version, canonical_source,
         provenance_class, properties_json, provenance_json, created_at, updated_at, deleted_at)
      VALUES (?, ?, 'AUTHORED_LINK', ?, ?, ?, 'workspace-json', 'authored', ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        type = 'AUTHORED_LINK',
        from_object_id = excluded.from_object_id,
        to_object_id = excluded.to_object_id,
        relation_version = excluded.relation_version,
        canonical_source = 'workspace-json',
        provenance_class = 'authored',
        properties_json = excluded.properties_json,
        provenance_json = excluded.provenance_json,
        updated_at = excluded.updated_at,
        deleted_at = NULL
    `);
    for (const link of workspace.links) {
      const id = relationId(spaceId, link.id);
      const from = objectId(spaceId, link.fromId);
      const to = objectId(spaceId, link.toId);
      // A user-drawn arrow is not verified provenance, whatever it is labelled.
      // The label is preserved as data; it never becomes the relation type, or a
      // user could type "VERIFIED_BY" on a line and forge proof.
      const properties = canonicalJson({
        legacyId: link.id,
        arrow: link.arrow || 'end',
        ...(link.label?.trim() ? { authoredLabel: link.label.trim() } : {})
      });
      const previous = existingRelations.get(id);
      const changed =
        !previous ||
        previous.deleted_at !== null ||
        previous.type !== 'AUTHORED_LINK' ||
        previous.from_object_id !== from ||
        previous.to_object_id !== to ||
        canonicalJson(parseRecord(previous.properties_json)) !== properties;
      upsertRelation.run(
        id,
        spaceId,
        from,
        to,
        previous ? previous.relation_version + (changed ? 1 : 0) : 1,
        properties,
        sourceJson,
        now,
        now
      );
    }

    // Records the workspace no longer contains become tombstones. Only
    // workspace-owned records: a graph-native object was never in the JSON and
    // must not be deleted for being absent from it.
    if (activeObjectIds.length) {
      const placeholders = activeObjectIds.map(() => '?').join(', ');
      db.prepare(
        `UPDATE operational_objects SET deleted_at = ?, updated_at = ?, semantic_version = semantic_version + 1 WHERE space_id = ? AND canonical_source = 'workspace-json' AND id LIKE ? AND deleted_at IS NULL AND id NOT IN (${placeholders})`
      ).run(now, now, spaceId, `workspace:${spaceId}:object:%`, ...activeObjectIds);
    } else {
      db.prepare(
        "UPDATE operational_objects SET deleted_at = ?, updated_at = ?, semantic_version = semantic_version + 1 WHERE space_id = ? AND canonical_source = 'workspace-json' AND id LIKE ? AND deleted_at IS NULL"
      ).run(now, now, spaceId, `workspace:${spaceId}:object:%`);
    }
    if (activeRelationIds.length) {
      const placeholders = activeRelationIds.map(() => '?').join(', ');
      db.prepare(
        `UPDATE operational_relations SET deleted_at = ?, updated_at = ?, relation_version = relation_version + 1 WHERE space_id = ? AND canonical_source = 'workspace-json' AND id LIKE ? AND deleted_at IS NULL AND id NOT IN (${placeholders})`
      ).run(now, now, spaceId, `workspace:${spaceId}:relation:%`, ...activeRelationIds);
    } else {
      db.prepare(
        "UPDATE operational_relations SET deleted_at = ?, updated_at = ?, relation_version = relation_version + 1 WHERE space_id = ? AND canonical_source = 'workspace-json' AND id LIKE ? AND deleted_at IS NULL"
      ).run(now, now, spaceId, `workspace:${spaceId}:relation:%`);
    }

    const operationId = `workspace:${spaceId}:revision:${workspace.revision}`;
    const operationExists = db.prepare('SELECT 1 FROM operational_operations WHERE id = ?').get(operationId);
    if (!operationExists) {
      const nextLamport = Number(
        (db.prepare('SELECT COALESCE(MAX(lamport), 0) + 1 AS value FROM operational_operations WHERE space_id = ?').get(spaceId) as { value: number }).value
      );
      db.prepare(`
        INSERT INTO operational_operations
          (id, space_id, actor_id, type, target_id, base_version, result_version, lamport,
           payload_json, provenance_class, authority_json, created_at)
        VALUES (?, ?, ?, 'PROJECT_WORKSPACE_REVISION', ?, ?, ?, ?, ?, 'migration', '{}', ?)
      `).run(
        operationId,
        spaceId,
        actorId,
        `workspace:${spaceId}`,
        Math.max(0, workspace.revision - 1),
        workspace.revision,
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

type ObjectRow = {
  id: string;
  space_id: string;
  type: string;
  schema_version: number;
  semantic_version: number;
  canonical_source: string;
  provenance_class: string;
  properties_json: string;
  provenance_json: string;
  owner_actor_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};
type RelationRow = {
  id: string;
  space_id: string;
  type: string;
  from_object_id: string;
  to_object_id: string;
  relation_version: number;
  canonical_source: string;
  provenance_class: string;
  properties_json: string;
  provenance_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};
type ProjectionRow = {
  space_id: string;
  object_id: string;
  projection: string;
  projection_version: number;
  canonical_source: string;
  state_json: string;
  updated_at: string;
  deleted_at: string | null;
};
type OperationRow = {
  id: string;
  space_id: string;
  actor_id: string;
  device_id: string | null;
  type: string;
  target_id: string | null;
  base_version: number | null;
  result_version: number | null;
  lamport: number;
  payload_json: string;
  authority_grant_id: string | null;
  idempotency_key: string | null;
  operation_hash: string | null;
  provenance_class: string | null;
  authority_json: string | null;
  interaction_id: string | null;
  interaction_sequence: number | null;
  causation_event_id: string | null;
  created_at: string;
};

export function toOperationalObject(row: ObjectRow): OperationalObject {
  return {
    id: row.id,
    spaceId: row.space_id,
    type: row.type,
    schemaVersion: row.schema_version,
    semanticVersion: row.semantic_version,
    canonicalSource: row.canonical_source as CanonicalSource,
    provenanceClass: row.provenance_class as ProvenanceClass,
    properties: parseRecord(row.properties_json),
    provenance: parseRecord(row.provenance_json),
    ownerActorId: row.owner_actor_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

export function toOperationalRelation(row: RelationRow): OperationalRelation {
  return {
    id: row.id,
    spaceId: row.space_id,
    type: row.type as RelationType,
    fromObjectId: row.from_object_id,
    toObjectId: row.to_object_id,
    relationVersion: row.relation_version,
    canonicalSource: row.canonical_source as CanonicalSource,
    provenanceClass: row.provenance_class as ProvenanceClass,
    properties: parseRecord(row.properties_json),
    provenance: parseRecord(row.provenance_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

export function toObjectProjection(row: ProjectionRow): ObjectProjection {
  return {
    spaceId: row.space_id,
    objectId: row.object_id,
    projection: row.projection,
    projectionVersion: row.projection_version,
    canonicalSource: row.canonical_source as CanonicalSource,
    state: parseRecord(row.state_json),
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

export function toOperationalOperation(row: OperationRow): OperationalOperation {
  return {
    id: row.id,
    spaceId: row.space_id,
    actorId: row.actor_id,
    deviceId: row.device_id,
    type: row.type,
    targetId: row.target_id,
    baseVersion: row.base_version,
    resultVersion: row.result_version,
    lamport: row.lamport,
    payload: parseRecord(row.payload_json),
    authorityGrantId: row.authority_grant_id,
    idempotencyKey: row.idempotency_key,
    operationHash: row.operation_hash,
    provenanceClass: (row.provenance_class as ProvenanceClass) ?? null,
    authority: parseRecord(row.authority_json ?? '{}'),
    interactionId: row.interaction_id,
    interactionSequence: row.interaction_sequence,
    causationEventId: row.causation_event_id,
    createdAt: row.created_at
  };
}

export function readOperationalSpace(spaceId: string): OperationalSpaceSnapshot {
  const db = database();
  const objects = db.prepare('SELECT * FROM operational_objects WHERE space_id = ? ORDER BY created_at, id').all(spaceId) as unknown as ObjectRow[];
  const relations = db.prepare('SELECT * FROM operational_relations WHERE space_id = ? ORDER BY created_at, id').all(spaceId) as unknown as RelationRow[];
  const projections = db.prepare('SELECT * FROM object_projections WHERE space_id = ? ORDER BY object_id, projection').all(spaceId) as unknown as ProjectionRow[];
  const operations = db.prepare('SELECT * FROM operational_operations WHERE space_id = ? ORDER BY lamport, id').all(spaceId) as unknown as OperationRow[];
  return {
    spaceId,
    objects: objects.map(toOperationalObject),
    relations: relations.map(toOperationalRelation),
    projections: projections.map(toObjectProjection),
    operations: operations.map(toOperationalOperation)
  };
}

export function resetOperationalObjectStoreForTests() {
  for (const db of databases.values()) db.close();
  databases.clear();
}
