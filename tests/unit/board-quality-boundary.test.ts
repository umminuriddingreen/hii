// @vitest-environment node
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}), { virtual: true });

let runtimeDir = '';
const execFileAsync = promisify(execFile);

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

function compatibilityCli(...args: string[]) {
  return execFileAsync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'hii-cli.mjs'),
    ...args
  ], {
    cwd: process.cwd(),
    env: { ...process.env, HII_RUNTIME_DIR: runtimeDir }
  });
}

describe('HII board quality boundary', () => {
  it('holds generated active work as a reviewable backlog proposal', async () => {
    const { boardTaskView, createBoardTask } = await board();
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
    expect(boardTaskView(task).proposalQuality).toMatchObject({
      ready: false,
      issues: expect.arrayContaining([
        'Explain why this work matters and what context it uses.',
        'Add at least one concrete “done when” criterion.'
      ])
    });
  });

  it('requires an explicit approval before a proposal can enter active work', async () => {
    const { createBoardTask, updateBoardTask } = await board();
    const task = await createBoardTask({
      title: 'Prepare a source-linked campaign demo',
      lane: 'next',
      coordinate: '/Users/ummi/hii',
      source: 'hii.knowledge.system-map',
      origin: 'system',
      notes: 'Turn the approved launch sources into one inspectable campaign demo.',
      acceptanceCriteria: ['The demo opens beside its source context and has one passing receipt check.']
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

  it('requires generated proposals to define why and done-when proof before approval', async () => {
    const { createBoardTask, updateBoardTask } = await board();
    const task = await createBoardTask({
      title: 'Improve',
      lane: 'doing',
      origin: 'agent'
    });

    await expect(updateBoardTask(task.id, {
      lane: 'doing',
      reviewState: 'approved',
      approvedBy: 'local operator'
    })).rejects.toMatchObject({
      code: 'BOARD_TASK_LOW_QUALITY',
      message: expect.stringContaining('Define this proposal before approval')
    });

    const defined = await updateBoardTask(task.id, {
      title: 'Improve the launch receipt review',
      notes: 'Make the final proof legible to a maker before the task enters active work.',
      acceptanceCriteria: [
        'The receipt view names the artifact, verification result, and next action.'
      ]
    });
    expect(defined.reviewState).toBe('proposed');

    const approved = await updateBoardTask(task.id, {
      lane: 'doing',
      reviewState: 'approved',
      approvedBy: 'local operator'
    });
    expect(approved).toMatchObject({
      lane: 'doing',
      reviewState: 'approved',
      acceptanceCriteria: [
        'The receipt view names the artifact, verification result, and next action.'
      ]
    });
  });

  it('keeps the compatibility CLI behind the same proposal-definition gate', async () => {
    const { createBoardTask } = await board();
    const task = await createBoardTask({
      title: 'Prepare the maker handoff',
      lane: 'next',
      origin: 'system'
    });

    await expect(compatibilityCli('board', 'approve', task.id.slice(0, 8)))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('Define this proposal before approval')
      });

    await compatibilityCli(
      'board',
      'edit',
      task.id.slice(0, 8),
      '--notes',
      'Keep the final maker handoff bounded to the named deliverable.',
      '--check',
      'The handoff links one deliverable and its passing receipt.'
    );
    const { stdout } = await compatibilityCli('board', 'approve', task.id.slice(0, 8));
    expect(stdout).toContain('approved');
  });

  it('shows why, done-when proof, refinement, approval, and archive actions in the board UI', () => {
    const page = readFileSync(
      path.join(process.cwd(), 'src/routes/(app)/boards/+page.svelte'),
      'utf8'
    );
    expect(page).toContain('Needs definition');
    expect(page).toContain('Why / context');
    expect(page).toContain('Done when · one criterion per line');
    expect(page).toContain('Save definition');
    expect(page).toContain('disabled={!task.proposalQuality.ready}');
    expect(page).toContain('Archive');
  });

  it('does not trust a browser caller to declare agent or human provenance', () => {
    const route = readFileSync(
      path.join(process.cwd(), 'app/api/board/tasks/route.ts'),
      'utf8'
    );
    expect(route).toContain("origin: 'human'");
    expect(route).toContain("approvedBy: 'local operator'");
    expect(route).not.toContain('origin: body?.origin');
    expect(route).not.toContain('approvedBy: body?.approvedBy');
  });

  it('links only approved work to a governed run and completed receipt', async () => {
    const { createBoardTask, updateBoardTask } = await board();
    const proposal = await createBoardTask({
      title: 'Verify the client handoff',
      lane: 'next',
      origin: 'agent',
      notes: 'Verify the exact client deliverable and keep its source-linked approval boundary.',
      acceptanceCriteria: ['A completed receipt links the final deliverable and one passing check.']
    });

    await expect(
      updateBoardTask(proposal.id, {
        runId: 'run-proposed',
        runStatus: 'waiting_approval'
      })
    ).rejects.toMatchObject({ code: 'BOARD_TASK_APPROVAL_REQUIRED' });

    const approved = await updateBoardTask(proposal.id, {
      lane: 'next',
      reviewState: 'approved',
      approvedBy: 'local operator',
      runId: 'run-approved',
      runStatus: 'waiting_approval'
    });
    expect(approved).toMatchObject({
      lane: 'next',
      runId: 'run-approved',
      runStatus: 'waiting_approval'
    });

    await expect(
      updateBoardTask(proposal.id, { receiptRef: '/tmp/receipt.json' })
    ).rejects.toThrow('A receipt can only be linked to a completed board run.');

    await updateBoardTask(proposal.id, {
      lane: 'doing',
      runId: 'run-approved',
      runStatus: 'queued'
    });
    await updateBoardTask(proposal.id, {
      lane: 'doing',
      runId: 'run-approved',
      runStatus: 'running'
    });
    const completed = await updateBoardTask(proposal.id, {
      lane: 'done',
      runId: 'run-approved',
      runStatus: 'completed',
      receiptRef: '/tmp/receipt.json'
    });
    expect(completed).toMatchObject({
      lane: 'done',
      runStatus: 'completed',
      receiptRef: '/tmp/receipt.json'
    });
    expect(completed.completedAt).toEqual(expect.any(String));
  });
});
