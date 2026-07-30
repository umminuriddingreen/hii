import type { WorkspaceNode, WorkspaceViewport } from './types';

export const WORKSPACE_ZOOM_MIN = 0.05;
export const WORKSPACE_ZOOM_MAX = 2.5;

type WorkspaceRect = Pick<WorkspaceNode, 'x' | 'y' | 'w' | 'h'>;

export function countWorkspaceNodesInViewport(
  nodes: WorkspaceRect[],
  viewport: WorkspaceViewport,
  size: { width: number; height: number }
) {
  if (!nodes.length || size.width <= 0 || size.height <= 0 || viewport.zoom <= 0) return 0;
  const left = -viewport.x / viewport.zoom;
  const top = -viewport.y / viewport.zoom;
  const right = (size.width - viewport.x) / viewport.zoom;
  const bottom = (size.height - viewport.y) / viewport.zoom;

  return nodes.filter((node) => (
    node.x + node.w >= left
    && node.x <= right
    && node.y + node.h >= top
    && node.y <= bottom
  )).length;
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
