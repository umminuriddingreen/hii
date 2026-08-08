/**
 * Durable, human-approved object grants — and the territories that draw them.
 *
 * Slice 5 enforced object scope but the scope arrived with the request, which
 * means the caller described its own authority. This makes the grant a record: a
 * human approves it once, it is appended to a ledger, and enforcement reads it.
 *
 * Enforcement comes first and the picture second, deliberately. A territory is a
 * *rendering* of a grant, so moving or resizing the rectangle changes where the
 * grant is drawn and nothing about what it permits. The alternative — inferring
 * authority from geometry — would mean an agent could widen its own permissions
 * by dragging a box, or a human could widen them by accident while tidying.
 *
 * Append-only, like every other HII ledger. A grant is never rewritten; it is
 * superseded or revoked by a later record, so what was approved when a run
 * executed stays readable afterwards.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withFileLock } from './atomic-write.ts';
import { objectOperations, type ObjectAccessScope, type ObjectOperation } from './governed-objects.ts';
import { relationTypes, type RelationType } from '../operational-graph/types.ts';

export type ObjectGrantStatus = 'active' | 'superseded' | 'revoked' | 'expired';

export type ObjectGrant = {
  id: string;
  revision: number;
  /** The agent, run or tool this grant is for. */
  subject: string;
  spaceId: string;
  readableObjectIds: string[];
  writableObjectIds: string[];
  creatableTypes: string[];
  allowedRelationTypes: RelationType[];
  allowedOperations: ObjectOperation[];
  /** Frames or scenes the subject may place and move objects within. */
  projectionScope: string[];
  externalTransmission: 'blocked' | 'allowed';
  /** Absolute expiry; a grant always ends. */
  expiresAt: string | null;
  /** The run this grant is bound to, if any. It dies with that run. */
  runId: string | null;
  intentId: string | null;
  receiptId: string | null;
  /** Who approved it. A grant with no approver is not a grant. */
  approvedBy: string;
  approvedAt: string;
  status: ObjectGrantStatus;
  /** Where the territory is drawn. Presentation only; never read for authority. */
  territory: { x: number; y: number; w: number; h: number } | null;
  note: string;
};

export type ObjectGrantEvent = {
  eventId: string;
  kind: 'grant.approved' | 'grant.revised' | 'grant.revoked';
  at: string;
  grant: ObjectGrant;
};

export type ObjectGrantCorruption = { line: number; reason: string; raw: string };

const relationTypeSet = new Set<string>(relationTypes);
const operationSet = new Set<string>(objectOperations);

export function objectGrantsPath() {
  const runtime = process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
  return path.join(runtime, 'grants', 'object-grants.jsonl');
}

function clean(value: unknown, max: number) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanId(value: unknown, max = 200) {
  return clean(value, max).replace(/[^a-zA-Z0-9_:.-]/g, '');
}

function idList(value: unknown, limit = 512) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry) => cleanId(entry, 300)).filter(Boolean))).slice(0, limit);
}

function typeList(value: unknown, limit = 64) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry) => clean(entry, 120)).filter(Boolean))).slice(0, limit);
}

function rectangle(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const numbers = ['x', 'y', 'w', 'h'].map((key) => Number(raw[key]));
  if (numbers.some((entry) => !Number.isFinite(entry))) return null;
  return { x: numbers[0], y: numbers[1], w: Math.max(0, numbers[2]), h: Math.max(0, numbers[3]) };
}

/**
 * Validate a grant request into a record.
 *
 * Every widening is stated explicitly. An unrecognised relation type or
 * operation is refused rather than dropped, because a silently narrowed grant
 * would fail confusingly at execution time instead of at approval time, when a
 * human is present to fix it.
 */
