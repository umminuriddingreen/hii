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
const artifacts = await import('../lib/server/hii-workspace-artifacts.ts');
const jobs = await import('../lib/capabilities/local-store.ts');
const progress = await import('../lib/workspace/run-progress.ts');

try {
  const referencePath = path.join(workspaceRoot, 'reference.png');
  fs.writeFileSync(referencePath, 'reference image fixture\n');
  const selectedContext = [{
    id: 'source-1',
    title: 'Reference image',
    type: 'image',
    source: referencePath,
    excerpt: 'Use the selected reference as the visual constraint.',
    objectKind: 'source',
    owner: 'human',
    authority: 'hii-runtime'
  }];
  const contextPreview = await runs.previewWorkspaceRunContext({
    runId: 'spatial-demo',
    workspaceRoot,
    context: selectedContext
  });
  assert.equal(contextPreview.blocked, false);
  assert.equal(contextPreview.summary.workspaceFiles, 1);
  assert.equal(contextPreview.items[0].access, 'workspace-file');
  assert.match(contextPreview.items[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(contextPreview.network.required, false);

  await assert.rejects(
    () => runs.queueApprovedWorkspaceRun({
      id: 'spatial-demo',
      goal: 'Create and verify one local artifact.',
      workspaceRoot,
      context: selectedContext
    }),
    /Explicit approval/
  );

  const emptyPreview = await runs.previewWorkspaceRunContext({
    runId: 'missing-model-demo',
    workspaceRoot,
    context: []
  });
  await assert.rejects(
    () => runs.queueApprovedWorkspaceRun({
      id: 'missing-model-demo',
      goal: 'Prove an unavailable model cannot be queued.',
      workspaceRoot,
      model: 'not-installed:latest',
      contextFingerprint: emptyPreview.fingerprint,
      approved: true
    }),
    /not installed/
  );

  await assert.rejects(
    () => runs.queueApprovedWorkspaceRun({
      id: 'secret-context-demo',
      goal: 'Prove secret-like context cannot be queued.',
      workspaceRoot,
      model: 'qwen3.6:35b-mlx',
      context: [{ id: 'secret-1', title: 'Environment', type: 'text', source: path.join(workspaceRoot, '.env') }],
      contextFingerprint: 'reviewed-secret-context',
      approved: true
    }),
    /not executable/
  );

  const outsidePath = path.join(directory, 'outside-context.txt');
  fs.writeFileSync(outsidePath, 'outside context\n');
  const outsidePreview = await runs.previewWorkspaceRunContext({
    runId: 'outside-context-demo',
    workspaceRoot,
    context: [{ id: 'outside-1', title: 'Outside source', type: 'file', source: outsidePath }]
  });
  assert.equal(outsidePreview.blocked, true);
  assert.match(outsidePreview.blockers[0], /outside the approved workspace root/);

  const remotePreview = await runs.previewWorkspaceRunContext({
    runId: 'remote-context-demo',
    workspaceRoot,
    context: [{ id: 'remote-1', title: 'Remote brief', type: 'link', source: 'https://example.com/brief' }]
  });
  assert.equal(remotePreview.network.required, true);
  assert.match(remotePreview.network.scope, /outbound read-only web retrieval/);

  const inlinePreview = await runs.previewWorkspaceRunContext({
    runId: 'inline-context-demo',
    workspaceRoot,
    context: [{ id: 'note-1', title: 'Human note', type: 'note', excerpt: 'Keep the interface calm and inspectable.' }]
  });
  assert.equal(inlinePreview.items[0].access, 'inline-snapshot');

  const mutablePath = path.join(workspaceRoot, 'mutable.txt');
  fs.writeFileSync(mutablePath, 'before review\n');
  const mutableContext = [{ id: 'mutable-1', title: 'Mutable source', type: 'file', source: mutablePath }];
  const mutablePreview = await runs.previewWorkspaceRunContext({
    runId: 'stale-context-demo',
    workspaceRoot,
    context: mutableContext
  });
  fs.writeFileSync(mutablePath, 'changed after review\n');
  await assert.rejects(
    () => runs.queueApprovedWorkspaceRun({
      id: 'stale-context-demo',
      goal: 'Reject context changed after operator review.',
      workspaceRoot,
      model: 'qwen3.6:35b-mlx',
      context: mutableContext,
      contextFingerprint: mutablePreview.fingerprint,
      approved: true
    }),
    /changed after review/
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
    context: selectedContext,
    contextFingerprint: contextPreview.fingerprint,
    approved: true
  });
  assert.equal(queued.job.status, 'queued');
  assert.equal(queued.job.metadata.context.length, 1);
  assert.equal(queued.job.metadata.contextPreview.fingerprint, contextPreview.fingerprint);
  assert.match(queued.job.metadata.boundary.network, /remain blocked/);
  const intents = fs.readFileSync(path.join(process.env.HII_RUNTIME_DIR, 'daemon', 'intents.jsonl'), 'utf8').trim().split('\n');
  assert.equal(intents.length, 1);
  const intent = JSON.parse(intents[0]);
  assert.equal(intent.kind, 'workspace.run');
  assert.match(intent.goal, /Approved HII execution context manifest/);
  assert.match(intent.goal, /SHA-256/);

  const changedArtifact = path.join(workspaceRoot, 'proof.txt');
  const imageArtifact = path.join(workspaceRoot, 'proof.png');
  const outsideArtifact = path.join(directory, 'outside.txt');
  fs.writeFileSync(changedArtifact, 'original proof\n');
  fs.writeFileSync(imageArtifact, Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(outsideArtifact, 'outside boundary\n');
  fs.symlinkSync(outsideArtifact, path.join(workspaceRoot, 'escape.txt'));
  const receiptPath = path.join(directory, 'receipt.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify({
    id: 'verified-receipt',
    status: 'completed',
    summary: 'Created the isolated proof artifact.',
    artifacts: ['proof.txt', 'proof.png', 'escape.txt'],
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
  const progressSteps = progress.workspaceRunProgress({
    status: completed.job.status,
    contextCount: 1,
    maxSteps: 5,
    workspaceRoot,
    job: completed.job,
    receipt: completed.receipt
  });
  assert.deepEqual(progressSteps.map((step) => step.state), ['done', 'done', 'done', 'done', 'done']);
  assert.doesNotMatch(JSON.stringify(progressSteps), /isolated spatial run verified/);
  assert.match(progress.workspaceRunEvidence(completed.job, completed.receipt).logs.at(-1), /isolated spatial run verified/);

  const openedArtifact = await artifacts.readWorkspaceRunArtifact({ runId: 'spatial-demo', artifact: 'proof.txt' });
  assert.equal(openedArtifact.content, 'original proof\n');
  assert.equal(openedArtifact.editable, true);
  const openedImage = await artifacts.readWorkspaceRunArtifact({ runId: 'spatial-demo', artifact: 'proof.png' });
  assert.equal(openedImage.previewable, true);
  assert.equal(openedImage.mediaType, 'image/png');
  const imagePreview = await artifacts.readWorkspaceRunArtifactPreview({ runId: 'spatial-demo', artifact: 'proof.png' });
  assert.equal(imagePreview.mediaType, 'image/png');
  assert.deepEqual(imagePreview.body, fs.readFileSync(imageArtifact));
  const editedArtifact = await artifacts.saveWorkspaceRunArtifact({
    runId: 'spatial-demo',
    artifact: 'proof.txt',
    content: 'human edited proof\n',
    ifMatch: openedArtifact.revision
  });
  assert.equal(fs.readFileSync(changedArtifact, 'utf8'), 'human edited proof\n');
  assert.equal(editedArtifact.edit.actor, 'human');
  assert.ok(fs.existsSync(path.join(process.env.HII_RUNTIME_DIR, 'workspace', 'artifact-edits.jsonl')));
  await assert.rejects(
    () => artifacts.saveWorkspaceRunArtifact({
      runId: 'spatial-demo',
      artifact: 'proof.txt',
      content: 'stale overwrite\n',
      ifMatch: openedArtifact.revision
    }),
    /changed since it was opened/
  );
  await assert.rejects(
    () => artifacts.readWorkspaceRunArtifact({ runId: 'spatial-demo', artifact: 'escape.txt' }),
    /outside the approved workspace boundary/
  );
  await assert.rejects(
    () => artifacts.readWorkspaceRunArtifact({ runId: 'spatial-demo', artifact: 'not-in-receipt.txt' }),
    /not named in this run receipt/
  );

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
  console.log('focus:        concise lifecycle -> evidence -> raw log hierarchy verified');
console.log('artifact:     receipt-listed text + bounded image preview verified');
  console.log('edit proof:   atomic save + optimistic conflict + human receipt verified');
  console.log('boundary:     unlisted and symlink-escaped artifacts rejected');
  console.log('context:      executable manifest + snapshots + hashes + stale review rejection verified');
  console.log('network:      remote-read warning + local-only manifest verified');
  console.log('capability:   verified receipt -> idempotent review draft verified');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
