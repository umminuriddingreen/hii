/**
 * The governed object interface agents actually get.
 *
 * Agents do not edit Workspace JSON, and they do not reach the graph's mutation
 * API directly either. Everything goes through here so object existence,
 * validation, revisions, attribution, provenance and receipts stay consistent.
 *
 * Every mutation records who asked, for which intent and run,
 * from which base version to which resulting version — carried through to the
 * graph's operation ledger, which is what makes an agent's changes reviewable
 * rather than merely present.
 */

import {
  GraphMutationError,
  relationTypes,
  type MutationActor,
  type RelationType
} from '../operational-graph/types.ts';
import {
  applyGraphMutation,
  readOperationHistory,
  type MutationResult,
  type MutationType
} from './operational-graph-mutations.ts';
import { readOperationalSpace } from './operational-object-store.ts';

export type ObjectOperation =
  | 'read'
  | 'create'
  | 'annotate'
  | 'patch-semantic'
  | 'patch-projection'
  | 'relate'
  | 'tombstone';

export const objectOperations: readonly ObjectOperation[] = [
  'read',
  'create',
  'annotate',
  'patch-semantic',
  'patch-projection',
  'relate',
  'tombstone'
] as const;

/** Legacy grant data accepted for API compatibility; it no longer gates object actions. */
export type ObjectAccessScope = {
  /** Optional legacy attribution, recorded on an operation when supplied. */
  grantId?: string | null;
  spaceId: string;
  readableObjectIds: string[];
  writableObjectIds: string[];
  creatableTypes: string[];
  allowedRelationTypes: RelationType[];
  allowedOperations: ObjectOperation[];
  /** Frames/scenes the subject may place or move objects within. Empty means none. */
  projectionScope: string[];
  /** Whether resolved object content may leave the machine. */
  externalTransmission: 'blocked' | 'allowed';
  /** ISO timestamp after which the scope is spent. */
  expiresAt?: string | null;
  /** The run this scope belongs to. A scope outlives no run. */
  runId?: string | null;
};

export class ObjectAuthorityError extends Error {
  readonly code = 'object-authority-denied';
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ObjectAuthorityError';
    this.details = details;
  }
}

const relationTypeSet = new Set<string>(relationTypes);
const secretField = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|private[_-]?key|authorization)/i;

function redactText(value: string) {
  return value
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)=)([^\s]+)/gi, '$1[redacted]')
    .replace(/((?:OPENAI|ANTHROPIC|SUPABASE|STRIPE|GITHUB|VERCEL|CLOUDFLARE|AWS)[A-Z0-9_]*=)([^\s]+)/g, '$1[redacted]')
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, '$1[redacted]')
    .replace(/(--(?:api-key|token|secret|password|auth|key)\s+)([^\s]+)/gi, '$1[redacted]')
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[redacted]')
    .replace(/(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/g, '[redacted]');
}

function redactSecrets<T>(value: T, key = ''): T {
  if (secretField.test(key)) return '[redacted]' as T;
  if (typeof value === 'string') {
    if (/(?:payload|authority|properties|provenance|state)_json$/i.test(key)) {
      try {
        return JSON.stringify(redactSecrets(JSON.parse(value))) as T;
      } catch {
        // Keep malformed historical data readable, with inline tokens scrubbed.
      }
    }
    return redactText(value) as T;
  }
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redactSecrets(child, childKey)])
    ) as T;
  }
  return value;
}

export function objectAccessScope(spaceId = 'default', runId?: string): ObjectAccessScope {
  return {
    grantId: null,
    spaceId: String(spaceId || 'default'),
    readableObjectIds: [],
    writableObjectIds: [],
    creatableTypes: [],
    allowedRelationTypes: [],
    allowedOperations: [],
    projectionScope: [],
    externalTransmission: 'allowed',
    runId: runId || null
  };
}

function actorFor(scope: ObjectAccessScope, actor: MutationActor): MutationActor {
  return { ...actor, authorityGrantId: actor.authorityGrantId ?? scope.grantId ?? null, runId: actor.runId ?? scope.runId ?? null };
}

// --- reads -----------------------------------------------------------------

export type ObjectSummary = {
  id: string;
  type: string;
  semanticVersion: number;
  canonicalSource: string;
  provenanceClass: string;
  ownerActorId: string | null;
  updatedAt: string;
  tombstoned: boolean;
};

