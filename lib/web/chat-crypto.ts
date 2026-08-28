// SPDX-License-Identifier: LicenseRef-BSL-1.1

export type ChatDevice = {
  id: string;
  accountId: string;
  active: boolean;
  ecdhPublicJwk: JsonWebKey;
  signingPublicJwk: JsonWebKey;
};

export type RecipientWrap = {
  deviceId: string;
  ephemeralPublicJwk: JsonWebKey;
  nonce: string;
  ciphertext: string;
};

export type ChatEnvelope = {
  version: 1;
  algorithm: 'P256-HKDF-SHA256-A256GCM';
  conversationId: string;
  messageId: string;
  senderDeviceId: string;
  clientCreatedAt: number;
  nonce: string;
  ciphertext: string;
  signature: string;
  recipientWraps: RecipientWrap[];
};

export type LocalChatDevice = {
  deviceId: string;
  ecdhPrivateKey: CryptoKey;
  signingPrivateKey: CryptoKey;
  ecdhPublicJwk: JsonWebKey;
  signingPublicJwk: JsonWebKey;
};

const DATABASE = 'hii-chat-device-v1';
const STORE = 'keys';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64url(bytes: ArrayBuffer | Uint8Array) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function randomId() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('device_store_unavailable'));
  });
}

function deviceRecord(accountId: string) {
  return `account:${accountId}`;
}

async function readDevice(accountId: string): Promise<LocalChatDevice | null> {
  const database = await openDatabase();
  return await new Promise<LocalChatDevice | null>((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(deviceRecord(accountId));
    request.onsuccess = () => resolve((request.result as LocalChatDevice | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error('device_store_unavailable'));
  }).finally(() => database.close());
}

async function writeDevice(accountId: string, device: LocalChatDevice) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE, 'readwrite').objectStore(STORE).put(device, deviceRecord(accountId));
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('device_store_unavailable'));
  }).finally(() => database.close());
}

export async function ensureLocalChatDevice(
  accountId: string,
  register: (keys: { ecdhPublicJwk: JsonWebKey; signingPublicJwk: JsonWebKey }) => Promise<{ deviceId: string }>,
) {
  const stored = await readDevice(accountId);
  if (stored) return stored;
  const ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const ecdhPublicJwk = canonicalPublicJwk(await crypto.subtle.exportKey('jwk', ecdh.publicKey));
  const signingPublicJwk = canonicalPublicJwk(await crypto.subtle.exportKey('jwk', signing.publicKey));
  const { deviceId } = await register({ ecdhPublicJwk, signingPublicJwk });
  const device: LocalChatDevice = {
    deviceId,
    ecdhPrivateKey: ecdh.privateKey,
    signingPrivateKey: signing.privateKey,
    ecdhPublicJwk,
    signingPublicJwk,
  };
  await writeDevice(accountId, device);
  return device;
}

function messageAad(envelope: Pick<ChatEnvelope, 'version' | 'conversationId' | 'messageId' | 'senderDeviceId' | 'clientCreatedAt'>) {
  return encoder.encode(JSON.stringify([
    envelope.version,
    envelope.conversationId,
    envelope.messageId,
    envelope.senderDeviceId,
    envelope.clientCreatedAt,
  ]));
}

function canonicalPublicJwk(jwk: JsonWebKey) {
  if (![jwk.kty, jwk.crv, jwk.x, jwk.y].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new Error('invalid_public_key');
  }
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

function canonicalPublicJwkTuple(jwk: JsonWebKey) {
  const canonical = canonicalPublicJwk(jwk);
  return [canonical.kty, canonical.crv, canonical.x, canonical.y];
}

function signedBytes(envelope: Omit<ChatEnvelope, 'signature'>) {
  return encoder.encode(JSON.stringify([
    envelope.version,
    envelope.algorithm,
    envelope.conversationId,
    envelope.messageId,
    envelope.senderDeviceId,
    envelope.clientCreatedAt,
    envelope.nonce,
    envelope.ciphertext,
    envelope.recipientWraps.map((wrap) => [wrap.deviceId, canonicalPublicJwkTuple(wrap.ephemeralPublicJwk), wrap.nonce, wrap.ciphertext]),
  ]));
}

async function wrappingKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  nonce: Uint8Array<ArrayBuffer>,
  conversationId: string,
  deviceId: string,
) {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: nonce,
    info: encoder.encode(`hii-chat-wrap-v1|${conversationId}|${deviceId}`),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptChatMessage(
  plaintext: string,
  conversationId: string,
  sender: LocalChatDevice,
  devices: ChatDevice[],
): Promise<ChatEnvelope> {
  const messageId = randomId();
  const clientCreatedAt = Date.now();
  const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawContentKey = await crypto.subtle.exportKey('raw', contentKey);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const base = { version: 1 as const, conversationId, messageId, senderDeviceId: sender.deviceId, clientCreatedAt };
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: messageAad(base) }, contentKey, encoder.encode(plaintext.slice(0, 8_000)));
  const recipientWraps: RecipientWrap[] = [];
  for (const device of devices) {
    const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicKey = await crypto.subtle.importKey('jwk', device.ecdhPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const wrapNonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await wrappingKey(ephemeral.privateKey, publicKey, wrapNonce, conversationId, device.id);
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapNonce }, key, rawContentKey);
    recipientWraps.push({
      deviceId: device.id,
      ephemeralPublicJwk: await crypto.subtle.exportKey('jwk', ephemeral.publicKey),
      nonce: b64url(wrapNonce),
      ciphertext: b64url(wrapped),
    });
  }
  const unsigned: Omit<ChatEnvelope, 'signature'> = {
    ...base,
    algorithm: 'P256-HKDF-SHA256-A256GCM',
    nonce: b64url(nonce),
    ciphertext: b64url(ciphertext),
    recipientWraps,
  };
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, sender.signingPrivateKey, signedBytes(unsigned));
  return { ...unsigned, signature: b64url(signature) };
}

export async function decryptChatMessage(
  envelope: ChatEnvelope,
  local: LocalChatDevice,
  sender: ChatDevice,
) {
  const { signature, ...unsigned } = envelope;
  const signingKey = await crypto.subtle.importKey('jwk', sender.signingPublicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, bytes(signature), signedBytes(unsigned));
  if (!verified) throw new Error('message_signature_failed');
  const wrap = envelope.recipientWraps.find((entry) => entry.deviceId === local.deviceId);
  if (!wrap) throw new Error('message_not_for_device');
  const ephemeralPublic = await crypto.subtle.importKey('jwk', wrap.ephemeralPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const wrapNonce = bytes(wrap.nonce);
  const key = await wrappingKey(local.ecdhPrivateKey, ephemeralPublic, wrapNonce, envelope.conversationId, local.deviceId);
  const rawContentKey = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: wrapNonce }, key, bytes(wrap.ciphertext));
  const contentKey = await crypto.subtle.importKey('raw', rawContentKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(envelope.nonce), additionalData: messageAad(envelope) }, contentKey, bytes(envelope.ciphertext));
  return decoder.decode(plaintext);
}
