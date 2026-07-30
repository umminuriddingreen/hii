#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-spatial-run-'));
const workspaceRoot = path.join(directory, 'project');
fs.mkdirSync(workspaceRoot, { recursive: true });
process.env.HII_DB_PATH = path.join(directory, 'hii.db');
process.env.HII_RUNTIME_DIR = path.join(directory, 'runtime');
process.env.HII_WORKSPACE_RUN_MODELS = 'qwen3.6:35b-mlx,qwen3.6:27b-mlx';

const runs = await import('../lib/server/hii-workspace-runs.ts');
const jobs = await import('../lib/capabilities/local-store.ts');

try {
  await assert.rejects(
    () => runs.queueApprovedWorkspaceRun({
      id: 'spatial-demo',
      goal: 'Create and verify one local artifact.',
      workspaceRoot,
      context: [{ id: 'source-1', title: 'Reference image', type: 'image', source: '/tmp/reference.png' }]
    }),
    /Explicit approval/
  );

  await assert.rejects(
    () => runs.queueApprovedWorkspaceRun({
      id: 'missing-model-demo',
      goal: 'Prove an unavailable model cannot be queued.',
      workspaceRoot,
      model: 'not-installed:latest',
      approved: true
    }),
    /not installed/
  );

  const discovered = await runs.discoverWorkspaceRunModels();
  assert.deepEqual(discovered.models, ['qwen3.6:35b-mlx', 'qwen3.6:27b-mlx']);
  assert.equal(discovered.defaultModel, 'qwen3.6:35b-mlx');

  const queued = await runs.queueApprovedWorkspaceRun({
    id: 'spatial-demo',
    projectId: 'spatial-smoke',
    goal: 'Create and verify one local artifact.',
    workspaceRoot,
    model: 'qwen3.6:27b-mlx',
    maxSteps: 5,
    context: [{ id: 'source-1', title: 'Reference image', type: 'image', source: '/tmp/reference.png' }],
    approved: true
  });
  assert.equal(queued.job.status, 'queued');
  assert.equal(queued.job.metadata.context.length, 1);
  assert.match(queued.job.metadata.boundary.network, /not authorized/);
  const intents = fs.readFileSync(path.join(process.env.HII_RUNTIME_DIR, 'daemon', 'intents.jsonl'), 'utf8').trim().split('\n');
  assert.equal(intents.length, 1);
  const intent = JSON.parse(intents[0]);
  assert.equal(intent.kind, 'workspace.run');
  assert.match(intent.goal, /Approved HII canvas context/);

  const receiptPath = path.join(directory, 'receipt.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify({
    id: 'verified-receipt',
    status: 'completed',
    summary: 'Created the isolated proof artifact.',
    artifacts: ['proof.txt'],
    verification: [{ command: 'test -f proof.txt', ok: true, output: 'passed' }]
  }, null, 2)}\n`);
  const completedAt = new Date().toISOString();
  await jobs.appendCapabilityJob({
    ...queued.job,
    status: 'completed',
    updatedAt: completedAt,
    logs: [...queued.job.logs, `[${completedAt}] isolated spatial run verified`],
    proofArtifacts: [{
      id: 'receipt-proof',
      kind: 'receipt',
      label: 'Verified spatial receipt',
      path: receiptPath,
      summary: 'Created the isolated proof artifact.',
      createdAt: completedAt
    }]
  });

  const completed = await runs.getWorkspaceRun('spatial-demo');
  assert.equal(completed.job.status, 'completed');
  assert.equal(completed.receipt.summary, 'Created the isolated proof artifact.');

  const draft = await runs.createWorkspaceRunCapabilityDraft({
    id: 'spatial-demo',
    name: 'Create isolated proof artifact'
  });
  assert.equal(draft.id, 'create-isolated-proof-artifact');
  assert.ok(fs.existsSync(path.join(process.env.HII_RUNTIME_DIR, 'skills', 'proposed', draft.id, 'SKILL.md')));
  const secondDraft = await runs.createWorkspaceRunCapabilityDraft({
    id: 'spatial-demo',
    name: 'Create isolated proof artifact'
  });
  assert.equal(secondDraft.reused, true);

  console.log('HII spatial governed run smoke');
  console.log('status:       ok');
  console.log('approval:     explicit local boundary verified');
  console.log('models:       installed-only discovery and rejection verified');
  console.log('handoff:      selected canvas context -> AII workspace.run verified');
  console.log('receipt:      completed job -> structured receipt verified');
  console.log('capability:   verified receipt -> idempotent review draft verified');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
