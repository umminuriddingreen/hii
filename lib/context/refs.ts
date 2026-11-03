/**
 * Durable pointers to context, and what resolving one produces.
 *
 * The problem this replaces: context was copied into an intent as a payload. A
 * copy is stale the moment the source changes, it cannot be re-read, and nothing
 * downstream can tell whether the human reviewed the current thing or a snapshot
 * of something that has since moved. A ContextRef points; resolution reads the
 * authoritative source; only the *reviewed manifest* freezes content, and it
 * freezes it deliberately with a hash.
 *
 * Pure types and normalisation, kept storage-free so the Notch, the CLI-facing
 * APIs, the voice runtime and the workspace can all speak the same shapes.
 */

export type ContextRefKind =
  | 'workspace-object'
  | 'knowledge-note'
  | 'context-document'
  | 'context-chunk'
  | 'receipt-artifact'
  | 'capability'
  | 'skill';

export const contextRefKinds: readonly ContextRefKind[] = [
  'workspace-object',
  'knowledge-note',
  'context-document',
  'context-chunk',
  'receipt-artifact',
  'capability',
  'skill'
] as const;

/**
 * A pointer, not a payload.
 *
 * `scope` and `anchor` narrow *which part* of the source is meant; they are
 * addressing, not content. Nothing here carries the text itself — a ref that
 * embedded its own excerpt would be a copy wearing a pointer's name.
 */
export type ContextRef = {
  kind: ContextRefKind;
  /** Identifier within the source system. */
  id: string;
  /** Which workspace, project or run the id belongs to, when the id alone is ambiguous. */
  scope?: string;
  /** Line/page range or selector inside the source. */
  anchor?: { lineStart?: number; lineEnd?: number; pageStart?: number; pageEnd?: number; selector?: string };
  /** Source version the caller last saw, so drift is detectable. */
  seenRevision?: string;
  /** Content hash the caller last saw, for sources that expose one. */
  seenSha256?: string;
};

export type ContextRefStatus = 'resolved' | 'stale' | 'missing' | 'unreadable' | 'blocked';

/** Where resolved content is allowed to travel. */
export type TransmissionScope = 'local-only' | 'local-model' | 'external-model' | 'blocked';

/**
 * The current reading of a ref. Produced fresh on every resolve; never stored as
 * though it were the ref.
 */
export type ResolvedContextItem = {
  ref: ContextRef;
  status: ContextRefStatus;
  title: string;
  /** Source-system type, e.g. the workspace node type or document format. */
  type: string;
  /** Filesystem path or URL, when the source has one. */
  source?: string;
  excerpt?: string;
  sha256?: string;
  revision?: string;
  byteSize?: number;
  modifiedAt?: string;
  transmissionScope: TransmissionScope;
  /** Why the status is what it is, in words a human can act on. */
  notice?: string;
};

export type ReviewedContextEntry = {
  ref: ContextRef;
  title: string;
  type: string;
  source?: string;
  /** Frozen at review time. The manifest is the one place content is copied. */
  excerpt?: string;
  sha256?: string;
  revision?: string;
  transmissionScope: TransmissionScope;
};

/**
 * The immutable thing an approval actually approves.
 *
 * Hash-locked over its entries, so an approval cannot be carried onto different
 * context: if anything in it changes, the fingerprint changes and the approval
 * no longer matches.
 */
export type ReviewedContextManifest = {
  version: 1;
  id: string;
  createdAt: string;
  workspaceId?: string;
  workspaceRevision?: number;
  entries: ReviewedContextEntry[];
  unresolved: { ref: ContextRef; status: ContextRefStatus; notice?: string }[];
  transmissionScope: TransmissionScope;
  fingerprint: string;
};

const refKindSet = new Set<string>(contextRefKinds);

function clean(value: unknown, max: number) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function positiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeAnchor(value: unknown): ContextRef['anchor'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const anchor: NonNullable<ContextRef['anchor']> = {};
  const lineStart = positiveInt(raw.lineStart);
  const lineEnd = positiveInt(raw.lineEnd);
  const pageStart = positiveInt(raw.pageStart);
  const pageEnd = positiveInt(raw.pageEnd);
  const selector = clean(raw.selector, 240);
  if (lineStart !== undefined) anchor.lineStart = lineStart;
  if (lineEnd !== undefined) anchor.lineEnd = Math.max(lineEnd, lineStart ?? lineEnd);
  if (pageStart !== undefined) anchor.pageStart = pageStart;
  if (pageEnd !== undefined) anchor.pageEnd = Math.max(pageEnd, pageStart ?? pageEnd);
  if (selector) anchor.selector = selector;
  return Object.keys(anchor).length ? anchor : undefined;
}

export function normalizeContextRef(value: unknown): ContextRef | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const kind = clean(raw.kind, 40);
  if (!refKindSet.has(kind)) return null;
  const id = clean(raw.id, 300);
  if (!id) return null;
  const scope = clean(raw.scope, 200);
  const seenRevision = clean(raw.seenRevision, 120);
  const seenSha256 = clean(raw.seenSha256, 64).toLowerCase();
  const anchor = normalizeAnchor(raw.anchor);
  return {
    kind: kind as ContextRefKind,
    id,
    ...(scope ? { scope } : {}),
    ...(anchor ? { anchor } : {}),
    ...(seenRevision ? { seenRevision } : {}),
    ...(/^[a-f0-9]{64}$/.test(seenSha256) ? { seenSha256 } : {})
  };
}

export function normalizeContextRefs(value: unknown, limit = 64): ContextRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const refs: ContextRef[] = [];
  for (const entry of value) {
    const ref = normalizeContextRef(entry);
    if (!ref) continue;
    const key = contextRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
    if (refs.length >= limit) break;
  }
  return refs;
}

/** Stable identity of a ref, for dedupe and for comparing two selections. */
export function contextRefKey(ref: ContextRef) {
  const anchor = ref.anchor
    ? `#${ref.anchor.lineStart ?? ''}-${ref.anchor.lineEnd ?? ''}-${ref.anchor.pageStart ?? ''}-${ref.anchor.pageEnd ?? ''}-${ref.anchor.selector ?? ''}`
    : '';
  return `${ref.kind}:${ref.scope ?? ''}:${ref.id}${anchor}`;
}

/**
 * The widest scope in a set. External beats local because the widest exposure is
 * what the human needs to see before approving, and blocked beats everything
 * because a blocked entry means the set cannot go out at all.
 */
export function widestTransmissionScope(scopes: TransmissionScope[]): TransmissionScope {
  if (scopes.includes('blocked')) return 'blocked';
  if (scopes.includes('external-model')) return 'external-model';
  if (scopes.includes('local-model')) return 'local-model';
  return 'local-only';
}
