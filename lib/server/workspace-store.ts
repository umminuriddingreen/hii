import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { emptyWorkspace, normalizeWorkspace, type WorkspaceDoc } from '../workspace/types';

const workspaceDir = path.join(process.env.HII_RUNTIME_DIR || path.join(process.env.HOME || '.', '.hii'), 'workspace');
const workspacePath = path.join(workspaceDir, 'workspace.json');
const legacySpatialKey = ['can', 'vas'].join('');
const legacyWorkspacePath = path.join(
  process.env.HII_RUNTIME_DIR || path.join(process.env.HOME || '.', '.hii'),
  legacySpatialKey,
  'workspace.json'
);

export async function readWorkspace(): Promise<WorkspaceDoc> {
  try {
    const raw = await readFile(workspacePath, 'utf8');
    return normalizeWorkspace(JSON.parse(raw));
  } catch {
    try {
      const legacy = normalizeWorkspace(JSON.parse(await readFile(legacyWorkspacePath, 'utf8')));
      await persistWorkspace(legacy);
      return legacy;
    } catch {
      return emptyWorkspace();
    }
  }
}

async function persistWorkspace(doc: WorkspaceDoc) {
  await mkdir(workspaceDir, { recursive: true });
  const tmpPath = `${workspacePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await rename(tmpPath, workspacePath);
}

export async function writeWorkspace(raw: unknown): Promise<WorkspaceDoc> {
  const doc = normalizeWorkspace(raw);
  doc.updatedAt = new Date().toISOString();
  await persistWorkspace(doc);
  return doc;
}
