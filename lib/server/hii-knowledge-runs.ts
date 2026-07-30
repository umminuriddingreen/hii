import { listCapabilityJobs } from '../capabilities/local-store.ts';
import type { CapabilityJobStatus } from '../capabilities/types.ts';
import {
  createKnowledgeObject,
  createKnowledgeRelation,
  ensureSystemMap,
  knowledgeSystemSnapshot,
  updateKnowledgeObject
} from './hii-knowledge-systems.ts';
import { defaultWorkspaceRunModel, queueApprovedWorkspaceRun } from './hii-workspace-runs.ts';

const capabilityId = 'hii.agent.workspace_run';
const supportedModels = new Set(['qwen3.6:27b-mlx', 'qwen3.6:35b-mlx']);

function clean(value: unknown, max: number) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function getObject(id: unknown, projectId?: unknown) {
  const objectId = clean(id, 120);
  return knowledgeSystemSnapshot(clean(projectId, 120) || undefined).objects.find((object) => object.id === objectId) || null;
}

export function prepareKnowledgeRun(input: { id?: unknown; projectId?: unknown; goal?: unknown }) {
  const source = getObject(input.id, input.projectId);
  if (!source || !['accepted', 'active'].includes(source.status)) {
    throw new Error('Accept the source object before preparing execution.');
  }
  if (!['task', 'decision'].includes(source.kind)) throw new Error('Only an accepted task or decision can prepare a run.');
  const goal = clean(input.goal, 4000) || `${source.title}. ${source.summary}`.trim();
  const run = createKnowledgeObject({
    projectId: source.projectId,
    kind: 'run',
    title: `Run · ${source.title}`,
    summary: `Bounded local execution proposal. Goal: ${goal}`,
    status: 'proposed',
    owner: 'aii',
    provenance: source.provenance
  });
  createKnowledgeRelation({
    projectId: source.projectId,
    fromId: run.id,
    toId: source.id,
    kind: 'depends_on',
    status: 'accepted'
  });
  ensureSystemMap(source.projectId);
  return {
    object: run,
    proposal: {
      capabilityId,
      goal,
      workspaceRoot: '/Users/ummi/hii',
      model: defaultWorkspaceRunModel,
      maxSteps: 8,
      permissions: [
        'selected workspace only',
        'local-only Ollama',
        'no secrets, destructive actions, network publication, spending, or messaging'
      ],
      proofRequired: 'At least one successful verification record and a local receipt.',
      requiresApproval: true
    }
  };
}

export async function approveKnowledgeRun(input: {
  runId?: unknown;
  goal?: unknown;
  workspaceRoot?: unknown;
  model?: unknown;
  maxSteps?: unknown;
  approved?: unknown;
}) {
  if (input.approved !== true) throw new Error('Explicit approval is required before a run can be queued.');
  const run = getObject(input.runId);
  if (!run || run.kind !== 'run' || run.status !== 'proposed') throw new Error('Only a proposed run can be approved.');
  const goal = clean(input.goal, 4000);
  if (goal.length < 8) throw new Error('Describe the bounded goal in at least 8 characters.');
  const { job } = await queueApprovedWorkspaceRun({
    id: run.id,
    projectId: run.projectId,
    goal,
    workspaceRoot: input.workspaceRoot,
    model: supportedModels.has(String(input.model)) ? input.model : defaultWorkspaceRunModel,
    maxSteps: input.maxSteps,
    approved: true,
    requestedBy: 'hii.knowledge'
  });
  const object = updateKnowledgeObject(run.id, { status: 'active', externalRef: `capability-job:${job.id}`, ifRevision: run.revision });
  return { object, job, queued: true };
}

function knowledgeStatus(status: CapabilityJobStatus) {
  if (status === 'completed') return 'completed' as const;
  if (status === 'failed' || status === 'cancelled') return 'blocked' as const;
  return 'active' as const;
}

export async function syncKnowledgeRun(input: { runId?: unknown }) {
  const run = getObject(input.runId);
  if (!run || run.kind !== 'run') throw new Error('Knowledge run not found.');
  const job = (await listCapabilityJobs({ limit: 250 })).find((candidate) => candidate.id === run.id);
  if (!job) throw new Error('Capability job not found yet.');
  let updatedRun = run;
  const nextStatus = knowledgeStatus(job.status);
  if (run.status !== nextStatus || run.externalRef !== `capability-job:${job.id}`) {
    updatedRun = updateKnowledgeObject(run.id, {
      status: nextStatus,
      externalRef: `capability-job:${job.id}`,
      ifRevision: run.revision
    });
  }
  const created = [];
  if (['completed', 'failed', 'cancelled'].includes(job.status)) {
    const snapshot = knowledgeSystemSnapshot(run.projectId);
    for (const artifact of job.proofArtifacts) {
      const externalRef = artifact.kind === 'receipt'
        ? `capability-receipt:${job.id}`
        : `capability-proof:${job.id}:${artifact.id}`;
      let proof = snapshot.objects.find((object) => object.externalRef === externalRef);
      if (!proof) {
        proof = createKnowledgeObject({
          projectId: run.projectId,
          kind: artifact.kind === 'receipt' ? 'receipt' : 'proof',
          title: artifact.label,
          summary: artifact.summary || artifact.path || artifact.href || 'Capability proof artifact.',
          status: job.status === 'completed' ? 'accepted' : 'blocked',
          owner: 'aii',
          externalRef
        });
        createKnowledgeRelation({ projectId: run.projectId, fromId: run.id, toId: proof.id, kind: 'produces', status: 'accepted' });
        created.push(proof);
      }
    }
    const receiptRef = `capability-receipt:${job.id}`;
    if (!knowledgeSystemSnapshot(run.projectId).objects.some((object) => object.externalRef === receiptRef)) {
      const receipt = createKnowledgeObject({
        projectId: run.projectId,
        kind: 'receipt',
        title: `${job.status === 'completed' ? 'Completed' : 'Stopped'} · ${run.title}`,
        summary: job.logs.at(-1) || `${capabilityId} ${job.status}.`,
        status: job.status === 'completed' ? 'accepted' : 'blocked',
        owner: 'aii',
        externalRef: receiptRef
      });
      createKnowledgeRelation({ projectId: run.projectId, fromId: receipt.id, toId: run.id, kind: 'derived_from', status: 'accepted' });
      created.push(receipt);
    }
    ensureSystemMap(run.projectId);
  }
  return { object: updatedRun, job, created };
}
