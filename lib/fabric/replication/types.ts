import type { WorkspaceDoc, WorkspaceLink, WorkspaceNode } from '../../workspace/types.ts';

export const REPLICATION_SCHEMA_VERSION = 1 as const;
export const MAX_OPERATION_BYTES = 64 * 1024;
export const MAX_PAYLOAD_BYTES = 48 * 1024;
export const MAX_FRONTIER_DEVICES = 64;
export const MAX_PATCH_FIELDS = 64;

export type ReplicatedOperationKind =
  | 'object.create'
  | 'object.move'
  | 'object.update'
  | 'object.delete'
  | 'link.create'
  | 'link.delete';

export type ReplicatedOperation = {
  schemaVersion: typeof REPLICATION_SCHEMA_VERSION;
  accountId: string;
  workspaceId: string;
  operationId: string;
  deviceId: string;
  sequence: number;
  causalFrontier: Record<string, number>;
  kind: ReplicatedOperationKind;
  targetId: string;
  payload: Record<string, unknown>;
  keyEpoch: number;
  createdAt: string;
  signature: string;
};

export type ObjectCreatePayload = { node: WorkspaceNode };
export type ObjectMovePayload = Pick<WorkspaceNode, 'x' | 'y'> &
  Partial<Pick<WorkspaceNode, 'z' | 'rotation'>>;
export type ObjectUpdatePayload = { patch: Partial<Omit<WorkspaceNode, 'id' | 'createdAt'>> };
export type LinkCreatePayload = { link: WorkspaceLink };

export type ReplicationConflict = {
  kind: 'concurrent-field' | 'id-reuse';
  targetId: string;
  field: string;
  winnerOperationId: string;
  winnerValue: unknown;
  loserOperationId: string;
  loserValue: unknown;
};

export type SignatureVerifier = (operation: Readonly<ReplicatedOperation>) => boolean;

export type ReplicationNamespace = {
  accountId: string;
  workspaceId: string;
};

export type ReplicationFrontier = Readonly<Record<string, number>>;

export type ReplicationAppendResult = {
  appended: boolean;
};

export type ReplicationOperationStore = {
  append(namespace: Readonly<ReplicationNamespace>, operation: Readonly<ReplicatedOperation>): Promise<ReplicationAppendResult>;
  readAll(namespace: Readonly<ReplicationNamespace>): Promise<ReplicatedOperation[]>;
  readMissing(namespace: Readonly<ReplicationNamespace>, frontier: ReplicationFrontier): Promise<ReplicatedOperation[]>;
  frontier(namespace: Readonly<ReplicationNamespace>): Promise<ReplicationFrontier>;
  allocateSequence(namespace: Readonly<ReplicationNamespace>, deviceId: string): Promise<number>;
};

export type ReplicationApplyResult = {
  applied: boolean;
  replayed: boolean;
  frontier: Readonly<Record<string, number>>;
};

export type ReplicationSnapshot = {
  workspace: WorkspaceDoc;
  conflicts: ReplicationConflict[];
  frontier: Readonly<Record<string, number>>;
  operationCount: number;
};

export type ReplicationErrorCode =
  | 'invalid-operation'
  | 'operation-too-large'
  | 'payload-too-large'
  | 'invalid-signature'
  | 'sequence-conflict';

export type ReplicationStoreErrorCode =
  | 'storage-unavailable'
  | 'quota-exceeded'
  | 'corrupt-store'
  | 'write-failed';

export class ReplicationError extends Error {
  readonly code: ReplicationErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ReplicationErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ReplicationError';
    this.code = code;
    this.details = details;
  }
}

export class ReplicationStoreError extends Error {
  readonly code: ReplicationStoreErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ReplicationStoreErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ReplicationStoreError';
    this.code = code;
    this.details = details;
  }
}
