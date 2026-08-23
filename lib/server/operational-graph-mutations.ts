/**
 * Versioned mutations against the Operational Graph.
 *
 * This is not a second graph. It is the write side of the one in
 * `operational-object-store.ts`, which until now could only be written by
 * projecting Workspace JSON. Every mutation here validates, records an
 * operation, applies the change and records the resulting version inside a
 * single SQLite transaction.
 *
 * What this deliberately does *not* claim: atomicity across Workspace JSON and
 * SQLite. Those are two files on a disk with no shared transaction. Workspace
 * save stays canonical for workspace-owned records; the graph follows
 * idempotently and can be reconciled by replaying a revision.
 */

import { createHash } from 'node:crypto';
import {
  GraphMutationError,
  provenanceClasses,
  relationTypes,
  type CanonicalSource,
  type MutationActor,
  type ObjectProjection,
  type OperationalObject,
  type OperationalRelation,
  type ProvenanceClass,
  type RelationType
} from '../operational-graph/types.ts';
import { qualifiesForHighTrust } from './proof-policy.ts';
import {
  canonicalJson,
  operationalDatabase,
  toObjectProjection,
  toOperationalObject,
  toOperationalRelation
} from './operational-object-store.ts';

export type MutationType =
  | 'CREATE_OBJECT'
  | 'PATCH_OBJECT'
  | 'TOMBSTONE_OBJECT'
  | 'UPSERT_PROJECTION'
  | 'PATCH_PROJECTION'
  | 'TOMBSTONE_PROJECTION'
  | 'CREATE_RELATION'
  | 'PATCH_RELATION'
  | 'TOMBSTONE_RELATION';

const mutationTypes = new Set<MutationType>([
  'CREATE_OBJECT',
  'PATCH_OBJECT',
  'TOMBSTONE_OBJECT',
  'UPSERT_PROJECTION',
  'PATCH_PROJECTION',
  'TOMBSTONE_PROJECTION',
  'CREATE_RELATION',
  'PATCH_RELATION',
  'TOMBSTONE_RELATION'
]);

const relationTypeSet = new Set<string>(relationTypes);
const provenanceClassSet = new Set<string>(provenanceClasses);

export interface MutationRequest {
  spaceId: string;
  type: MutationType;
  actor: MutationActor;
  /** Replay key. The same key with the same content is a no-op that returns the original result. */
  idempotencyKey?: string | null;
  /** The version the caller read before deciding to write. */
  baseVersion?: number | null;
  payload: Record<string, unknown>;
}

export interface MutationResult {
  operationId: string;
  operationHash: string;
  /** Server-issued total-order cursor for this Space. Clients never supply it. */
  lamport: number;
  applied: boolean;
  /** False when an idempotency key replayed an operation already recorded. */
  replayed: boolean;
  targetId: string | null;
  baseVersion: number | null;
  resultVersion: number | null;
  object?: OperationalObject;
  relation?: OperationalRelation;
  projection?: ObjectProjection;
}

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new GraphMutationError('invalid-operation', message, details);
}

