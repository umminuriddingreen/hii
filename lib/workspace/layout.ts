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