export function buildObjectGrant(input: Record<string, unknown>, previous?: ObjectGrant): ObjectGrant {
  const subject = cleanId(input.subject);
  if (!subject) throw new Error('A grant needs a subject: the agent, run or tool it is for.');
  const approvedBy = clean(input.approvedBy, 200);
  if (!approvedBy) throw new Error('A grant needs the human who approved it.');
  const spaceId = cleanId(input.spaceId) || 'default';

  const allowedRelationTypes = typeList(input.allowedRelationTypes).map((entry) => {
    if (!relationTypeSet.has(entry)) throw new Error(`"${entry}" is not a known relation type.`);
    return entry as RelationType;
  });
  const allowedOperations = typeList(input.allowedOperations).map((entry) => {
    if (!operationSet.has(entry)) throw new Error(`"${entry}" is not a known object operation.`);
    return entry as ObjectOperation;
  });

  const expiresAtRaw = clean(input.expiresAt, 40);
  const expiresAt = expiresAtRaw && !Number.isNaN(Date.parse(expiresAtRaw)) ? expiresAtRaw : null;
  const runId = cleanId(input.runId) || null;
  if (!expiresAt && !runId) {
    // A grant that never ends is a permission, and permissions are what this
    // exists to replace.
    throw new Error('A grant must end: give it an expiry or bind it to a run.');
  }

  const now = new Date().toISOString();
  return {
    id: cleanId(input.id) || previous?.id || randomUUID(),
    revision: previous ? previous.revision + 1 : 1,
    subject,
    spaceId,
    readableObjectIds: idList(input.readableObjectIds),
    writableObjectIds: idList(input.writableObjectIds),
    creatableTypes: typeList(input.creatableTypes),
    allowedRelationTypes,
    allowedOperations,
    projectionScope: idList(input.projectionScope, 64),
    externalTransmission: input.externalTransmission === 'allowed' ? 'allowed' : 'blocked',
    expiresAt,
    runId,
    intentId: cleanId(input.intentId) || null,
    receiptId: clean(input.receiptId, 1000) || null,
    approvedBy,
    approvedAt: now,
    status: 'active',
    territory: rectangle(input.territory),
    note: clean(input.note, 1000)
  };
}

async function readLines(file: string) {
  try {
    return (await readFile(file, 'utf8')).split('\n');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export type ObjectGrantLedger = {
  grants: ObjectGrant[];
  events: ObjectGrantEvent[];
  corruption: ObjectGrantCorruption[];
};

/**
 * Fold the ledger into current grants.
 *
 * Malformed lines stay on disk exactly as written and are reported. Erasing a
 * damaged authority record would be the worst possible recovery: the history of
 * what was permitted is the point.
 */
export async function readObjectGrants(file = objectGrantsPath()): Promise<ObjectGrantLedger> {
  const lines = await readLines(file);
  const events: ObjectGrantEvent[] = [];
  const corruption: ObjectGrantCorruption[] = [];
  const current = new Map<string, ObjectGrant>();

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
    const event = parsed as Partial<ObjectGrantEvent>;
    if (!event || typeof event !== 'object' || !event.grant?.id || !event.kind) {
      corruption.push({ line: index + 1, reason: 'unrecognized-record', raw: raw.slice(0, 2000) });
      return;
    }
    events.push(event as ObjectGrantEvent);
    const grant = event.grant as ObjectGrant;
    const existing = current.get(grant.id);
    if (existing && existing.revision > grant.revision) return;
    current.set(grant.id, {
      ...grant,
      status: event.kind === 'grant.revoked' ? 'revoked' : grant.status || 'active'
    });
  });

  const now = Date.now();
  const grants = [...current.values()].map((grant) => ({
    ...grant,
    status:
      grant.status === 'revoked'
        ? 'revoked'
        : grant.expiresAt && Date.parse(grant.expiresAt) <= now
          ? 'expired'
          : grant.status
  })) as ObjectGrant[];
  return { grants, events, corruption };
}

async function appendEvent(file: string, event: ObjectGrantEvent) {
  await mkdir(path.dirname(file), { recursive: true });
  await withFileLock(file, async () => {
    await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
  });
  return event;
}

/** Approve a new grant. */
export async function approveObjectGrant(input: Record<string, unknown>, file = objectGrantsPath()) {
  const grant = buildObjectGrant(input);
  await appendEvent(file, {
    eventId: `${grant.id}:${grant.revision}`,
    kind: 'grant.approved',
    at: grant.approvedAt,
    grant
  });
  return grant;
}

/**
 * Revise a grant.
 *
 * A revision is a fresh approval, not an edit: it carries its own approver and
 * bumps the revision, so nothing about an existing grant changes without a human
 * saying so again.
 */
export async function reviseObjectGrant(
  grantId: string,
  input: Record<string, unknown>,
  file = objectGrantsPath()
) {
  const { grants } = await readObjectGrants(file);
  const previous = grants.find((grant) => grant.id === grantId);
  if (!previous) throw new Error('That grant does not exist.');
  if (previous.status !== 'active') throw new Error(`That grant is ${previous.status} and cannot be revised.`);
  const grant = buildObjectGrant({ ...input, id: grantId }, previous);
  await appendEvent(file, {
    eventId: `${grant.id}:${grant.revision}`,
    kind: 'grant.revised',
    at: grant.approvedAt,
    grant
  });
  return grant;
}

export async function revokeObjectGrant(grantId: string, revokedBy: string, file = objectGrantsPath()) {
  const { grants } = await readObjectGrants(file);
  const previous = grants.find((grant) => grant.id === grantId);
  if (!previous) throw new Error('That grant does not exist.');
  const grant: ObjectGrant = {
    ...previous,
    revision: previous.revision + 1,
    status: 'revoked',
    approvedBy: clean(revokedBy, 200) || previous.approvedBy,
    approvedAt: new Date().toISOString()
  };
  await appendEvent(file, {
    eventId: `${grant.id}:${grant.revision}`,
    kind: 'grant.revoked',
    at: grant.approvedAt,
    grant
  });
  return grant;
}

