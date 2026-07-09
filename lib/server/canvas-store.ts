import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { emptyWorkspace, normalizeWorkspace, type WorkspaceDoc } from '../canvas/types';

const canvasDir = path.join(process.env.HII_RUNTIME_DIR || path.join(process.env.HOME || '.', '.hii'), 'canvas');
const workspacePath = path.join(canvasDir, 'workspace.json');

export async function readWorkspace(): Promise<WorkspaceDoc> {
  try {
    const raw = await readFile(workspacePath, 'utf8');
    return normalizeWorkspace(JSON.parse(raw));
  } catch {
    return emptyWorkspace();
  }
}

export async function writeWorkspace(raw: unknown): Promise<WorkspaceDoc> {
  const doc = normalizeWorkspace(raw);
  doc.updatedAt = new Date().toISOString();
  await mkdir(canvasDir, { recursive: true });
  const tmpPath = `${workspacePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await rename(tmpPath, workspacePath);
  return doc;
}
