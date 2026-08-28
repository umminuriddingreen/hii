import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { decryptChatMessage, encryptChatMessage, type ChatDevice, type LocalChatDevice } from '../../lib/web/chat-crypto';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

async function device(id: string, accountId: string): Promise<{ local: LocalChatDevice; public: ChatDevice }> {
  const ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const ecdhPublicJwk = await crypto.subtle.exportKey('jwk', ecdh.publicKey);
  const signingPublicJwk = await crypto.subtle.exportKey('jwk', signing.publicKey);
  return {
    local: { deviceId: id, ecdhPrivateKey: ecdh.privateKey, signingPrivateKey: signing.privateKey, ecdhPublicJwk, signingPublicJwk },
    public: { id, accountId, active: true, ecdhPublicJwk, signingPublicJwk },
  };
}

describe('web chat encryption', () => {
  it('round-trips only for wrapped devices and rejects tampering', async () => {
    const sender = await device('sender', 'a');
    const recipient = await device('recipient', 'b');
    const envelope = await encryptChatMessage('private hello', 'conversation', sender.local, [sender.public, recipient.public]);
    await expect(decryptChatMessage(envelope, recipient.local, sender.public)).resolves.toBe('private hello');
    await expect(decryptChatMessage({ ...envelope, ciphertext: envelope.ciphertext.replace(/^./, envelope.ciphertext[0] === 'A' ? 'B' : 'A') }, recipient.local, sender.public)).rejects.toThrow();
  });
});
