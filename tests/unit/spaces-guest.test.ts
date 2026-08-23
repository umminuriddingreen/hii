import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  assertGuestOwnsObject,
  guestOwnsObject,
  GuestOwnershipError,
  GuestTokenError,
  issueGuestCredential,
  MAX_GUEST_TOKEN_BYTES,
  verifyGuestToken
} from '../../lib/spaces/guest.ts';

const key = randomBytes(32);
const now = Date.UTC(2026, 7, 20);

function expectGuestError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GuestTokenError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected GuestTokenError with code ${code}.`);
}

describe('Space guest credentials', () => {
  it('issues and verifies a PII-free credential bound to one Space and browser device', () => {
    const credential = issueGuestCredential({ spaceId: '14th-street', key, now, ttlMs: 60_000 });
    expect(credential.guestId).toMatch(/^guest_/);
    expect(credential.deviceId).toMatch(/^device_/);
    expect(Buffer.byteLength(credential.token)).toBeLessThanOrEqual(MAX_GUEST_TOKEN_BYTES);
    expect(credential).not.toHaveProperty('email');
    expect(verifyGuestToken({
      token: credential.token,
      spaceId: '14th-street',
      deviceId: credential.deviceId,
      key,
      now: now + 1
    })).toEqual({
      version: 1,
      spaceId: '14th-street',
      guestId: credential.guestId,
      deviceId: credential.deviceId,
      issuedAt: now,
      expiresAt: now + 60_000
    });
  });

  it('rejects the wrong Space, browser device, host key, and a tampered MAC', () => {
    const credential = issueGuestCredential({ spaceId: '14th-street', key, now });
    expect(() => verifyGuestToken({ ...credential, token: credential.token, spaceId: 'other-space', key, now })).toThrow(/not valid for this Space/);
    expect(() => verifyGuestToken({ token: credential.token, spaceId: credential.spaceId, deviceId: `device_${'x'.repeat(20)}`, key, now })).toThrow(/browser device/);
    expect(() => verifyGuestToken({ ...credential, token: credential.token, key: randomBytes(32), now })).toThrow(/signature/);
    const [payload, signature] = credential.token.split('.');
    const tampered = `${payload}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
    expect(() => verifyGuestToken({ ...credential, token: tampered, key, now })).toThrow(/signature/);
  });

  it('expires at the signed boundary and rejects oversized or malformed wire input', () => {
    const credential = issueGuestCredential({ spaceId: '14th-street', key, now, ttlMs: 1_000 });
    expect(() => verifyGuestToken({ ...credential, token: credential.token, key, now: now + 999 })).not.toThrow();
    expectGuestError(
      () => verifyGuestToken({ ...credential, token: credential.token, key, now: now + 1_000 }),
      'expired_token'
    );
    expect(() => verifyGuestToken({ token: 'x'.repeat(MAX_GUEST_TOKEN_BYTES + 1), spaceId: '14th-street', deviceId: credential.deviceId, key, now })).toThrow(/wire limit/);
    expect(() => verifyGuestToken({ token: 'not.a.valid.token', spaceId: '14th-street', deviceId: credential.deviceId, key, now })).toThrow(GuestTokenError);
  });

  it('allows a guest to mutate only their own object in their own Space', () => {
    const guest = issueGuestCredential({ spaceId: '14th-street', key, now });
    const own = { spaceId: guest.spaceId, creatorId: guest.guestId };
    expect(guestOwnsObject(guest, own)).toBe(true);
    expect(guestOwnsObject(guest, { ...own, creatorId: 'guest_someone-else-id' })).toBe(false);
    expect(guestOwnsObject(guest, { ...own, spaceId: 'other-space' })).toBe(false);
    expect(() => assertGuestOwnsObject(guest, own)).not.toThrow();
    expect(() => assertGuestOwnsObject(guest, { ...own, creatorId: undefined })).toThrow(GuestOwnershipError);
  });
});
