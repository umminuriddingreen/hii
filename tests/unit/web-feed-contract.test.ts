import { describe, expect, it } from 'vitest';
import { feedSnapshotFromNode, nodeSeedFromFeedSnapshot, type FeedItem } from '../../lib/web/feed-contract';
import type { WorkspaceNode } from '../../lib/workspace/types';

function node(type: WorkspaceNode['type'], payload: Record<string, unknown>): WorkspaceNode {
  return { id: 'local-secret-id', type, x: 1, y: 2, w: 100, h: 100, z: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), spaceId: 'private-space', creatorId: 'private-account', payload };
}

describe('web feed contract', () => {
  it('publishes only the allowlisted snapshot rather than private node metadata', () => {
    expect(feedSnapshotFromNode(node('canvas-text', { text: 'hello', localPath: '/secret' }))).toEqual({ kind: 'text', text: 'hello' });
    expect(JSON.stringify(feedSnapshotFromNode(node('canvas-text', { text: 'hello' })))).not.toMatch(/space|creator|secret/i);
    expect(feedSnapshotFromNode(node('image', { src: 'https://tracker.invalid/pixel' }))).toBeNull();
  });

  it('imports a feed item with bounded account-asserted provenance', () => {
    const item: FeedItem = {
      id: 'feed-id',
      authorHandle: 'ummi',
      snapshot: { kind: 'text', text: 'shared' },
      provenance: { source: 'hii.canvas', assurance: 'session-authenticated-account-asserted', sourceUpdatedAt: '2026-08-28T00:00:00Z', sharedAt: 1_700_000_000_000, contentHash: 'sha' },
      createdAt: 1_700_000_000_000,
      ownedByViewer: false,
    };
    const seed = nodeSeedFromFeedSnapshot(item);
    expect(seed.type).toBe('canvas-text');
    expect(seed.payload.text).toBe('shared');
    expect(seed.object?.owner).toBe('account:ummi');
    expect(seed.object?.status).toBe('unknown');
    expect(seed.object?.proofRefs).toBeUndefined();
    expect(seed.object?.audit?.[0]?.actor).toBe('hii');
    expect(seed.payload.feedProvenance).toMatchObject({ assurance: 'session-authenticated-account-asserted', contentHash: 'sha' });
  });

  it('does not re-share imported feed items without a server-verified lineage', () => {
    const base: Omit<FeedItem, 'snapshot'> = {
      id: 'feed-id',
      authorHandle: 'ummi',
      provenance: { source: 'hii.canvas', assurance: 'session-authenticated-account-asserted', sourceUpdatedAt: '2026-08-28T00:00:00Z', sharedAt: 1_700_000_000_000, contentHash: 'sha' },
      createdAt: 1_700_000_000_000,
      ownedByViewer: false,
    };
    const snapshots: FeedItem['snapshot'][] = [
      { kind: 'text', text: 'shared' },
      { kind: 'sticker', emoji: '○' },
      { kind: 'ink', strokes: [{ points: [0, 0, 10, 10], color: '#111', width: 2 }] },
    ];
    for (const snapshot of snapshots) {
      const seed = nodeSeedFromFeedSnapshot({ ...base, snapshot });
      expect(feedSnapshotFromNode({ ...node(seed.type, seed.payload), type: seed.type, payload: seed.payload })).toBeNull();
    }
  });
});