function text(value: unknown, field: string, max = 500): string {
  const cleaned = String(value ?? '').trim();
  if (!cleaned) invalid(`${field} is required.`, { field });
  if (cleaned.length > max) invalid(`${field} is longer than ${max} characters.`, { field });
  return cleaned;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${field} must be an object.`, { field });
  }
  return value as Record<string, unknown>;
}

function provenanceClass(value: unknown, fallback: ProvenanceClass): ProvenanceClass {
  if (value === undefined || value === null || value === '') return fallback;
  const cleaned = String(value);
  if (!provenanceClassSet.has(cleaned)) {
    invalid(`Unknown provenance class "${cleaned}".`, { provenanceClass: cleaned });
  }
  return cleaned as ProvenanceClass;
}

/**
 * The deterministic identity of a mutation's content.
 *
 * Two calls with the same idempotency key must be the same operation. Hashing
 * the content is what makes "same" checkable instead of assumed, so a retry is a
 * no-op and a *different* write reusing a key is refused rather than silently
 * dropped.
 */
export function operationHash(request: MutationRequest): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        spaceId: request.spaceId,
        type: request.type,
        actorId: request.actor.actorId,
        baseVersion: request.baseVersion ?? null,
        payload: request.payload
      })
    )
    .digest('hex');
}

function authorityRecord(actor: MutationActor) {
  return {
    actorId: actor.actorId,
    ...(actor.deviceId ? { deviceId: actor.deviceId } : {}),
    ...(actor.authorityGrantId ? { authorityGrantId: actor.authorityGrantId } : {}),
    ...(actor.intentId ? { intentId: actor.intentId } : {}),
    ...(actor.runId ? { runId: actor.runId } : {}),
    ...(actor.receiptId ? { receiptId: actor.receiptId } : {}),
    ...(actor.proof
      ? {
          proof: {
            completed: actor.proof.completed === true,
            proofStrength: String(actor.proof.proofStrength ?? 'none'),
            legacy: actor.proof.legacy === true
          }
        }
      : {})
  };
}

type Db = ReturnType<typeof operationalDatabase>;

function objectRow(db: Db, spaceId: string, id: string) {
  return db
    .prepare('SELECT * FROM operational_objects WHERE space_id = ? AND id = ?')
    .get(spaceId, id) as unknown as Parameters<typeof toOperationalObject>[0] | undefined;
}

function relationRow(db: Db, spaceId: string, id: string) {
  return db
    .prepare('SELECT * FROM operational_relations WHERE space_id = ? AND id = ?')
    .get(spaceId, id) as unknown as Parameters<typeof toOperationalRelation>[0] | undefined;
}

function projectionRow(db: Db, spaceId: string, objectId: string, projection: string) {
  return db
    .prepare('SELECT * FROM object_projections WHERE space_id = ? AND object_id = ? AND projection = ?')
    .get(spaceId, objectId, projection) as unknown as
    | Parameters<typeof toObjectProjection>[0]
    | undefined;
}

/**
 * Optimistic concurrency.
 *
 * A caller that read version N and writes against N wins; a caller that read N
 * and finds N+1 is told, rather than having its decision applied to state it
 * never saw. `null` is accepted only where there is nothing to be stale about.
 */
function requireVersion(expected: number | null | undefined, actual: number, target: string) {
  if (expected === null || expected === undefined) {
    throw new GraphMutationError(
      'stale-version',
      `This mutation must state the version it was decided against (${target} is at ${actual}).`,
      { target, actual }
    );
  }
  if (expected !== actual) {
    throw new GraphMutationError(
      'stale-version',
      `${target} changed since this mutation was decided: expected version ${expected}, found ${actual}.`,
      { target, expected, actual }
    );
  }
}

/**
 * Workspace JSON owns its own records during the migration.
 *
 * A graph-first write to a workspace-owned object would be overwritten by the
 * next autosave without anyone noticing, so it is refused with the reason rather
 * than accepted and lost.
 */
function requireGraphOwnership(source: string, id: string, kind: string) {
  if (source !== 'graph') {
    throw new GraphMutationError(
      'canonical-owner-mismatch',
      `${kind} ${id} is owned by Workspace JSON, so it cannot be changed directly in the graph. Edit it through the Workspace.`,
      { id, canonicalSource: source }
    );
  }
}

function requireLive(deletedAt: string | null, id: string, kind: string) {
  if (deletedAt !== null) {
    throw new GraphMutationError('tombstoned-target', `${kind} ${id} is tombstoned.`, { id });
  }
}

function nextLamport(db: Db, spaceId: string) {
  const row = db
    .prepare('SELECT COALESCE(MAX(lamport), 0) + 1 AS value FROM operational_operations WHERE space_id = ?')
    .get(spaceId) as { value: number };
  return Number(row.value);
}

/**
 * Apply one mutation.
 *
 * Validation, operation recording, the mutation itself and the resulting version
 * all happen inside one transaction. A refusal leaves no operation record and no
 * partial change: an operation exists only if it applied.
 */
export function applyGraphMutation(request: MutationRequest): MutationResult {
  const spaceId = text(request.spaceId, 'spaceId', 200);
  if (!mutationTypes.has(request.type)) {
    invalid(`Unknown mutation type "${String(request.type)}".`, { type: request.type });
  }
  const actorId = text(request.actor?.actorId, 'actor.actorId', 200);
  const hash = operationHash({ ...request, spaceId });
  const idempotencyKey = request.idempotencyKey ? text(request.idempotencyKey, 'idempotencyKey', 200) : null;
  const db = operationalDatabase();
  const now = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    if (idempotencyKey) {
      const previous = db
        .prepare('SELECT * FROM operational_operations WHERE space_id = ? AND idempotency_key = ?')
        .get(spaceId, idempotencyKey) as unknown as
        | { id: string; operation_hash: string | null; target_id: string | null; base_version: number | null; result_version: number | null; lamport: number }
        | undefined;
      if (previous) {
        if (previous.operation_hash !== hash) {
          throw new GraphMutationError(
            'idempotency-conflict',
            `Idempotency key "${idempotencyKey}" was already used for a different mutation.`,
            { idempotencyKey, recordedOperationId: previous.id }
          );
        }
        // A genuine retry. The original result is returned unchanged rather than
        // applied twice.
        db.exec('COMMIT');
        return {
          operationId: previous.id,
          operationHash: hash,
          lamport: previous.lamport,
          applied: false,
          replayed: true,
          targetId: previous.target_id,
          baseVersion: previous.base_version,
          resultVersion: previous.result_version,
          ...readTarget(db, spaceId, request.type, previous.target_id)
        };
      }
    }

    const outcome = applyInTransaction(db, spaceId, request, actorId, now);
    const lamport = nextLamport(db, spaceId);
    const operationId = `op:${spaceId}:${hash.slice(0, 24)}:${lamport}`;
    db.prepare(`
      INSERT INTO operational_operations
        (id, space_id, actor_id, device_id, type, target_id, base_version, result_version, lamport,
         payload_json, authority_grant_id, idempotency_key, operation_hash, provenance_class, authority_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      operationId,
      spaceId,
      actorId,
      request.actor.deviceId ?? null,
      request.type,
      outcome.targetId,
      request.baseVersion ?? null,
      outcome.resultVersion,
      lamport,
      JSON.stringify(request.payload ?? {}),
      request.actor.authorityGrantId ?? null,
      idempotencyKey,
      hash,
      outcome.provenanceClass,
      JSON.stringify(authorityRecord(request.actor)),
      now
    );
    db.exec('COMMIT');
    return {
      operationId,
      operationHash: hash,
      lamport,
      applied: true,
      replayed: false,
      targetId: outcome.targetId,
      baseVersion: request.baseVersion ?? null,
      resultVersion: outcome.resultVersion,
      ...readTarget(db, spaceId, request.type, outcome.targetId)
    };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Already committed on the idempotency-conflict path.
    }
    throw error;
  }
}

