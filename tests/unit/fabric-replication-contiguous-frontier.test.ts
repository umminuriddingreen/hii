import { describe, expect, it } from 'vitest';
import { calculateFrontier, operationIsMissing } from '@/lib/fabric/replication/store';
import type { ReplicatedOperation } from '@/lib/fabric/replication';

function operation(sequence: number): ReplicatedOperation {
  return {
    version: 1,
    operationId: `device-a:${sequence}`,
    accountId: 'account-a',
    workspaceId: 'workspace-a',
    deviceId: 'device-a',
    sequence,
    causalFrontier: {},
    createdAt: '2026-08-21T00:00:00.000Z',
    mutation: { type: 'object.delete', nodeId: `node-${sequence}` },
    signature: 'test-signature'
  };
}

describe('durable replication frontier', () => {
  it('never advertises progress across a missing sequence', () => {
    const second = operation(2);
    expect(calculateFrontier([second])).toEqual({ 'device-a': 0 });
    expect(operationIsMissing(second, { 'device-a': 0 })).toBe(true);
    expect(calculateFrontier([second, operation(1)])).toEqual({ 'device-a': 2 });
  });
});
