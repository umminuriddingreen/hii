/**
 * The Operational Graph's record shapes.
 *
 * Version numbers are split into three independent domains. A move must not
 * invalidate the semantic context an approved run was reviewed against, and a
 * semantic edit must not look like the object was dragged. Collapsing them into
 * one number would make both of those indistinguishable.
 */

/** Where the authoritative copy of a record lives during the migration. */
export type CanonicalSource = 'workspace-json' | 'graph';

/** How a record came to exist. Kept separate from who wrote it. */
export type ProvenanceClass =
  | 'authored'
  | 'inferred'
  | 'execution_generated'
  | 'verified'
  | 'migration';

export const provenanceClasses: readonly ProvenanceClass[] = [
  'authored',
  'inferred',
  'execution_generated',
  'verified',
  'migration'
] as const;

/**
 * The controlled relation vocabulary.
 *
 * A closed set on purpose: a free-text relation type cannot be reasoned about,
 * and a user-typed arrow label reaching this list is how forged provenance would
 * get in. Anything a human draws becomes AUTHORED_LINK with its label kept as a
 * property.
 */
export type RelationType =
  | 'CONTAINS'
  | 'REFERENCES'
  | 'CONTEXT_FOR'
  | 'DERIVED_FROM'
  | 'GENERATED_BY'
  | 'VERIFIED_BY'
  | 'USES'
  | 'PARENT_OF'
  | 'VARIANT_OF'
  | 'COMBINES'
  | 'AUTHORED_LINK';

export const relationTypes: readonly RelationType[] = [
  'CONTAINS',
  'REFERENCES',
  'CONTEXT_FOR',
  'DERIVED_FROM',
  'GENERATED_BY',
  'VERIFIED_BY',
  'USES',
  'PARENT_OF',
  'VARIANT_OF',
  'COMBINES',
  'AUTHORED_LINK'
] as const;

/** Relations that assert something was proven, not merely connected. */
export const provenanceAssertingRelations: readonly RelationType[] = ['VERIFIED_BY'] as const;

export type OperationalObject = {
  id: string;
  spaceId: string;
  type: string;
  schemaVersion: number;
  /** Bumped only by semantic change: properties, type, ownership, tombstone. */
  semanticVersion: number;
  canonicalSource: CanonicalSource;
  provenanceClass: ProvenanceClass;
  properties: Record<string, unknown>;
  provenance: Record<string, unknown>;
  ownerActorId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type OperationalRelation = {
  id: string;
  spaceId: string;
  type: RelationType;
  fromObjectId: string;
  toObjectId: string;
  /** Bumped by relation metadata, provenance state, or tombstone change. */
  relationVersion: number;
  canonicalSource: CanonicalSource;
  provenanceClass: ProvenanceClass;
  properties: Record<string, unknown>;
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type OperationalOperation = {
  id: string;
  spaceId: string;
  actorId: string;
  deviceId: string | null;
  type: string;
  targetId: string | null;
  baseVersion: number | null;
  /** The version the target carried after this operation applied. */
  resultVersion: number | null;
  lamport: number;
  payload: Record<string, unknown>;
  authorityGrantId: string | null;
  /** Caller-supplied replay key. Same key + same operation is a no-op. */
  idempotencyKey: string | null;
  /** Content hash of the operation, so a replayed key can be checked. */
  operationHash: string | null;
  provenanceClass: ProvenanceClass | null;
  authority: Record<string, unknown>;
  createdAt: string;
};

export type ObjectProjection = {
  spaceId: string;
  objectId: string;
  projection: string;
  /** Bumped only by presentation change: position, size, z, frame, visibility. */
  projectionVersion: number;
  canonicalSource: CanonicalSource;
  state: Record<string, unknown>;
  updatedAt: string;
  deletedAt: string | null;
};

export type OperationalSpaceSnapshot = {
  spaceId: string;
  objects: OperationalObject[];
  relations: OperationalRelation[];
  projections: ObjectProjection[];
  operations: OperationalOperation[];
};

/** Every way a mutation can be refused, as a code a caller can branch on. */
export type GraphMutationErrorCode =
  | 'missing-target'
  | 'stale-version'
  | 'tombstoned-target'
  | 'idempotency-conflict'
  | 'invalid-operation'
  | 'invalid-relation'
  | 'dangling-relation'
  | 'canonical-owner-mismatch'
  | 'authority-mismatch';

export class GraphMutationError extends Error {
  readonly code: GraphMutationErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: GraphMutationErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GraphMutationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Who is asking, under what grant, and with what proof.
 *
 * Carried on every mutation rather than looked up, so the operation record can
 * state the authority that was actually presented at the time.
 */
export type MutationActor = {
  actorId: string;
  deviceId?: string | null;
  /** The grant this mutation claims. Slice 7 makes grants enforceable objects. */
  authorityGrantId?: string | null;
  intentId?: string | null;
  runId?: string | null;
  receiptId?: string | null;
  /** Completion proof, when the mutation claims a run verified something. */
  proof?: {
    completed?: boolean;
    legacy?: boolean;
    proofStrength?: string | null;
    reasons?: string[];
  } | null;
};
