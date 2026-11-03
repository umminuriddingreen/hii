import { describe, expect, it } from 'vitest';
import { normalizeNode, type SpatialObjectKind } from '../../lib/workspace/types';

const ecosystemKinds: SpatialObjectKind[] = ['device', 'service', 'space'];

describe('ecosystem workspace object kinds', () => {
  it.each(ecosystemKinds)('preserves %s runtime projections through normalization', (kind) => {
    const node = normalizeNode({
      id: `${kind}:example`,
      type: 'surface',
      x: 10,
      y: 20,
      w: 320,
      h: 180,
      z: 1,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      object: { kind, status: 'ready', source: 'hii-runtime' },
      objectRef: { authority: 'hii-runtime', id: `${kind}:example`, kind },
      payload: { title: `Example ${kind}` }
    });

    expect(node?.object?.kind).toBe(kind);
    expect(node?.objectRef).toEqual({
      authority: 'hii-runtime',
      id: `${kind}:example`,
      projectId: undefined,
      kind
    });
  });
});
