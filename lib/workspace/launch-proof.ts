import path from 'node:path';
import { makeNode, seedFor } from './ingest.ts';
import { workspaceRunProgress, type RunJobLike, type RunReceiptLike } from './run-progress.ts';
import { emptyWorkspace, type SpatialObjectMetadata, type SpatialObjectStatus } from './types.ts';
import { fitWorkspaceViewport } from './viewport.ts';

export const launchProofWorkspaceId = 'launch-proof';
export const launchStoryboardPath = 'docs/launch/launch-storyboard.md';
export const launchStoryboardContent = `# HII X Demo Storyboard

## Beat 1
Time: 0–8s
Screen: Select three real source objects in a clean HII workspace.
Caption: You pick the context.

## Beat 2
Time: 8–21s
Screen: Show the capability, step budget, workspace boundary, external boundary, and installed model before approval.
Caption: You see the boundary first.

## Beat 3
Time: 21–39s
Screen: Approve the bounded run and show the five-step lifecycle with the stop control visible.
Caption: Bounded work. Visible state.

## Beat 4
Time: 39–45s
Screen: Open and edit the Markdown artifact beside its receipt, with raw logs closed.
Caption: Edit the result. Inspect receipt.
`;
const launchStoryboardVerification = `node -e "const fs=require('fs');const p='${launchStoryboardPath}';const s=fs.readFileSync(p,'utf8');const beats=s.match(/^## Beat [1-4]$/gm)||[];if(beats.length!==4)process.exit(1);console.log('4 launch beats verified')"`;
const launchStoryboardWriteAction = JSON.stringify({
  type: 'write',
  path: launchStoryboardPath,
  content: launchStoryboardContent
});
const launchStoryboardVerifyAction = JSON.stringify({
  type: 'verify',
  command: launchStoryboardVerification
});
export const launchProofGoal = [
  'Execute this bounded task without analysis or rewriting.',
  `Action 1 is exactly: ${launchStoryboardWriteAction}`,
  `After Action 1 succeeds, Action 2 is exactly: ${launchStoryboardVerifyAction}`,
  'Do not emit read, list, search, shell, http, edit, commit, push, publish, message, spend, or network actions.',
  'Do not repeat either action. After Action 2 passes, finish with a receipt summary.'
].join(' ');

type CompletedLaunchRun = {
  job: RunJobLike & {
    id: string;
    metadata?: Record<string, unknown>;
  };
  path: string;
  receipt: RunReceiptLike & {
    artifacts?: string[];
  };
};

function governedObject(kind: 'source' | 'intent' | 'run' | 'artifact' | 'receipt', source: string, action: string, parentId?: string, runId?: string): SpatialObjectMetadata {
  const status: SpatialObjectStatus = kind === 'intent' ? 'approved' : kind === 'source' ? 'ready' : 'completed';
  return {
    kind,
    owner: kind === 'intent' || kind === 'source' ? 'human' : 'runtime',
    status,
    source,
    capabilityId: kind === 'source' ? undefined : 'hii.agent.workspace_run',
    parentId,
    runId,
    audit: [{
      ts: new Date().toISOString(),
      actor: kind === 'source' || kind === 'intent' ? 'human' as const : 'hii' as const,
      action
    }]
  };
}

