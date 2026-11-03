import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
  GuestTokenError,
  issueGuestCredential,
  verifyGuestToken,
  type GuestClaims,
  type GuestCredential
} from '../guest.ts';
import {
  evaluateSpacePolicy,
  type SpacePolicyActor,
  type SpacePolicyOperation,
  type SpacePolicyReasonCode,
  type SpacePolicyRequest
} from '../policy.ts';
import type { Space, SpaceAudience } from '../types.ts';

export const SPACE_GUEST_COOKIE = 'hii_space_guest';

export class SpaceAuthorityError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    status = 403
  ) {
    super(message);
    this.name = 'SpaceAuthorityError';
    this.code = code;
    this.status = status;
  }
}

export type AuthenticatedSpaceGuest = GuestClaims & {
  actor: 'guest' | 'invite';
  cookieValue: string;
};

const policyMessages: Record<Exclude<SpacePolicyReasonCode, 'POLICY_ALLOWED'>, string> = {
  POLICY_INVALID: 'This Space policy is invalid.',
  POLICY_INVALID_REQUEST: 'The requested Space operation is invalid.',
  POLICY_INVITE_REQUIRED: 'This Space requires an invitation.',
  POLICY_LOCAL_AUDIENCE_REQUIRED: 'This operation is available only through the local Space listener.',
  POLICY_READ_ONLY: 'This Space is read-only.',
  POLICY_WRITES_FROZEN: 'Writes are frozen for this Space.',
  POLICY_UPLOADS_DISABLED: 'Uploads are disabled for this Space.',
  POLICY_UPLOAD_SIZE_REQUIRED: 'Upload size is required.',
  POLICY_UPLOAD_TOO_LARGE: 'The image exceeds this Space upload limit.',
  POLICY_STORAGE_USAGE_REQUIRED: 'Space storage usage is required.',
  POLICY_STORAGE_QUOTA_EXCEEDED: 'This Space has reached its storage quota.',
  POLICY_OBJECT_COUNT_REQUIRED: 'Space object count is required.',
  POLICY_OBJECT_LIMIT_REACHED: 'This Space has reached its object limit.'
};

function parseCookies(request: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  const header = request.headers.cookie;
  if (typeof header !== 'string' || Buffer.byteLength(header) > 8_192) return cookies;
  for (const field of header.split(';')) {
    const separator = field.indexOf('=');
    if (separator < 1) continue;
    const name = field.slice(0, separator).trim();
    const value = field.slice(separator + 1).trim();
    if (/^[A-Za-z0-9_-]{1,64}$/.test(name) && value.length <= 4_096) cookies.set(name, value);
  }
  return cookies;
}

function decodeCookieValue(value: string): { deviceId: string; token: string } {
  const separator = value.indexOf('.');
  if (separator < 1) throw new SpaceAuthorityError('INVALID_GUEST_CREDENTIAL', 'Guest credential is malformed.', 401);
  return { deviceId: value.slice(0, separator), token: value.slice(separator + 1) };
}

export function assertSpacePolicy(
  space: Pick<Space, 'policy'>,
  request: SpacePolicyRequest
): void {
  const decision = evaluateSpacePolicy(space.policy, request);
  if (decision.allowed) return;
  const status = decision.reason === 'POLICY_WRITES_FROZEN' ? 423
    : decision.reason === 'POLICY_UPLOAD_TOO_LARGE' || decision.reason === 'POLICY_STORAGE_QUOTA_EXCEEDED' ? 413
      : 403;
  const reason = decision.reason as Exclude<SpacePolicyReasonCode, 'POLICY_ALLOWED'>;
  throw new SpaceAuthorityError(reason, policyMessages[reason], status);
}

export class SpaceHostAuthority {
  readonly #key: Buffer;
  readonly #revoked = new Map<string, Map<string, number>>();
  readonly #invites = new Map<string, { spaceId: string; expiresAt: number }>();
  readonly #invitedGuests = new Map<string, Set<string>>();

  constructor(key: Uint8Array = randomBytes(32)) {
    this.#key = Buffer.from(key);
  }

