/**
 * Durable storage for Space records.
 *
 * One Space is one file at `~/.hii/spaces/<id>.json`. There is no index file
 * and no database table: the directory listing *is* the index, which means a
 * Space cannot exist in the index but not on disk, or the reverse. The
 * operational graph already partitions by `space_id` and the canvas already
 * lives at `workspace/workspaces/<id>.json`; adding a third place that also
 * claims to know which Spaces exist is exactly the ambiguous ownership
 * docs/SPACES_ARCHITECTURE.md §6 forbids.
 *
 * The write discipline is borrowed wholesale from `workspace-store.ts` — atomic
 * rename, an advisory file lock around read-modify-write, and an unreadable
 * file preserved rather than overwritten — because a Space record losing its
 * owner or its policy is worse than a canvas losing a node.
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, withFileLock } from './atomic-write.ts';
import { runtimeRoot } from './runtime-root.ts';
import {
  SPACE_ID_PATTERN,
  defaultSpacePolicy,
  type Space,
  type SpaceHostingMode,
  type SpacePolicy,
  type SpacePublication,
  type SpaceSummary
} from '../spaces/types.ts';

export class SpaceNotFoundError extends Error {
  readonly code = 'SPACE_NOT_FOUND';
  readonly spaceId: string;
  constructor(spaceId: string) {
    super(`space "${spaceId}" does not exist`);
    this.name = 'SpaceNotFoundError';
    this.spaceId = spaceId;
  }
}

export class SpaceExistsError extends Error {
  readonly code = 'SPACE_EXISTS';
  readonly spaceId: string;
  constructor(spaceId: string) {
    super(`space "${spaceId}" already exists`);
    this.name = 'SpaceExistsError';
    this.spaceId = spaceId;
  }
}

export class SpaceLoadError extends Error {
  readonly code = 'SPACE_LOAD_FAILED';
  readonly recoveryPath?: string;
  constructor(message: string, recoveryPath?: string) {
    super(message);
    this.name = 'SpaceLoadError';
    this.recoveryPath = recoveryPath;
  }
}

export class SpaceRevisionConflictError extends Error {
  readonly code = 'SPACE_REVISION_CONFLICT';
  readonly expectedRevision: number;
  readonly actualRevision: number;
  constructor(expectedRevision: number, actualRevision: number) {
    super(`space revision changed from ${expectedRevision} to ${actualRevision}`);
    this.name = 'SpaceRevisionConflictError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function runtimeDir() {
  return runtimeRoot();
}

export function spacesDirectory() {
  return path.join(runtimeDir(), 'spaces');
}

/**
 * Validate before touching the filesystem.
 *
 * This runs first in every exported function, including the read paths, so a
 * hostile `:space_id` from an HTTP route can never reach `path.join`. The
 * pattern forbids `.` and `/` outright, so traversal is not merely filtered —
 * it is unrepresentable.
 */
export function validateSpaceId(raw: unknown): string {
  if (typeof raw !== 'string' || !SPACE_ID_PATTERN.test(raw)) {
    throw new TypeError(
      'spaceId must be 1-64 lowercase letters, numbers, hyphens, or underscores'
    );
  }
  return raw;
}

function spacePath(spaceId: string) {
  return path.join(spacesDirectory(), `${validateSpaceId(spaceId)}.json`);
}

/**
 * Copy a file we could not read or parse to a sibling named by its digest.
 *
 * A Space record that fails to parse is still the only evidence of who owned
 * that Space and what its policy was. Overwriting it with a fresh default would
 * silently hand a Space a new, more permissive life.
 */
async function preserveUnreadable(file: string, raw: string | undefined) {
  const digest = createHash('sha256').update(raw ?? 'unreadable').digest('hex').slice(0, 12);
  const base = path.basename(file, path.extname(file));
  const recoveryPath = path.join(spacesDirectory(), `${base}.unreadable.${digest}.json`);
  try {
    await copyFile(file, recoveryPath);
    return recoveryPath;
  } catch {
    return file;
  }
}

