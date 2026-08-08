/**
 * Resolving durable context references against their authoritative sources.
 *
 * One resolver, shared by voice and typed input. Two would let an approved
 * manifest disagree with what the human reviewed depending on which surface
 * started the run — the same reason `workspaceNodeContextItems` is shared.
 *
 * Nothing supplied by a browser is trusted as content. A caller sends
 * identifiers; this reads the current source and reports drift rather than
 * accepting the caller's copy.
 */

import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  contextRefKey,
  normalizeContextRefs,
  widestTransmissionScope,
  type ContextRef,
  type ContextRefStatus,
  type ResolvedContextItem,
  type ReviewedContextEntry,
  type ReviewedContextManifest,
  type TransmissionScope
} from '../context/refs.ts';
import { workspaceNodeContextItem } from '../workspace/context-item.ts';
import { sensitiveWorkspaceContextSource } from '../workspace/run-boundary.ts';
import { readWorkspace } from './workspace-store.ts';
import type { WorkspaceRunContextItem } from './hii-workspace-run-context.ts';

function clean(value: unknown, max: number) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Where a resolved item may travel.
 *
 * Secret-like sources are blocked outright rather than downgraded, because the
 * question "may this leave the machine" has no safe default for a credential
 * file. Everything else is local until a caller widens it explicitly.
 */
function scopeFor(source: string | undefined): TransmissionScope {
  if (source && sensitiveWorkspaceContextSource(source)) return 'blocked';
  return 'local-only';
}

function missing(ref: ContextRef, notice: string): ResolvedContextItem {
  return {
    ref,
    status: 'missing',
    title: ref.id,
    type: ref.kind,
    transmissionScope: 'blocked',
    notice
  };
}

function unreadable(ref: ContextRef, notice: string): ResolvedContextItem {
  return { ref, status: 'unreadable', title: ref.id, type: ref.kind, transmissionScope: 'blocked', notice };
}

/**
 * Whether the caller is looking at what is there now.
 *
 * A ref that recorded what it last saw and no longer matches is `stale`, not
 * `resolved`: the human reviewed something else, so the approval should not
 * carry over silently.
 */
function driftStatus(ref: ContextRef, current: { sha256?: string; revision?: string }): ContextRefStatus {
  if (ref.seenSha256 && current.sha256 && ref.seenSha256 !== current.sha256) return 'stale';
  if (ref.seenRevision && current.revision && ref.seenRevision !== current.revision) return 'stale';
  return 'resolved';
}

async function resolveWorkspaceObject(ref: ContextRef): Promise<ResolvedContextItem> {
  let doc;
  try {
    doc = await readWorkspace(ref.scope);
  } catch (error) {
    return unreadable(ref, `Workspace unavailable: ${clean((error as Error).message, 200)}.`);
  }
  const node = doc.nodes.find((candidate) => candidate.id === ref.id);
  if (!node) return missing(ref, 'This object is no longer in the workspace.');
  const item = workspaceNodeContextItem(node);
  const source = item.source || undefined;
  const revision = String(doc.revision);
  const content = item.excerpt || '';
  const current = { sha256: content ? sha256(content) : undefined, revision };
  const blocked = scopeFor(source) === 'blocked';
  return {
    ref,
    status: blocked ? 'blocked' : driftStatus(ref, current),
    title: item.title,
    type: item.type,
    ...(source ? { source } : {}),
    ...(content ? { excerpt: content } : {}),
    ...(current.sha256 ? { sha256: current.sha256 } : {}),
    revision,
    modifiedAt: node.updatedAt,
    transmissionScope: blocked ? 'blocked' : 'local-only',
    ...(blocked ? { notice: 'Secret-like sources cannot be attached to a run.' } : {})
  };
}

async function resolveKnowledgeNote(ref: ContextRef): Promise<ResolvedContextItem> {
  const { getKnowledgeNote } = await import('./hii-knowledge.ts');
  let detail;
  try {
    detail = getKnowledgeNote(ref.id);
  } catch (error) {
    return unreadable(ref, `Knowledge note unreadable: ${clean((error as Error).message, 200)}.`);
  }
  const note = detail?.note;
  if (!note || note.deletedAt) return missing(ref, 'This note has been deleted or does not exist.');
  const excerpt = clean(note.content, 2400);
  const current = { sha256: sha256(note.content ?? ''), revision: note.revision };
  return {
    ref,
    status: driftStatus(ref, current),
    title: note.title,
    type: 'knowledge-note',
    source: note.path,
    ...(excerpt ? { excerpt } : {}),
    sha256: current.sha256,
    revision: note.revision,
    modifiedAt: note.updatedAt,
    transmissionScope: 'local-only'
  };
}

