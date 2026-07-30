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
    const namedDir = path.join(workspaceDir, 'workspaces');
    await mkdir(namedDir, { recursive: true });
    await writeFile(path.join(namedDir, 'default.json'), '{not json', 'utf8');

    await expect(loadWorkspace()).rejects.toMatchObject({
      code: 'WORKSPACE_LOAD_FAILED',
      recoveryPath: expect.stringContaining('default.unreadable.')
    });
    expect(await readFile(path.join(namedDir, 'default.json'), 'utf8')).toBe('{not json');
    const files = await readdir(workspaceDir);
    expect(files.some((file) => file.startsWith('default.unreadable.'))).toBe(true);

    await writeFile(path.join(namedDir, 'default.json'), '{}', 'utf8');
    await expect(loadWorkspace()).rejects.toMatchObject({ code: 'WORKSPACE_LOAD_FAILED' });
  });

  it('blocks writes while the current file is unreadable and recovers after it is repaired', async () => {
    const { loadWorkspace, writeWorkspace } = await store();
    const workspaceDir = path.join(runtimeDir, 'workspace');
    const workspacePath = path.join(workspaceDir, 'workspaces', 'default.json');
    await mkdir(path.dirname(workspacePath), { recursive: true });
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
      await readFile(path.join(runtimeDir, 'workspace', 'workspaces', 'default.json'), 'utf8')
    );
    expect(persisted.revision).toBe(1);
    expect((await readdir(path.join(runtimeDir, 'workspace', 'workspaces'))).sort()).toEqual([
      'default.json'
    ]);
  });

  it('migrates the old single workspace into the named default without altering the original', async () => {
    const oldPath = path.join(runtimeDir, 'workspace', 'workspace.json');
    await mkdir(path.dirname(oldPath), { recursive: true });
    const original = JSON.stringify({
      version: 1,
      revision: 7,
      viewport: { x: 12, y: 24, zoom: 0.5 },
      nextZ: 1,
      nodes: []
    });
    await writeFile(oldPath, original, 'utf8');

    const { loadWorkspace } = await store();
    const migrated = await loadWorkspace();
    expect(migrated).toMatchObject({
      status: 'migrated',
      workspaceId: 'default',
      workspace: { revision: 7 }
    });
    expect(await readFile(oldPath, 'utf8')).toBe(original);
    expect(
      JSON.parse(
        await readFile(path.join(runtimeDir, 'workspace', 'workspaces', 'default.json'), 'utf8')
      )
    ).toMatchObject({ revision: 7, viewport: { x: 12, y: 24, zoom: 0.5 } });
  });

  it('creates, lists, selects, and independently revisions named workspaces', async () => {
    const {
      createWorkspace,
      getSelectedWorkspaceId,
      listWorkspaces,
      loadWorkspace,
      selectWorkspace,
      writeWorkspace
    } = await store();
    await createWorkspace('research');
    expect(await getSelectedWorkspaceId()).toBe('research');
    const research = await loadWorkspace();
    const saved = await writeWorkspace(research.workspace, 0);
    expect(saved.revision).toBe(1);

    await createWorkspace('project_2');
    expect((await loadWorkspace()).workspace.revision).toBe(0);
    await selectWorkspace('research');
    expect((await loadWorkspace()).workspace.revision).toBe(1);

    expect(await listWorkspaces()).toMatchObject({
      selectedWorkspaceId: 'research',
      workspaces: [
        { id: 'project_2', selected: false, status: 'ready', revision: 0 },
        { id: 'research', selected: true, status: 'ready', revision: 1 }
      ]
    });
  });

  it('rejects traversal ids and refuses to select a missing workspace', async () => {
    const { createWorkspace, loadWorkspace, selectWorkspace, writeWorkspace } = await store();
    await expect(createWorkspace('../escape')).rejects.toThrow(/workspaceId/);
    await expect(loadWorkspace('Has Spaces')).rejects.toThrow(/workspaceId/);
    await expect(writeWorkspace({ version: 1, nodes: [] }, 0, 'a/b')).rejects.toThrow(/workspaceId/);
    await expect(writeWorkspace({ version: 1, nodes: [] }, 0, 'not-created')).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_FOUND'
    });
    await expect(selectWorkspace('missing')).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
      workspaceId: 'missing'
    });
    await expect(readFile(path.join(runtimeDir, 'escape.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('keeps a corrupt named workspace isolated and blocks writes only to that workspace', async () => {
    const { createWorkspace, listWorkspaces, loadWorkspace, selectWorkspace, writeWorkspace } =
      await store();
    await createWorkspace('healthy');
    await createWorkspace('broken');
    const brokenPath = path.join(runtimeDir, 'workspace', 'workspaces', 'broken.json');
    await writeFile(brokenPath, '{bad', 'utf8');

    await expect(loadWorkspace('broken')).rejects.toMatchObject({ code: 'WORKSPACE_LOAD_FAILED' });
    await expect(writeWorkspace({ version: 1, nodes: [] }, 0, 'broken')).rejects.toMatchObject({
      code: 'WORKSPACE_LOAD_FAILED'
    });
    expect((await writeWorkspace((await loadWorkspace('healthy')).workspace, 0, 'healthy')).revision).toBe(
      1
    );
    expect(await listWorkspaces()).toMatchObject({
      selectedWorkspaceId: 'broken',
      workspaces: expect.arrayContaining([
        expect.objectContaining({ id: 'broken', selected: true, status: 'recovery' }),
        expect.objectContaining({ id: 'healthy', selected: false, status: 'ready' })
      ])
    });
    await selectWorkspace('healthy');
    expect((await loadWorkspace()).workspace.revision).toBe(1);
  });
});
