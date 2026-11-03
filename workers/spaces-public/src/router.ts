import { isSpaceId } from './types.ts';

export type SpacesRoute =
  | Readonly<{ kind: 'spaces-index' }>
  | Readonly<{ kind: 'new-space' }>
  | Readonly<{ kind: 'preview-favicon' }>
  | Readonly<{ kind: 'space'; spaceId: string }>
  | Readonly<{ kind: 'invalid-space'; candidate: string }>
  | Readonly<{ kind: 'owned-not-found' }>
  | Readonly<{ kind: 'method-not-allowed'; allow: 'GET, HEAD' }>
  | Readonly<{ kind: 'fallback' }>;

function ownedPath(pathname: string) {
  return pathname === '/favicon.ico' ||
    pathname === '/spaces' || pathname.startsWith('/spaces/') ||
    pathname === '/new' || pathname === '/new/' ||
    pathname === '/s' || pathname.startsWith('/s/');
}

export function routeSpacesRequest(method: string, pathname: string): SpacesRoute {
  if (!ownedPath(pathname)) return Object.freeze({ kind: 'fallback' });
  if (method !== 'GET' && method !== 'HEAD') {
    return Object.freeze({ kind: 'method-not-allowed', allow: 'GET, HEAD' });
  }
  if (pathname === '/spaces' || pathname === '/spaces/') return Object.freeze({ kind: 'spaces-index' });
  if (pathname === '/new' || pathname === '/new/') return Object.freeze({ kind: 'new-space' });
  if (pathname === '/favicon.ico') return Object.freeze({ kind: 'preview-favicon' });
  if (pathname.startsWith('/spaces/')) return Object.freeze({ kind: 'owned-not-found' });
  const candidate = pathname.startsWith('/s/') ? pathname.slice(3) : '';
  let decoded = candidate;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return Object.freeze({ kind: 'invalid-space', candidate: '' });
  }
  return isSpaceId(decoded)
    ? Object.freeze({ kind: 'space', spaceId: decoded })
    : Object.freeze({ kind: 'invalid-space', candidate: decoded.slice(0, 80) });
}