async function resolveContextChunk(ref: ContextRef): Promise<ResolvedContextItem> {
  const { searchContext } = await import('./hii-context-dock.ts');
  const projectId = ref.scope;
  if (!projectId) return unreadable(ref, 'A context chunk needs the project it belongs to.');
  let hits;
  try {
    // The Dock's index is the authority for chunk content; the id is looked up
    // there rather than trusting whatever the caller cached.
    hits = searchContext(projectId, ref.id, 200);
  } catch (error) {
    return unreadable(ref, `Context Dock unreadable: ${clean((error as Error).message, 200)}.`);
  }
  const hit = hits.find((candidate) => candidate.chunkId === ref.id || candidate.documentId === ref.id);
  if (!hit) return missing(ref, 'This context chunk is no longer in the indexed project.');
  const current = { sha256: hit.contentHash, revision: hit.freshnessAt };
  return {
    ref,
    status: driftStatus(ref, current),
    title: path.basename(hit.sourcePath) || hit.sourcePath,
    type: hit.kind,
    source: hit.sourcePath,
    excerpt: clean(hit.excerpt, 2400),
    sha256: hit.contentHash,
    revision: hit.freshnessAt,
    modifiedAt: hit.freshnessAt,
    transmissionScope: scopeFor(hit.sourcePath) === 'blocked' ? 'blocked' : 'local-only'
  };
}

async function resolveReceiptArtifact(ref: ContextRef): Promise<ResolvedContextItem> {
  // The id is an absolute path recorded in a receipt's artifact inventory. It is
  // checked against the filesystem, not assumed to still be there.
  if (!path.isAbsolute(ref.id)) return unreadable(ref, 'A receipt artifact reference must be an absolute path.');
  if (sensitiveWorkspaceContextSource(ref.id)) {
    return { ref, status: 'blocked', title: path.basename(ref.id), type: 'artifact', source: ref.id, transmissionScope: 'blocked', notice: 'Secret-like files cannot be attached to a run.' };
  }
  let info;
  try {
    info = await stat(ref.id);
  } catch {
    return missing(ref, 'This artifact no longer exists on disk.');
  }
  if (!info.isFile()) return unreadable(ref, 'This artifact path is not a regular file.');
  return {
    ref,
    status: 'resolved',
    title: path.basename(ref.id),
    type: path.extname(ref.id).replace('.', '') || 'file',
    source: ref.id,
    byteSize: info.size,
    modifiedAt: info.mtime.toISOString(),
    transmissionScope: 'local-only'
  };
}

async function resolveSkill(ref: ContextRef): Promise<ResolvedContextItem> {
  const { getHiiSkillDetail } = await import('./hii-skills.ts');
  try {
    const detail = await getHiiSkillDetail(ref.id);
    if (!detail) return missing(ref, 'This skill is not registered.');
    return {
      ref,
      status: 'resolved',
      title: clean((detail as Record<string, unknown>).name ?? ref.id, 240) || ref.id,
      type: 'skill',
      excerpt: clean((detail as Record<string, unknown>).description, 2400),
      transmissionScope: 'local-only'
    };
  } catch (error) {
    return unreadable(ref, `Skill unreadable: ${clean((error as Error).message, 200)}.`);
  }
}

async function resolveCapability(ref: ContextRef): Promise<ResolvedContextItem> {
  const { listCapabilityJobs } = await import('../capabilities/local-store.ts');
  try {
    const job = (await listCapabilityJobs({ limit: 500 })).find((candidate) => candidate.id === ref.id);
    if (!job) return missing(ref, 'This capability run is not in the local store.');
    return {
      ref,
      status: 'resolved',
      title: clean(job.inputSummary, 240) || ref.id,
      type: 'capability',
      excerpt: clean(job.logs.join(' '), 2400),
      revision: job.status,
      transmissionScope: 'local-only'
    };
  } catch (error) {
    return unreadable(ref, `Capability store unreadable: ${clean((error as Error).message, 200)}.`);
  }
}

/** Resolve one reference against its authoritative source. */
export async function resolveContextRef(ref: ContextRef): Promise<ResolvedContextItem> {
  switch (ref.kind) {
    case 'workspace-object':
      return resolveWorkspaceObject(ref);
    case 'knowledge-note':
      return resolveKnowledgeNote(ref);
    case 'context-document':
    case 'context-chunk':
      return resolveContextChunk(ref);
    case 'receipt-artifact':
      return resolveReceiptArtifact(ref);
    case 'skill':
      return resolveSkill(ref);
    case 'capability':
      return resolveCapability(ref);
  }
}

export type ContextResolution = {
  items: ResolvedContextItem[];
  /** Refs that did not resolve cleanly, so a caller can show them rather than drop them. */
  unresolved: ResolvedContextItem[];
  transmissionScope: TransmissionScope;
  notice: string;
};

