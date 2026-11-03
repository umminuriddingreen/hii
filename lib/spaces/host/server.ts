import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readSpace,
  SpaceLoadError,
  SpaceNotFoundError,
  validateSpaceId
} from '../../server/space-store.ts';
import {
  isAllowedSpacesPeer,
  resolveSpacesHostBinding,
  type SpacesHostBinding,
  type SpacesHostMode
} from './network.ts';
import {
  readMultipartSpaceUpload,
  readSpaceBlob,
  storeSpaceBlob
} from './blobs.ts';
import { SlidingWindowUploadLimiter, SpaceUploadError } from '../upload-policy.ts';
import { createSpaceEventHub, type SpaceEventHubOptions } from './events.ts';
import { SpaceAuthorityError, SpaceHostAuthority } from './authority.ts';
import { SpaceHostControls } from './controls.ts';
import { evaluateSpacePolicy } from '../policy.ts';
import type { SpaceAudience } from '../types.ts';
import { startSpacesOperatorHost } from './operator.ts';
import {
  SpacePublisher,
  type PublicSpaceListener,
  type SpacePublisherOptions
} from '../publication.ts';

const DEFAULT_PORT = 4312;
export const SPACES_HOST_LIMITS = Object.freeze({
  maxHeaderSize: 16 * 1024,
  headersTimeout: 5_000,
  requestTimeout: 10_000,
  keepAliveTimeout: 2_000,
  maxRequestsPerSocket: 100
});
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin'
} as const;
const HTML_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:"
].join('; ');

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

export type SpacesHostOptions = {
  mode?: SpacesHostMode;
  port?: number;
  appRoot?: string;
  interfaces?: Parameters<typeof resolveSpacesHostBinding>[1];
  /** Additional operator-configured DNS names accepted by the listener. */
  allowedHostnames?: string[];
  /** Injectable timing/size bounds for focused transport tests. */
  events?: Partial<Pick<SpaceEventHubOptions, 'maxFrameBytes' | 'heartbeatIntervalMs' | 'heartbeatTimeoutMs'>>;
  /** Explicit listener classification. LAN/loopback hosts default to local. */
  audience?: SpaceAudience;
  /** Separate loopback-only operator listener. Zero requests an ephemeral port. */
  operatorPort?: number;
  /** Public-safe listeners set this false so operator routes never coexist. */
  operator?: boolean;
  /** Main hosts expose explicit publication control; public listeners disable it. */
  publication?: false | Omit<SpacePublisherOptions, 'startPublicListener'>;
  /** Required on audience='public'; prevents one tunnel exposing other Spaces. */
  publicSpaceId?: string;
};

export type RunningSpacesHost = {
  binding: SpacesHostBinding;
  port: number;
  origins: string[];
  operatorOrigins: string[];
  spaceUrls(spaceId: string): string[];
  controls: SpaceHostControls;
  /** Settles after any durable published Space has been rebound or recovery failed. */
  publicationReady: Promise<void>;
  stop(): Promise<void>;
};

function writeResponse(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {}
) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Length': String(Buffer.byteLength(body)),
    ...headers
  });
  if (response.req.method === 'HEAD') response.end();
  else response.end(body);
}

