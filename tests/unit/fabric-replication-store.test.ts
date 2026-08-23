import { describe, expect, it } from 'vitest';
import {
  IndexedDbReplicationStore,
  ReplicaCoordinator,
  ReplicationStoreError,
  WorkspaceReplica,
  calculateFrontier,
  operationIsMissing,
  type ReplicatedOperation,
  type ReplicationFrontier,
  type ReplicationNamespace,
  type ReplicationOperationStore
} from '../../lib/fabric/replication/index.ts';

const accountId = 'account:ummi';
const workspaceId = 'workspace:home';
const namespace = { accountId, workspaceId };
const verify = (operation: Readonly<ReplicatedOperation>) => operation.signature === `signed:${operation.operationId}`;

function operation(deviceId: string, sequence: number, targetId = `${deviceId}-${sequence}`, scope: ReplicationNamespace = namespace): ReplicatedOperation {
  const operationId = `${deviceId}:${sequence}`;
  return {
    schemaVersion: 1,
    ...scope,
    operationId,
    deviceId,
    sequence,
    causalFrontier: {},
    kind: 'object.create',
    targetId,
    payload: { node: { id: targetId, type: 'note', x: sequence, y: 0, w: 240, h: 160, z: sequence, createdAt: '2026-08-21T12:00:00.000Z', updatedAt: '2026-08-21T12:00:00.000Z', payload: { title: targetId, body: '' } } },
    keyEpoch: 1,
    createdAt: '2026-08-21T12:00:00.000Z',
    signature: `signed:${operationId}`
  };
}

class TestStore implements ReplicationOperationStore {
  private readonly operations = new Map<string, ReplicatedOperation[]>();
  private readonly sequences = new Map<string, number>();
  failAppend = false;

  async append(scope: Readonly<ReplicationNamespace>, value: Readonly<ReplicatedOperation>) {
    if (this.failAppend) throw new ReplicationStoreError('write-failed', 'injected failure');
    const key = this.key(scope);
    const entries = this.operations.get(key) ?? [];
    const existing = entries.find((entry) => entry.operationId === value.operationId);
    if (existing) return { appended: false };
    entries.push(structuredClone(value));
    this.operations.set(key, entries);
    return { appended: true };
  }

  async readAll(scope: Readonly<ReplicationNamespace>) {
    return structuredClone(this.operations.get(this.key(scope)) ?? []).sort((left, right) => left.operationId.localeCompare(right.operationId));
  }

  async readMissing(scope: Readonly<ReplicationNamespace>, frontier: ReplicationFrontier) {
    return (await this.readAll(scope)).filter((entry) => operationIsMissing(entry, frontier));
  }

  async frontier(scope: Readonly<ReplicationNamespace>) {
    return calculateFrontier(await this.readAll(scope));
  }

  async allocateSequence(scope: Readonly<ReplicationNamespace>, deviceId: string) {
    const key = `${this.key(scope)}:${deviceId}`;
    const next = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, next);
    return next;
  }

  private key(scope: Readonly<ReplicationNamespace>) {
    return `${scope.accountId}/${scope.workspaceId}`;
  }
}

function coordinator(store: ReplicationOperationStore, scope: ReplicationNamespace = namespace) {
  const replica = new WorkspaceReplica({ ...scope, verifier: verify });
  return { replica, coordinator: new ReplicaCoordinator({ store, replica, verifier: verify }) };
}

describe('durable fabric replication', () => {
  it('restores the authoritative operation log after a fresh-process reload', async () => {
    const store = new TestStore();
    const first = coordinator(store).coordinator;
    await first.append(operation('iphone', 1));
    await first.append(operation('mac', 1));

    const reloaded = coordinator(store).coordinator;
    const snapshot = await reloaded.restore();
    expect(snapshot.operationCount).toBe(2);
    expect(snapshot.workspace.nodes.map((node) => node.id)).toEqual(['iphone-1', 'mac-1']);
    expect(snapshot.frontier).toEqual({ iphone: 1, mac: 1 });
  });

  it('never materializes an operation before the durable append succeeds', async () => {
    const store = new TestStore();
    store.failAppend = true;
    const instance = coordinator(store);
    await expect(instance.coordinator.append(operation('mac', 1))).rejects.toMatchObject({ code: 'write-failed' });
    expect(instance.replica.snapshot().operationCount).toBe(0);
  });

  it('exports only operations missing from a remote causal frontier', async () => {
    const store = new TestStore();
    const instance = coordinator(store).coordinator;
    await instance.append(operation('mac', 1));
    await instance.append(operation('mac', 2));
    await instance.append(operation('pc', 1));
    await expect(instance.exportMissing({ mac: 1, pc: 1 })).resolves.toEqual([
      expect.objectContaining({ operationId: 'mac:2', deviceId: 'mac', sequence: 2, targetId: 'mac-2' })
    ]);
    await expect(instance.durableFrontier()).resolves.toEqual({ mac: 2, pc: 1 });
  });

  it('allocates monotonic device sequences independently by namespace', async () => {
    const store = new TestStore();
    const home = coordinator(store).coordinator;
    const other = coordinator(store, { accountId, workspaceId: 'workspace:other' }).coordinator;
    await expect(Promise.all([home.allocateSequence('iphone'), home.allocateSequence('iphone')])).resolves.toEqual([1, 2]);
    await expect(other.allocateSequence('iphone')).resolves.toBe(1);
  });

  it('isolates durable operations by account and workspace', async () => {
    const store = new TestStore();
    const home = coordinator(store).coordinator;
    const otherScope = { accountId: 'account:other', workspaceId };
    const other = coordinator(store, otherScope).coordinator;
    await home.append(operation('mac', 1));
    await other.append(operation('pc', 1, 'private', otherScope));
    await expect(home.exportMissing({})).resolves.toEqual([
      expect.objectContaining({ operationId: 'mac:1', accountId, workspaceId })
    ]);
    expect((await coordinator(store).coordinator.restore()).workspace.nodes.map((node) => node.id)).toEqual(['mac-1']);
  });

  it('fails safely when IndexedDB is unavailable instead of falling back to localStorage', async () => {
    const store = new IndexedDbReplicationStore(undefined);
    await expect(store.readAll(namespace)).rejects.toMatchObject({ code: 'storage-unavailable' });
  });
});
