import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { isSpaceId } from './types.ts';
import type { WorkspaceNode } from '../workspace/types.ts';

export const GUEST_ID_PATTERN = /^guest_[A-Za-z0-9_-]{16,48}$/;
export const GUEST_DEVICE_ID_PATTERN = /^device_[A-Za-z0-9_-]{16,48}$/;
export const MAX_GUEST_TOKEN_BYTES = 2_048;
export const DEFAULT_GUEST_TOKEN_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_GUEST_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const MIN_HOST_KEY_BYTES = 32;
const MAX_HOST_KEY_BYTES = 4_096;
const MAX_PAYLOAD_BYTES = 1_024;
const MAX_CLOCK_SKEW_MS = 60_000;

export type GuestTokenErrorCode =
  | 'invalid_configuration'
  | 'malformed_token'
  | 'invalid_token'
  | 'expired_token'
  | 'space_mismatch'
  | 'device_mismatch';

export class GuestTokenError extends Error {
  readonly code: GuestTokenErrorCode;

  constructor(code: GuestTokenErrorCode, message: string) {
    super(message);
    this.name = 'GuestTokenError';
    this.code = code;
  }
}

export class GuestOwnershipError extends Error {
  constructor(message = 'Guest may modify only objects they created in this Space.') {
    super(message);
    this.name = 'GuestOwnershipError';
  }
}

export type GuestClaims = {
  version: 1;
  spaceId: string;
  guestId: string;
  deviceId: string;
  issuedAt: number;
  expiresAt: number;
};

export type GuestCredential = GuestClaims & {
  token: string;
};

type WireClaims = {
  v: 1;
  s: string;
  g: string;
  d: string;
  iat: number;
  exp: number;
  n: string;
};

type GuestTokenOptions = {
  spaceId: string;
  /** Runtime-owned secret. It must never be stored in a guest record. */
  key: Uint8Array;
  now?: number;
  ttlMs?: number;
  /** Browser-held binding. Omit only when issuing a browser's first credential. */
  deviceId?: string;
};

type VerifyGuestTokenOptions = {
  token: string;
  spaceId: string;
  deviceId: string;
  key: Uint8Array;
  now?: number;
};

function fail(code: GuestTokenErrorCode, message: string): never {
  throw new GuestTokenError(code, message);
}

function validateKey(key: Uint8Array): void {
  if ((!Buffer.isBuffer(key) && !(key instanceof Uint8Array))
    || key.byteLength < MIN_HOST_KEY_BYTES || key.byteLength > MAX_HOST_KEY_BYTES) {
    fail('invalid_configuration', `Guest token key must be ${MIN_HOST_KEY_BYTES}-${MAX_HOST_KEY_BYTES} bytes.`);
  }
}

function validateNow(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) fail('invalid_configuration', 'Guest token time must be a non-negative integer.');
  return now;
}

function validateDeviceId(deviceId: string): string {
  if (!GUEST_DEVICE_ID_PATTERN.test(deviceId)) {
    fail('malformed_token', 'Guest device binding is invalid.');
  }
  return deviceId;
}

function decodeBase64Url(value: string, maxBytes: number, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(maxBytes * 4 / 3) + 2) {
    fail('malformed_token', `${label} is not valid bounded base64url.`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength === 0 || decoded.byteLength > maxBytes || decoded.toString('base64url') !== value) {
    fail('malformed_token', `${label} is not canonical base64url.`);
  }
  return decoded;
}

function sign(payload: string, key: Uint8Array): Buffer {
  return createHmac('sha256', key).update(payload, 'ascii').digest();
}

function constantTimeMacMatches(expected: Buffer, supplied: Buffer): boolean {
  const candidate = Buffer.alloc(expected.byteLength);
  supplied.copy(candidate, 0, 0, expected.byteLength);
  const equal = timingSafeEqual(expected, candidate);
  return supplied.byteLength === expected.byteLength && equal;
}