function json(response: ServerResponse, status: number, value: unknown) {
  const body = `${JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  })}\n`;
  writeResponse(response, status, body, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
}

function visitorSpace(space: Awaited<ReturnType<typeof readSpace>>) {
  return {
    schemaVersion: space.schemaVersion,
    id: space.id,
    name: space.name,
    hosting: space.hosting,
    policy: {
      read: space.policy.read,
      write: space.policy.write,
      writesFrozen: space.policy.writesFrozen,
      uploadsEnabled: space.policy.uploadsEnabled,
      maxUploadBytes: space.policy.maxUploadBytes,
      maxObjects: space.policy.maxObjects
    },
    updatedAt: space.updatedAt,
    revision: space.revision
  };
}

export function normalizeHostname(raw: string): string | null {
  if (!raw || /[\s/@]/.test(raw)) return null;
  try {
    const parsed = new URL(`http://${raw}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase();
    return hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  } catch {
    return null;
  }
}

export function hasSameOrigin(
  request: IncomingMessage,
  requestHostname: string,
  audience: SpaceAudience = 'local'
) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1).toLowerCase()
      : parsed.hostname.toLowerCase();
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    if (audience === 'public') {
      return (
        parsed.protocol === 'https:' &&
        parsed.username === '' &&
        parsed.password === '' &&
        hostname === requestHostname &&
        port === 443
      );
    }
    return (
      parsed.protocol === 'http:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      hostname === requestHostname &&
      port === request.socket.localPort
    );
  } catch {
    return false;
  }
}

function error(response: ServerResponse, status: number, code: string, message: string) {
  json(response, status, { error: { code, message } });
}

function decodeSpaceId(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new TypeError('invalid encoded space id');
  }
  return validateSpaceId(decoded);
}

function requirePublicScope(
  space: Awaited<ReturnType<typeof readSpace>>,
  audience: SpaceAudience,
  publicSpaceId?: string
) {
  if (
    audience === 'public' &&
    (space.id !== publicSpaceId || space.publication.state !== 'published')
  ) {
    throw new SpaceNotFoundError(space.id);
  }
}

function isSafeStaticRelativePath(relative: string): boolean {
  const segments = relative.split('/');
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)
    )
  );
}

async function serveFile(
  response: ServerResponse,
  file: string,
  contentType: string,
  cacheControl: string,
  html = false
) {
  try {
    const body = await readFile(file);
    writeResponse(response, 200, body, {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      ...(html ? { 'Content-Security-Policy': HTML_CSP } : {})
    });
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === 'ENOENT') {
      error(response, 503, 'APP_SHELL_UNAVAILABLE', 'The HII app shell has not been built.');
      return;
    }
    error(response, 500, 'HOST_READ_FAILED', 'The HII Spaces host could not read this resource.');
  }
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  appRoot: string,
  allowedHostnames: ReadonlySet<string>,
  binding: SpacesHostBinding,
  uploadLimiter: SlidingWindowUploadLimiter
  , authority: SpaceHostAuthority
  , audience: SpaceAudience
  , publicSpaceId?: string
) {
  if (!isAllowedSpacesPeer(request.socket.remoteAddress, binding)) {
    response.shouldKeepAlive = false;
    response.setHeader('Connection', 'close');
    response.once('finish', () => request.socket.destroy());
    error(response, 403, 'PEER_NOT_LOCAL', 'This HII Space is available only on its local network.');
    return;
  }

  const requestHostname = normalizeHostname(request.headers.host ?? '');
  if (!requestHostname || !allowedHostnames.has(requestHostname)) {
    error(response, 421, 'MISDIRECTED_REQUEST', 'This host name is not accepted by HII Spaces.');
    return;
  }

  const method = request.method ?? 'GET';
  let url: URL;
  try {
    // Routing never trusts Host or X-Forwarded-* headers. The fixed base is
    // used only to parse the request target.
    url = new URL(request.url ?? '/', 'http://hii-spaces.invalid');
  } catch {
    error(response, 400, 'INVALID_REQUEST', 'The request target is invalid.');
    return;
  }

  const blobCollectionMatch = /^\/api\/spaces\/([^/]+)\/blobs$/.exec(url.pathname);
  const blobMatch = /^\/api\/spaces\/([^/]+)\/blobs\/([^/]+)$/.exec(url.pathname);
  const sessionMatch = /^\/api\/spaces\/([^/]+)\/guest-session$/.exec(url.pathname);
  if (sessionMatch) {
    if (url.search !== '' || method !== 'POST') {
      response.setHeader('Allow', 'POST');
      error(response, method === 'POST' ? 404 : 405, 'METHOD_NOT_ALLOWED', 'This method is not allowed on the guest session route.');
      return;
    }
    const sessionHasBody = request.headers['transfer-encoding'] !== undefined
      || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0');
    if (sessionHasBody) {
      response.shouldKeepAlive = false;
      response.setHeader('Connection', 'close');
      response.once('finish', () => request.socket.destroy());
      error(response, 400, 'REQUEST_BODY_NOT_ALLOWED', 'Guest session requests cannot include a body.');
      return;
    }
    try {
      const spaceId = decodeSpaceId(sessionMatch[1]);
      const space = await readSpace(spaceId);
      requirePublicScope(space, audience, publicSpaceId);
      if (!hasSameOrigin(request, requestHostname, audience)) throw new SpaceAuthorityError('ORIGIN_NOT_ALLOWED', 'Guest sessions require the same HII Space origin.', 403);
      const credential = space.policy.admission === 'invite'
        ? authority.ensureInvite(request, spaceId)
        : authority.ensure(request, spaceId);
      const actor = 'actor' in credential ? credential.actor : space.policy.admission === 'invite' ? 'invite' : 'guest';
      authority.authorize(space, audience, 'join', actor);
      authority.authorize(space, audience, 'read', actor);
      response.setHeader('Set-Cookie', authority.cookie(credential, audience === 'public'));
      json(response, 201, { participantId: credential.guestId, expiresAt: credential.expiresAt });
    } catch (caught) {
      if (caught instanceof SpaceNotFoundError) error(response, 404, 'SPACE_NOT_FOUND', 'Space not found.');
      else if (caught instanceof SpaceAuthorityError) error(response, caught.status, caught.code, caught.message);
      else if (caught instanceof TypeError) error(response, 400, 'INVALID_SPACE_ID', 'The Space id is invalid.');
      else error(response, 500, 'GUEST_SESSION_FAILED', 'The guest session could not be created.');
    }
    return;
  }
  if ((blobCollectionMatch || blobMatch) && url.search !== '') {
    error(response, 404, 'ROUTE_NOT_FOUND', 'Space route not found.');
    return;
  }
  if (blobCollectionMatch && method === 'POST') {
    try {
      const spaceId = decodeSpaceId(blobCollectionMatch[1]);
      const space = await readSpace(spaceId);
      requirePublicScope(space, audience, publicSpaceId);
      if (!hasSameOrigin(request, requestHostname, audience)) {
        throw new SpaceUploadError('ORIGIN_NOT_ALLOWED', 'Uploads require the same HII Space origin.', 403);
      }
      authority.authenticate(request, spaceId);
      const earlyUpload = evaluateSpacePolicy(space.policy, {
        audience,
        actor: authority.authenticate(request, spaceId).actor,
        operation: 'upload',
        uploadBytes: 0,
        storageUsedBytes: 0
      });
      if (!earlyUpload.allowed && !['POLICY_UPLOAD_TOO_LARGE', 'POLICY_STORAGE_QUOTA_EXCEEDED'].includes(earlyUpload.reason)) {
        throw new SpaceAuthorityError(earlyUpload.reason, 'This Space policy does not allow uploads.', earlyUpload.reason === 'POLICY_WRITES_FROZEN' ? 423 : 403);
      }
      if (!space.policy.uploadsEnabled) {
        throw new SpaceUploadError('UPLOADS_DISABLED', 'Uploads are disabled for this Space.', 403);
      }
      if (space.policy.writesFrozen) {
        throw new SpaceUploadError('SPACE_FROZEN', 'This Space is frozen.', 423);
      }
      const peer = request.socket.remoteAddress ?? 'unknown';
      if (!uploadLimiter.take(peer)) {
        response.setHeader('Retry-After', '60');
        throw new SpaceUploadError('UPLOAD_RATE_LIMITED', 'Too many uploads. Try again shortly.', 429);
      }
      const upload = await readMultipartSpaceUpload(request, space.policy.maxUploadBytes);
      const uploadGuest = authority.authenticate(request, spaceId);
      json(response, 201, await storeSpaceBlob({ spaceId, ...upload, audience, actor: uploadGuest.actor }));
      return;
    } catch (caught) {
      if (caught instanceof SpaceNotFoundError) {
        error(response, 404, 'SPACE_NOT_FOUND', 'Space not found.');
        return;
      }
      if (caught instanceof SpaceLoadError) {
        error(response, 503, 'SPACE_UNAVAILABLE', 'Space is temporarily unavailable.');
        return;
      }
      if (caught instanceof SpaceUploadError) {
        response.shouldKeepAlive = false;
        response.setHeader('Connection', 'close');
        response.once('finish', () => request.socket.destroy());
        error(response, caught.status, caught.code, caught.message);
        return;
      }
      if (caught instanceof SpaceAuthorityError) {
        error(response, caught.status, caught.code, caught.message);
        return;
      }
      if (caught instanceof TypeError) {
        error(response, 400, 'INVALID_SPACE_ID', 'The Space id is invalid.');
        return;
      }
      error(response, 500, 'UPLOAD_FAILED', 'The image could not be stored.');
      return;
    }
  }
  if (blobMatch && (method === 'GET' || method === 'HEAD')) {
    try {
      const spaceId = decodeSpaceId(blobMatch[1]);
      const space = await readSpace(spaceId);
      requirePublicScope(space, audience, publicSpaceId);
      const readDecision = evaluateSpacePolicy(space.policy, { audience, actor: 'guest', operation: 'read' });
      if (!readDecision.allowed) throw new SpaceAuthorityError(readDecision.reason, 'This Space policy does not allow blob reads.', 403);
      const blobId = decodeURIComponent(blobMatch[2]);
      const blob = await readSpaceBlob(spaceId, blobId);
      if (!blob) {
        error(response, 404, 'BLOB_NOT_FOUND', 'Space blob not found.');
        return;
      }
      writeResponse(response, 200, blob.bytes, {
        'Content-Type': blob.mime,
        'Content-Disposition': `inline; filename="${blob.filename}"`,
        'Cache-Control': 'private, max-age=31536000, immutable'
      });
      return;
    } catch (caught) {
      if (caught instanceof SpaceNotFoundError) {
        error(response, 404, 'SPACE_NOT_FOUND', 'Space not found.');
        return;
      }
      if (caught instanceof TypeError || caught instanceof URIError) {
        error(response, 400, 'INVALID_BLOB_ID', 'The Space blob id is invalid.');
        return;
      }
      if (caught instanceof SpaceAuthorityError) {
        error(response, caught.status, caught.code, caught.message);
        return;
      }
      error(response, 500, 'BLOB_READ_FAILED', 'The Space blob could not be read.');
      return;
    }
  }
  if (blobCollectionMatch || blobMatch) {
    response.setHeader('Allow', blobCollectionMatch ? 'POST' : 'GET, HEAD');
    error(response, 405, 'METHOD_NOT_ALLOWED', 'This method is not allowed on the Space blob route.');
    return;
  }

  const contentLength = request.headers['content-length'];
  const hasBody =
    request.headers['transfer-encoding'] !== undefined ||
    (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) !== 0));
  if (hasBody) {
    response.shouldKeepAlive = false;
    response.setHeader('Connection', 'close');
    response.once('finish', () => request.socket.destroy());
    error(response, 400, 'REQUEST_BODY_NOT_ALLOWED', 'GET and HEAD requests cannot include a body.');
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    error(response, 405, 'METHOD_NOT_ALLOWED', 'This Space route is read-only.');
    return;
  }

  const apiMatch = /^\/api\/spaces\/([^/]+)$/.exec(url.pathname);
  const shellMatch = /^\/s\/([^/]+)$/.exec(url.pathname);
  if ((apiMatch || shellMatch) && url.search !== '') {
    error(response, 404, 'ROUTE_NOT_FOUND', 'Space route not found.');
    return;
  }

  if (apiMatch || shellMatch) {
    let spaceId: string;
    try {
      spaceId = decodeSpaceId((apiMatch ?? shellMatch)![1]);
    } catch {
      error(response, 400, 'INVALID_SPACE_ID', 'The Space id is invalid.');
      return;
    }

    try {
      const space = await readSpace(spaceId);
      requirePublicScope(space, audience, publicSpaceId);
      const decision = evaluateSpacePolicy(space.policy, { audience, actor: 'guest', operation: apiMatch ? 'read' : 'join' });
      if (!decision.allowed) throw new SpaceAuthorityError(decision.reason, 'This Space policy does not allow access from this listener.', 403);
      if (apiMatch) {
        json(response, 200, visitorSpace(space));
        return;
      }
      await serveFile(
        response,
        path.join(appRoot, 'index.html'),
        'text/html; charset=utf-8',
        'no-store',
        true
      );
      return;
    } catch (caught) {
      if (caught instanceof SpaceNotFoundError) {
        error(response, 404, 'SPACE_NOT_FOUND', 'Space not found.');
        return;
      }
      if (caught instanceof SpaceLoadError) {
        error(response, 503, 'SPACE_UNAVAILABLE', 'Space is temporarily unavailable.');
        return;
      }
      if (caught instanceof SpaceAuthorityError) {
        error(response, caught.status, caught.code, caught.message);
        return;
      }
      error(response, 500, 'SPACE_READ_FAILED', 'The Space could not be read.');
      return;
    }
  }

  if (url.pathname === '/icon.svg' && /^\?(?:[A-Za-z0-9_-]+)?$/.test(url.search)) {
    await serveFile(response, path.join(appRoot, 'icon.svg'), MIME_TYPES['.svg'], 'public, max-age=3600');
    return;
  }

  const staticPrefix = '/_next/static/';
  if (url.search === '' && url.pathname.startsWith(staticPrefix)) {
    const relative = url.pathname.slice(staticPrefix.length);
    if (!isSafeStaticRelativePath(relative)) {
      error(response, 404, 'ROUTE_NOT_FOUND', 'Space route not found.');
      return;
    }
    const extension = path.extname(relative).toLowerCase();
    const contentType = MIME_TYPES[extension];
    if (!contentType) {
      error(response, 404, 'ROUTE_NOT_FOUND', 'Space route not found.');
      return;
    }
    await serveFile(
      response,
      path.join(appRoot, '_next', 'static', ...relative.split('/')),
      contentType,
      'public, max-age=31536000, immutable'
    );
    return;
  }

  error(response, 404, 'ROUTE_NOT_FOUND', 'Space route not found.');
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('port must be an integer from 0 through 65535');
  }
  return port;
}

export async function startSpacesHost(options: SpacesHostOptions = {}): Promise<RunningSpacesHost> {
  const binding = resolveSpacesHostBinding(options.mode, options.interfaces);
  const requestedPort = validatePort(options.port ?? DEFAULT_PORT);
  const appRoot = path.resolve(
    options.appRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'out')
  );
  const configuredHostnames = (options.allowedHostnames ?? []).map((hostname) => {
    const normalized = normalizeHostname(hostname);
    if (!normalized) throw new TypeError(`invalid allowed host name: ${hostname}`);
    return normalized;
  });
  const allowedHostnames = new Set([
    '127.0.0.1',
    'localhost',
    '::1',
    ...binding.advertisedAddresses,
    ...configuredHostnames
  ]);
  const uploadLimiter = new SlidingWindowUploadLimiter();
  const authority = new SpaceHostAuthority();
  const audience = options.audience ?? 'local';
  const publicSpaceId = audience === 'public'
    ? validateSpaceId(options.publicSpaceId)
    : undefined;
  const server = createServer({ maxHeaderSize: SPACES_HOST_LIMITS.maxHeaderSize }, (request, response) => {
    void routeRequest(request, response, appRoot, allowedHostnames, binding, uploadLimiter, authority, audience, publicSpaceId).catch(() => {
      if (!response.headersSent) {
        error(response, 500, 'HOST_FAILURE', 'The HII Spaces host could not handle this request.');
      } else {
        response.destroy();
      }
    });
  });
  server.headersTimeout = SPACES_HOST_LIMITS.headersTimeout;
  server.requestTimeout = SPACES_HOST_LIMITS.requestTimeout;
  server.keepAliveTimeout = SPACES_HOST_LIMITS.keepAliveTimeout;
  server.maxRequestsPerSocket = SPACES_HOST_LIMITS.maxRequestsPerSocket;
  const eventHub = createSpaceEventHub({
    server,
    binding,
    allowedHostnames,
    normalizeHostname,
    hasSameOrigin: (request, requestHostname) => hasSameOrigin(request, requestHostname, audience),
    authority,
    audience,
    publicSpaceId,
    ...options.events
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (caught: Error) => {
      server.off('listening', onListening);
      reject(caught);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, binding.bindAddress);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('HII Spaces host did not acquire a TCP address.');
  }
  const port = address.port;
  const origins = binding.advertisedAddresses.map((host) => `http://${host}:${port}`);
  const publisher = options.publication === false ? undefined : new SpacePublisher({
    ...options.publication,
    startPublicListener: async ({ allowedHostname, spaceId, port: publicPort }): Promise<PublicSpaceListener> => {
      const publicHost = await startSpacesHost({
        mode: 'local',
        port: publicPort,
        appRoot,
        allowedHostnames: [allowedHostname],
        events: options.events,
        audience: 'public',
        operator: false,
        publication: false,
        publicSpaceId: spaceId
      });
      return { port: publicHost.port, stop: publicHost.stop };
    }
  });
  const controls = new SpaceHostControls(eventHub, authority, publisher);
  const publicationReady = publisher
    ? publisher.reconcile().then(() => undefined, () => undefined)
    : Promise.resolve();
  let operator: Awaited<ReturnType<typeof startSpacesOperatorHost>> | undefined;
  try {
    if (options.operator !== false) {
      operator = await startSpacesOperatorHost({
        port: options.operatorPort ?? 0,
        appRoot,
        visitorOrigin: origins[0],
        controls
      });
    }
  } catch (caught) {
    await eventHub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw caught;
  }

  return {
    binding,
    port,
    origins,
    operatorOrigins: operator?.origins ?? [],
    controls,
    publicationReady,
    spaceUrls(spaceId: string) {
      const id = validateSpaceId(spaceId);
      return origins.map((origin) => `${origin}/s/${id}`);
    },
    async stop() {
      const results = await Promise.allSettled([
        publisher?.close() ?? Promise.resolve(),
        operator?.stop() ?? Promise.resolve(),
        eventHub.close(),
        new Promise<void>((resolve, reject) => {
          server.close((caught) => (caught ? reject(caught) : resolve()));
          server.closeIdleConnections();
        })
      ]);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
  };
}
