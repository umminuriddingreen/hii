// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { createHash, randomBytes, webcrypto } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const crypto = webcrypto;
const encoder = new TextEncoder();
const runtime = () => process.env.HII_RUNTIME_DIR || join(homedir(), ".hii");
const b64 = (value) => Buffer.from(value).toString("base64url");

async function keys() {
  const location = join(runtime(), "browser-sync", "device-keys.json");
  try {
    const stored = JSON.parse(await readFile(location, "utf8"));
    return {
      ecdhPrivate: await crypto.subtle.importKey("jwk", stored.ecdhPrivateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
      ecdhPublicJwk: stored.ecdhPublicJwk,
      signingPublicJwk: stored.signingPublicJwk,
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const stored = {
    ecdhPrivateJwk: await crypto.subtle.exportKey("jwk", ecdh.privateKey),
    ecdhPublicJwk: await crypto.subtle.exportKey("jwk", ecdh.publicKey),
    signingPublicJwk: await crypto.subtle.exportKey("jwk", signing.publicKey),
  };
  await mkdir(join(runtime(), "browser-sync"), { recursive: true, mode: 0o700 });
  await writeFile(location, JSON.stringify(stored), { flag: "wx", mode: 0o600 }).catch(async (error) => {
    if (error.code !== "EEXIST") throw error;
  });
  return keys();
}

async function request(api, token, path, body) {
  const response = await fetch(`${api}/browser-snapshots${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `browser_sync_http_${response.status}`);
  return value;
}

async function wrappingKey(privateKey, publicJwk, nonce, snapshotId, deviceId) {
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256", salt: nonce,
    info: encoder.encode(`hii-browser-snapshot-wrap-v1|${snapshotId}|${deviceId}`),
  }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
}

export async function syncIndexedCapture(payload) {
  if (payload.capture?.method !== "extension-page-index") return { skipped: true };
  const configPath = join(process.env.HII_ACCOUNT_DIR || join(runtime(), "account"), "device.json");
  let config;
  try { config = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return { skipped: true, reason: "account_not_linked" };
    throw error;
  }
  const api = new URL(config.api);
  if (!((api.protocol === "https:" && api.hostname === "humaninformationinterface.com") ||
        (api.protocol === "http:" && ["127.0.0.1", "localhost"].includes(api.hostname))) ||
      api.pathname !== "/api/device") throw new Error("browser_sync_api_not_trusted");
  const local = await keys();
  await request(api.href.replace(/\/$/, ""), config.token, "/keys", {
    ecdhPublicJwk: local.ecdhPublicJwk,
    signingPublicJwk: local.signingPublicJwk,
  });
  const { devices } = await request(api.href.replace(/\/$/, ""), config.token, "/devices");
  if (!devices.some((device) => device.id === config.deviceId)) throw new Error("browser_sync_device_missing");
  const snapshot = {
    url: payload.source.url,
    title: payload.source.title || payload.source.url,
    content: payload.content?.text || "",
    capturedAt: payload.capturedAt,
    browser: payload.capture.browserName || "Chromium",
  };
  const id = b64(randomBytes(32));
  const sourceId = b64(createHash("sha256").update(snapshot.url).digest());
  const base = { version: 1, id, sourceId, senderDeviceId: config.deviceId, createdAt: Date.now() };
  const contentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const rawKey = await crypto.subtle.exportKey("raw", contentKey);
  const nonce = randomBytes(12);
  const aad = encoder.encode(JSON.stringify([base.version, base.id, base.sourceId, base.senderDeviceId, base.createdAt]));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, contentKey, encoder.encode(JSON.stringify(snapshot)));
  const recipientWraps = [];
  for (const device of devices) {
    const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const wrapNonce = randomBytes(12);
    const key = await wrappingKey(ephemeral.privateKey, device.ecdhPublicJwk, wrapNonce, id, device.id);
    const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapNonce }, key, rawKey);
    recipientWraps.push({ deviceId: device.id, ephemeralPublicJwk: await crypto.subtle.exportKey("jwk", ephemeral.publicKey), nonce: b64(wrapNonce), ciphertext: b64(wrapped) });
  }
  await request(api.href.replace(/\/$/, ""), config.token, "", {
    ...base, algorithm: "P256-HKDF-SHA256-A256GCM", nonce: b64(nonce), ciphertext: b64(ciphertext), recipientWraps,
  });
  return { uploaded: true, id };
}
