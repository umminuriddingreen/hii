import { describe, expect, it } from 'vitest';
import {
  normalizeNode,
  normalizeWorkspace,
  spaceObjectNodeTypes,
  workspaceNodeTransform,
  type WorkspaceNode
} from '../../lib/workspace/types';

const legacyNode = {
  id: 'legacy-image',
  type: 'image',
  x: 12,
  y: 24,
  w: 320,
  h: 180,
  z: 2,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  payload: { src: '/asset.jpg' }
};

describe('WorkspaceNode Space fields', () => {
  it('loads legacy Workspace documents with a safe zero rotation', () => {
    const workspace = normalizeWorkspace({
      version: 1,
      revision: 3,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [legacyNode],
      links: []
    });

    expect(workspace.nodes[0]).toMatchObject({
      id: 'legacy-image',
      rotation: 0,
      payload: { src: '/asset.jpg' }
    });
  });

  it('preserves additive Space wire fields through normalization', () => {
    expect(normalizeNode({
      ...legacyNode,
      id: 'space-sticker',
      spaceId: 'space_14th_street',
      creatorId: 'guest:7f1c',
      rotation: -22.5,
      permissions: { inheritance: 'space-policy', ignoredGrant: 'write' },
      payload: { src: '/blobs/sticker.webp', sticker: true }
    })).toMatchObject({
      id: 'space-sticker',
      spaceId: 'space_14th_street',
      creatorId: 'guest:7f1c',
      rotation: -22.5,
      permissions: { inheritance: 'space-policy' },
      payload: { src: '/blobs/sticker.webp', sticker: true }
    });
  });

  it('uses existing node types for every initial Space object', () => {
    expect(spaceObjectNodeTypes).toEqual({
      Image: 'image',
      Text: 'canvas-text',
      Sticker: 'image',
      Drawing: 'ink'
    });
    expect(normalizeNode({ ...legacyNode, type: 'ink' })?.type).toBe('ink');
    expect(normalizeNode({ ...legacyNode, type: 'canvas-text' })?.type).toBe('canvas-text');
  });

  it('applies rotation after translation and keeps it during a drag transform', () => {
    const node = { ...legacyNode, rotation: 35 } as WorkspaceNode;
    expect(workspaceNodeTransform(node)).toBe('translate(12px, 24px) rotate(35deg)');
    expect(workspaceNodeTransform({ ...node, x: 90, y: 120 })).toBe(
      'translate(90px, 120px) rotate(35deg)'
    );
    expect(workspaceNodeTransform({ ...node, rotation: Number.NaN })).toBe(
      'translate(12px, 24px) rotate(0deg)'
    );
  });
});
