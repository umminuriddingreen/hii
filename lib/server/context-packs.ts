/**
 * Context Packs: a named, reusable set of ContextRefs.
 *
 * The smallest thing that earns its place. A pack holds *pointers* — it does not
 * copy Context Dock content, knowledge notes or workspace objects, because a
 * second copy of indexed content is a second thing to keep in sync and a second
 * place for it to go stale silently.
 *
 * Deliberately not implemented here: facts, decisions, entity extraction, or any
 * broader context ontology. Those are speculative until something needs them,
 * and a schema invented in advance is a schema the real use case will not fit.
 *
 * Append-only, like every other HII ledger. A revision supersedes; nothing is
 * rewritten, so a run that used revision 3 can still be understood after
 * revision 4 exists.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withFileLock } from './atomic-write.ts';
import { resolveContextRefs, reviewContextResolution } from './context-refs.ts';
import {
  contextRefKey,
  normalizeContextRefs,
  type ContextRef,
  type ReviewedContextManifest,
  type TransmissionScope
} from '../context/refs.ts';

export type ContextPackReviewState = 'draft' | 'reviewed' | 'approved' | 'stale';

export type ContextPack = {
  id: string;
  revision: number;
  title: string;
  purpose: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
  /** Ordered. Order is meaning: it is the sequence the human wants read. */
  refs: ContextRef[];
  /** What each ref looked like when the pack was last reviewed. */
  sourceVersions: { key: string; sha256: string | null; revision: string | null }[];
  transmissionScope: TransmissionScope;
  reviewState: ContextPackReviewState;
  /** Fingerprint of the manifest this pack was approved against. */
  approvedFingerprint: string | null;
  intentId: string | null;
  runId: string | null;
};

export type ContextPackEvent = {
  eventId: string;
  kind: 'pack.created' | 'pack.revised' | 'pack.reviewed' | 'pack.approved';
  at: string;
  pack: ContextPack;
};

export type ContextPackCorruption = { line: number; reason: string; raw: string };

export function contextPacksPath() {
  const runtime = process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
  return path.join(runtime, 'context', 'packs.jsonl');
}

function clean(value: unknown, max: number) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function readLines(file: string) {
  try {
    return (await readFile(file, 'utf8')).split('\n');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function readContextPacks(file = contextPacksPath()) {
  const lines = await readLines(file);
  const events: ContextPackEvent[] = [];
  const corruption: ContextPackCorruption[] = [];
  const current = new Map<string, ContextPack>();

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      corruption.push({ line: index + 1, reason: 'unparseable-json', raw: raw.slice(0, 2000) });
      return;
    }
    const event = parsed as Partial<ContextPackEvent>;
    if (!event?.pack?.id || !event.kind) {
      corruption.push({ line: index + 1, reason: 'unrecognized-record', raw: raw.slice(0, 2000) });
      return;
    }
    events.push(event as ContextPackEvent);
    const existing = current.get(event.pack.id);
    if (existing && existing.revision > event.pack.revision) return;
    current.set(event.pack.id, event.pack);
  });

  return { packs: [...current.values()], events, corruption };
}

async function appendEvent(file: string, event: ContextPackEvent) {
  await mkdir(path.dirname(file), { recursive: true });
  await withFileLock(file, async () => {
    await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
  });
  return event.pack;
}

function sourceVersionsFrom(manifest: ReviewedContextManifest) {
  return manifest.entries.map((entry) => ({
    key: contextRefKey(entry.ref),
    sha256: entry.sha256 ?? null,
    revision: entry.revision ?? null
  }));
}

/**
 * Create a pack from a set of references, typically the current selection.
 *
 * The refs are resolved once so the pack records what it was built from, but the
 * content is not stored — only the versions, so drift is detectable later.
 */
