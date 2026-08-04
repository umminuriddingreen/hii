import type { WorkspaceNode, WorkspaceViewport } from './types';

export const WORKSPACE_ZOOM_MIN = 0.05;
export const WORKSPACE_ZOOM_MAX = 2.5;

type WorkspaceRect = Pick<WorkspaceNode, 'x' | 'y' | 'w' | 'h'>;

export type WorkspaceViewportRect = { left: number; top: number; right: number; bottom: number };

/**
 * The visible region of the workspace, in workspace coordinates.
 *
 * `margin` expands the rect by that many screen-widths/heights on each side.
 * Rendering uses a margin so a node is already mounted by the time it scrolls
 * into view; the "is anything visible?" check uses none.
 */
export function workspaceViewportRect(
  viewport: WorkspaceViewport,
  size: { width: number; height: number },
  margin = 0
): WorkspaceViewportRect | null {
  if (size.width <= 0 || size.height <= 0 || viewport.zoom <= 0) return null;
  const padX = (size.width * margin) / viewport.zoom;
  const padY = (size.height * margin) / viewport.zoom;
  return {
    left: -viewport.x / viewport.zoom - padX,
    top: -viewport.y / viewport.zoom - padY,
    right: (size.width - viewport.x) / viewport.zoom + padX,
    bottom: (size.height - viewport.y) / viewport.zoom + padY
  };
}

const intersects = (node: WorkspaceRect, rect: WorkspaceViewportRect) => (
  node.x + node.w >= rect.left
  && node.x <= rect.right
  && node.y + node.h >= rect.top
  && node.y <= rect.bottom
);

export function countWorkspaceNodesInViewport(
  nodes: WorkspaceRect[],
  viewport: WorkspaceViewport,
  size: { width: number; height: number }
) {
  if (!nodes.length) return 0;
  const rect = workspaceViewportRect(viewport, size);
  if (!rect) return 0;
  return nodes.filter((node) => intersects(node, rect)).length;
}

/**
 * Ids of the nodes worth mounting for this camera.
 *
 * The canvas renders every node as live DOM — including iframes, xterm
 * terminals, and three.js scenes — so a board that has scrolled away still cost
 * full mount and paint. Returning `null` means "no useful camera yet" (the
 * element has not been measured), in which case the caller should render
 * everything rather than blank the canvas.
 */
export function visibleWorkspaceNodeIds<T extends WorkspaceRect & { id: string }>(
  nodes: T[],
  viewport: WorkspaceViewport,
  size: { width: number; height: number },
  margin = 1
): Set<string> | null {
  const rect = workspaceViewportRect(viewport, size, margin);
  if (!rect) return null;
  const visible = new Set<string>();
  for (const node of nodes) if (intersects(node, rect)) visible.add(node.id);
  return visible;
}

export function fitWorkspaceViewport(
  nodes: WorkspaceRect[],
  size: { width: number; height: number },
  options: { padding?: number; maxZoom?: number } = {}
): WorkspaceViewport | null {
  if (!nodes.length || size.width <= 0 || size.height <= 0) return null;
  const padding = Math.max(0, options.padding ?? 72);
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.w));
  const bottom = Math.max(...nodes.map((node) => node.y + node.h));
  const contentWidth = Math.max(1, right - left);
  const contentHeight = Math.max(1, bottom - top);
  const availableWidth = Math.max(1, size.width - padding * 2);
  const availableHeight = Math.max(1, size.height - padding * 2);
  const zoom = Math.min(
    options.maxZoom ?? 1,
    WORKSPACE_ZOOM_MAX,
    Math.max(WORKSPACE_ZOOM_MIN, Math.min(availableWidth / contentWidth, availableHeight / contentHeight))
  );

  return {
    x: size.width / 2 - (left + contentWidth / 2) * zoom,
    y: size.height / 2 - (top + contentHeight / 2) * zoom,
    zoom
  };
}

export function panWorkspaceViewport(
  viewport: WorkspaceViewport,
  deltaX: number,
  deltaY: number
): WorkspaceViewport {
  return {
    ...viewport,
    x: viewport.x - deltaX,
    y: viewport.y - deltaY
  };
}

export function zoomWorkspaceViewportAt(
  viewport: WorkspaceViewport,
  point: { x: number; y: number },
  deltaY: number
): WorkspaceViewport {
  const zoom = Math.min(
    WORKSPACE_ZOOM_MAX,
    Math.max(WORKSPACE_ZOOM_MIN, viewport.zoom * Math.exp(-deltaY * 0.002))
  );
  const workspaceX = (point.x - viewport.x) / viewport.zoom;
  const workspaceY = (point.y - viewport.y) / viewport.zoom;

  return {
    ...viewport,
    x: point.x - workspaceX * zoom,
    y: point.y - workspaceY * zoom,
    zoom
  };
}
