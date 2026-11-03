import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createSpace,
  listSpaces,
  readSpace,
  SpaceExistsError,
  SpaceNotFoundError
} from '../../server/space-store.ts';
import { SPACE_POLICY_MODES, type SpacePolicyMode } from '../policy.ts';
import { GUEST_ID_PATTERN } from '../guest.ts';
import { slugifySpaceName } from '../types.ts';
import type { SpaceHostControls } from './controls.ts';

const MAX_OPERATOR_BODY_BYTES = 16 * 1024;
const OPERATOR_HOSTS = new Set(['127.0.0.1', 'localhost']);
const STATIC_MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' ws: wss:",
  'Cross-Origin-Resource-Policy': 'same-origin'
} as const;

export type SpacesOperatorOptions = {
  port?: number;
  appRoot: string;
  visitorOrigin: string;
  controls: SpaceHostControls;
};

export type RunningSpacesOperator = {
  port: number;
  origins: string[];
  stop(): Promise<void>;
};

class OperatorRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'OperatorRequestError';
    this.status = status;
    this.code = code;
  }
}

function respond(response: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Length': String(Buffer.byteLength(body)), ...headers });
  if (response.req.method === 'HEAD') response.end();
  else response.end(body);
}

function json(response: ServerResponse, status: number, value: unknown) {
  const body = `${JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
  respond(response, status, body, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function fail(status: number, code: string, message: string): never {
  throw new OperatorRequestError(status, code, message);
}

function accessUrl(spaceId: string, visitorOrigin: string) {
  return `${visitorOrigin}/s/${spaceId}`;
}

function requestHostname(request: IncomingMessage): string | null {
  const raw = request.headers.host ?? '';
  if (!raw || /[\s/@]/.test(raw)) return null;
  try {
    const parsed = new URL(`http://${raw}`);
    const port = parsed.port ? Number(parsed.port) : 80;
    return OPERATOR_HOSTS.has(parsed.hostname.toLowerCase()) && port === request.socket.localPort
      ? parsed.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function requireOperatorOrigin(request: IncomingMessage, hostname: string) {
  if (request.headers.origin !== `http://${hostname}:${request.socket.localPort}`) {
    fail(403, 'OPERATOR_ORIGIN_REQUIRED', 'Operator writes require the exact loopback operator origin.');
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
    fail(415, 'JSON_REQUIRED', 'Operator writes require application/json.');
  }
  const declared = request.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_OPERATOR_BODY_BYTES)) {
    fail(413, 'OPERATOR_BODY_TOO_LARGE', 'Operator request body is too large.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_OPERATOR_BODY_BYTES) fail(413, 'OPERATOR_BODY_TOO_LARGE', 'Operator request body is too large.');
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail(400, 'INVALID_JSON', 'Operator request body must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_JSON', 'Operator request body must be an object.');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(400, 'INVALID_OPERATOR_ACTION', 'Operator request contains an unknown field.');
}

function safeStaticPath(relative: string) {
  const segments = relative.split('/');
  return segments.length > 0 && segments.every((segment) =>
    segment.length > 0 && segment !== '.' && segment !== '..' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)
  );
}

function boundedInteger(value: unknown, field: string, max: number) {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    fail(400, 'INVALID_OPERATOR_ACTION', `${field} is outside its allowed range.`);
  }
  return value as number;
}

async function applyControl(spaceId: string, body: Record<string, unknown>, controls: SpaceHostControls) {
  const action = body.action;
  if (action === 'set-writes-frozen') {
    exactKeys(body, ['action', 'value']);
    if (typeof body.value !== 'boolean') fail(400, 'INVALID_OPERATOR_ACTION', 'set-writes-frozen requires a boolean value.');
    return { ok: true, space: await controls.freezeWrites(spaceId, body.value) };
  }
  if (action === 'set-uploads-enabled') {
    exactKeys(body, ['action', 'value']);
    if (typeof body.value !== 'boolean') fail(400, 'INVALID_OPERATOR_ACTION', 'set-uploads-enabled requires a boolean value.');
    return { ok: true, space: await controls.disableUploads(spaceId, !body.value) };
  }
  if (action === 'set-upload-limits') {
    exactKeys(body, ['action', 'maxUploadBytes', 'storageQuotaBytes', 'maxObjects']);
    const limits = {
      ...(body.maxUploadBytes === undefined ? {} : { maxUploadBytes: boundedInteger(body.maxUploadBytes, 'maxUploadBytes', 250 * 1024 * 1024) }),
      ...(body.storageQuotaBytes === undefined ? {} : { storageQuotaBytes: boundedInteger(body.storageQuotaBytes, 'storageQuotaBytes', 10 * 1024 * 1024 * 1024) }),
      ...(body.maxObjects === undefined ? {} : { maxObjects: boundedInteger(body.maxObjects, 'maxObjects', 100_000) })
    };
    if (Object.keys(limits).length === 0) fail(400, 'INVALID_OPERATOR_ACTION', 'set-upload-limits requires at least one limit.');
    return { ok: true, space: await controls.configureUploadLimits(spaceId, limits) };
  }
  if (action === 'set-policy-mode') {
    exactKeys(body, ['action', 'mode']);
    if (typeof body.mode !== 'string' || !SPACE_POLICY_MODES.includes(body.mode as SpacePolicyMode)) fail(400, 'INVALID_OPERATOR_ACTION', 'set-policy-mode requires a supported mode.');
    return { ok: true, space: await controls.setPolicyMode(spaceId, body.mode as SpacePolicyMode) };
  }
  if (action === 'remove-object') {
    exactKeys(body, ['action', 'objectId']);
    if (typeof body.objectId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.objectId)) fail(400, 'INVALID_OPERATOR_ACTION', 'remove-object requires a valid objectId.');
    await controls.removeObject(spaceId, body.objectId);
    return { ok: true };
  }
  if (action === 'remove-participant') {
    exactKeys(body, ['action', 'participantId']);
    if (typeof body.participantId !== 'string' || !GUEST_ID_PATTERN.test(body.participantId)) fail(400, 'INVALID_OPERATOR_ACTION', 'remove-participant requires a valid participantId.');
    await controls.removeParticipant(spaceId, body.participantId);
    return { ok: true };
  }
  if (action === 'clear-space') {
    exactKeys(body, ['action']);
    await controls.clearSpace(spaceId);
    return { ok: true };
  }
  if (action === 'create-invite') {
    exactKeys(body, ['action']);
    return { ok: true, invite: await controls.createInvite(spaceId) };
  }
  if (action === 'publish-space') {
    exactKeys(body, ['action']);
    return { ok: true, publication: await controls.publishSpace(spaceId) };
  }
  if (action === 'unpublish-space') {
    exactKeys(body, ['action']);
    return { ok: true, space: await controls.unpublishSpace(spaceId) };
  }
  fail(400, 'INVALID_OPERATOR_ACTION', 'Unknown Space control action.');
}

