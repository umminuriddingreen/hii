import { describe, expect, it } from 'vitest';
import { countWorkspaceNodesInViewport, fitWorkspaceViewport } from '../../lib/workspace/viewport';

const node = (x: number, y: number, w = 100, h = 100) => ({ x, y, w, h });

describe('workspace viewport orientation', () => {
  it('detects when a populated workspace is completely outside the visible camera', () => {
    expect(countWorkspaceNodesInViewport(
      [node(4_000, 3_000), node(4_200, 3_000)],
      { x: 0, y: 0, zoom: 1 },
      { width: 1_280, height: 720 }
    )).toBe(0);
  });

  it('counts partially visible objects as reachable content', () => {
    expect(countWorkspaceNodesInViewport(
      [node(-40, 80), node(2_000, 2_000)],
      { x: 0, y: 0, zoom: 1 },
      { width: 1_280, height: 720 }
    )).toBe(1);
  });

  it('fits distant content back into the camera without moving the objects', () => {
    const nodes = [node(4_000, 3_000), node(4_800, 3_600)];
    const viewport = fitWorkspaceViewport(nodes, { width: 1_280, height: 720 });
    expect(viewport).not.toBeNull();
    expect(countWorkspaceNodesInViewport(nodes, viewport!, { width: 1_280, height: 720 })).toBe(2);
  });
});
