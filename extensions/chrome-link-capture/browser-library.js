import { buildWebCapture } from "./capture-payload.js";

export const BROWSER_LIBRARY_BATCH_SIZE = 20;
export const MAX_HISTORY_RESULTS = 20_000;
export const MAX_PAGE_TEXT_CHARS = 80_000;
export const PAGE_ORIGINS = ["http://*/*", "https://*/*"];

const SENSITIVE_HOST = /(^|\.)(?:accounts?|auth|login|signin|sign-in|checkout|pay|payments?|wallet|banking)(?:\.|$)/i;
const SENSITIVE_PATH = /(?:^|\/)(?:account|auth|login|log-in|signin|sign-in|sso|oauth|session|password|reset-password|signup|sign-up|register|checkout|cart|order|purchase|billing|pay|payments?|wallet|banking)(?:\/|$)/i;
const SENSITIVE_QUERY_KEY = /^(?:access_token|auth|authorization|code|credential|jwt|oauth|pass(?:word)?|payment|refresh_token|session|token)$/i;

function cleanText(value, limit = 500) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, limit)
    : "";
}

export function inspectImportUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { allowed: false, reason: "invalid_url" };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { allowed: false, reason: "browser_internal_or_non_web" };
  }
  if (url.username || url.password) {
    return { allowed: false, reason: "embedded_credentials" };
  }
  if (SENSITIVE_HOST.test(url.hostname) || SENSITIVE_PATH.test(url.pathname)) {
    return { allowed: false, reason: "sign_in_or_payment" };
  }
  if ([...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key))) {
    return { allowed: false, reason: "credential_like_url_parameter" };
  }
  url.hash = "";
  return { allowed: true, url: url.href };
}

export function flattenBookmarks(nodes, parents = [], output = []) {
  for (const node of nodes || []) {
    const title = cleanText(node?.title, 300);
    if (node?.url) {
      output.push({
        id: String(node.id || ""),
        title,
        url: node.url,
        folderPath: parents.filter(Boolean).join(" / "),
        dateAdded: Number.isFinite(node.dateAdded) ? node.dateAdded : undefined,
        dateLastUsed: Number.isFinite(node.dateLastUsed) ? node.dateLastUsed : undefined
      });
    }
    if (Array.isArray(node?.children)) {
      flattenBookmarks(node.children, title ? [...parents, title] : parents, output);
    }
  }
  return output;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function deterministicCaptureId(category, value) {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `browser-library-${category}-${hex.slice(0, 40)}`;
}

function metadataLines(metadata) {
  return Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(" / ") : value}`);
}

export async function buildLibraryCapture({
  category,
  url,
  title,
  observedAt,
  itemTimestamp,
  metadata = {},
  text = ""
}) {
  const decision = inspectImportUrl(url);
  if (!decision.allowed) return { excluded: decision.reason };
  const parsedItemTime = Number.isFinite(itemTimestamp) ? new Date(itemTimestamp) : null;
  const capturedAt = parsedItemTime && Number.isFinite(parsedItemTime.getTime())
    ? parsedItemTime.toISOString()
    : observedAt;
  const normalizedTitle = cleanText(title, 500) || decision.url;
  const normalizedText = typeof text === "string" ? text.trim().slice(0, MAX_PAGE_TEXT_CHARS) : "";
  const body = [
    normalizedTitle,
    decision.url,
    ...metadataLines(metadata),
    normalizedText
  ].filter(Boolean).join("\n\n");
  const identity = {
    category,
    url: decision.url,
    title: normalizedTitle,
    capturedAt,
    metadata,
    text: normalizedText
  };
  return {
    payload: buildWebCapture({
      url: decision.url,
      title: normalizedTitle,
      method: "extension-page-index",
      contentText: body,
      browserName: "Chrome",
      tags: ["browser", "browser-library", category],
      capturedAt,
      captureId: await deterministicCaptureId(category, identity)
    })
  };
}

// This function is serialized by chrome.scripting. Keep it self-contained and
// avoid reading form controls or browser-managed values.
export function extractVisiblePageText(maxChars) {
  const sensitiveControl = document.querySelector([
    'input[type="password"]',
    '[autocomplete="current-password"]',
    '[autocomplete="new-password"]',
    '[autocomplete^="cc-"]',
    '[name*="card" i]',
    '[name*="payment" i]'
  ].join(","));
  if (sensitiveControl) return { ok: false, reason: "sensitive_form" };

  const blocked = "script,style,noscript,template,svg,canvas,form,input,textarea,select,option,button,[contenteditable],[aria-hidden='true']";
  const parts = [];
  let length = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && length < maxChars) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || parent.closest(blocked)) continue;
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
    const value = node.nodeValue?.replace(/\s+/g, " ").trim();
    if (!value) continue;
    const slice = value.slice(0, maxChars - length);
    parts.push(slice);
    length += slice.length + 1;
  }
  const text = parts.join("\n").trim();
  return text.length >= 40 ? { ok: true, text } : { ok: false, reason: "too_little_visible_text" };
}

export function chunks(values, size = BROWSER_LIBRARY_BATCH_SIZE) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
