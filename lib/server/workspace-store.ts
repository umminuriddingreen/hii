import { createHash } from 'crypto';
import { copyFile, mkdir, readFile, readdir } from 'fs/promises';
import path from 'path';
import { emptyWorkspace, normalizeWorkspace, type WorkspaceDoc } from '../workspace/types.ts';
import { atomicWriteFile, withFileLock } from './atomic-write.ts';
import { projectWorkspaceIntoOperationalGraph } from './operational-object-store.ts';
import { runtimeRoot } from '@/lib/server/runtime-root';

const legacySpatialKey = ['can', 'vas'].join('');
export const DEFAULT_WORKSPACE_ID = 'default';
const workspaceIdPattern = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export type WorkspaceLoadResult = {
  status: 'ready' | 'missing' | 'migrated';
  workspaceId: string;
  workspace: WorkspaceDoc;
};

export type WorkspaceSummary = {
  id: string;
  selected: boolean;
  status: 'ready' | 'recovery';
  revision?: number;
  updatedAt?: string;
};

export class WorkspaceLoadError extends Error {
  readonly code = 'WORKSPACE_LOAD_FAILED';
  readonly recoveryPath?: string;
  constructor(message: string, recoveryPath?: string) {
    super(message);
    this.name = 'WorkspaceLoadError';
    this.recoveryPath = recoveryPath;
  }
}

export class WorkspaceRevisionConflictError extends Error {
  readonly code = 'WORKSPACE_REVISION_CONFLICT';
  readonly expectedRevision: number;
  readonly actualRevision: number;
  constructor(expectedRevision: number, actualRevision: number) {
    super(`workspace revision changed from ${expectedRevision} to ${actualRevision}`);
    this.name = 'WorkspaceRevisionConflictError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class WorkspaceNotFoundError extends Error {
  readonly code = 'WORKSPACE_NOT_FOUND';
  readonly workspaceId: string;
  constructor(workspaceId: string) {
    super(`workspace "${workspaceId}" does not exist`);
    this.name = 'WorkspaceNotFoundError';
    this.workspaceId = workspaceId;
  }
}

function runtimeDir() {
  return runtimeRoot();
}

function paths() {
  const root = runtimeDir();
  const directory = path.join(root, 'workspace');
  return {
    directory,
    workspaces: path.join(directory, 'workspaces'),
    selection: path.join(directory, 'selection.json'),
    oldSingleWorkspace: path.join(directory, 'workspace.json'),
    legacy: path.join(root, legacySpatialKey, 'workspace.json')
  };
}

export function validateWorkspaceId(raw: unknown): string {
  if (typeof raw !== 'string' || !workspaceIdPattern.test(raw)) {
    throw new TypeError(
      'workspaceId must be 1-64 lowercase letters, numbers, hyphens, or underscores'
    );
  }
  return raw;
}

function workspacePath(workspaceId: string) {
  return path.join(paths().workspaces, `${validateWorkspaceId(workspaceId)}.json`);
}

async function preserveUnreadable(file: string, raw: string | undefined) {
  const { directory } = paths();
  await mkdir(directory, { recursive: true });
  const digest = createHash('sha256').update(raw ?? 'unreadable').digest('hex').slice(0, 12);
  const base = path.basename(file, path.extname(file));
  const recoveryPath = path.join(directory, `${base}.unreadable.${digest}.json`);
  try {
    await copyFile(file, recoveryPath);
    return recoveryPath;
  } catch {
    return file;
  }
}

async function parseWorkspace(file: string) {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const recoveryPath = await preserveUnreadable(file, undefined);
    throw new WorkspaceLoadError('HII could not read the workspace file.', recoveryPath);
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.nodes) ||
      !parsed.viewport ||
      typeof parsed.viewport !== 'object'
    ) {
      throw new Error('invalid workspace shape');
    }
    return normalizeWorkspace(parsed);
  } catch {
    const recoveryPath = await preserveUnreadable(file, raw);
    throw new WorkspaceLoadError('HII could not parse the workspace file.', recoveryPath);
  }
}

