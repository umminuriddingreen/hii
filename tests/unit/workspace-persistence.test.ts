// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let runtimeDir = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-workspace-persistence-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

async function store() {
  return import('../../lib/server/workspace-store');
}

describe('workspace persistence lifecycle', () => {
  it('distinguishes a missing workspace from a failed load', async () => {
    const { loadWorkspace } = await store();
    const missing = await loadWorkspace();
    expect(missing).toMatchObject({
      status: 'missing',
      workspace: { version: 1, revision: 0, nodes: [] }
    });

    const workspaceDir = path.join(runtimeDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, 'workspace.json'), '{not json', 'utf8');

    await expect(loadWorkspace()).rejects.toMatchObject({
      code: 'WORKSPACE_LOAD_FAILED',
      recoveryPath: expect.stringContaining('workspace.unreadable.')
    });
    expect(await readFile(path.join(workspaceDir, 'workspace.json'), 'utf8')).toBe('{not json');
    const files = await readdir(workspaceDir);
    expect(files.some((file) => file.startsWith('workspace.unreadable.'))).toBe(true);

    await writeFile(path.join(workspaceDir, 'workspace.json'), '{}', 'utf8');
    await expect(loadWorkspace()).rejects.toMatchObject({ code: 'WORKSPACE_LOAD_FAILED' });
  });

  it('blocks writes while the current file is unreadable and recovers after it is repaired', async () => {
    const { loadWorkspace, writeWorkspace } = await store();
    const workspaceDir = path.join(runtimeDir, 'workspace');
    const workspacePath = path.join(workspaceDir, 'workspace.json');
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(workspacePath, '{broken', 'utf8');

    await expect(writeWorkspace({ version: 1, nodes: [] }, 0)).rejects.toMatchObject({
      code: 'WORKSPACE_LOAD_FAILED'
    });
    expect(await readFile(workspacePath, 'utf8')).toBe('{broken');

    await writeFile(
      workspacePath,
      JSON.stringify({ version: 1, revision: 4, viewport: { x: 0, y: 0, zoom: 1 }, nextZ: 1, nodes: [] }),
      'utf8'
    );
    const recovered = await loadWorkspace();
    expect(recovered.status).toBe('ready');
    expect(recovered.workspace.revision).toBe(4);
  });

  it('requires the current revision and atomically advances it once', async () => {
    const { loadWorkspace, writeWorkspace } = await store();
    const missing = await loadWorkspace();
    const first = await writeWorkspace(missing.workspace, missing.workspace.revision);
    expect(first.revision).toBe(1);

    await expect(writeWorkspace(first, 0)).rejects.toMatchObject({
      code: 'WORKSPACE_REVISION_CONFLICT',
      expectedRevision: 0,
      actualRevision: 1
    });
    const persisted = JSON.parse(
      await readFile(path.join(runtimeDir, 'workspace', 'workspace.json'), 'utf8')
    );
    expect(persisted.revision).toBe(1);
    expect((await readdir(path.join(runtimeDir, 'workspace'))).sort()).toEqual(['workspace.json']);
  });
});