function normalizePolicy(raw: unknown): SpacePolicy {
  const base = defaultSpacePolicy();
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Partial<SpacePolicy>;
  const audience = (input: unknown, fallback: SpacePolicy['read']) =>
    input === 'local' || input === 'public' ? input : fallback;
  const writeAudience = (input: unknown, fallback: SpacePolicy['write']) =>
    input === 'none' || input === 'local' || input === 'public' ? input : fallback;
  const bounded = (input: unknown, fallback: number) =>
    typeof input === 'number' && Number.isFinite(input) && input >= 0 ? Math.floor(input) : fallback;
  return {
    admission: value.admission === 'invite' ? 'invite' : 'open',
    read: audience(value.read, base.read),
    write: writeAudience(value.write, base.write),
    writesFrozen: value.writesFrozen === true,
    uploadsEnabled: value.uploadsEnabled !== false,
    maxUploadBytes: bounded(value.maxUploadBytes, base.maxUploadBytes),
    storageQuotaBytes: bounded(value.storageQuotaBytes, base.storageQuotaBytes),
    maxObjects: bounded(value.maxObjects, base.maxObjects)
  };
}

function normalizePublication(raw: unknown, now: string): SpacePublication {
  if (!raw || typeof raw !== 'object') return { state: 'unpublished', updatedAt: now };
  const value = raw as Partial<SpacePublication>;
  const state =
    value.state === 'published' || value.state === 'failed' ? value.state : 'unpublished';
  return {
    state,
    ...(typeof value.endpoint === 'string' ? { endpoint: value.endpoint } : {}),
    ...(typeof value.provider === 'string' ? { provider: value.provider } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now
  };
}

/**
 * Coerce a parsed record into a complete `Space`.
 *
 * Unknown fields are dropped and missing fields take their default, so a record
 * written by an older build loads rather than failing — but an unparseable
 * *shape* (not an object, wrong id, no owner) is a load error, not a silent
 * default, because those are the fields that carry authority.
 */
function normalizeSpace(raw: unknown, spaceId: string): Space {
  if (!raw || typeof raw !== 'object') throw new Error('invalid space shape');
  const value = raw as Record<string, unknown>;
  if (value.id !== spaceId) throw new Error('space id does not match its filename');
  if (typeof value.ownerId !== 'string' || !value.ownerId) throw new Error('space has no owner');
  const now = new Date().toISOString();
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : now;
  return {
    schemaVersion: 1,
    id: spaceId,
    name: typeof value.name === 'string' && value.name ? value.name : spaceId,
    ownerId: value.ownerId,
    policy: normalizePolicy(value.policy),
    hosting: value.hosting === 'published' ? 'published' : 'local-only',
    publication: normalizePublication(value.publication, now),
    createdAt,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : createdAt,
    revision:
      typeof value.revision === 'number' && Number.isInteger(value.revision) && value.revision >= 0
        ? value.revision
        : 0
  };
}

async function parseSpace(file: string, spaceId: string): Promise<Space | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SpaceLoadError(
      'HII could not read the space record.',
      await preserveUnreadable(file, undefined)
    );
  }
  try {
    return normalizeSpace(JSON.parse(raw), spaceId);
  } catch {
    throw new SpaceLoadError(
      'HII could not parse the space record.',
      await preserveUnreadable(file, raw)
    );
  }
}

async function persistSpace(space: Space) {
  await mkdir(spacesDirectory(), { recursive: true });
  // Pretty-printed, unlike the workspace document. A Space record is written
  // once per policy change rather than on every keystroke, and it is the file a
  // person is most likely to open to answer "who can write to this?".
  await atomicWriteFile(spacePath(space.id), `${JSON.stringify(space, null, 2)}\n`);
}

export type CreateSpaceInput = {
  id: string;
  ownerId: string;
  name?: string;
  policy?: Partial<SpacePolicy>;
};

export async function createSpace(input: CreateSpaceInput): Promise<Space> {
  const spaceId = validateSpaceId(input.id);
  if (typeof input.ownerId !== 'string' || !input.ownerId) {
    throw new TypeError('ownerId is required');
  }
  const file = spacePath(spaceId);
  await mkdir(spacesDirectory(), { recursive: true });
  return withFileLock(file, async () => {
    // A record that exists but cannot be parsed still claims this id. Letting
    // the load error escape here would be safe (nothing is overwritten) but
    // would report a corrupt file as a create failure, and the caller's correct
    // response — pick another id — is the same one an existing space warrants.
    const occupied = await parseSpace(file, spaceId).catch((error) => {
      if (error instanceof SpaceLoadError) return true;
      throw error;
    });
    if (occupied) throw new SpaceExistsError(spaceId);
    const now = new Date().toISOString();
    const space: Space = {
      schemaVersion: 1,
      id: spaceId,
      name: input.name?.trim() || spaceId,
      ownerId: input.ownerId,
      policy: normalizePolicy({ ...defaultSpacePolicy(), ...input.policy }),
      hosting: 'local-only',
      publication: { state: 'unpublished', updatedAt: now },
      createdAt: now,
      updatedAt: now,
      revision: 1
    };
    await persistSpace(space);
    return space;
  });
}