/** List objects in a Space. The scope argument is accepted for old callers only. */
export function listApprovedObjects(scope: ObjectAccessScope = objectAccessScope()): ObjectSummary[] {
  return readOperationalSpace(scope.spaceId)
    .map((object) => ({
      id: object.id,
      type: object.type,
      semanticVersion: object.semanticVersion,
      canonicalSource: object.canonicalSource,
      provenanceClass: object.provenanceClass,
      ownerActorId: object.ownerActorId,
      updatedAt: object.updatedAt,
      tombstoned: object.deletedAt !== null
    }));
}

export function listObjects(spaceId = 'default'): ObjectSummary[] {
  return listApprovedObjects(objectAccessScope(spaceId));
}

export function readApprovedObject(scope: ObjectAccessScope, objectId: string) {
  const snapshot = readOperationalSpace(scope.spaceId);
  const object = snapshot.objects.find((candidate) => candidate.id === objectId);
  if (!object) throw new GraphMutationError('missing-target', `Object ${objectId} does not exist.`, { objectId });
  return {
    object: redactSecrets(object),
    projections: redactSecrets(snapshot.projections.filter((entry) => entry.objectId === objectId)),
    // Return the object's complete graph neighborhood so callers receive
    // accurate relationship and provenance context.
    relations: redactSecrets(snapshot.relations.filter(
      (relation) =>
        relation.fromObjectId === objectId || relation.toObjectId === objectId
    )),
    history: redactSecrets(readOperationHistory(scope.spaceId, objectId))
  };
}

export function readObject(objectId: string, spaceId = 'default') {
  return readApprovedObject(objectAccessScope(spaceId), objectId);
}

// --- writes ----------------------------------------------------------------

function govern(
  scope: ObjectAccessScope,
  actor: MutationActor,
  type: MutationType,
  payload: Record<string, unknown>,
  options: { baseVersion?: number | null; idempotencyKey?: string | null } = {}
): MutationResult {
  return redactSecrets(applyGraphMutation({
    spaceId: scope.spaceId,
    type,
    actor: actorFor(scope, actor),
    baseVersion: options.baseVersion ?? null,
    idempotencyKey: options.idempotencyKey ?? null,
    payload
  }));
}

export function createApprovedObject(
  scope: ObjectAccessScope,
  actor: MutationActor,
  input: { id: string; type: string; properties?: Record<string, unknown>; frameId?: string; idempotencyKey?: string }
) {
  const result = govern(
    scope,
    actor,
    'CREATE_OBJECT',
    {
      id: input.id,
      type: input.type,
      properties: { ...(input.properties ?? {}), ...(input.frameId ? { frameId: input.frameId } : {}) },
      provenanceClass: 'execution_generated'
    },
    { idempotencyKey: input.idempotencyKey }
  );
  return result;
}

export function patchApprovedObject(
  scope: ObjectAccessScope,
  actor: MutationActor,
  input: { id: string; baseVersion: number; properties?: Record<string, unknown>; type?: string; idempotencyKey?: string }
) {
  return govern(
    scope,
    actor,
    'PATCH_OBJECT',
    {
      id: input.id,
      ...(input.properties ? { properties: input.properties } : {}),
      ...(input.type ? { type: input.type } : {})
    },
    { baseVersion: input.baseVersion, idempotencyKey: input.idempotencyKey }
  );
}

/**
 * An annotation is a patch that may only add commentary.
 *
 * Separated from a semantic patch so a grant can allow "say something about
 * this" without allowing "change what this is" — the common safe case for an
 * agent working over objects it did not author.
 */
export function annotateApprovedObject(
  scope: ObjectAccessScope,
  actor: MutationActor,
  input: { id: string; baseVersion: number; annotation: string; idempotencyKey?: string }
) {
  const note = String(input.annotation ?? '').trim().slice(0, 4000);
  if (!note) throw new GraphMutationError('invalid-operation', 'An annotation needs text.');
  return govern(
    scope,
    actor,
    'PATCH_OBJECT',
    {
      id: input.id,
      properties: {
        annotations: [
          {
            text: note,
            actorId: actor.actorId,
            runId: actor.runId ?? scope.runId ?? null,
            at: new Date().toISOString()
          }
        ]
      }
    },
    { baseVersion: input.baseVersion, idempotencyKey: input.idempotencyKey }
  );
}

