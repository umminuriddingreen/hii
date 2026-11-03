import { newSpacePage, spacePage, spacesIndexPage } from './pages.ts';
import { safePublicProjection } from './resolver.ts';
import { routeSpacesRequest } from './router.ts';
import type { PublicSpaceResolver } from './types.ts';

export interface SpacesHandlerOptions {
  readonly previewFavicon?: boolean;
  readonly previewIndexLink?: Readonly<{ href: string; label: string }>;
}

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
});

function response(request: Request, body: string, status: number, headers: Record<string, string> = {}) {
  const result = new Response(request.method === 'HEAD' ? null : body, {
    status,
    headers: { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers }
  });
  result.headers.set('Content-Length', String(new TextEncoder().encode(body).byteLength));
  return result;
}

function html(request: Request, body: string, status = 200) {
  return response(request, body, status, { 'Content-Type': 'text/html; charset=utf-8', 'X-HII-Route-Owner': 'spaces-public' });
}

function problem(request: Request, status: number, code: string, message: string, owner = 'spaces-public') {
  return response(request, `${JSON.stringify({ error: { code, message } })}\n`, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-HII-Route-Owner': owner
  });
}

export async function handleSpacesRequest(
  request: Request,
  resolver: PublicSpaceResolver,
  options: SpacesHandlerOptions = {}
): Promise<Response> {
  const url = new URL(request.url);
  const route = routeSpacesRequest(request.method, url.pathname);
  if (url.search !== '') {
    const owner = route.kind === 'fallback' ? 'none' : 'spaces-public';
    return problem(request, 404, 'QUERY_NOT_ALLOWED', 'Public Space routes do not accept query parameters.', owner);
  }
  try {
    if (route.kind === 'preview-favicon') {
      if (!options.previewFavicon) {
        const fallback = problem(request, 404, 'ROUTE_NOT_OWNED', 'This route belongs to the existing HII origin.', 'none');
        fallback.headers.set('X-HII-Fallback', 'route-scoped-upstream');
        return fallback;
      }
      return new Response(null, {
        status: 204,
        headers: {
          ...SECURITY_HEADERS,
          'Cache-Control': 'public, max-age=86400',
          'X-HII-Route-Owner': 'spaces-public-preview'
        }
      });
    }
    if (route.kind === 'spaces-index') return html(request, spacesIndexPage(options.previewIndexLink));
    if (route.kind === 'new-space') return html(request, newSpacePage());
    if (route.kind === 'invalid-space') {
      return problem(request, 400, 'INVALID_SPACE_ID', 'The Space id is invalid.');
    }
    if (route.kind === 'method-not-allowed') {
      const denied = problem(request, 405, 'METHOD_NOT_ALLOWED', 'This public HII surface is read-only.');
      denied.headers.set('Allow', route.allow);
      return denied;
    }
    if (route.kind === 'owned-not-found') {
      return problem(request, 404, 'ROUTE_NOT_FOUND', 'Public Space route not found.');
    }
    if (route.kind === 'fallback') {
      const fallback = problem(request, 404, 'ROUTE_NOT_OWNED', 'This route belongs to the existing HII origin.', 'none');
      fallback.headers.set('X-HII-Fallback', 'route-scoped-upstream');
      return fallback;
    }
    const resolved = await resolver.resolve(route.spaceId);
    const space = resolved ? safePublicProjection(resolved) : null;
    return space && space.id === route.spaceId
      ? html(request, spacePage(space))
      : problem(request, 404, 'SPACE_NOT_FOUND', 'Space not found.');
  } catch {
    console.error(JSON.stringify({
      message: 'spaces-public request failed',
      path: url.pathname,
      code: 'SPACE_RESOLUTION_UNAVAILABLE'
    }));
    return problem(request, 503, 'SPACE_RESOLUTION_UNAVAILABLE', 'The public Space resolver is unavailable.');
  }
}
