// SPDX-License-Identifier: LicenseRef-BSL-1.1

import type { ChatDevice, LocalChatDevice, RecipientWrap } from './chat-crypto';

export type BrowserSnapshotEnvelope = {
  version: 1;
  algorithm: 'P256-HKDF-SHA256-A256GCM';
  id: string;
  sourceId: string;
  senderDeviceId: string;
  createdAt: number;
  nonce: string;
  ciphertext: string;
  recipientWraps: RecipientWrap[];
};

export type BrowserSnapshot = {
  url: string;
  title: string;
  content: string;
  capturedAt: string;
  browser: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64url(value: ArrayBuffer | Uint8Array) {
  const array = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function aad(envelope: Pick<BrowserSnapshotEnvelope, 'version' | 'id' | 'sourceId' | 'senderDeviceId' | 'createdAt'>) {
  return encoder.encode(JSON.stringify([envelope.version, envelope.id, envelope.sourceId, envelope.senderDeviceId, envelope.createdAt]));
}

async function wrapKey(privateKey: CryptoKey, publicKey: CryptoKey, nonce: Uint8Array<ArrayBuffer>, snapshotId: string, deviceId: string) {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: nonce,
    info: encoder.encode(`hii-browser-snapshot-wrap-v1|${snapshotId}|${deviceId}`),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBrowserSnapshot(snapshot: BrowserSnapshot, sender: LocalChatDevice, devices: ChatDevice[]): Promise<BrowserSnapshotEnvelope> {
  if (!snapshot.url.startsWith('http://') && !snapshot.url.startsWith('https://')) throw new Error('invalid_snapshot_url');
  if (snapshot.content.length > 500_000) throw new Error('snapshot_too_large');
  const recipients = devices.filter((device) => device.active);
  if (!recipients.some((device) => device.id === sender.deviceId) || recipients.length > 16) throw new Error('invalid_snapshot_recipients');
  const id = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const sourceId = b64url(await crypto.subtle.digest('SHA-256', encoder.encode(snapshot.url)));
  const base = { version: 1 as const, id, sourceId, senderDeviceId: sender.deviceId, createdAt: Date.now() };
  const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawContentKey = await crypto.subtle.exportKey('raw', contentKey);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(base) }, contentKey, encoder.encode(JSON.stringify(snapshot)));
  const recipientWraps: RecipientWrap[] = [];
  for (const device of recipients) {
    const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicKey = await crypto.subtle.importKey('jwk', device.ecdhPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const wrapNonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await wrapKey(ephemeral.privateKey, publicKey, wrapNonce, id, device.id);
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapNonce }, key, rawContentKey);
    recipientWraps.push({
      deviceId: device.id,
      ephemeralPublicJwk: await crypto.subtle.exportKey('jwk', ephemeral.publicKey),
      nonce: b64url(wrapNonce), ciphertext: b64url(wrapped),
    });
  }
  return { ...base, algorithm: 'P256-HKDF-SHA256-A256GCM', nonce: b64url(nonce), ciphertext: b64url(ciphertext), recipientWraps };
}

export async function decryptBrowserSnapshot(envelope: BrowserSnapshotEnvelope, local: LocalChatDevice): Promise<BrowserSnapshot> {
  const wrap = envelope.recipientWraps.find((entry) => entry.deviceId === local.deviceId);
  if (!wrap) throw new Error('snapshot_not_for_device');
  const ephemeralPublic = await crypto.subtle.importKey('jwk', wrap.ephemeralPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const wrapNonce = bytes(wrap.nonce);
  const key = await wrapKey(local.ecdhPrivateKey, ephemeralPublic, wrapNonce, envelope.id, local.deviceId);
  const rawContentKey = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: wrapNonce }, key, bytes(wrap.ciphertext));
  const contentKey = await crypto.subtle.importKey('raw', rawContentKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(envelope.nonce), additionalData: aad(envelope) }, contentKey, bytes(envelope.ciphertext));
  const snapshot = JSON.parse(decoder.decode(plaintext)) as BrowserSnapshot;
  if (typeof snapshot.url !== 'string' || typeof snapshot.content !== 'string') throw new Error('invalid_snapshot');
  return snapshot;
}
