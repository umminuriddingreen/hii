import { describe, expect, it } from 'vitest';
import { tidyWorkspaceNodes } from '../../lib/workspace/layout';
import { workspaceRectsOverlap } from '../../lib/workspace/layout';
import type { WorkspaceNode } from '../../lib/workspace/types';

const node = (id: string, x: number, y: number, w = 200, h = 150): WorkspaceNode => ({
  id,
  type: 'image',
  x,
  y,
  w,
  h,
  z: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  payload: {}
} as WorkspaceNode);

/** Apply a move map so the packed result can be inspected as rects. */
const applied = (nodes: WorkspaceNode[], moves: Map<string, { x: number; y: number }>) =>
  nodes.map((n) => ({ ...n, ...(moves.get(n.id) ?? {}) }));

describe('tidying a board into a packed layout', () => {
  it('leaves no two nodes overlapping', () => {
    const scattered = Array.from({ length: 24 }, (_, index) =>
      node(`n${index}`, (index * 37) % 500, (index * 53) % 500, 200, 100 + (index % 5) * 60));
    const result = applied(scattered, tidyWorkspaceNodes(scattered));

    for (let i = 0; i < result.length; i += 1) {
      for (let j = i + 1; j < result.length; j += 1) {
        expect(workspaceRectsOverlap(result[i], result[j])).toBe(false);
      }
    }
  });

  it('anchors the packed block at the selection\'s existing top-left', () => {
    const nodes = [node('a', 900, 700), node('b', 1_400, 1_100)];
    const result = applied(nodes, tidyWorkspaceNodes(nodes));

    expect(Math.min(...result.map((n) => n.x))).toBe(900);
    expect(Math.min(...result.map((n) => n.y))).toBe(700);
  });

  it('packs mixed heights into columns rather than a ragged grid', () => {
    // Two columns; the short node should be followed under it, not beside it.
    const nodes = [node('tall', 0, 0, 200, 600), node('short', 0, 0, 200, 100), node('next', 0, 0, 200, 100)];
    const result = applied(nodes, tidyWorkspaceNodes(nodes, { maxWidth: 500 }));
    const short = result.find((n) => n.id === 'short')!;
    const next = result.find((n) => n.id === 'next')!;

    expect(next.x).toBe(short.x); // same column
    expect(next.y).toBeGreaterThan(short.y); // stacked under the shorter one
  });

  it('is idempotent, so tidying twice does not drift the board', () => {
    const nodes = [node('a', 0, 0), node('b', 300, 0), node('c', 0, 300)];
    const once = applied(nodes, tidyWorkspaceNodes(nodes));
    expect(tidyWorkspaceNodes(once).size).toBe(0);
  });

  it('ignores scenes, which are containers rather than packable content', () => {
    const nodes = [node('a', 0, 0), { ...node('frame', 0, 0), type: 'frame' } as WorkspaceNode, node('b', 500, 500)];
    expect(tidyWorkspaceNodes(nodes).has('frame')).toBe(false);
  });

  it('does nothing with fewer than two packable nodes', () => {
    expect(tidyWorkspaceNodes([node('a', 0, 0)]).size).toBe(0);
  });
});