function readTarget(db: Db, spaceId: string, type: MutationType, targetId: string | null) {
  if (!targetId) return {};
  if (type.endsWith('OBJECT')) {
    const row = objectRow(db, spaceId, targetId);
    return row ? { object: toOperationalObject(row) } : {};
  }
  if (type.endsWith('RELATION')) {
    const row = relationRow(db, spaceId, targetId);
    return row ? { relation: toOperationalRelation(row) } : {};
  }
  const [objectId, projection] = splitProjectionTarget(targetId);
  const row = projectionRow(db, spaceId, objectId, projection);
  return row ? { projection: toObjectProjection(row) } : {};
}

/** Projection targets are addressed by object plus projection name. */
export function projectionTarget(objectId: string, projection: string) {
  return `${objectId}::${projection}`;
}

function splitProjectionTarget(target: string): [string, string] {
  const at = target.lastIndexOf('::');
  return at === -1 ? [target, 'workspace-spatial'] : [target.slice(0, at), target.slice(at + 2)];
}

type Outcome = { targetId: string; resultVersion: number; provenanceClass: ProvenanceClass };

function applyInTransaction(
  db: Db,
  spaceId: string,
  request: MutationRequest,
  actorId: string,
  now: string
): Outcome {
  const payload = record(request.payload, 'payload');
  switch (request.type) {
    case 'CREATE_OBJECT':
      return createObject(db, spaceId, payload, request, actorId, now);
    case 'PATCH_OBJECT':
      return patchObject(db, spaceId, payload, request, now);
    case 'TOMBSTONE_OBJECT':
      return tombstoneObject(db, spaceId, payload, request, now);
    case 'UPSERT_PROJECTION':
      return upsertProjection(db, spaceId, payload, request, now);
    case 'PATCH_PROJECTION':
      return patchProjection(db, spaceId, payload, request, now);
    case 'TOMBSTONE_PROJECTION':
      return tombstoneProjection(db, spaceId, payload, request, now);
    case 'CREATE_RELATION':
      return createRelation(db, spaceId, payload, request, now);
    case 'PATCH_RELATION':
      return patchRelation(db, spaceId, payload, request, now);
    case 'TOMBSTONE_RELATION':
      return tombstoneRelation(db, spaceId, payload, request, now);
  }
}

