import { describe, expect, it } from 'vitest';
import { isNodeLocked, resizeNodeRect, rotationFromPointer } from '../../components/workspace/nodeTransform';
import type { WorkspaceNode } from '../../lib/workspace/types';

const rect = { x: 100, y: 200, w: 300, h: 160, rotation: 0 };

describe('workspace node transforms', () => {
  it('resizes from every edge while keeping the opposite edge fixed', () => {
    expect(resizeNodeRect(rect, 'nw', 20, 30)).toMatchObject({ x: 120, y: 230, w: 280, h: 130 });
    expect(resizeNodeRect(rect, 'se', 20, 30)).toMatchObject({ x: 100, y: 200, w: 320, h: 190 });
    expect(resizeNodeRect(rect, 'w', 500, 0)).toMatchObject({ x: 320, w: 80 });
    expect(resizeNodeRect(rect, 'n', 0, 500)).toMatchObject({ y: 320, h: 40 });
  });

  it('calculates rotation around the object center and snaps with Shift', () => {
    expect(rotationFromPointer(rect, { x: 250, y: 120 })).toBe(0);
    expect(rotationFromPointer(rect, { x: 500, y: 280 })).toBe(90);
    expect(rotationFromPointer(rect, { x: 300, y: 100 }, true) % 15).toBe(0);
  });

  it('treats only an explicit payload lock as locked', () => {
    const node = { payload: { locked: true } } as WorkspaceNode;
    expect(isNodeLocked(node)).toBe(true);
    expect(isNodeLocked({ payload: { locked: 'true' } } as unknown as WorkspaceNode)).toBe(false);
  });
});

