/**
 * The governed object interface agents actually get.
 *
 * Agents do not edit Workspace JSON, and they do not reach the graph's mutation
 * API directly either. Everything goes through here, where object scope is
 * checked *independently of filesystem scope*. Those are different questions: a
 * run allowed to write files under a repo has said nothing about which objects
 * it may read, and a grant over three objects does not imply a shell.
 *
 * Every mutation records who asked, under what grant, for which intent and run,
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
  projectionTarget,
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

/**
 * What a subject may do with objects, for the duration of one run.
 *
 * Deliberately explicit rather than inherited: an empty list means "none", so a
 * scope that forgets to mention something denies it. Slice 7 turns this into a
 * durable, human-approved grant with a spatial representation; the enforcement
 * shape does not change when it does.
 */
export type ObjectAccessScope = {
  /** Grant this scope came from, recorded on every operation it authorises. */
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

function deny(message: string, details: Record<string, unknown> = {}): never {
  throw new ObjectAuthorityError(message, details);
}

function requireLiveScope(scope: ObjectAccessScope, now = Date.now()) {
  if (scope.expiresAt && Date.parse(scope.expiresAt) <= now) {
    deny('This grant has expired. A new approval is required.', { expiresAt: scope.expiresAt });
  }
}

function requireOperation(scope: ObjectAccessScope, operation: ObjectOperation) {
  if (!scope.allowedOperations.includes(operation)) {
    deny(`This grant does not allow ${operation}.`, {
      operation,
      allowed: scope.allowedOperations
    });
  }
}

function requireReadable(scope: ObjectAccessScope, objectId: string) {
  if (!scope.readableObjectIds.includes(objectId)) {
    deny(`Object ${objectId} is outside the approved read scope.`, { objectId });
  }
}

function requireWritable(scope: ObjectAccessScope, objectId: string) {
  if (!scope.writableObjectIds.includes(objectId)) {
    deny(`Object ${objectId} is outside the approved write scope.`, { objectId });
  }
}

/**
 * Frame placement is checked separately from write access.
 *
 * Being allowed to change an object does not imply being allowed to move it
 * somewhere else — "may edit this" and "may put it there" are different
 * permissions, and conflating them is how an agent tidies its work into a scene
 * nobody granted it.
 */
function requireFrame(scope: ObjectAccessScope, frameId: unknown) {
  const frame = String(frameId ?? '').trim();
  if (!frame) return;
  if (!scope.projectionScope.includes(frame)) {
    deny(`Frame ${frame} is outside the approved projection scope.`, {
      frameId: frame,
      allowed: scope.projectionScope
    });
  }
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

/** Objects inside the approved read scope. Nothing outside it is even listed. */
export function listApprovedObjects(scope: ObjectAccessScope): ObjectSummary[] {
  requireLiveScope(scope);
  requireOperation(scope, 'read');
  const readable = new Set(scope.readableObjectIds);
  return readOperationalSpace(scope.spaceId)
    .objects.filter((object) => readable.has(object.id))
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

export function readApprovedObject(scope: ObjectAccessScope, objectId: string) {
  requireLiveScope(scope);
  requireOperation(scope, 'read');
  requireReadable(scope, objectId);
  const snapshot = readOperationalSpace(scope.spaceId);
  const object = snapshot.objects.find((candidate) => candidate.id === objectId);
  if (!object) throw new GraphMutationError('missing-target', `Object ${objectId} does not exist.`, { objectId });
  return {
    object,
    projections: snapshot.projections.filter((entry) => entry.objectId === objectId),
    // Only relations whose *other* end is also readable. An edge is a fact about
    // two objects, and revealing one outside the scope through an edge is still
    // revealing it.
    relations: snapshot.relations.filter(
      (relation) =>
        (relation.fromObjectId === objectId || relation.toObjectId === objectId) &&
        scope.readableObjectIds.includes(relation.fromObjectId) &&
        scope.readableObjectIds.includes(relation.toObjectId)
    ),
    history: readOperationHistory(scope.spaceId, objectId)
  };
}

// --- writes ----------------------------------------------------------------

function govern(
  scope: ObjectAccessScope,
  actor: MutationActor,
  type: MutationType,
  payload: Record<string, unknown>,
  options: { baseVersion?: number | null; idempotencyKey?: string | null } = {}
): MutationResult {
  return applyGraphMutation({
    spaceId: scope.spaceId,
    type,
    actor: actorFor(scope, actor),
    baseVersion: options.baseVersion ?? null,
    idempotencyKey: options.idempotencyKey ?? null,
    payload
  });
}

export function createApprovedObject(
  scope: ObjectAccessScope,
  actor: MutationActor,
  input: { id: string; type: string; properties?: Record<string, unknown>; frameId?: string; idempotencyKey?: string }
) {
  requireLiveScope(scope);
  requireOperation(scope, 'create');
  if (!scope.creatableTypes.includes(input.type)) {
    deny(`This grant does not allow creating "${input.type}" objects.`, {
      type: input.type,
      allowed: scope.creatableTypes
    });
  }
  requireFrame(scope, input.frameId);
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
  // A newly created object is in scope for the rest of this run: an agent that
  // may create must be able to finish what it created.
  if (result.applied || result.replayed) {
    if (!scope.readableObjectIds.includes(input.id)) scope.readableObjectIds.push(input.id);
    if (!scope.writableObjectIds.includes(input.id)) scope.writableObjectIds.push(input.id);
  }
  return result;
}

export function patchApprovedObject(
  scope: ObjectAccessScope,
  actor: MutationActor,
  input: { id: string; baseVersion: number; properties?: Record<string, unknown>; type?: string; idempotencyKey?: string }
) {
  requireLiveScope(scope);
  requireOperation(scope, 'patch-semantic');
  requireWritable(scope, input.id);
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
  requireLiveScope(scope);
  requireOperation(scope, 'annotate');
  requireWritable(scope, input.id);
  const note = String(input.annotation ?? '').trim().slice(0, 4000);
  if (!note) deny('An annotation needs text.');
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
  requireLiveScope(scope);
  requireOperation(scope, 'patch-projection');
  requireWritable(scope, input.objectId);
  requireFrame(scope, input.state.frameId ?? input.state.sceneId);
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
  requireLiveScope(scope);
  requireOperation(scope, 'relate');
  if (!relationTypeSet.has(input.type) || !scope.allowedRelationTypes.includes(input.type as RelationType)) {
    deny(`This grant does not allow ${input.type} relations.`, {
      type: input.type,
      allowed: scope.allowedRelationTypes
    });
  }
  // Both ends must be in scope. Relating an in-scope object to one the subject
  // was never granted would let an edge assert something about a stranger.
  requireReadable(scope, input.fromObjectId);
  requireReadable(scope, input.toObjectId);
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

/**
 * Tombstoning is the only operation that is denied by default even when the
 * object is writable: removing something a human made is not a normal step of
 * doing the work, so it needs its own explicit permission.
 */
export function tombstoneApprovedObject(
  scope: ObjectAccessScope,
  actor: MutationActor,
  input: { id: string; baseVersion: number; idempotencyKey?: string }
) {
  requireLiveScope(scope);
  requireOperation(scope, 'tombstone');
  requireWritable(scope, input.id);
  return govern(scope, actor, 'TOMBSTONE_OBJECT', { id: input.id }, {
    baseVersion: input.baseVersion,
    idempotencyKey: input.idempotencyKey
  });
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
