import { WorkspaceReplica } from './replica.ts';
import { asCorruptStore } from './store.ts';
import {
  ReplicationError,
  ReplicationStoreError,
  type ReplicatedOperation,
  type ReplicationAppendResult,
  type ReplicationFrontier,
  type ReplicationNamespace,
  type ReplicationOperationStore,
  type ReplicationSnapshot,
  type SignatureVerifier
} from './types.ts';
import { validateReplicatedOperation } from './validation.ts';

export class ReplicaCoordinator {
  readonly namespace: Readonly<ReplicationNamespace>;
  private readonly store: ReplicationOperationStore;
  private readonly replica: WorkspaceReplica;
  private readonly verifier: SignatureVerifier;

  constructor(options: {
    store: ReplicationOperationStore;
    replica: WorkspaceReplica;
    verifier: SignatureVerifier;
  }) {
    this.store = options.store;
    this.replica = options.replica;
    this.verifier = options.verifier;
    this.namespace = { accountId: options.replica.accountId, workspaceId: options.replica.workspaceId };
  }

  async restore(): Promise<ReplicationSnapshot> {
    let operations: ReplicatedOperation[];
    try {
      operations = await this.store.readAll(this.namespace);
    } catch (error) {
      if (error instanceof ReplicationStoreError) throw error;
      throw asCorruptStore(error, 'read');
    }
    try {
      for (const operation of operations) this.replica.apply(operation);
    } catch (error) {
      if (error instanceof ReplicationError) throw new ReplicationStoreError('corrupt-store', 'Durable replication data failed validation or signature verification.');
      throw error;
    }
    return this.replica.snapshot();
  }

  async append(operationValue: unknown): Promise<ReplicationAppendResult> {
    const operation = validateReplicatedOperation(operationValue);
    if (operation.accountId !== this.namespace.accountId || operation.workspaceId !== this.namespace.workspaceId) {
      throw new ReplicationError('invalid-operation', 'Operation belongs to a different account or workspace.');
    }
    if (!this.verifier(operation)) throw new ReplicationError('invalid-signature', 'Operation signature was not accepted.');
    const result = await this.store.append(this.namespace, operation);
    this.replica.apply(operation);
    return result;
  }

  exportMissing(frontier: ReplicationFrontier): Promise<ReplicatedOperation[]> {
    return this.store.readMissing(this.namespace, frontier);
  }

  durableFrontier(): Promise<ReplicationFrontier> {
    return this.store.frontier(this.namespace);
  }

  allocateSequence(deviceId: string): Promise<number> {
    return this.store.allocateSequence(this.namespace, deviceId);
  }

  snapshot(): ReplicationSnapshot {
    return this.replica.snapshot();
  }
}