export function patchApprovedProjection(
  scope: ObjectAccessScope,
  actor: MutationActor,
  input: {
    objectId: string;
    projection?: string;
    baseVersion?: number | null;
    state: Record<string, unknown>;
    upsert?: boolean;
    idempotencyKey?: string;
  }
) {
  return govern(
    scope,
    actor,
    input.upsert ? 'UPSERT_PROJECTION' : 'PATCH_PROJECTION',
    {
      objectId: input.objectId,
      ...(input.projection ? { projection: input.projection } : {}),
      state: input.state
    },
    { baseVersion: input.baseVersion ?? null, idempotencyKey: input.idempotencyKey }
  );
}

export function createApprovedRelation(
  scope: ObjectAccessScope,
  actor: MutationActor,
  input: {
    id: string;
    type: string;
    fromObjectId: string;
    toObjectId: string;
    properties?: Record<string, unknown>;
    idempotencyKey?: string;
  }
) {
  if (!relationTypeSet.has(input.type)) {
    throw new GraphMutationError('invalid-operation', `Unknown relation type "${input.type}".`, { type: input.type });
  }
  return govern(
    scope,
    actor,
    'CREATE_RELATION',
    {
      id: input.id,
      type: input.type,
      fromObjectId: input.fromObjectId,
      toObjectId: input.toObjectId,
      ...(input.properties ? { properties: input.properties } : {})
    },
    { idempotencyKey: input.idempotencyKey }
  );
}

/** Tombstone an object while retaining the graph's version and provenance checks. */
export function tombstoneApprovedObject(
  scope: ObjectAccessScope,
  actor: MutationActor,
  input: { id: string; baseVersion: number; idempotencyKey?: string }
) {
  return govern(scope, actor, 'TOMBSTONE_OBJECT', { id: input.id }, {
    baseVersion: input.baseVersion,
    idempotencyKey: input.idempotencyKey
  });
}

// Current no-grant API. The legacy `*Approved*` functions above keep their
// positional signatures for callers being migrated, but their scope data is
// attribution only and does not limit the requested operation.
export function createObject(
  actor: MutationActor,
  input: Parameters<typeof createApprovedObject>[2],
  spaceId = 'default'
) {
  return createApprovedObject(objectAccessScope(spaceId, actor.runId), actor, input);
}

export function patchObject(
  actor: MutationActor,
  input: Parameters<typeof patchApprovedObject>[2],
  spaceId = 'default'
) {
  return patchApprovedObject(objectAccessScope(spaceId, actor.runId), actor, input);
}

export function annotateObject(
  actor: MutationActor,
  input: Parameters<typeof annotateApprovedObject>[2],
  spaceId = 'default'
) {
  return annotateApprovedObject(objectAccessScope(spaceId, actor.runId), actor, input);
}

export function patchObjectProjection(
  actor: MutationActor,
  input: Parameters<typeof patchApprovedProjection>[2],
  spaceId = 'default'
) {
  return patchApprovedProjection(objectAccessScope(spaceId, actor.runId), actor, input);
}

export function createRelation(
  actor: MutationActor,
  input: Parameters<typeof createApprovedRelation>[2],
  spaceId = 'default'
) {
  return createApprovedRelation(objectAccessScope(spaceId, actor.runId), actor, input);
}

export function tombstoneObject(
  actor: MutationActor,
  input: Parameters<typeof tombstoneApprovedObject>[2],
  spaceId = 'default'
) {
  return tombstoneApprovedObject(objectAccessScope(spaceId, actor.runId), actor, input);
}

/**
 * The scope a run gets when nothing wider was approved.
 *
 * Read-only over exactly the objects in the reviewed manifest. Every widening is
 * something a human said yes to, not something the default handed out.
 */
export function readOnlyScope(spaceId: string, objectIds: string[], runId?: string): ObjectAccessScope {
  return {
    spaceId,
    readableObjectIds: [...objectIds],
    writableObjectIds: [],
    creatableTypes: [],
    allowedRelationTypes: [],
    allowedOperations: ['read'],
    projectionScope: [],
    externalTransmission: 'blocked',
    runId: runId ?? null
  };
}
