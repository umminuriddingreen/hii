import { describe, expect, it } from 'vitest';
import { findOpenWorkspacePosition, workspaceRectsOverlap } from '../../lib/workspace/layout';
import type { WorkspaceNode } from '../../lib/workspace/types';

function node(id: string, x: number, y: number, w = 620, h = 630): WorkspaceNode {
  return {
    id,
    type: 'run',
    x,
    y,
    w,
    h,
    z: 1,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    payload: {}
  };
}

describe('workspace group layout', () => {
  it('keeps an open preferred position unchanged', () => {
    expect(findOpenWorkspacePosition([node('existing', 0, 0)], { x: 700, y: 0 }, { w: 620, h: 630 }))
      .toEqual({ x: 700, y: 0 });
  });

  it('moves a colliding run group into the next open vertical lane', () => {
    const preferred = { x: 700, y: 0 };
    const placed = findOpenWorkspacePosition(
      [node('existing', preferred.x, preferred.y)],
      preferred,
      { w: 620, h: 630 },
      { gap: 32 }
    );

    expect(placed).toEqual({ x: 700, y: 662 });
    expect(workspaceRectsOverlap({ ...placed, w: 620, h: 630 }, node('existing', 700, 0), 32)).toBe(false);
  });

  it('uses the nearest clear lane when several run groups already exist', () => {
    const preferred = { x: 700, y: 0 };
    const placed = findOpenWorkspacePosition(
      [
        node('first', 700, 0),
        node('second', 700, 662),
        node('third', 700, 1324)
      ],
      preferred,
      { w: 620, h: 630 },
      { gap: 32 }
    );

    expect(placed).toEqual({ x: 1352, y: 0 });
  });
});
