import { describe, expect, it } from 'vitest';
import {
  createRemoteSession,
  timingSafeTextEqual,
  verifyRemoteSession
} from '../../src/lib/server/hii-remote-auth';

describe('HII remote authentication', () => {
  it('compares credential text without direct string equality', async () => {
    await expect(timingSafeTextEqual('ummi', 'ummi')).resolves.toBe(true);
    await expect(timingSafeTextEqual('ummi', 'someone-else')).resolves.toBe(false);
  });

  it('accepts a signed session before expiration', async () => {
    const token = await createRemoteSession('ummi', 'test-session-key', 1_000);
    await expect(verifyRemoteSession(token, 'ummi', 'test-session-key', 2_000)).resolves.toBe(true);
  });

  it('rejects tampering, the wrong user, and expiration', async () => {
    const token = await createRemoteSession('ummi', 'test-session-key', 1_000);
    await expect(verifyRemoteSession(`${token}x`, 'ummi', 'test-session-key', 2_000)).resolves.toBe(false);
    await expect(verifyRemoteSession(token, 'other', 'test-session-key', 2_000)).resolves.toBe(false);
    await expect(verifyRemoteSession(token, 'ummi', 'test-session-key', 40_000_000)).resolves.toBe(false);
  });
});
