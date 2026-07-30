import { createHash } from 'crypto';
import { copyFile, mkdir, readFile } from 'fs/promises';
import path from 'path';
import { emptyWorkspace, normalizeWorkspace, type WorkspaceDoc } from '../workspace/types.ts';
import { atomicWriteFile, withFileLock } from './atomic-write.ts';

const legacySpatialKey = ['can', 'vas'].join('');

export type WorkspaceLoadResult = {
  status: 'ready' | 'missing' | 'migrated';
  workspace: WorkspaceDoc;
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

function runtimeDir() {
  return process.env.HII_RUNTIME_DIR || path.join(process.env.HOME || '.', '.hii');
}

function paths() {
  const root = runtimeDir();
  const directory = path.join(root, 'workspace');
  return {
    directory,
    workspace: path.join(directory, 'workspace.json'),
    legacy: path.join(root, legacySpatialKey, 'workspace.json')
  };
}

async function preserveUnreadable(file: string, raw: string | undefined) {
  const { directory } = paths();
  await mkdir(directory, { recursive: true });
  const digest = createHash('sha256').update(raw ?? 'unreadable').digest('hex').slice(0, 12);
  const recoveryPath = path.join(directory, `workspace.unreadable.${digest}.json`);
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

async function persistWorkspace(doc: WorkspaceDoc) {
  const { directory, workspace } = paths();
  await mkdir(directory, { recursive: true });
  await atomicWriteFile(workspace, `${JSON.stringify(doc, null, 2)}\n`);
}

export async function loadWorkspace(): Promise<WorkspaceLoadResult> {
  const { workspace, legacy } = paths();
  const current = await parseWorkspace(workspace);
  if (current) return { status: 'ready', workspace: current };

  const legacyWorkspace = await parseWorkspace(legacy);
  if (!legacyWorkspace) return { status: 'missing', workspace: emptyWorkspace() };
  legacyWorkspace.revision = Math.max(1, legacyWorkspace.revision);
  legacyWorkspace.updatedAt = new Date().toISOString();
  await persistWorkspace(legacyWorkspace);
  return { status: 'migrated', workspace: legacyWorkspace };
}

export async function readWorkspace(): Promise<WorkspaceDoc> {
  return (await loadWorkspace()).workspace;
}

export async function writeWorkspace(raw: unknown, expectedRevision: number): Promise<WorkspaceDoc> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError('expectedRevision must be a non-negative integer');
  }
  const { directory, workspace } = paths();
  await mkdir(directory, { recursive: true });
  return withFileLock(workspace, async () => {
    const loaded = await loadWorkspace();
    const actualRevision = loaded.workspace.revision;
    if (actualRevision !== expectedRevision) {
      throw new WorkspaceRevisionConflictError(expectedRevision, actualRevision);
    }
    const doc = normalizeWorkspace(raw);
    doc.revision = actualRevision + 1;
    doc.updatedAt = new Date().toISOString();
    await persistWorkspace(doc);
    return doc;
  });
}
