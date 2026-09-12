import type { WorkspaceNode } from '@/lib/workspace/types';

export type NodeResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export type NodeTransformKind = 'move' | 'resize' | 'rotate';

export type NodeTransformRect = Pick<WorkspaceNode, 'x' | 'y' | 'w' | 'h' | 'rotation'>;

export type NodeTransformModifiers = {
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
};

export type NodeTransformDetail = {
  nodeId: string;
  kind: NodeTransformKind;
  handle?: NodeResizeHandle;
  origin: NodeTransformRect;
  next: NodeTransformRect;
  delta: { x: number; y: number };
  modifiers: NodeTransformModifiers;
};

const MIN_WIDTH = 80;
const MIN_HEIGHT = 40;

export function resizeNodeRect(
  origin: NodeTransformRect,
  handle: NodeResizeHandle,
  deltaX: number,
  deltaY: number
): NodeTransformRect {
  let { x, y, w, h } = origin;

  if (handle.includes('e')) w = Math.max(MIN_WIDTH, origin.w + deltaX);
  if (handle.includes('s')) h = Math.max(MIN_HEIGHT, origin.h + deltaY);
  if (handle.includes('w')) {
    w = Math.max(MIN_WIDTH, origin.w - deltaX);
    x = origin.x + origin.w - w;
  }
  if (handle.includes('n')) {
    h = Math.max(MIN_HEIGHT, origin.h - deltaY);
    y = origin.y + origin.h - h;
  }

  return { x, y, w, h, rotation: origin.rotation };
}

export function rotationFromPointer(
  origin: NodeTransformRect,
  pointer: { x: number; y: number },
  snap = false
): number {
  const centerX = origin.x + origin.w / 2;
  const centerY = origin.y + origin.h / 2;
  // The rotation handle begins above the object, so twelve o'clock is zero.
  const degrees = Math.atan2(pointer.y - centerY, pointer.x - centerX) * 180 / Math.PI + 90;
  const normalized = ((degrees + 180) % 360 + 360) % 360 - 180;
  return snap ? Math.round(normalized / 15) * 15 : normalized;
}

export function isNodeLocked(node: WorkspaceNode): boolean {
  return node.payload.locked === true;
}