export function buildLaunchProofWorkspace(run: CompletedLaunchRun, options: { workspaceRoot?: string } = {}) {
  const workspaceRoot = String(options.workspaceRoot || process.cwd());
  const receipt = run.receipt;
  const receiptPath = String(run.path || '');
  const runId = String(run.job.id);
  const approvedContext = Array.isArray(run.job.metadata?.context) ? run.job.metadata.context as Array<{ id?: unknown }> : [];
  const artifacts = Array.isArray(receipt.artifacts) ? receipt.artifacts.map(String) : [];
  const artifactPath = artifacts.find((item) => item.endsWith(launchStoryboardPath));
  if (!artifactPath) throw new Error(`The verified receipt did not name ${launchStoryboardPath}.`);

  let z = 0;
  let imageNode = makeNode({
    type: 'image',
    w: 380,
    h: 300,
    object: governedObject(
      'source',
      path.join(workspaceRoot, 'public/marketing/hii-workspace-live.png'),
      'added verified HII workspace reference'
    ),
    payload: {
      title: 'HII workspace reference',
      name: 'hii-workspace-live.png',
      path: path.join(workspaceRoot, 'public/marketing/hii-workspace-live.png'),
      url: '/marketing/hii-workspace-live.png',
      mime: 'image/png',
      local: true
    }
  }, 0, 0, ++z);
  if (approvedContext[0]?.id) imageNode = { ...imageNode, id: String(approvedContext[0].id) };
  let briefNode = makeNode({
    type: 'note',
    w: 400,
    h: 220,
    object: governedObject(
      'source',
      path.join(workspaceRoot, 'docs/launch/hii-x-launch-kit-opus5.md'),
      'added approved launch brief'
    ),
    payload: {
      title: 'Launch brief',
      content: 'Create a four-beat, silent-legible X demo: context, boundary, editable artifact, receipt.',
      path: path.join(workspaceRoot, 'docs/launch/hii-x-launch-kit-opus5.md')
    }
  }, 420, 0, ++z);
  if (approvedContext[1]?.id) briefNode = { ...briefNode, id: String(approvedContext[1].id) };
  let boundaryNode = makeNode({
    type: 'note',
    w: 400,
    h: 220,
    object: governedObject(
      'source',
      path.join(workspaceRoot, 'docs/marketing/2026-07-30-hii-agentic-environment-audit.md'),
      'added approved launch claim boundary'
    ),
    payload: {
      title: 'Claim boundary',
      content: 'No autonomy, infinite-loop, total-privacy, zero-setup, correctness, novelty, or guaranteed-virality claims.',
      path: path.join(workspaceRoot, 'docs/marketing/2026-07-30-hii-agentic-environment-audit.md')
    }
  }, 420, 260, ++z);
  if (approvedContext[2]?.id) boundaryNode = { ...boundaryNode, id: String(approvedContext[2].id) };
  const context = [imageNode, briefNode, boundaryNode].map((node) => ({
    id: node.id,
    title: String(node.payload.title),
    type: node.type,
    source: String(node.object?.source || '')
  }));
  const intentSeed = seedFor('intent', {
    title: 'your intent',
    text: launchProofGoal,
    context
  });
  const intentNode = makeNode(intentSeed, 0, 340, ++z);
  const baseRunSeed = seedFor('run', {
    title: 'Create the four-beat HII X storyboard',
    prompt: launchProofGoal,
    parentId: intentNode.id,
    autoStart: false,
    status: 'completed',
    context,
    workspaceRoot,
    model: String(run.job.metadata?.model || 'qwen3.6:35b-mlx'),
    maxSteps: Number(run.job.metadata?.maxSteps || 8),
    runId,
    job: run.job,
    receipt,
    receiptPath,
    resultNodesCreated: true,
    progress: workspaceRunProgress({
      status: 'completed',
      contextCount: context.length,
      maxSteps: Number(run.job.metadata?.maxSteps || 8),
      workspaceRoot,
      job: run.job,
      receipt
    })
  });
  const runSeed = {
    ...baseRunSeed,
    object: {
      ...baseRunSeed.object,
      kind: 'run' as const,
      owner: 'runtime',
      status: 'completed' as const,
      source: 'HII spatial managed agent run',
      capabilityId: 'hii.agent.workspace_run',
      parentId: intentNode.id,
      runId
    },
    payload: {
      ...baseRunSeed.payload,
      status: 'completed'
    }
  };
  const runNode = makeNode(runSeed, 0, 510, ++z);
  const artifactNode = makeNode({
    type: 'text',
    w: 460,
    h: 340,
    object: {
      ...governedObject('artifact', artifactPath, 'materialized receipt-linked launch storyboard', runNode.id, runId),
      proofRefs: [receiptPath, artifactPath].filter(Boolean)
    },
    payload: {
      adapter: 'run-artifact',
      title: 'launch-storyboard.md',
      artifactPath,
      runId,
      receiptPath,
      summary: String(receipt.summary || 'Created the verified launch storyboard.')
    }
  }, 660, 510, ++z);
  const checks = Array.isArray(receipt.verification)
    ? receipt.verification.filter((check) => check && typeof check === 'object' && check.ok === true)
    : [];
  const receiptNode = makeNode({
    type: 'note',
    w: 430,
    h: 360,
    object: {
      ...governedObject('receipt', 'HII append-only workspace receipt', 'returned verified launch storyboard receipt', runNode.id, runId),
      proofRefs: [receiptPath].filter(Boolean)
    },
    payload: {
      title: 'Run receipt',
      summary: String(receipt.summary || 'Created the verified launch storyboard.'),
      intent: launchProofGoal,
      context,
      checks,
      artifactCount: artifacts.length,
      materializedArtifactCount: 1,
      receiptPath,
      runId,
      status: 'completed'
    }
  }, 660, 870, ++z);

  const nodes = [imageNode, briefNode, boundaryNode, intentNode, runNode, artifactNode, receiptNode];
  const doc = emptyWorkspace();
  return {
    ...doc,
    nextZ: z,
    nodes,
    viewport: fitWorkspaceViewport(nodes, { width: 1200, height: 900 }, { padding: 56, maxZoom: 0.72 }) || doc.viewport
  };
}
