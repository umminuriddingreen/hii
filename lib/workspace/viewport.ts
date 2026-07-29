import type { WorkspaceViewport } from './types';

export const WORKSPACE_ZOOM_MIN = 0.25;
export const WORKSPACE_ZOOM_MAX = 2.5;

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