export async function readSpace(spaceId: string): Promise<Space> {
  const id = validateSpaceId(spaceId);
  const space = await parseSpace(spacePath(id), id);
  if (!space) throw new SpaceNotFoundError(id);
  return space;
}

export async function spaceExists(spaceId: string): Promise<boolean> {
  const id = validateSpaceId(spaceId);
  try {
    return (await parseSpace(spacePath(id), id)) !== null;
  } catch (error) {
    // An unreadable record is still a Space that exists. Reporting it absent
    // would let `createSpace` claim the id and overwrite it.
    if (error instanceof SpaceLoadError) return true;
    throw error;
  }
}

/** The fields a caller may change. Identity and provenance are not among them. */
export type SpaceUpdate = {
  name?: string;
  policy?: Partial<SpacePolicy>;
  hosting?: SpaceHostingMode;
  publication?: Partial<SpacePublication>;
};

/**
 * Read-modify-write under the lock, refusing a caller that decided against a
 * revision the record has since moved past.
 *
 * `expectedRevision` is optional so that a host applying its own sequential
 * change does not have to thread a revision through every call; when it is
 * supplied, it is enforced.
 */
export async function updateSpace(
  spaceId: string,
  update: SpaceUpdate,
  expectedRevision?: number
): Promise<Space> {
  const id = validateSpaceId(spaceId);
  const file = spacePath(id);
  return withFileLock(file, async () => {
    const current = await parseSpace(file, id);
    if (!current) throw new SpaceNotFoundError(id);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new SpaceRevisionConflictError(expectedRevision, current.revision);
    }
    const now = new Date().toISOString();
    const next: Space = {
      ...current,
      name: update.name?.trim() || current.name,
      policy: update.policy ? normalizePolicy({ ...current.policy, ...update.policy }) : current.policy,
      hosting: update.hosting ?? current.hosting,
      publication: update.publication
        ? normalizePublication({ ...current.publication, ...update.publication, updatedAt: now }, now)
        : current.publication,
      updatedAt: now,
      revision: current.revision + 1
    };
    await persistSpace(next);
    return next;
  });
}

/**
 * Forget a Space's identity record.
 *
 * Deliberately does NOT touch the canvas document or the blobs. Those are owned
 * by the workspace store and the asset directory; deleting them from here would
 * make this module a second authority over state it does not own. Clearing a
 * Space's contents is a separate, explicit operation.
 */
export async function deleteSpaceRecord(spaceId: string): Promise<void> {
  const id = validateSpaceId(spaceId);
  const file = spacePath(id);
  await withFileLock(file, async () => {
    if (!(await parseSpace(file, id).catch(() => null))) throw new SpaceNotFoundError(id);
    await rm(file, { force: true });
  });
}

export async function listSpaces(): Promise<SpaceSummary[]> {
  const directory = spacesDirectory();
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const summaries: SpaceSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -5);
    // Skips the `<id>.unreadable.<digest>.json` recovery copies as well as
    // anything else that is not a Space id.
    if (!SPACE_ID_PATTERN.test(id)) continue;
    try {
      const space = await parseSpace(path.join(directory, entry.name), id);
      if (!space) continue;
      summaries.push({
        id,
        name: space.name,
        ownerId: space.ownerId,
        hosting: space.hosting,
        publicationState: space.publication.state,
        status: 'ready',
        updatedAt: space.updatedAt
      });
    } catch (error) {
      if (!(error instanceof SpaceLoadError)) throw error;
      // A corrupt record must not hide the healthy Spaces listed beside it.
      summaries.push({
        id,
        name: id,
        ownerId: 'unknown',
        hosting: 'local-only',
        publicationState: 'unpublished',
        status: 'recovery'
      });
    }
  }
  summaries.sort((a, b) => a.id.localeCompare(b.id));
  return summaries;
}
