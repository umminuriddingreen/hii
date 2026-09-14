import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { decryptBrowserSnapshot, encryptBrowserSnapshot } from '../../lib/web/browser-snapshot-crypto';
import type { ChatDevice, LocalChatDevice } from '../../lib/web/chat-crypto';

async function device(id: string): Promise<{ local: LocalChatDevice; publicDevice: ChatDevice }> {
  const ecdh = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const signing = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const ecdhPublicJwk = await webcrypto.subtle.exportKey('jwk', ecdh.publicKey);
  const signingPublicJwk = await webcrypto.subtle.exportKey('jwk', signing.publicKey);
  return {
    local: { deviceId: id, ecdhPrivateKey: ecdh.privateKey, signingPrivateKey: signing.privateKey, ecdhPublicJwk, signingPublicJwk },
    publicDevice: { id, accountId: 'account', active: true, ecdhPublicJwk, signingPublicJwk },
  };
}

describe('encrypted browser snapshots', () => {
  it('wraps a page for paired devices and detects ciphertext changes', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const sender = await device('a'.repeat(43));
    const paired = await device('b'.repeat(43));
    const page = { url: 'https://example.com/article', title: 'Article', content: 'Rendered page content', capturedAt: '2026-09-14T00:00:00Z', browser: 'Chrome' };
    const envelope = await encryptBrowserSnapshot(page, sender.local, [sender.publicDevice, paired.publicDevice]);
    expect(JSON.stringify(envelope)).not.toContain(page.content);
    expect(await decryptBrowserSnapshot(envelope, paired.local)).toEqual(page);
    const changed = { ...envelope, sourceId: 'c'.repeat(43) };
    await expect(decryptBrowserSnapshot(changed, paired.local)).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
