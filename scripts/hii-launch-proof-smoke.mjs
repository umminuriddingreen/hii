import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const runtime = await mkdtemp(path.join(os.tmpdir(), 'hii-launch-proof-smoke-'));
process.env.HII_RUNTIME_DIR = runtime;

try {
  const {
    buildLaunchProofWorkspace,
    launchProofGoal,
    launchProofWorkspaceId,
    launchStoryboardPath
  } = await import('../lib/workspace/launch-proof.ts');
  const {
    createWorkspace,
    listWorkspaces,
    readWorkspace,
    writeWorkspace
  } = await import('../lib/server/workspace-store.ts');

  await createWorkspace('governed-run-demo', true);
  const run = {
    job: {
      id: 'launch-proof-run',
      status: 'completed',
      logs: ['bounded run completed'],
      ledger: [{ type: 'approval', summary: 'Approved 3 canvas context objects.' }],
      proofArtifacts: [{ kind: 'receipt', path: '/tmp/launch-proof-receipt.json', label: 'receipt' }],
      metadata: {
        model: 'qwen3.6:35b-mlx',
        maxSteps: 8,
        context: [
          { id: 'source-image' },
          { id: 'source-brief' },
          { id: 'source-boundary' }
        ]
      },
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:41.916Z'
    },
    path: '/tmp/launch-proof-receipt.json',
    receipt: {
      summary: 'Created and verified the four-beat launch storyboard.',
      artifacts: [launchStoryboardPath],
      verification: [{ command: 'verify four launch beats', ok: true }]
    }
  };
  const document = buildLaunchProofWorkspace(run, { workspaceRoot: '/Users/ummi/hii' });

  assert.equal(document.nodes.length, 7);
  assert.deepEqual(document.nodes.map((node) => node.object?.kind), [
    'source',
    'source',
    'source',
    'intent',
    'run',
    'artifact',
    'receipt'
  ]);
  assert.deepEqual(document.nodes.slice(0, 3).map((node) => node.id), [
    'source-image',
    'source-brief',
    'source-boundary'
  ]);
  assert.equal(new Set(document.nodes.map((node) => node.id)).size, 7);
  assert.equal(
    document.nodes.find((node) => node.object?.kind === 'artifact')?.payload.artifactPath,
    launchStoryboardPath
  );
  assert.match(launchProofGoal, /Do not repeat either action/);

  await createWorkspace(launchProofWorkspaceId, false);
  await writeWorkspace(document, 0, launchProofWorkspaceId);
  const listed = await listWorkspaces();
  const persisted = await readWorkspace(launchProofWorkspaceId);

  assert.equal(listed.selectedWorkspaceId, 'governed-run-demo');
  assert.equal(persisted.nodes.length, 7);
  await assert.rejects(
    () => createWorkspace(launchProofWorkspaceId, false),
    /already exists/
  );

  console.log('HII launch proof smoke');
  console.log('status:       ok');
  console.log('workspace:    seven receipt-linked semantic objects persisted');
  console.log('selection:    current operator workspace remains selected');
  console.log('safety:       existing launch workspace cannot be replaced');
} finally {
  await rm(runtime, { recursive: true, force: true });
}
