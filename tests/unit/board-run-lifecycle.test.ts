// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardPatchForRunState } from '../../lib/workspace/board-run';

vi.mock('server-only', () => ({}), { virtual: true });

let runtimeDir = '';
const execFileAsync = promisify(execFile);

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-board-run-lifecycle-'));
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

async function events() {
  const raw = await readFile(path.join(runtimeDir, 'board', 'tasks.jsonl'), 'utf8');
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function compatibilityCli(...args: string[]) {
  return execFileAsync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'hii-cli.mjs'),
    ...args
  ], {
    cwd: process.cwd(),
    env: { ...process.env, HII_RUNTIME_DIR: runtimeDir }
  });
}

describe('HII board run lifecycle authority', () => {
  it('keeps failure, retry, cancellation, completion, and receipts append-only', async () => {
    const { createBoardTask, listBoardTasks, updateBoardTask } = await board();
    const applyRunState = (
      task: Awaited<ReturnType<typeof createBoardTask>>,
      status: string,
      runId: string,
      receiptRef = ''
    ) => updateBoardTask(task.id, boardPatchForRunState({
      status,
      runId,
      receiptRef,
      currentLane: task.lane
    }));

    let task = await createBoardTask({
      title: 'Verify the governed client handoff',
      lane: 'next',
      origin: 'human',
      coordinate: '/Users/ummi/hii'
    });

    task = await applyRunState(task, 'waiting_approval', 'run-first');
    expect(task.lane).toBe('next');
    expect(await events()).toHaveLength(2);

    const unchanged = await applyRunState(task, 'waiting_approval', 'run-first');
    expect(unchanged.updatedAt).toBe(task.updatedAt);
    expect(await events()).toHaveLength(2);

    await expect(applyRunState(task, 'running', 'run-first'))
      .rejects.toThrow('cannot move from waiting_approval to running');

    task = await applyRunState(task, 'queued', 'run-first');
    expect(task.lane).toBe('doing');
    task = await applyRunState(task, 'running', 'run-first');
    expect(task.lane).toBe('doing');
    await expect(compatibilityCli('board', 'done', task.id.slice(0, 8)))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('completed status and a receipt')
      });

    await expect(updateBoardTask(task.id, {
      lane: 'done',
      runId: 'run-first',
      runStatus: 'completed'
    })).rejects.toThrow('requires a receipt reference');

    task = await applyRunState(task, 'failed', 'run-first');
    expect(task.lane).toBe('blocked');
    await expect(applyRunState(task, 'waiting_approval', 'run-first'))
      .rejects.toThrow('requires a fresh run id');

    task = await applyRunState(task, 'waiting_approval', 'run-retry');
    expect(task.lane).toBe('next');
    task = await applyRunState(task, 'queued', 'run-retry');
    task = await applyRunState(task, 'running', 'run-retry');
    task = await applyRunState(
      task,
      'completed',
      'run-retry',
      '/tmp/run-retry-receipt.json'
    );
    expect(task).toMatchObject({
      lane: 'done',
      runStatus: 'completed',
      receiptRef: '/tmp/run-retry-receipt.json'
    });

    await expect(applyRunState(task, 'running', 'run-retry'))
      .rejects.toThrow('cannot move from completed to running');
    await expect(updateBoardTask(task.id, {
      runId: 'run-retry',
      runStatus: 'completed',
      receiptRef: '/tmp/replacement-receipt.json'
    })).rejects.toThrow('receipt is immutable');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await applyRunState(task, 'completed', 'run-retry', '/tmp/run-retry-receipt.json');
    expect(await events()).toHaveLength(9);
    await compatibilityCli('board', 'move', task.id.slice(0, 8), 'done');
    expect(await events()).toHaveLength(9);

    let cancelled = await createBoardTask({
      title: 'Cancel one bounded fixture run',
      lane: 'next',
      origin: 'human',
      coordinate: '/Users/ummi/hii'
    });
    cancelled = await applyRunState(cancelled, 'waiting_approval', 'run-cancel');
    cancelled = await applyRunState(cancelled, 'queued', 'run-cancel');
    cancelled = await applyRunState(cancelled, 'cancelled', 'run-cancel');
    expect(cancelled.lane).toBe('blocked');
    await applyRunState(cancelled, 'cancelled', 'run-cancel');

    const ledger = await events();
    expect(ledger).toHaveLength(13);
    expect(
      ledger.filter((event) => event.id === task.id).map((event) => event.patch?.runStatus)
    ).toEqual([
      'waiting_approval',
      'queued',
      'running',
      'failed',
      'waiting_approval',
      'queued',
      'running',
      'completed'
    ]);
    expect(ledger.filter((event) => event.id === cancelled.id).at(-1)?.patch.runStatus)
      .toBe('cancelled');
    expect(await listBoardTasks()).toHaveLength(1);
    expect(await listBoardTasks({ includeDone: true })).toHaveLength(2);
  });
});