async function persistWorkspace(workspaceId: string, doc: WorkspaceDoc, projectIntoGraph = true) {
  const { workspaces } = paths();
  await mkdir(workspaces, { recursive: true });
  // Written compactly on purpose. This file is rewritten on every autosave and
  // pretty-printing a board with image contact sheets in it roughly doubled the
  // bytes serialized, written, and fsynced on each keystroke-triggered save.
  await atomicWriteFile(workspacePath(workspaceId), `${JSON.stringify(doc)}\n`);
  if (projectIntoGraph) projectWorkspaceIntoOperationalGraph(workspaceId, doc);
}

export async function getSelectedWorkspaceId(): Promise<string> {
  const { selection } = paths();
  let raw: string;
  try {
    raw = await readFile(selection, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_WORKSPACE_ID;
    const recoveryPath = await preserveUnreadable(selection, undefined);
    throw new WorkspaceLoadError('HII could not read the workspace selection.', recoveryPath);
  }
  try {
    const parsed = JSON.parse(raw) as { workspaceId?: unknown };
    return validateWorkspaceId(parsed.workspaceId);
  } catch {
    const recoveryPath = await preserveUnreadable(selection, raw);
    throw new WorkspaceLoadError('HII could not parse the workspace selection.', recoveryPath);
  }
}

async function persistSelection(workspaceId: string) {
  const { directory, selection } = paths();
  await mkdir(directory, { recursive: true });
  await atomicWriteFile(selection, `${JSON.stringify({ workspaceId }, null, 2)}\n`);
}

async function migrateDefaultWorkspace(): Promise<WorkspaceDoc | null> {
  const { oldSingleWorkspace, legacy } = paths();
  const oldSingle = await parseWorkspace(oldSingleWorkspace);
  const source = oldSingle ?? (await parseWorkspace(legacy));
  if (!source) return null;
  source.revision = Math.max(1, source.revision);
  source.updatedAt = new Date().toISOString();
  await persistWorkspace(DEFAULT_WORKSPACE_ID, source);
  return source;
}

export async function loadWorkspace(requestedWorkspaceId?: string): Promise<WorkspaceLoadResult> {
  const workspaceId = requestedWorkspaceId
    ? validateWorkspaceId(requestedWorkspaceId)
    : await getSelectedWorkspaceId();
  const current = await parseWorkspace(workspacePath(workspaceId));
  if (current) return { status: 'ready', workspaceId, workspace: current };

  if (workspaceId === DEFAULT_WORKSPACE_ID) {
    const migrated = await migrateDefaultWorkspace();
    if (migrated) return { status: 'migrated', workspaceId, workspace: migrated };
  }
  return { status: 'missing', workspaceId, workspace: emptyWorkspace() };
}

export async function readWorkspace(workspaceId?: string): Promise<WorkspaceDoc> {
  return (await loadWorkspace(workspaceId)).workspace;
}

export async function backfillWorkspaceOperationalGraph(workspaceId?: string) {
  const loaded = await loadWorkspace(workspaceId);
  projectWorkspaceIntoOperationalGraph(loaded.workspaceId, loaded.workspace, 'hii:workspace-migration');
  return {
    workspaceId: loaded.workspaceId,
    revision: loaded.workspace.revision,
    objectCount: loaded.workspace.nodes.length,
    relationCount: loaded.workspace.links.length
  };
}

export async function createWorkspace(workspaceId: string, select = true): Promise<WorkspaceLoadResult> {
  workspaceId = validateWorkspaceId(workspaceId);
  const file = workspacePath(workspaceId);
  await mkdir(paths().workspaces, { recursive: true });
  const result = await withFileLock(file, async () => {
    const existing = await loadWorkspace(workspaceId);
    if (existing.status !== 'missing') {
      throw new TypeError(`workspace "${workspaceId}" already exists`);
    }
    const workspace = emptyWorkspace();
    await persistWorkspace(workspaceId, workspace);
    return { status: 'ready' as const, workspaceId, workspace };
  });
  if (select) await persistSelection(workspaceId);
  return result;
}

export async function selectWorkspace(workspaceId: string): Promise<WorkspaceLoadResult> {
  workspaceId = validateWorkspaceId(workspaceId);
  const loaded = await loadWorkspace(workspaceId);
  if (loaded.status === 'missing') throw new WorkspaceNotFoundError(workspaceId);
  await persistSelection(workspaceId);
  return loaded;
}

export async function listWorkspaces(): Promise<{
  selectedWorkspaceId: string;
  workspaces: WorkspaceSummary[];
}> {
  const selectedWorkspaceId = await getSelectedWorkspaceId();
  // Make the old single-workspace layout visible as "default" before listing.
  // A corrupt selected workspace must not hide healthy workspaces that can be
  // selected to recover the application.
  try {
    await loadWorkspace(selectedWorkspaceId);
  } catch (error) {
    if (!(error instanceof WorkspaceLoadError)) throw error;
  }
  const { workspaces } = paths();
  const entries = await readdir(workspaces, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const summaries: WorkspaceSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -5);
    if (!workspaceIdPattern.test(id)) continue;
    try {
      const workspace = await parseWorkspace(path.join(workspaces, entry.name));
      if (workspace) {
        summaries.push({
          id,
          selected: id === selectedWorkspaceId,
          status: 'ready',
          revision: workspace.revision,
          updatedAt: workspace.updatedAt
        });
      }
    } catch (error) {
      if (!(error instanceof WorkspaceLoadError)) throw error;
      summaries.push({ id, selected: id === selectedWorkspaceId, status: 'recovery' });
    }
  }
  summaries.sort((a, b) => a.id.localeCompare(b.id));
  return { selectedWorkspaceId, workspaces: summaries };
}