function parseClaims(encodedPayload: string): WireClaims {
  const payload = decodeBase64Url(encodedPayload, MAX_PAYLOAD_BYTES, 'Guest token payload');
  let value: unknown;
  try {
    value = JSON.parse(payload.toString('utf8'));
  } catch {
    fail('malformed_token', 'Guest token payload must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('malformed_token', 'Guest token payload must be an object.');
  const record = value as Record<string, unknown>;
  const expectedKeys = ['d', 'exp', 'g', 'iat', 'n', 's', 'v'];
  if (Object.keys(record).sort().join(',') !== expectedKeys.join(',')) fail('malformed_token', 'Guest token payload fields are invalid.');
  if (record.v !== 1 || !isSpaceId(record.s) || typeof record.g !== 'string' || !GUEST_ID_PATTERN.test(record.g)
    || typeof record.d !== 'string' || !GUEST_DEVICE_ID_PATTERN.test(record.d)
    || !Number.isSafeInteger(record.iat) || !Number.isSafeInteger(record.exp)
    || typeof record.n !== 'string' || !/^[A-Za-z0-9_-]{16,32}$/.test(record.n)) {
    fail('malformed_token', 'Guest token claims are invalid.');
  }
  return record as WireClaims;
}

/** Issue an account-free, PII-free credential scoped to one Space and device binding. */
export function issueGuestCredential(options: GuestTokenOptions): GuestCredential {
  validateKey(options.key);
  if (!isSpaceId(options.spaceId)) fail('invalid_configuration', 'Cannot issue a guest token for an invalid Space id.');
  const issuedAt = validateNow(options.now ?? Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_GUEST_TOKEN_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_GUEST_TOKEN_TTL_MS) {
    fail('invalid_configuration', `Guest token lifetime must be 1000-${MAX_GUEST_TOKEN_TTL_MS} ms.`);
  }
  const guestId = `guest_${randomBytes(18).toString('base64url')}`;
  const deviceId = options.deviceId ? validateDeviceId(options.deviceId) : `device_${randomBytes(18).toString('base64url')}`;
  const expiresAt = issuedAt + ttlMs;
  const claims: WireClaims = {
    v: 1,
    s: options.spaceId,
    g: guestId,
    d: deviceId,
    iat: issuedAt,
    exp: expiresAt,
    n: randomBytes(12).toString('base64url')
  };
  const encodedPayload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const token = `${encodedPayload}.${sign(encodedPayload, options.key).toString('base64url')}`;
  if (Buffer.byteLength(token, 'utf8') > MAX_GUEST_TOKEN_BYTES) fail('invalid_configuration', 'Issued guest token exceeds its wire limit.');
  return { version: 1, spaceId: options.spaceId, guestId, deviceId, issuedAt, expiresAt, token };
}

/** Verify integrity, expiry, Space scope, and the browser-held device binding. */
export function verifyGuestToken(options: VerifyGuestTokenOptions): GuestClaims {
  validateKey(options.key);
  const now = validateNow(options.now ?? Date.now());
  if (typeof options.token !== 'string' || Buffer.byteLength(options.token, 'utf8') > MAX_GUEST_TOKEN_BYTES) {
    fail('malformed_token', 'Guest token is missing or exceeds its wire limit.');
  }
  const parts = options.token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail('malformed_token', 'Guest token format is invalid.');
  const suppliedMac = decodeBase64Url(parts[1], 64, 'Guest token signature');
  const expectedMac = sign(parts[0], options.key);
  if (!constantTimeMacMatches(expectedMac, suppliedMac)) fail('invalid_token', 'Guest token signature is invalid.');
  const claims = parseClaims(parts[0]);
  if (claims.s !== options.spaceId) fail('space_mismatch', 'Guest token is not valid for this Space.');
  if (claims.d !== options.deviceId) fail('device_mismatch', 'Guest token is not valid for this browser device.');
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_GUEST_TOKEN_TTL_MS || claims.iat > now + MAX_CLOCK_SKEW_MS) {
    fail('invalid_token', 'Guest token time claims are invalid.');
  }
  if (now >= claims.exp) fail('expired_token', 'Guest token has expired.');
  return {
    version: 1,
    spaceId: claims.s,
    guestId: claims.g,
    deviceId: claims.d,
    issuedAt: claims.iat,
    expiresAt: claims.exp
  };
}

export function guestOwnsObject(
  guest: Pick<GuestClaims, 'guestId' | 'spaceId'>,
  object: Pick<WorkspaceNode, 'creatorId' | 'spaceId'>
): boolean {
  return object.spaceId === guest.spaceId && object.creatorId === guest.guestId;
}

export function assertGuestOwnsObject(
  guest: Pick<GuestClaims, 'guestId' | 'spaceId'>,
  object: Pick<WorkspaceNode, 'creatorId' | 'spaceId'>
): void {
  if (!guestOwnsObject(guest, object)) throw new GuestOwnershipError();
}