/**
 * Move or resize a territory.
 *
 * Explicitly *not* a revision: geometry is presentation. Dragging the rectangle
 * cannot widen what the grant permits, so this path never touches the scope
 * fields and never asks for a new approval.
 */
export async function moveObjectGrantTerritory(
  grantId: string,
  territory: unknown,
  file = objectGrantsPath()
) {
  const { grants } = await readObjectGrants(file);
  const previous = grants.find((grant) => grant.id === grantId);
  if (!previous) throw new Error('That grant does not exist.');
  const grant: ObjectGrant = {
    ...previous,
    revision: previous.revision + 1,
    territory: rectangle(territory),
    approvedAt: new Date().toISOString()
  };
  await appendEvent(file, {
    eventId: `${grant.id}:${grant.revision}`,
    kind: 'grant.revised',
    at: grant.approvedAt,
    grant
  });
  return grant;
}

export class ObjectGrantError extends Error {
  readonly code = 'object-grant-unavailable';
}

/**
 * Turn an approved grant into the scope the governed tools enforce.
 *
 * The only supported way to obtain a scope. Everything a caller could have
 * described about its own authority now comes from a record a human approved.
 */
export function grantToScope(grant: ObjectGrant, now = Date.now()): ObjectAccessScope {
  if (grant.status === 'revoked') throw new ObjectGrantError('That grant has been revoked.');
  if (grant.status === 'expired' || (grant.expiresAt && Date.parse(grant.expiresAt) <= now)) {
    throw new ObjectGrantError('That grant has expired. A new approval is required.');
  }
  return {
    grantId: grant.id,
    spaceId: grant.spaceId,
    readableObjectIds: [...grant.readableObjectIds],
    writableObjectIds: [...grant.writableObjectIds],
    creatableTypes: [...grant.creatableTypes],
    allowedRelationTypes: [...grant.allowedRelationTypes],
    allowedOperations: [...grant.allowedOperations],
    projectionScope: [...grant.projectionScope],
    externalTransmission: grant.externalTransmission,
    expiresAt: grant.expiresAt,
    runId: grant.runId
  };
}

export async function scopeForGrant(grantId: string, file = objectGrantsPath()) {
  const { grants } = await readObjectGrants(file);
  const grant = grants.find((entry) => entry.id === grantId);
  if (!grant) throw new ObjectGrantError('That grant does not exist.');
  return { grant, scope: grantToScope(grant) };
}

/** Grants a run may use: active, unexpired, and either unbound or bound to it. */
export async function grantsForRun(runId: string, file = objectGrantsPath()) {
  const { grants } = await readObjectGrants(file);
  return grants.filter(
    (grant) => grant.status === 'active' && (grant.runId === null || grant.runId === runId)
  );
}

/**
 * The human-readable sentence a territory shows.
 *
 * Written as "may" and "may not" because that is how a person checks a
 * permission — a list of enabled flags reads as capability, not as limit.
 */
export function describeObjectGrant(grant: ObjectGrant) {
  const may: string[] = [];
  const mayNot: string[] = [];
  if (grant.allowedOperations.includes('read')) {
    may.push(`read ${grant.readableObjectIds.length} object${grant.readableObjectIds.length === 1 ? '' : 's'}`);
  }
  if (grant.allowedOperations.includes('create') && grant.creatableTypes.length) {
    may.push(
      `create ${grant.creatableTypes.join(', ')}${grant.projectionScope.length ? ` inside ${grant.projectionScope.join(', ')}` : ''}`
    );
  }
  if (grant.allowedOperations.includes('annotate')) may.push('annotate');
  if (grant.allowedOperations.includes('patch-semantic')) {
    may.push(`edit ${grant.writableObjectIds.length} object${grant.writableObjectIds.length === 1 ? '' : 's'}`);
  } else {
    mayNot.push('edit source objects');
  }
  if (grant.allowedRelationTypes.length) may.push(`create ${grant.allowedRelationTypes.join(', ')}`);
  if (!grant.allowedOperations.includes('tombstone')) mayNot.push('delete objects');
  if (!grant.projectionScope.length) mayNot.push('place objects in any frame');
  if (grant.externalTransmission === 'blocked') mayNot.push('send anything externally');
  return {
    may,
    mayNot,
    ends: grant.runId ? `when run ${grant.runId} finishes` : `at ${grant.expiresAt}`,
    approvedBy: grant.approvedBy,
    status: grant.status
  };
}
