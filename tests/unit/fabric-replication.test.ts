import { describe, expect, it } from 'vitest';
import {
  MAX_PAYLOAD_BYTES,
  ReplicationError,
  WorkspaceReplica,
  type ReplicatedOperation,
  type ReplicatedOperationKind
} from '../../lib/fabric/replication/index.ts';
import type { WorkspaceNode } from '../../lib/workspace/types.ts';

const accountId = 'account:ummi';
const workspaceId = 'workspace:home';
const devices = ['mac', 'pc', 'iphone'] as const;
const verify = (operation: Readonly<ReplicatedOperation>) => operation.signature === `signed:${operation.operationId}`;

function node(id: string, title = 'Initial'): WorkspaceNode {
  return { id, type: 'note', x: 0, y: 0, w: 240, h: 160, z: 1, createdAt: '2026-08-21T12:00:00.000Z', updatedAt: '2026-08-21T12:00:00.000Z', payload: { title, body: '' } };
}

function op(deviceId: string, sequence: number, kind: ReplicatedOperationKind, targetId: string, payload: Record<string, unknown>, causalFrontier: Record<string, number> = {}): ReplicatedOperation {
  const operationId = `${deviceId}:${sequence}`;
  return { schemaVersion: 1, accountId, workspaceId, operationId, deviceId, sequence, causalFrontier, kind, targetId, payload, keyEpoch: 1, createdAt: `2026-08-21T12:00:${String(sequence).padStart(2, '0')}.000Z`, signature: `signed:${operationId}` };
}