function createObject(
  db: Db,
  spaceId: string,
  payload: Record<string, unknown>,
  request: MutationRequest,
  actorId: string,
  now: string
): Outcome {
  const id = text(payload.id, 'payload.id', 300);
  const type = text(payload.type, 'payload.type', 120);
  if (objectRow(db, spaceId, id)) {
    invalid(`Object ${id} already exists.`, { id });
  }
  // Graph-native by construction: an object created here was never in the
  // Workspace JSON, so the JSON must not tombstone it for being absent.
  const provenance = provenanceClass(payload.provenanceClass, 'execution_generated');
  db.prepare(`
    INSERT INTO operational_objects
      (id, space_id, type, schema_version, semantic_version, canonical_source, provenance_class,
       properties_json, provenance_json, owner_actor_id, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, 1, 1, 'graph', ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    spaceId,
    type,
    provenance,
    canonicalJson(record(payload.properties, 'payload.properties')),
    canonicalJson({ ...record(payload.provenance, 'payload.provenance'), ...authorityRecord(request.actor) }),
    String(payload.ownerActorId ?? actorId),
    now,
    now
  );
  return { targetId: id, resultVersion: 1, provenanceClass: provenance };
}

function patchObject(
  db: Db,
  spaceId: string,
  payload: Record<string, unknown>,
  request: MutationRequest,
  now: string
): Outcome {
  const id = text(payload.id, 'payload.id', 300);
  const row = objectRow(db, spaceId, id);
  if (!row) throw new GraphMutationError('missing-target', `Object ${id} does not exist.`, { id });
  requireLive(row.deleted_at, id, 'Object');
  requireGraphOwnership(row.canonical_source, id, 'Object');
  requireVersion(request.baseVersion, row.semantic_version, `Object ${id}`);

  const properties = payload.properties === undefined
    ? parseJson(row.properties_json)
    : { ...parseJson(row.properties_json), ...record(payload.properties, 'payload.properties') };
  const type = payload.type === undefined ? row.type : text(payload.type, 'payload.type', 120);
  const provenance = provenanceClass(payload.provenanceClass, row.provenance_class as ProvenanceClass);
  const version = row.semantic_version + 1;
  db.prepare(
    'UPDATE operational_objects SET type = ?, properties_json = ?, provenance_class = ?, owner_actor_id = ?, semantic_version = ?, updated_at = ? WHERE space_id = ? AND id = ?'
  ).run(
    type,
    canonicalJson(properties),
    provenance,
    payload.ownerActorId === undefined ? row.owner_actor_id : String(payload.ownerActorId),
    version,
    now,
    spaceId,
    id
  );
  return { targetId: id, resultVersion: version, provenanceClass: provenance };
}

function tombstoneObject(
  db: Db,
  spaceId: string,
  payload: Record<string, unknown>,
  request: MutationRequest,
  now: string
): Outcome {
  const id = text(payload.id, 'payload.id', 300);
  const row = objectRow(db, spaceId, id);
  if (!row) throw new GraphMutationError('missing-target', `Object ${id} does not exist.`, { id });
  requireLive(row.deleted_at, id, 'Object');
  requireGraphOwnership(row.canonical_source, id, 'Object');
  requireVersion(request.baseVersion, row.semantic_version, `Object ${id}`);
  const version = row.semantic_version + 1;
  // A tombstone hides the object; it never removes the row or the operations
  // that produced it. History is the point of the ledger.
  db.prepare(
    'UPDATE operational_objects SET deleted_at = ?, semantic_version = ?, updated_at = ? WHERE space_id = ? AND id = ?'
  ).run(now, version, now, spaceId, id);
  // Relations to a tombstoned object would otherwise dangle.
  db.prepare(
    'UPDATE operational_relations SET deleted_at = ?, relation_version = relation_version + 1, updated_at = ? WHERE space_id = ? AND deleted_at IS NULL AND (from_object_id = ? OR to_object_id = ?)'
  ).run(now, now, spaceId, id, id);
  db.prepare(
    'UPDATE object_projections SET deleted_at = ?, projection_version = projection_version + 1, updated_at = ? WHERE space_id = ? AND object_id = ? AND deleted_at IS NULL'
  ).run(now, now, spaceId, id);
  return { targetId: id, resultVersion: version, provenanceClass: row.provenance_class as ProvenanceClass };
}

function requireProjectionOwner(db: Db, spaceId: string, objectId: string) {
  const owner = objectRow(db, spaceId, objectId);
  if (!owner) {
    throw new GraphMutationError('missing-target', `Object ${objectId} does not exist.`, { objectId });
  }
  requireLive(owner.deleted_at, objectId, 'Object');
  return owner;
}

function upsertProjection(
  db: Db,
  spaceId: string,
  payload: Record<string, unknown>,
  request: MutationRequest,
  now: string
): Outcome {
  const objectId = text(payload.objectId, 'payload.objectId', 300);
  const projection = text(payload.projection ?? 'workspace-spatial', 'payload.projection', 120);
  const owner = requireProjectionOwner(db, spaceId, objectId);
  requireGraphOwnership(owner.canonical_source, objectId, 'Object');
  const state = record(payload.state, 'payload.state');
  const existing = projectionRow(db, spaceId, objectId, projection);
  const target = projectionTarget(objectId, projection);
  if (existing && existing.deleted_at === null) {
    requireVersion(request.baseVersion, existing.projection_version, `Projection ${target}`);
  }
  const version = existing ? existing.projection_version + 1 : 1;
  db.prepare(`
    INSERT INTO object_projections
      (space_id, object_id, projection, projection_version, canonical_source, state_json, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, 'graph', ?, ?, NULL)
    ON CONFLICT(space_id, object_id, projection) DO UPDATE SET
      projection_version = excluded.projection_version,
      canonical_source = 'graph',
      state_json = excluded.state_json,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `).run(spaceId, objectId, projection, version, canonicalJson(state), now);
  return { targetId: target, resultVersion: version, provenanceClass: 'authored' };
}

function patchProjection(
  db: Db,
  spaceId: string,
  payload: Record<string, unknown>,
  request: MutationRequest,
  now: string
): Outcome {
  const objectId = text(payload.objectId, 'payload.objectId', 300);
  const projection = text(payload.projection ?? 'workspace-spatial', 'payload.projection', 120);
  const target = projectionTarget(objectId, projection);
  const existing = projectionRow(db, spaceId, objectId, projection);
  if (!existing) {
    throw new GraphMutationError('missing-target', `Projection ${target} does not exist.`, { target });
  }
  requireLive(existing.deleted_at, target, 'Projection');
  requireGraphOwnership(existing.canonical_source, target, 'Projection');
  requireVersion(request.baseVersion, existing.projection_version, `Projection ${target}`);
  const state = { ...parseJson(existing.state_json), ...record(payload.state, 'payload.state') };
  const version = existing.projection_version + 1;
  db.prepare(
    'UPDATE object_projections SET state_json = ?, projection_version = ?, updated_at = ? WHERE space_id = ? AND object_id = ? AND projection = ?'
  ).run(canonicalJson(state), version, now, spaceId, objectId, projection);
  return { targetId: target, resultVersion: version, provenanceClass: 'authored' };
}

function tombstoneProjection(
  db: Db,
  spaceId: string,
  payload: Record<string, unknown>,
  request: MutationRequest,
  now: string
): Outcome {
  const objectId = text(payload.objectId, 'payload.objectId', 300);
  const projection = text(payload.projection ?? 'workspace-spatial', 'payload.projection', 120);
  const target = projectionTarget(objectId, projection);
  const existing = projectionRow(db, spaceId, objectId, projection);
  if (!existing) {
    throw new GraphMutationError('missing-target', `Projection ${target} does not exist.`, { target });
  }
  requireLive(existing.deleted_at, target, 'Projection');
  requireGraphOwnership(existing.canonical_source, target, 'Projection');
  requireVersion(request.baseVersion, existing.projection_version, `Projection ${target}`);
  const version = existing.projection_version + 1;
  db.prepare(
    'UPDATE object_projections SET deleted_at = ?, projection_version = ?, updated_at = ? WHERE space_id = ? AND object_id = ? AND projection = ?'
  ).run(now, version, now, spaceId, objectId, projection);
  return { targetId: target, resultVersion: version, provenanceClass: 'authored' };
}

/**
 * VERIFIED_BY is a claim that a run proved something.
 *
 * Only a satisfied assessment with declared proof supports it, checked through
 * the same policy every other high-trust surface uses. Without this an agent
 * could assert its own work was verified simply by drawing an edge.
 */
function requireRelationAuthority(type: RelationType, request: MutationRequest) {
  if (type !== 'VERIFIED_BY') return;
  const decision = qualifiesForHighTrust(request.actor.proof ?? null, 'verified-by-relation');
  if (!decision.qualifies) {
    throw new GraphMutationError('authority-mismatch', decision.reason, {
      relationType: type,
      proofStrength: request.actor.proof?.proofStrength ?? null
    });
  }
}

function createRelation(
  db: Db,
  spaceId: string,
  payload: Record<string, unknown>,
  request: MutationRequest,
  now: string
): Outcome {
  const id = text(payload.id, 'payload.id', 300);
  const rawType = text(payload.type, 'payload.type', 60);
  if (!relationTypeSet.has(rawType)) {
    throw new GraphMutationError(
      'invalid-relation',
      `"${rawType}" is not a known relation type.`,
      { type: rawType, allowed: [...relationTypeSet] }
    );
  }
  const type = rawType as RelationType;
  requireRelationAuthority(type, request);
  if (relationRow(db, spaceId, id)) invalid(`Relation ${id} already exists.`, { id });

  const fromObjectId = text(payload.fromObjectId, 'payload.fromObjectId', 300);
  const toObjectId = text(payload.toObjectId, 'payload.toObjectId', 300);
  for (const [end, endId] of [
    ['fromObjectId', fromObjectId],
    ['toObjectId', toObjectId]
  ] as const) {
    const row = objectRow(db, spaceId, endId);
    if (!row || row.deleted_at !== null) {
      throw new GraphMutationError(
        'dangling-relation',
        `Relation ${end} ${endId} ${row ? 'is tombstoned' : 'does not exist'}.`,
        { end, objectId: endId }
      );
    }
  }
  const provenance = provenanceClass(
    payload.provenanceClass,
    type === 'VERIFIED_BY' ? 'verified' : 'execution_generated'
  );
  db.prepare(`
    INSERT INTO operational_relations
      (id, space_id, type, from_object_id, to_object_id, relation_version, canonical_source,
       provenance_class, properties_json, provenance_json, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, 1, 'graph', ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    spaceId,
    type,
    fromObjectId,
    toObjectId,
    provenance,
    canonicalJson(record(payload.properties, 'payload.properties')),
    canonicalJson({ ...record(payload.provenance, 'payload.provenance'), ...authorityRecord(request.actor) }),
    now,
    now
  );
  return { targetId: id, resultVersion: 1, provenanceClass: provenance };
}

/** Only relation metadata is patchable. Its endpoints and type are its identity. */
function patchRelation(
  db: Db,
  spaceId: string,
  payload: Record<string, unknown>,
  request: MutationRequest,
  now: string
): Outcome {
  const id = text(payload.id, 'payload.id', 300);
  const row = relationRow(db, spaceId, id);
  if (!row) throw new GraphMutationError('missing-target', `Relation ${id} does not exist.`, { id });
  requireLive(row.deleted_at, id, 'Relation');
  requireGraphOwnership(row.canonical_source, id, 'Relation');
  requireVersion(request.baseVersion, row.relation_version, `Relation ${id}`);
  if (payload.type !== undefined || payload.fromObjectId !== undefined || payload.toObjectId !== undefined) {
    invalid(
      'A relation\'s type and endpoints are its identity. Tombstone it and create the relation you mean.',
      { id }
    );
  }
  const provenance = provenanceClass(payload.provenanceClass, row.provenance_class as ProvenanceClass);
  if (provenance === 'verified' && row.type === 'VERIFIED_BY') {
    requireRelationAuthority('VERIFIED_BY', request);
  }
  const properties = { ...parseJson(row.properties_json), ...record(payload.properties, 'payload.properties') };
  const version = row.relation_version + 1;
  db.prepare(
    'UPDATE operational_relations SET properties_json = ?, provenance_class = ?, relation_version = ?, updated_at = ? WHERE space_id = ? AND id = ?'
  ).run(canonicalJson(properties), provenance, version, now, spaceId, id);
  return { targetId: id, resultVersion: version, provenanceClass: provenance };
}

function tombstoneRelation(
  db: Db,
  spaceId: string,
  payload: Record<string, unknown>,
  request: MutationRequest,
  now: string
): Outcome {
  const id = text(payload.id, 'payload.id', 300);
  const row = relationRow(db, spaceId, id);
  if (!row) throw new GraphMutationError('missing-target', `Relation ${id} does not exist.`, { id });
  requireLive(row.deleted_at, id, 'Relation');
  requireGraphOwnership(row.canonical_source, id, 'Relation');
  requireVersion(request.baseVersion, row.relation_version, `Relation ${id}`);
  const version = row.relation_version + 1;
  db.prepare(
    'UPDATE operational_relations SET deleted_at = ?, relation_version = ?, updated_at = ? WHERE space_id = ? AND id = ?'
  ).run(now, version, now, spaceId, id);
  return { targetId: id, resultVersion: version, provenanceClass: row.provenance_class as ProvenanceClass };
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Every operation recorded against a target, oldest first. */
export function readOperationHistory(spaceId: string, targetId?: string) {
  const db = operationalDatabase();
  const rows = targetId
    ? db
        .prepare('SELECT * FROM operational_operations WHERE space_id = ? AND target_id = ? ORDER BY lamport, id')
        .all(spaceId, targetId)
    : db.prepare('SELECT * FROM operational_operations WHERE space_id = ? ORDER BY lamport, id').all(spaceId);
  return rows as unknown as Record<string, unknown>[];
}

export type { CanonicalSource };