export async function writeWorkspace(
  raw: unknown,
  expectedRevision: number,
  requestedWorkspaceId?: string
): Promise<WorkspaceDoc> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError('expectedRevision must be a non-negative integer');
  }
  const workspaceId = requestedWorkspaceId
    ? validateWorkspaceId(requestedWorkspaceId)
    : await getSelectedWorkspaceId();
  const file = workspacePath(workspaceId);
  await mkdir(paths().workspaces, { recursive: true });
  return withFileLock(file, async () => {
    const loaded = await loadWorkspace(workspaceId);
    if (loaded.status === 'missing' && workspaceId !== DEFAULT_WORKSPACE_ID) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    const actualRevision = loaded.workspace.revision;
    if (actualRevision !== expectedRevision) {
      throw new WorkspaceRevisionConflictError(expectedRevision, actualRevision);
    }
    const doc = normalizeWorkspace(raw);
    doc.revision = actualRevision + 1;
    doc.updatedAt = new Date().toISOString();
    await persistWorkspace(workspaceId, doc);
    return doc;
  });
}

/**
 * Persist the human-readable projection of a graph-authoritative Space.
 *
 * This uses the same lock, revision check, atomic rename and recovery behavior
 * as Workspace writes, but deliberately does not project the JSON back into the
 * graph. Doing so would create workspace-json-owned duplicates beside the
 * canonical graph-owned Space objects.
 */
export async function writeGraphCanonicalWorkspace(
  raw: unknown,
  expectedRevision: number,
  requestedWorkspaceId: string
): Promise<WorkspaceDoc> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError('expectedRevision must be a non-negative integer');
  }
  const workspaceId = validateWorkspaceId(requestedWorkspaceId);
  const file = workspacePath(workspaceId);
  await mkdir(paths().workspaces, { recursive: true });
  return withFileLock(file, async () => {
    const loaded = await loadWorkspace(workspaceId);
    const actualRevision = loaded.workspace.revision;
    if (actualRevision !== expectedRevision) {
      throw new WorkspaceRevisionConflictError(expectedRevision, actualRevision);
    }
    const doc = normalizeWorkspace(raw);
    doc.revision = actualRevision + 1;
    doc.updatedAt = new Date().toISOString();
    await persistWorkspace(workspaceId, doc, false);
    return doc;
  });
}