export async function startSpacesOperatorHost(options: SpacesOperatorOptions): Promise<RunningSpacesOperator> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError('operatorPort must be an integer from 0 through 65535');
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    void (async () => {
      if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(request.socket.remoteAddress ?? '')) fail(403, 'OPERATOR_LOOPBACK_REQUIRED', 'The HII operator is loopback-only.');
      const hostname = requestHostname(request);
      if (!hostname) fail(421, 'MISDIRECTED_REQUEST', 'This host name is not accepted by the HII operator.');
      const url = new URL(request.url ?? '/', 'http://hii-operator.invalid');
      if (url.search || url.hash) fail(404, 'ROUTE_NOT_FOUND', 'Operator route not found.');
      const method = request.method ?? 'GET';
      if (method === 'POST') requireOperatorOrigin(request, hostname);

      if (method === 'GET' && (url.pathname === '/spaces' || url.pathname === '/new' || /^\/host\/s\/[a-z0-9_-]{1,64}$/.test(url.pathname))) {
        const shell = await readFile(path.join(options.appRoot, 'index.html'));
        respond(response, 200, shell, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return;
      }
      if (method === 'GET' && url.pathname.startsWith('/_next/static/')) {
        const relative = url.pathname.slice('/_next/static/'.length);
        const contentType = STATIC_MIME[path.extname(relative).toLowerCase()];
        if (!safeStaticPath(relative) || !contentType) fail(404, 'ROUTE_NOT_FOUND', 'Operator route not found.');
        const asset = await readFile(path.join(options.appRoot, '_next', 'static', ...relative.split('/')));
        respond(response, 200, asset, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/host/spaces') {
        json(response, 200, { spaces: await listSpaces() });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/host/spaces') {
        const body = await readJson(request);
        exactKeys(body, ['name']);
        if (typeof body.name !== 'string' || body.name.length > 120) fail(400, 'INVALID_SPACE_NAME', 'Space name must be a string no longer than 120 characters.');
        const name = body.name.trim();
        const id = slugifySpaceName(name);
        if (!name || !id) fail(400, 'INVALID_SPACE_NAME', 'Use at least one letter or number in the Space name.');
        const space = await createSpace({ id, name, ownerId: 'user:local-host' });
        json(response, 201, { space, accessUrl: accessUrl(space.id, options.visitorOrigin) });
        return;
      }
      const detail = /^\/api\/host\/spaces\/([a-z0-9_-]{1,64})$/.exec(url.pathname);
      if (method === 'GET' && detail) {
        const space = await readSpace(detail[1]);
        json(response, 200, { space, accessUrl: accessUrl(space.id, options.visitorOrigin) });
        return;
      }
      const share = /^\/api\/host\/spaces\/([a-z0-9_-]{1,64})\/share$/.exec(url.pathname);
      if (method === 'GET' && share) {
        const space = await readSpace(share[1]);
        json(response, 200, { space, accessUrl: accessUrl(space.id, options.visitorOrigin) });
        return;
      }
      const control = /^\/api\/host\/spaces\/([a-z0-9_-]{1,64})\/controls$/.exec(url.pathname);
      if (method === 'POST' && control) {
        json(response, 200, await applyControl(control[1], await readJson(request), options.controls));
        return;
      }
      fail(404, 'ROUTE_NOT_FOUND', 'Operator route not found.');
    })().catch((error) => {
      if (response.headersSent) return response.destroy();
      if (error instanceof OperatorRequestError) return json(response, error.status, { error: { code: error.code, message: error.message } });
      if (error instanceof SpaceExistsError) return json(response, 409, { error: { code: error.code, message: 'A Space with this name already exists.' } });
      if (error instanceof SpaceNotFoundError) return json(response, 404, { error: { code: error.code, message: 'Space not found.' } });
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return json(response, 503, { error: { code: 'APP_SHELL_UNAVAILABLE', message: 'The HII app shell has not been built.' } });
      return json(response, 500, { error: { code: 'OPERATOR_FAILURE', message: 'The HII operator could not complete the request.' } });
    });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  server.maxRequestsPerSocket = 100;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HII Spaces operator did not acquire a TCP address.');
  const origins = [`http://127.0.0.1:${address.port}`];
  return {
    port: address.port,
    origins,
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    })
  };
}
