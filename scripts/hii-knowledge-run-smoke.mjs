#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTestTreeSync } from './lib/test-temp.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-knowledge-run-'));
process.env.HII_DB_PATH = path.join(directory, 'hii.db');
process.env.HII_RUNTIME_DIR = path.join(directory, 'runtime');
process.env.HII_WORKSPACE_RUN_MODELS = 'qwen3.6:35b-mlx';

const systems = await import('../lib/server/hii-knowledge-systems.ts');
const runs = await import('../lib/server/hii-knowledge-runs.ts');
const jobs = await import('../lib/capabilities/local-store.ts');

try {
  const task = systems.createKnowledgeObject({
    projectId: 'HII',
    kind: 'task',
    title: 'Prove the knowledge execution loop',
    summary: 'Create a bounded local run and return verified proof.',
    status: 'active',
    owner: 'main agent'
  });
  const prepared = runs.prepareKnowledgeRun({ id: task.id, projectId: 'HII' });
  assert.equal(prepared.object.status, 'proposed');
  assert.equal(prepared.proposal.requiresApproval, true);
  assert.equal(fs.existsSync(path.join(process.env.HII_RUNTIME_DIR, 'daemon', 'intents.jsonl')), false);

  await assert.rejects(
    () => runs.approveKnowledgeRun({ runId: prepared.object.id, goal: prepared.proposal.goal, workspaceRoot: directory }),
    /Explicit approval/
  );
  const approved = await runs.approveKnowledgeRun({
    runId: prepared.object.id,
    goal: prepared.proposal.goal,
    workspaceRoot: directory,
    model: prepared.proposal.model,
    maxSteps: 5,
    approved: true
  });
  assert.equal(approved.job.status, 'queued');
  assert.equal(approved.object.status, 'active');
  const intents = fs.readFileSync(path.join(process.env.HII_RUNTIME_DIR, 'daemon', 'intents.jsonl'), 'utf8').trim().split('\n');
  assert.equal(intents.length, 1);
  assert.equal(JSON.parse(intents[0]).kind, 'workspace.run');

  const finishedAt = new Date().toISOString();
  await jobs.appendCapabilityJob({
    ...approved.job,
    status: 'completed',
    updatedAt: finishedAt,
    logs: [...approved.job.logs, `[${finishedAt}] isolated run verified`],
    proofArtifacts: [{
      id: 'proof-1',
      kind: 'receipt',
      label: 'Isolated run receipt',
      path: path.join(directory, 'receipt.json'),
      summary: 'The isolated bounded run passed its verification.',
      createdAt: finishedAt
    }]
  });
  const synced = await runs.syncKnowledgeRun({ runId: prepared.object.id });
  assert.equal(synced.object.status, 'completed');
  assert.equal(synced.created.filter((object) => object.kind === 'receipt').length, 1);
  const snapshot = systems.knowledgeSystemSnapshot('HII');
  assert.ok(snapshot.relations.some((relation) => relation.fromId === prepared.object.id && relation.kind === 'produces'));
  assert.ok(snapshot.objects.some((object) => object.externalRef === `capability-receipt:${prepared.object.id}`));
  const secondSync = await runs.syncKnowledgeRun({ runId: prepared.object.id });
  assert.equal(secondSync.created.length, 0);

  console.log('HII knowledge run smoke');
  console.log('status:      ok');
  console.log('approval:    explicit preview gate verified');
  console.log('handoff:     HII workspace.run intent verified');
  console.log('lineage:     task -> run -> proof + receipt verified');
  console.log('idempotency: repeat sync creates no duplicate objects');
} finally {
  removeTestTreeSync(directory);
}