export async function createContextPack(
  input: {
    title?: unknown;
    purpose?: unknown;
    owner?: unknown;
    refs?: unknown;
    intentId?: unknown;
    runId?: unknown;
  },
  file = contextPacksPath()
): Promise<{ pack: ContextPack; manifest: ReviewedContextManifest }> {
  const title = clean(input.title, 200);
  if (!title) throw new Error('A context pack needs a title.');
  const owner = clean(input.owner, 200);
  if (!owner) throw new Error('A context pack needs an owner.');
  const refs = normalizeContextRefs(input.refs);
  if (!refs.length) throw new Error('A context pack needs at least one reference.');

  const resolution = await resolveContextRefs(refs);
  const manifest = reviewContextResolution(resolution);
  const now = new Date().toISOString();
  const pack: ContextPack = {
    id: randomUUID(),
    revision: 1,
    title,
    purpose: clean(input.purpose, 2000),
    owner,
    createdAt: now,
    updatedAt: now,
    refs,
    sourceVersions: sourceVersionsFrom(manifest),
    transmissionScope: manifest.transmissionScope,
    // A newly built pack is a draft. Being assembled is not the same as having
    // been looked at.
    reviewState: 'draft',
    approvedFingerprint: null,
    intentId: clean(input.intentId, 200) || null,
    runId: clean(input.runId, 200) || null
  };
  await appendEvent(file, { eventId: `${pack.id}:1`, kind: 'pack.created', at: now, pack });
  return { pack, manifest };
}

export async function getContextPack(id: string, file = contextPacksPath()) {
  const { packs } = await readContextPacks(file);
  return packs.find((pack) => pack.id === id) ?? null;
}

export type ContextPackInspection = {
  pack: ContextPack;
  manifest: ReviewedContextManifest;
  /** Refs whose source moved since the pack was last reviewed. */
  stale: { key: string; was: string | null; now: string | null }[];
  reviewState: ContextPackReviewState;
  notice: string;
};

/**
 * Resolve a pack against live sources and report what moved.
 *
 * Comparing recorded versions to current ones is the whole point of storing
 * pointers: a copied pack could never tell you it had gone out of date.
 */
export async function inspectContextPack(
  id: string,
  file = contextPacksPath()
): Promise<ContextPackInspection> {
  const pack = await getContextPack(id, file);
  if (!pack) throw new Error('That context pack does not exist.');
  const resolution = await resolveContextRefs(pack.refs);
  const manifest = reviewContextResolution(resolution);
  const currentByKey = new Map(sourceVersionsFrom(manifest).map((entry) => [entry.key, entry]));

  const stale: ContextPackInspection['stale'] = [];
  for (const recorded of pack.sourceVersions) {
    const now = currentByKey.get(recorded.key);
    if (!now) {
      stale.push({ key: recorded.key, was: recorded.sha256 ?? recorded.revision, now: null });
      continue;
    }
    // Content hash wins when both sides have one. A workspace revision is
    // document-wide, so comparing revisions would mark every reference in the
    // pack stale the moment any unrelated node was saved — noise that would
    // train the human to click through the warning.
    const changed = recorded.sha256 && now.sha256
      ? recorded.sha256 !== now.sha256
      : Boolean(recorded.revision && now.revision && recorded.revision !== now.revision);
    if (changed) {
      stale.push({
        key: recorded.key,
        was: recorded.sha256 ?? recorded.revision,
        now: now.sha256 ?? now.revision
      });
    }
  }

  const unresolved = resolution.unresolved.length;
  const reviewState: ContextPackReviewState =
    stale.length || unresolved ? 'stale' : pack.reviewState;
  return {
    pack,
    manifest,
    stale,
    reviewState,
    notice: stale.length
      ? `${stale.length} reference${stale.length === 1 ? '' : 's'} changed since this pack was reviewed.`
      : unresolved
        ? `${unresolved} reference${unresolved === 1 ? '' : 's'} could not be resolved.`
        : 'Every reference is current.'
  };
}

/** Mark a pack reviewed at its current source versions. */
export async function reviewContextPack(id: string, reviewer: string, file = contextPacksPath()) {
  const inspection = await inspectContextPack(id, file);
  const now = new Date().toISOString();
  const pack: ContextPack = {
    ...inspection.pack,
    revision: inspection.pack.revision + 1,
    updatedAt: now,
    owner: clean(reviewer, 200) || inspection.pack.owner,
    sourceVersions: sourceVersionsFrom(inspection.manifest),
    transmissionScope: inspection.manifest.transmissionScope,
    reviewState: 'reviewed',
    // A review resets any prior approval: what was approved is no longer what
    // this pack is.
    approvedFingerprint: null
  };
  await appendEvent(file, { eventId: `${pack.id}:${pack.revision}`, kind: 'pack.reviewed', at: now, pack });
  return { pack, manifest: inspection.manifest };
}