  #purge(now: number) {
    for (const [spaceId, guests] of this.#revoked) {
      for (const [guestId, expiresAt] of guests) if (now >= expiresAt) guests.delete(guestId);
      if (guests.size === 0) this.#revoked.delete(spaceId);
    }
  }

  issue(spaceId: string, now = Date.now()): GuestCredential {
    return issueGuestCredential({ spaceId, key: this.#key, now });
  }

  cookie(credential: GuestCredential | AuthenticatedSpaceGuest, secure = false): string {
    const maxAge = Math.max(1, Math.floor((credential.expiresAt - Date.now()) / 1_000));
    const value = 'cookieValue' in credential
      ? credential.cookieValue
      : `${credential.deviceId}.${credential.token}`;
    return `${SPACE_GUEST_COOKIE}=${value}; Path=/api/spaces/${credential.spaceId}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  authenticate(request: IncomingMessage, spaceId: string, now = Date.now()): AuthenticatedSpaceGuest {
    const value = parseCookies(request).get(SPACE_GUEST_COOKIE);
    if (!value) throw new SpaceAuthorityError('GUEST_CREDENTIAL_REQUIRED', 'A guest credential is required.', 401);
    try {
      const { deviceId, token } = decodeCookieValue(value);
      const claims = verifyGuestToken({ token, deviceId, spaceId, key: this.#key, now });
      this.#purge(now);
      if (this.#revoked.get(spaceId)?.has(claims.guestId)) {
        throw new SpaceAuthorityError('GUEST_REVOKED', 'This participant has been removed from the Space.', 401);
      }
      const actor = this.#invitedGuests.get(spaceId)?.has(claims.guestId) ? 'invite' : 'guest';
      return { ...claims, actor, cookieValue: value };
    } catch (error) {
      if (error instanceof SpaceAuthorityError) throw error;
      if (error instanceof GuestTokenError) {
        throw new SpaceAuthorityError(
          error.code === 'expired_token' ? 'GUEST_CREDENTIAL_EXPIRED' : 'INVALID_GUEST_CREDENTIAL',
          error.message,
          401
        );
      }
      throw error;
    }
  }

  ensure(request: IncomingMessage, spaceId: string, now = Date.now()): GuestCredential | AuthenticatedSpaceGuest {
    try {
      return this.authenticate(request, spaceId, now);
    } catch (error) {
      if (error instanceof SpaceAuthorityError && (
        error.code === 'GUEST_CREDENTIAL_REQUIRED' || error.code === 'GUEST_CREDENTIAL_EXPIRED'
      )) return this.issue(spaceId, now);
      throw error;
    }
  }

  createInvite(spaceId: string, ttlMs = 60 * 60_000, now = Date.now()): string {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60_000) {
      throw new SpaceAuthorityError('INVALID_INVITE_LIFETIME', 'Invite lifetime must be between one second and one day.', 400);
    }
    for (const [token, invite] of this.#invites) if (now >= invite.expiresAt) this.#invites.delete(token);
    if (this.#invites.size >= 1_000) throw new SpaceAuthorityError('INVITE_CAPACITY_REACHED', 'Too many active Space invites.', 429);
    const token = randomBytes(32).toString('base64url');
    this.#invites.set(token, { spaceId, expiresAt: now + ttlMs });
    return token;
  }

  redeemInvite(request: IncomingMessage, spaceId: string, now = Date.now()): GuestCredential {
    const token = request.headers['x-hii-space-invite'];
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new SpaceAuthorityError('INVITE_REQUIRED', 'A valid Space invite is required.', 401);
    }
    const invite = this.#invites.get(token);
    if (!invite || invite.spaceId !== spaceId || now >= invite.expiresAt) {
      throw new SpaceAuthorityError('INVITE_INVALID', 'The Space invite is invalid or expired.', 401);
    }
    this.#invites.delete(token);
    const credential = this.issue(spaceId, now);
    let guests = this.#invitedGuests.get(spaceId);
    if (!guests) {
      guests = new Set();
      this.#invitedGuests.set(spaceId, guests);
    }
    guests.add(credential.guestId);
    return credential;
  }

  ensureInvite(request: IncomingMessage, spaceId: string, now = Date.now()): GuestCredential | AuthenticatedSpaceGuest {
    if (typeof request.headers['x-hii-space-invite'] === 'string') return this.redeemInvite(request, spaceId, now);
    const existing = this.authenticate(request, spaceId, now);
    if (existing.actor !== 'invite') throw new SpaceAuthorityError('INVITE_REQUIRED', 'A valid Space invite is required.', 401);
    return existing;
  }

  revoke(claims: Pick<GuestClaims, 'spaceId' | 'guestId' | 'expiresAt'>): void {
    let guests = this.#revoked.get(claims.spaceId);
    if (!guests) {
      guests = new Map();
      this.#revoked.set(claims.spaceId, guests);
    }
    guests.set(claims.guestId, claims.expiresAt);
    this.#invitedGuests.get(claims.spaceId)?.delete(claims.guestId);
  }

  authorize(
    space: Space,
    audience: SpaceAudience,
    operation: SpacePolicyOperation,
    actor: SpacePolicyActor,
    detail: Omit<SpacePolicyRequest, 'audience' | 'operation' | 'actor'> = {}
  ): void {
    assertSpacePolicy(space, { audience, operation, actor, ...detail });
  }
}
