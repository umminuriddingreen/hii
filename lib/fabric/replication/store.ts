import {
  ReplicationStoreError,
  type ReplicatedOperation,
  type ReplicationFrontier,
  type ReplicationNamespace,
  type ReplicationOperationStore
} from './types.ts';

export type { ReplicationOperationStore } from './types.ts';

export function namespaceKey(namespace: Readonly<ReplicationNamespace>): string {
  return `${namespace.accountId}\u001f${namespace.workspaceId}`;
}

export function compareOperations(left: Readonly<ReplicatedOperation>, right: Readonly<ReplicatedOperation>): number {
  return left.operationId.localeCompare(right.operationId);
}

export function operationIsMissing(operation: Readonly<ReplicatedOperation>, frontier: ReplicationFrontier): boolean {
  return operation.sequence > (frontier[operation.deviceId] ?? 0);
}

export function calculateFrontier(operations: ReadonlyArray<Readonly<ReplicatedOperation>>): ReplicationFrontier {
  const received = new Map<string, Set<number>>();
  for (const operation of operations) {
    const sequences = received.get(operation.deviceId) ?? new Set<number>();
    sequences.add(operation.sequence);
    received.set(operation.deviceId, sequences);
  }
  const frontier: Record<string, number> = {};
  for (const [deviceId, sequences] of received) {
    let contiguous = 0;
    while (sequences.has(contiguous + 1)) contiguous += 1;
    frontier[deviceId] = contiguous;
  }
  return Object.fromEntries(Object.entries(frontier).sort(([left], [right]) => left.localeCompare(right)));
}

export function asCorruptStore(error: unknown, context: string): ReplicationStoreError {
  if (error instanceof ReplicationStoreError) return error;
  return new ReplicationStoreError('corrupt-store', `Stored replication data could not be ${context}.`);
}

export function isOperationStore(value: unknown): value is ReplicationOperationStore {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Record<keyof ReplicationOperationStore, unknown>>;
  return ['append', 'readAll', 'readMissing', 'frontier', 'allocateSequence'].every((key) => typeof candidate[key as keyof ReplicationOperationStore] === 'function');
}