function shuffled<T>(items: T[], seed: number) {
  const copy = [...items];
  let state = seed;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swap = state % (index + 1);
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

describe('fabric declarative replication', () => {
  it('converges across Mac, PC, and iPhone for randomized arrival orders', () => {
    const operations = [
      op('mac', 1, 'object.create', 'note-1', { node: node('note-1') }),
      op('pc', 1, 'object.move', 'note-1', { x: 400, y: 220 }),
      op('iphone', 1, 'object.update', 'note-1', { patch: { payload: { title: 'Phone title' } } }),
      op('mac', 2, 'object.update', 'note-1', { patch: { payload: { body: 'Mac body' } } }, { mac: 1 }),
      op('iphone', 2, 'object.create', 'note-2', { node: node('note-2', 'Offline') }, { iphone: 1 }),
      op('pc', 2, 'link.create', 'link-1', { link: { id: 'link-1', fromId: 'note-1', toId: 'note-2', arrow: 'end' } }, { pc: 1 })
    ];
    const snapshots = devices.map((_, index) => {
      const replica = new WorkspaceReplica({ accountId, workspaceId, verifier: verify });
      for (const operation of shuffled(operations, index + 7)) replica.apply(operation);
      return replica.snapshot();
    });
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
    expect(snapshots[0].workspace.nodes.find((entry) => entry.id === 'note-1')).toMatchObject({ x: 400, y: 220, payload: { title: 'Phone title', body: 'Mac body' } });
    expect(snapshots[0].workspace.links).toHaveLength(1);
  });

  it('deduplicates delivery, advances frontiers, and accepts offline sequence gaps', () => {
    const replica = new WorkspaceReplica({ accountId, workspaceId, verifier: verify });
    const offline = op('iphone', 3, 'object.create', 'offline', { node: node('offline') }, { iphone: 2, mac: 4 });
    expect(replica.apply(offline)).toMatchObject({ applied: true, frontier: {} });
    expect(replica.apply(offline)).toMatchObject({ applied: false, replayed: true, frontier: {} });
    expect(replica.snapshot().operationCount).toBe(1);
  });

  it('keeps sequence holes discoverable when a coordinator receives seq2 before seq1', () => {
    const source = new WorkspaceReplica({ accountId, workspaceId, verifier: verify });
    const coordinator = new WorkspaceReplica({ accountId, workspaceId, verifier: verify });
    const first = op('mac', 1, 'object.create', 'ordered', { node: node('ordered') });
    const second = op('mac', 2, 'object.update', 'ordered', { patch: { payload: { title: 'Second' } } }, { mac: 1 });
    source.apply(first);
    source.apply(second);

    coordinator.apply(second);
    expect(coordinator.frontier()).toEqual({});
    expect(source.readMissing(coordinator.frontier()).map((operation) => operation.operationId)).toEqual(['mac:1', 'mac:2']);

    for (const operation of source.readMissing(coordinator.frontier())) coordinator.apply(operation);
    expect(coordinator.frontier()).toEqual({ mac: 2 });
    expect(source.readMissing(coordinator.frontier())).toEqual([]);
    expect(coordinator.snapshot().workspace.nodes[0]).toMatchObject({ id: 'ordered', payload: { title: 'Second' } });
  });

  it('merges independent fields and preserves a deterministic concurrent text conflict', () => {
    const operations = [
      op('mac', 1, 'object.create', 'note', { node: node('note') }),
      op('mac', 2, 'object.update', 'note', { patch: { w: 320, payload: { title: 'Mac' } } }, { mac: 1 }),
      op('pc', 1, 'object.update', 'note', { patch: { h: 200, payload: { title: 'PC' } } })
    ];
    const replica = new WorkspaceReplica({ accountId, workspaceId, verifier: verify });
    operations.forEach((operation) => replica.apply(operation));
    const snapshot = replica.snapshot();
    expect(snapshot.workspace.nodes[0]).toMatchObject({ w: 320, h: 200, payload: { title: 'PC' } });
    expect(snapshot.conflicts).toContainEqual(expect.objectContaining({ kind: 'concurrent-field', field: 'payload.title', winnerOperationId: 'pc:1', loserOperationId: 'mac:2', winnerValue: 'PC', loserValue: 'Mac' }));
  });

  it('makes deletion permanent, removes dangling links, and reports ID reuse', () => {
    const replica = new WorkspaceReplica({ accountId, workspaceId, verifier: verify });
    [
      op('mac', 1, 'object.create', 'a', { node: node('a') }),
      op('mac', 2, 'object.create', 'b', { node: node('b') }, { mac: 1 }),
      op('mac', 3, 'link.create', 'a-b', { link: { id: 'a-b', fromId: 'a', toId: 'b' } }, { mac: 2 }),
      op('pc', 1, 'object.delete', 'a', {}),
      op('iphone', 1, 'object.update', 'a', { patch: { payload: { title: 'Cannot resurrect' } } }),
      op('pc', 2, 'object.create', 'a', { node: node('a', 'Reused') }, { pc: 1 })
    ].forEach((operation) => replica.apply(operation));
    const snapshot = replica.snapshot();
    expect(snapshot.workspace.nodes.map((entry) => entry.id)).toEqual(['b']);
    expect(snapshot.workspace.links).toEqual([]);
    expect(snapshot.conflicts).toContainEqual(expect.objectContaining({ kind: 'id-reuse', targetId: 'a', loserOperationId: 'pc:2' }));
  });

  it('keeps viewport local while materializing replicated objects', () => {
    const replica = new WorkspaceReplica({ accountId, workspaceId, verifier: verify, base: { version: 1, revision: 9, updatedAt: '2026-01-01T00:00:00.000Z', viewport: { x: 81, y: -22, zoom: 0.8 }, nextZ: 1, nodes: [], links: [] } });
    replica.apply(op('mac', 1, 'object.create', 'a', { node: node('a') }));
    expect(replica.snapshot().workspace.viewport).toEqual({ x: 81, y: -22, zoom: 0.8 });
  });

  it('rejects invalid signatures, frontiers, sequences, and oversized payloads with safe codes', () => {
    const replica = new WorkspaceReplica({ accountId, workspaceId, verifier: verify });
    const unsigned = { ...op('mac', 1, 'object.create', 'a', { node: node('a') }), signature: 'wrong' };
    expect(() => replica.apply(unsigned)).toThrowError(expect.objectContaining({ code: 'invalid-signature' }));
    expect(() => replica.apply({ ...op('mac', 1, 'object.create', 'a', { node: node('a') }), operationId: 'mac:2' })).toThrowError(expect.objectContaining({ code: 'invalid-operation' }));
    expect(() => replica.apply({ ...op('mac', 2, 'object.create', 'a', { node: node('a') }), causalFrontier: { mac: 2 } })).toThrowError(expect.objectContaining({ code: 'invalid-operation' }));
    const oversized = op('mac', 1, 'object.update', 'a', { patch: { payload: { text: 'x'.repeat(MAX_PAYLOAD_BYTES) } } });
    expect(() => replica.apply(oversized)).toThrowError(expect.objectContaining({ code: 'payload-too-large' }));
  });
});
