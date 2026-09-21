export const HII_WEB_CAPTURE_SCHEMA_VERSION = 1 as const;
export const HII_WEB_CAPTURE_KIND = 'hii.web.capture' as const;

export const HII_WEB_CAPTURE_METHODS = [
  'extension-action',
  'extension-page-index',
  'context-selection',
  'context-page',
  'context-image',
  'context-link'
] as const;

export type HiiWebCaptureMethod = (typeof HII_WEB_CAPTURE_METHODS)[number];

export interface HiiWebReferenceCapture {
  schemaVersion: typeof HII_WEB_CAPTURE_SCHEMA_VERSION;
  kind: typeof HII_WEB_CAPTURE_KIND;
  capturedAt: string;
  captureId: string;
  source: {
    url: string;
    canonicalUrl?: string;
    title?: string;
    siteName?: string;
    faviconUrl?: string;
    mediaType?: string;
  };
  capture: {
    method: HiiWebCaptureMethod;
    browserName?: string;
    browserTabId?: number;
    selectedText?: string;
    note?: string;
    tags: string[];
    projectId?: string;
    workspaceId?: string;
  };
  content?: {
    text?: string;
    html?: string;
    screenshotAssetId?: string;
    contentHash?: string;
  };
  authority: {
    client: 'chrome-extension';
    localOnly: true;
  };
}

export interface WebCaptureNormalizationOptions {
  now?: () => Date;
  createId?: () => string;
}

export class WebCaptureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebCaptureValidationError';
  }
}

type UnknownRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new WebCaptureValidationError(message);
}

function record(value: unknown, field: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${field} must be an object.`);
  }
  return value as UnknownRecord;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalid(`${field} must be a string.`);
  const normalized = value.trim();
  return normalized || undefined;
}

function sourceUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${field} is required.`);
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    invalid(`${field} must be a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    invalid(`${field} must use http or https.`);
  }
  return parsed.href;
}

function timestamp(value: unknown, now: () => Date): string {
  const date = value === undefined ? now() : typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) invalid('capturedAt must be a valid timestamp.');
  return date.toISOString();
}

function normalizeTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid('capture.tags must be an array of strings.');
  const tags = value.map((tag) => {
    if (typeof tag !== 'string') invalid('capture.tags must contain only strings.');
    return tag.trim().toLowerCase();
  });
  return [...new Set(tags.filter(Boolean))].sort();
}

function normalizeOptionalFields(raw: UnknownRecord, fields: readonly string[], prefix: string): UnknownRecord {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = optionalString(raw[field], `${prefix}.${field}`);
      return value === undefined ? [] : [[field, value]];
    })
  );
}

export function normalizeWebCapture(
  value: unknown,
  options: WebCaptureNormalizationOptions = {}
): HiiWebReferenceCapture {
  const raw = record(value, 'capture payload');
  if (raw.kind !== HII_WEB_CAPTURE_KIND) invalid(`kind must be ${HII_WEB_CAPTURE_KIND}.`);
  if (raw.schemaVersion !== HII_WEB_CAPTURE_SCHEMA_VERSION) invalid('schemaVersion must be 1.');

  const source = record(raw.source, 'source');
  const capture = record(raw.capture, 'capture');
  const authority = record(raw.authority, 'authority');
  if (!HII_WEB_CAPTURE_METHODS.includes(capture.method as HiiWebCaptureMethod)) {
    invalid('capture.method must identify an explicit browser capture action.');
  }
  if (authority.client !== 'chrome-extension' || authority.localOnly !== true) {
    invalid('authority must be local-only and owned by the chrome-extension input surface.');
  }

  const captureId = raw.captureId === undefined
    ? (options.createId ?? (() => globalThis.crypto.randomUUID()))()
    : optionalString(raw.captureId, 'captureId');
  if (!captureId) invalid('captureId must not be empty.');

  const selectedText = optionalString(capture.selectedText, 'capture.selectedText');
  const note = optionalString(capture.note, 'capture.note');
  const browserName = optionalString(capture.browserName, 'capture.browserName');
  const browserTabId = capture.browserTabId;
  if (browserTabId !== undefined && (typeof browserTabId !== 'number' || !Number.isSafeInteger(browserTabId) || browserTabId < 0)) {
    invalid('capture.browserTabId must be a non-negative integer.');
  }
  const content = raw.content === undefined ? undefined : record(raw.content, 'content');

  return {
    schemaVersion: HII_WEB_CAPTURE_SCHEMA_VERSION,
    kind: HII_WEB_CAPTURE_KIND,
    capturedAt: timestamp(raw.capturedAt, options.now ?? (() => new Date())),
    captureId,
    source: {
      url: sourceUrl(source.url, 'source.url'),
      ...(source.canonicalUrl === undefined ? {} : { canonicalUrl: sourceUrl(source.canonicalUrl, 'source.canonicalUrl') }),
      ...normalizeOptionalFields(source, ['title', 'siteName', 'faviconUrl', 'mediaType'], 'source')
    },
    capture: {
      method: capture.method as HiiWebCaptureMethod,
      ...(browserName === undefined ? {} : { browserName }),
      ...(browserTabId === undefined ? {} : { browserTabId }),
      ...(selectedText === undefined ? {} : { selectedText }),
      ...(note === undefined ? {} : { note }),
      tags: normalizeTags(capture.tags),
      ...normalizeOptionalFields(capture, ['projectId', 'workspaceId'], 'capture')
    },
    ...(content === undefined ? {} : {
      content: normalizeOptionalFields(content, ['text', 'html', 'screenshotAssetId', 'contentHash'], 'content')
    }),
    authority: { client: 'chrome-extension', localOnly: true }
  };
}
