import type { WorkspaceNode, WorkspaceNodeType } from '@/lib/workspace/types';
import { isSpaceId } from '@/lib/spaces/types';

export const SPACE_ALLOWED_NODE_TYPES = ['image', 'canvas-text', 'ink'] as const satisfies readonly WorkspaceNodeType[];
const allowed = new Set<WorkspaceNodeType>(SPACE_ALLOWED_NODE_TYPES);

export function isSpaceCanvasNodeType(type: WorkspaceNodeType) {
  return allowed.has(type);
}

export const SPACE_SURFACE_CAPABILITIES = Object.freeze({
  pan: true, zoom: true, select: true, move: true, resize: true, delete: true,
  image: true, text: true, sticker: true, drawing: true,
  terminal: false, browser: false, agents: false, receipts: false,
  applications: false, developerControls: false
});

export function isSpaceCanvasNode(node: Pick<WorkspaceNode, 'type' | 'spaceId'>, spaceId: string) {
  return isSpaceCanvasNodeType(node.type) && node.spaceId === spaceId;
}

export function spaceStorageKey(spaceId: string) {
  return `hii.space.workspace.${spaceId}.v1`;
}

export function spaceIdFromPathname(pathname: string): string | null {
  const match = /^\/s\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    const decoded = decodeURIComponent(match[1]);
    return isSpaceId(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export type HiiProductRoute =
  | { kind: 'workspace' }
  | { kind: 'spaces-home' }
  | { kind: 'space-new' }
  | { kind: 'space-visitor'; spaceId: string }
  | { kind: 'space-host'; spaceId: string }
  | { kind: 'not-found' };

export function hiiProductRouteFromPathname(pathname: string): HiiProductRoute {
  if (pathname === '/') return { kind: 'workspace' };
  if (/^\/spaces\/?$/.test(pathname)) return { kind: 'spaces-home' };
  if (/^\/new\/?$/.test(pathname)) return { kind: 'space-new' };
  const hostMatch = /^\/host\/s\/([^/]+)\/?$/.exec(pathname);
  const visitorMatch = /^\/s\/([^/]+)\/?$/.exec(pathname);
  const match = hostMatch ?? visitorMatch;
  if (!match) return { kind: 'not-found' };
  try {
    const spaceId = decodeURIComponent(match[1]);
    if (!isSpaceId(spaceId)) return { kind: 'not-found' };
    return { kind: hostMatch ? 'space-host' : 'space-visitor', spaceId };
  } catch {
    return { kind: 'not-found' };
  }
}

export const HOST_SPACES_API = '/api/host/spaces';

export function hostSpaceApiPath(spaceId: string): string {
  if (!isSpaceId(spaceId)) throw new TypeError('A canonical Space id is required');
  return `${HOST_SPACES_API}/${spaceId}`;
}

export function hostSpaceControlsApiPath(spaceId: string): string {
  return `${hostSpaceApiPath(spaceId)}/controls`;
}

/**
 * Trust the operator listener to choose the address, but never let it smuggle
 * credentials, invite tokens, or another Space identity into the share QR.
 */
export function validateSpaceAccessUrl(rawUrl: string, expectedSpaceId: string): string {
  if (!isSpaceId(expectedSpaceId)) throw new TypeError('A canonical Space id is required');
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new TypeError('The HII host returned an invalid Space access URL');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== `/s/${expectedSpaceId}`
  ) {
    throw new TypeError('The HII host returned an unsafe Space access URL');
  }
  return parsed.href;
}
