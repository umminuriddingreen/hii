// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}), { virtual: true });

let runtimeDir = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-board-quality-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

async function board() {
  return import('../../lib/server/hii-board');
}

describe('HII board quality boundary', () => {
  it('holds generated active work as a reviewable backlog proposal', async () => {
    const { createBoardTask } = await board();
    const task = await createBoardTask({
      title: 'Draft the founder pilot brief',
      lane: 'doing',
      coordinate: '/Users/ummi/hii',
      source: 'hii.agent.workspace-run',
      origin: 'agent'
    });

    expect(task).toMatchObject({
      lane: 'backlog',
      requestedLane: 'doing',
      reviewState: 'proposed',
      origin: 'agent'
    });
    expect(task.approvedAt).toBeUndefined();
  });

  it('requires an explicit approval before a proposal can enter active work', async () => {
    const { createBoardTask, updateBoardTask } = await board();
    const task = await createBoardTask({
      title: 'Prepare a source-linked campaign demo',
      lane: 'next',
      coordinate: '/Users/ummi/hii',
      source: 'hii.knowledge.system-map',
      origin: 'system'
    });

    await expect(updateBoardTask(task.id, { lane: 'next' })).rejects.toMatchObject({
      code: 'BOARD_TASK_APPROVAL_REQUIRED'
    });

    const approved = await updateBoardTask(task.id, {
      lane: 'next',
      reviewState: 'approved',
      approvedBy: 'local operator'
    });
    expect(approved).toMatchObject({
      lane: 'next',
      reviewState: 'approved',
      approvedBy: 'local operator'
    });
    expect(approved.approvedAt).toEqual(expect.any(String));
  });

  it('rejects an exact open duplicate before another event is appended', async () => {
    const { createBoardTask, listBoardTasks } = await board();
    const first = await createBoardTask({
      title: 'Build the launch proof',
      coordinate: '/Users/ummi/hii',
      owner: 'operator',
      origin: 'human'
    });

    await expect(
      createBoardTask({
        title: '  build   the LAUNCH proof ',
        coordinate: '/Users/ummi/hii',
        owner: 'another agent',
        origin: 'agent'
      })
    ).rejects.toMatchObject({
      code: 'BOARD_TASK_DUPLICATE',
      existingTask: { id: first.id }
    });
    expect(await listBoardTasks()).toHaveLength(1);
  });

  it('records direct human intent as approved provenance', async () => {
    const { createBoardTask } = await board();
    const task = await createBoardTask({
      title: 'Review the HII pilot receipt',
      lane: 'next',
      coordinate: '/Users/ummi/hii',
      origin: 'human',
      approvedBy: 'local operator'
    });

    expect(task).toMatchObject({
      lane: 'next',
      reviewState: 'approved',
      origin: 'human',
      approvedBy: 'local operator'
    });
    expect(task.approvedAt).toEqual(expect.any(String));
  });

  it('rejects command flags masquerading as task titles', async () => {
    const { createBoardTask } = await board();
    await expect(createBoardTask({ title: '--help', origin: 'human' })).rejects.toMatchObject({
      code: 'BOARD_TASK_LOW_QUALITY'
    });
  });
});
