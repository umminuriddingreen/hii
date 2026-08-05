const encoder = new TextEncoder();

export const remoteSessionCookie = 'hii_remote_session';
export const remoteSessionMaxAge = 8 * 60 * 60;

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  const timingSafeEqual = (
    crypto.subtle as SubtleCrypto & {
      timingSafeEqual?: (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView) => boolean;
    }
  ).timingSafeEqual;
  if (timingSafeEqual) return timingSafeEqual.call(crypto.subtle, left, right);
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index % left.byteLength] ?? 0) ^ (right[index % right.byteLength] ?? 0);
  }
  return difference === 0;
}

export async function timingSafeTextEqual(provided: string, expected: string) {
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected))
  ]);
  return constantTimeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash));
}

export async function createRemoteSession(username: string, secret: string, now = Date.now()) {
  const payload = base64Url(
    encoder.encode(JSON.stringify({ username, expiresAt: now + remoteSessionMaxAge * 1000 }))
  );
  return `${payload}.${base64Url(await hmac(payload, secret))}`;
}

export async function verifyRemoteSession(
  token: string | undefined,
  expectedUsername: string,
  secret: string,
  now = Date.now()
) {
  if (!token) return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return false;
  let providedSignature: Uint8Array;
  try {
    providedSignature = decodeBase64Url(signature);
  } catch {
    return false;
  }
  const expectedSignature = await hmac(payload, secret);
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', Uint8Array.from(providedSignature).buffer),
    crypto.subtle.digest('SHA-256', Uint8Array.from(expectedSignature).buffer)
  ]);
  if (!constantTimeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash))) {
    return false;
  }
  try {
    const data = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as {
      username?: string;
      expiresAt?: number;
    };
    return (
      typeof data.username === 'string' &&
      (await timingSafeTextEqual(data.username, expectedUsername)) &&
      typeof data.expiresAt === 'number' &&
      data.expiresAt > now
    );
  } catch {
    return false;
  }
}
