import type { WorkspaceNode } from './types';

export type WorkspaceRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export function workspaceRectsOverlap(a: WorkspaceRect, b: WorkspaceRect, gap = 0) {
  return !(
    a.x + a.w + gap <= b.x ||
    b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y ||
    b.y + b.h + gap <= a.y
  );
}

export type TidyOptions = {
  /** Space between packed nodes, in workspace units. */
  gap?: number;
  /** Target width of the packed block. Defaults to a roughly square result. */
  maxWidth?: number;
};

/**
 * Pack nodes into a masonry block anchored at their current top-left.
 *
 * Columns are fixed-width (the widest node in the set) and each node goes to the
 * shortest column, which is what keeps a wall of mixed-height images reading as
 * a board rather than a ragged grid. Original order is preserved so a tidy is
 * predictable — the same selection always lands the same way.
 *
 * Returns new positions keyed by id, omitting nodes that would not move.
 */
export function tidyWorkspaceNodes(
  nodes: WorkspaceNode[],
  options: TidyOptions = {}
): Map<string, { x: number; y: number }> {
  const moves = new Map<string, { x: number; y: number }>();
  const packable = nodes.filter((node) => node.type !== 'frame');
  if (packable.length < 2) return moves;

  const gap = Math.max(0, Number(options.gap) || 32);
  const anchorX = Math.min(...packable.map((node) => node.x));
  const anchorY = Math.min(...packable.map((node) => node.y));
  const columnWidth = Math.max(...packable.map((node) => node.w));

  const targetWidth = options.maxWidth
    ?? Math.sqrt(packable.reduce((total, node) => total + node.w * node.h, 0)) * 1.4;
  const columns = Math.max(1, Math.min(packable.length, Math.round(targetWidth / (columnWidth + gap)) || 1));
  const heights = new Array(columns).fill(0) as number[];

  for (const node of packable) {
    const shortest = heights.indexOf(Math.min(...heights));
    const x = anchorX + shortest * (columnWidth + gap);
    const y = anchorY + heights[shortest];
    heights[shortest] += node.h + gap;
    if (x !== node.x || y !== node.y) moves.set(node.id, { x, y });
  }
  return moves;
}

export function findOpenWorkspacePosition(
  nodes: WorkspaceNode[],
  preferred: { x: number; y: number },
  size: { w: number; h: number },
  options: { gap?: number; maxLanes?: number } = {}
) {
  const gap = Math.max(0, Number(options.gap) || 32);
  const maxLanes = Math.max(1, Number(options.maxLanes) || 48);
  const blockers = nodes.filter((node) => node.type !== 'frame');
  const available = (position: { x: number; y: number }) => {
    const candidate = { ...position, ...size };
    return blockers.every((node) => !workspaceRectsOverlap(candidate, node, gap));
  };

  if (available(preferred)) return preferred;

  const strideX = size.w + gap;
  const strideY = size.h + gap;
  for (let lane = 1; lane <= maxLanes; lane += 1) {
    const candidates = [
      { x: preferred.x, y: preferred.y + lane * strideY },
      { x: preferred.x + lane * strideX, y: preferred.y },
      { x: preferred.x + lane * strideX, y: preferred.y + lane * strideY },
      { x: preferred.x, y: preferred.y - lane * strideY },
      { x: preferred.x - lane * strideX, y: preferred.y }
    ];
    const open = candidates.find(available);
    if (open) return open;
  }

  return preferred;
}