/**
 * Approve a pack for use in a run.
 *
 * The approval must quote the fingerprint it saw. A pack whose sources moved
 * between review and approval fails here rather than executing against content
 * nobody looked at.
 */
export async function approveContextPack(
  id: string,
  input: { approvedBy?: unknown; fingerprint?: unknown },
  file = contextPacksPath()
) {
  const inspection = await inspectContextPack(id, file);
  const approvedBy = clean(input.approvedBy, 200);
  if (!approvedBy) throw new Error('An approval needs the human who gave it.');
  if (clean(input.fingerprint, 80) !== inspection.manifest.fingerprint) {
    throw new Error('This pack changed since it was reviewed. Review it again before approving.');
  }
  if (inspection.stale.length) {
    throw new Error(`This pack has ${inspection.stale.length} stale reference(s). Review it again before approving.`);
  }
  const now = new Date().toISOString();
  const pack: ContextPack = {
    ...inspection.pack,
    revision: inspection.pack.revision + 1,
    updatedAt: now,
    owner: inspection.pack.owner,
    reviewState: 'approved',
    approvedFingerprint: inspection.manifest.fingerprint
  };
  await appendEvent(file, { eventId: `${pack.id}:${pack.revision}`, kind: 'pack.approved', at: now, pack });
  return { pack, manifest: inspection.manifest, approvedBy };
}

/** Add or reorder references. A revision, never an in-place edit. */
export async function reviseContextPack(
  id: string,
  input: { refs?: unknown; title?: unknown; purpose?: unknown; owner?: unknown },
  file = contextPacksPath()
) {
  const previous = await getContextPack(id, file);
  if (!previous) throw new Error('That context pack does not exist.');
  const refs = input.refs === undefined ? previous.refs : normalizeContextRefs(input.refs);
  if (!refs.length) throw new Error('A context pack needs at least one reference.');
  const resolution = await resolveContextRefs(refs);
  const manifest = reviewContextResolution(resolution);
  const now = new Date().toISOString();
  const pack: ContextPack = {
    ...previous,
    revision: previous.revision + 1,
    updatedAt: now,
    title: input.title === undefined ? previous.title : clean(input.title, 200) || previous.title,
    purpose: input.purpose === undefined ? previous.purpose : clean(input.purpose, 2000),
    owner: input.owner === undefined ? previous.owner : clean(input.owner, 200) || previous.owner,
    refs,
    sourceVersions: sourceVersionsFrom(manifest),
    transmissionScope: manifest.transmissionScope,
    reviewState: 'draft',
    approvedFingerprint: null
  };
  await appendEvent(file, { eventId: `${pack.id}:${pack.revision}`, kind: 'pack.revised', at: now, pack });
  return { pack, manifest };
}

/** What changed between two revisions of a pack. */
export async function compareContextPackRevisions(
  id: string,
  from: number,
  to: number,
  file = contextPacksPath()
) {
  const { events } = await readContextPacks(file);
  const before = events.find((event) => event.pack.id === id && event.pack.revision === from)?.pack;
  const after = events.find((event) => event.pack.id === id && event.pack.revision === to)?.pack;
  if (!before || !after) throw new Error('Those revisions are not both in the ledger.');
  const beforeKeys = before.refs.map(contextRefKey);
  const afterKeys = after.refs.map(contextRefKey);
  return {
    added: afterKeys.filter((key) => !beforeKeys.includes(key)),
    removed: beforeKeys.filter((key) => !afterKeys.includes(key)),
    reordered:
      beforeKeys.length === afterKeys.length &&
      beforeKeys.join('|') !== afterKeys.join('|') &&
      beforeKeys.every((key) => afterKeys.includes(key)),
    reviewStateChanged: before.reviewState !== after.reviewState
  };
}