/**
 * Resolve a set of references.
 *
 * Failures are reported, never dropped: a run whose context silently shrank is
 * exactly the failure the manifest exists to prevent.
 */
export async function resolveContextRefs(value: unknown): Promise<ContextResolution> {
  const refs = normalizeContextRefs(value);
  const items = await Promise.all(refs.map((ref) => resolveContextRef(ref)));
  const unresolved = items.filter((item) => item.status !== 'resolved');
  const scope = widestTransmissionScope(items.map((item) => item.transmissionScope));
  const stale = unresolved.filter((item) => item.status === 'stale').length;
  const notice = !refs.length
    ? 'No context was referenced.'
    : unresolved.length
      ? `${items.length - unresolved.length} of ${items.length} references resolved; ${unresolved.length} need attention${stale ? ` (${stale} changed since they were selected)` : ''}.`
      : `${items.length} reference${items.length === 1 ? '' : 's'} resolved.`;
  return { items, unresolved, transmissionScope: scope, notice };
}

/**
 * Freeze a resolution into the immutable thing an approval approves.
 *
 * This is the one place content is deliberately copied. The fingerprint covers
 * every entry and the unresolved list, so an approval cannot be carried onto a
 * different set of context: change anything and the fingerprint changes.
 *
 * Only cleanly resolved entries become executable input. Stale and missing refs
 * are recorded so the human sees what was left out and can renew the review.
 */
export function reviewContextResolution(
  resolution: ContextResolution,
  meta: { workspaceId?: string; workspaceRevision?: number; id?: string; createdAt?: string } = {}
): ReviewedContextManifest {
  const entries: ReviewedContextEntry[] = resolution.items
    .filter((item) => item.status === 'resolved')
    .map((item) => ({
      ref: item.ref,
      title: item.title,
      type: item.type,
      ...(item.source ? { source: item.source } : {}),
      ...(item.excerpt ? { excerpt: item.excerpt } : {}),
      ...(item.sha256 ? { sha256: item.sha256 } : {}),
      ...(item.revision ? { revision: item.revision } : {}),
      transmissionScope: item.transmissionScope
    }));
  const unresolved = resolution.unresolved.map((item) => ({
    ref: item.ref,
    status: item.status,
    ...(item.notice ? { notice: item.notice } : {})
  }));
  const transmissionScope = widestTransmissionScope(entries.map((entry) => entry.transmissionScope));
  const fingerprint = sha256(
    JSON.stringify({
      workspaceId: meta.workspaceId ?? '',
      workspaceRevision: meta.workspaceRevision ?? 0,
      transmissionScope,
      entries: entries.map((entry) => ({
        key: contextRefKey(entry.ref),
        sha256: entry.sha256 ?? '',
        revision: entry.revision ?? '',
        excerpt: entry.excerpt ?? '',
        scope: entry.transmissionScope
      })),
      unresolved: unresolved.map((entry) => `${contextRefKey(entry.ref)}:${entry.status}`)
    })
  );
  return {
    version: 1,
    id: meta.id ?? randomUUID(),
    createdAt: meta.createdAt ?? new Date().toISOString(),
    ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
    ...(meta.workspaceRevision !== undefined ? { workspaceRevision: meta.workspaceRevision } : {}),
    entries,
    unresolved,
    transmissionScope,
    fingerprint
  };
}

/**
 * An approval is only valid for the manifest it was given.
 *
 * Comparing fingerprints is what stops an approval from being carried onto
 * changed context — the case where the human said yes to one thing and the run
 * executed against another.
 */
export function approvalMatchesManifest(manifest: ReviewedContextManifest, approvedFingerprint: unknown) {
  return typeof approvedFingerprint === 'string' && approvedFingerprint === manifest.fingerprint;
}

/**
 * Backward compatibility: an intent that carried copied context items.
 *
 * Old intents and runs stay readable. Their items become refs where they carry
 * a usable identifier, so a re-review resolves against the live source instead
 * of the copy.
 */
export function contextRefsFromLegacyItems(
  items: WorkspaceRunContextItem[],
  workspaceId?: string
): ContextRef[] {
  return normalizeContextRefs(
    items.map((item) => ({
      kind: 'workspace-object',
      id: item.id,
      ...(workspaceId ? { scope: workspaceId } : {}),
      ...(item.expectedSha256 ? { seenSha256: item.expectedSha256 } : {})
    }))
  );
}

/** Refs for a workspace selection, the shape both voice and typed input send. */
export function workspaceSelectionRefs(workspaceId: string, nodeIds: string[]): ContextRef[] {
  return normalizeContextRefs(
    nodeIds.map((id) => ({ kind: 'workspace-object', id, scope: workspaceId }))
  );
}
