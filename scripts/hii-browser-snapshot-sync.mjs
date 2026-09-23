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

async function deviceRequest(api, token, path, options = {}) {
  const response = await fetch(`${api}${path}`, {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 409) {
    throw new Error(value.error || `account_workspace_http_${response.status}`);
  }
  return { status: response.status, value };
}

async function accountConfig() {
  const configPath = join(process.env.HII_ACCOUNT_DIR || join(runtime(), "account"), "device.json");
  let config;
  try { config = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const api = new URL(config.api);
  if (!((api.protocol === "https:" && api.hostname === "humaninformationinterface.com") ||
        (api.protocol === "http:" && ["127.0.0.1", "localhost"].includes(api.hostname))) ||
      api.pathname !== "/api/device") throw new Error("browser_sync_api_not_trusted");
  return { ...config, api: api.href.replace(/\/$/, "") };
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

const EXPLICIT_CAPTURE_METHODS = new Set([
  "extension-action",
  "context-selection",
  "context-page",
  "context-image",
  "context-link",
]);

export async function syncBrowserCapture(payload) {
  if (!EXPLICIT_CAPTURE_METHODS.has(payload.capture?.method)) {
    return { skipped: true, reason: "capture_not_explicit" };
  }
  const config = await accountConfig();
  if (!config) return { skipped: true, reason: "account_not_linked" };
  const local = await keys();
  await request(config.api, config.token, "/keys", {
    ecdhPublicJwk: local.ecdhPublicJwk,
    signingPublicJwk: local.signingPublicJwk,
  });
  const { devices } = await request(config.api, config.token, "/devices");
  if (!devices.some((device) => device.id === config.deviceId)) throw new Error("browser_sync_device_missing");
  const snapshot = {
    url: payload.source.url,
    title: payload.source.title || payload.source.url,
    content: payload.content?.text || payload.capture?.selectedText || payload.capture?.note || "",
    capturedAt: payload.capturedAt,
    occurredAt: payload.capture?.occurredAt || payload.capturedAt,
    sourceKind: payload.capture?.sourceKind || "explicit-capture",
    domain: payload.capture?.domain || "",
    metrics: payload.capture?.metrics || {},
    search: payload.capture?.search || null,
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
  await request(config.api, config.token, "", {
    ...base, algorithm: "P256-HKDF-SHA256-A256GCM", nonce: b64(nonce), ciphertext: b64(ciphertext), recipientWraps,
  });
  return { uploaded: true, id };
}

// Compatibility for older callers while the manual companion replaces
// background page indexing.
export const syncIndexedCapture = syncBrowserCapture;

function accountNode(payload, result, document) {
  const createdAt = payload.capturedAt || new Date().toISOString();
  const digest = createHash("sha256").update(payload.captureId).digest("base64url").slice(0, 24);
  const excerpt = (payload.capture?.selectedText || payload.capture?.note || payload.content?.text || "").slice(0, 2_000);
  const sourceUrl = result?.source?.url || payload.source.url;
  const title = String(result?.source?.title || payload.source.title || sourceUrl).slice(0, 500);
  const z = Number.isSafeInteger(document.nextZ) ? document.nextZ : document.nodes.length + 1;
  return {
    id: `browser-capture-${digest}`,
    type: "link",
    x: 48 + (document.nodes.length % 8) * 28,
    y: 48 + (document.nodes.length % 8) * 28,
    w: 420,
    h: 240,
    z,
    createdAt,
    updatedAt: createdAt,
    permissions: { inheritance: "space-policy" },
    object: {
      kind: "source",
      owner: "hii",
      status: "ready",
      source: sourceUrl,
      capabilityId: "hii.browser.link_capture",
      proofRefs: result?.receiptId ? [result.receiptId] : [],
      audit: [{ ts: createdAt, actor: "hii", action: "shared explicit browser capture to account workspace" }],
    },
    payload: {
      title,
      url: sourceUrl,
      excerpt,
      note: payload.capture?.note || "",
      selectedText: payload.capture?.selectedText || "",
      tags: Array.isArray(payload.capture?.tags) ? payload.capture.tags.slice(0, 20) : [],
      captureId: payload.captureId,
      capturedAt: createdAt,
      occurredAt: payload.capture?.occurredAt || createdAt,
      sourceKind: payload.capture?.sourceKind || "explicit-capture",
      domain: String(payload.capture?.domain || "").slice(0, 253),
      metrics: payload.capture?.metrics || {},
      searchProvider: String(payload.capture?.search?.provider || "").slice(0, 80),
      searchQuery: String(payload.capture?.search?.query || "").slice(0, 500),
      receiptId: result?.receiptId || "",
    },
  };
}

export async function shareCaptureToAccountWorkspace(payload, result = {}) {
  const config = await accountConfig();
  if (!config) return { shared: false, reason: "account_not_linked" };
  const listed = await deviceRequest(config.api, config.token, "/workspaces");
  const writable = (listed.value.workspaces || []).filter((workspace) => ["owner", "admin", "editor"].includes(workspace.role));
  for (const summary of writable) {
    let current = await deviceRequest(config.api, config.token, `/workspaces/${encodeURIComponent(summary.id)}`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const workspace = current.value.workspace;
      const document = workspace?.document;
      if (!document || !Array.isArray(document.nodes) || document.nodes.length >= 500 || !Array.isArray(document.links)) break;
      const node = accountNode(payload, result, document);
      if (document.nodes.some((entry) => entry.id === node.id)) {
        return { shared: true, workspaceId: workspace.id, nodeId: node.id, duplicate: true };
      }
      const next = {
        ...document,
        updatedAt: new Date().toISOString(),
        nextZ: Math.max(Number(document.nextZ) || 1, node.z + 1),
        nodes: [...document.nodes, node],
      };
      const written = await deviceRequest(config.api, config.token, `/workspaces/${encodeURIComponent(workspace.id)}/document`, {
        method: "POST",
        body: { expectedRevision: workspace.revision, document: next },
      });
      if (written.status === 200) return { shared: true, workspaceId: workspace.id, nodeId: node.id };
      current = written;
    }
  }
  return { shared: false, reason: writable.length ? "account_workspaces_full_or_conflicted" : "no_writable_account_workspace" };
}
