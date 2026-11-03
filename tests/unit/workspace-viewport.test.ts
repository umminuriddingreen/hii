import { describe, expect, it } from 'vitest';
import { countWorkspaceNodesInViewport, fitWorkspaceViewport, visibleWorkspaceNodeIds } from '../../lib/workspace/viewport';

const node = (x: number, y: number, w = 100, h = 100) => ({ x, y, w, h });
const identified = (id: string, x: number, y: number, w = 100, h = 100) => ({ id, x, y, w, h });
const camera = { width: 1_280, height: 720 };

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

describe('workspace node mounting window', () => {
  it('mounts what is on screen and leaves distant work unmounted', () => {
    const visible = visibleWorkspaceNodeIds(
      [identified('near', 100, 100), identified('far', 40_000, 40_000)],
      { x: 0, y: 0, zoom: 1 },
      camera
    );
    expect(visible).toEqual(new Set(['near']));
  });

  it('mounts a margin of off-screen nodes so panning does not reveal empty frames', () => {
    // Just past the right edge, but inside the one-viewport margin.
    const justOffscreen = identified('ahead', 1_400, 100);
    expect(countWorkspaceNodesInViewport([justOffscreen], { x: 0, y: 0, zoom: 1 }, camera)).toBe(0);
    expect(visibleWorkspaceNodeIds([justOffscreen], { x: 0, y: 0, zoom: 1 }, camera)).toEqual(new Set(['ahead']));
  });

  it('scales the mounting window with zoom, so a zoomed-out board mounts more', () => {
    const distant = identified('distant', 4_000, 0);
    expect(visibleWorkspaceNodeIds([distant], { x: 0, y: 0, zoom: 1 }, camera)?.has('distant')).toBe(false);
    expect(visibleWorkspaceNodeIds([distant], { x: 0, y: 0, zoom: 0.25 }, camera)?.has('distant')).toBe(true);
  });

  it('declines to cull before the canvas has been measured', () => {
    // Returning an empty set here would blank the canvas on first paint.
    expect(visibleWorkspaceNodeIds([identified('a', 0, 0)], { x: 0, y: 0, zoom: 1 }, { width: 0, height: 0 })).toBeNull();
  });
});
