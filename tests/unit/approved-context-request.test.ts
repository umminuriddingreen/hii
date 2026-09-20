import { describe, expect, it } from 'vitest';
import { agentRequestFromContextPack, type ContextPackV1 } from '@/lib/client/hii-bridge';

const pack = {
  version: 1, id: 'reviewed-pack', status: 'approved', intent: 'Compare the selected study',
  mode: 'plan', spaceId: 'study', workspaceRoot: '/projects/study', fingerprint: 'reviewed-hash',
  risk: { action: 'review', reasons: [] },
  items: [
    { ref: { kind: 'object', id: 'object:study:kept' }, selected: true },
    { ref: { kind: 'object', id: 'object:study:ambient' }, selected: false }
  ]
} as ContextPackV1;

describe('execution from approved context', () => {
  it('uses only the reviewed selection and bound workspace, after an item is removed', () => {
    const request = agentRequestFromContextPack(pack);
    expect(request).toEqual({
      version: 1, intent: pack.intent, mode: 'plan', spaceId: 'study', workspaceRoot: '/projects/study',
      contextNodeIds: ['kept'], contextPackId: 'reviewed-pack', contextFingerprint: 'reviewed-hash'
    });
  });

  it('refuses stale, unapproved, and blocked context', () => {
    for (const status of ['draft', 'stale', 'blocked'] as const) {
      expect(() => agentRequestFromContextPack({ ...pack, status })).toThrow('approve');
    }
    expect(() => agentRequestFromContextPack({ ...pack, risk: { action: 'blocked', reasons: [] } })).toThrow('approve');
  });

  it('preserves an intentionally empty reviewed selection', () => {
    expect(agentRequestFromContextPack({ ...pack, items: [] }).contextNodeIds).toEqual([]);
  });
});
