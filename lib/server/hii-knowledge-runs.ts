import { appendFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendCapabilityJob, listCapabilityJobs } from '../capabilities/local-store.ts';
import type { CapabilityJob, CapabilityJobStatus } from '../capabilities/types.ts';
import { createContextProject } from './hii-context-dock.ts';
import {
  createKnowledgeObject,
  createKnowledgeRelation,
  ensureSystemMap,
  knowledgeSystemSnapshot,
  updateKnowledgeObject
} from './hii-knowledge-systems.ts';

const capabilityId = 'hii.agent.workspace_run';
const supportedModels = new Set(['qwen3.6:27b-mlx', 'qwen3.6:35b-mlx']);

function runtimeRoot() {
  return process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
}

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
      model: 'qwen3.6:27b-mlx',
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

async function initializeIntentCursor(intentsPath: string, cursorPath: string) {
  try {
    await stat(cursorPath);
  } catch {
    let processed = 0;
    try {
      processed = (await readFile(intentsPath, 'utf8')).split('\n').filter(Boolean).length;
    } catch { /* first intent */ }
    await writeFile(cursorPath, `${JSON.stringify({ processed })}\n`, { flag: 'wx' }).catch(() => undefined);
  }
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
  const requestedRoot = clean(input.workspaceRoot, 1000);
  const resolvedRoot = await realpath(requestedRoot).catch(() => '');
  if (!resolvedRoot) throw new Error('The selected workspace root does not exist.');
  if ([path.parse(resolvedRoot).root, os.homedir()].includes(resolvedRoot)) {
    throw new Error('Choose a specific project folder, not a filesystem or home-directory root.');
  }
  const project = createContextProject({ name: `${run.projectId} execution`, rootPath: resolvedRoot, approved: true });
  if (project.excluded || !project.approvedRoot) throw new Error('The selected workspace root is not approved.');
  const model = supportedModels.has(String(input.model)) ? String(input.model) : 'qwen3.6:27b-mlx';
  const maxSteps = Math.max(1, Math.min(24, Math.round(Number(input.maxSteps) || 8)));
  const now = new Date().toISOString();
  const intent = {
    kind: 'workspace.run',
    id: run.id,
    capabilityId,
    goal,
    workspaceRoot: project.rootPath,
    model,
    maxSteps,
    requestedAt: now,
    requestedBy: 'hii.knowledge',
    projectId: run.projectId
  };
  const daemonDir = path.join(runtimeRoot(), 'daemon');
  const intentsPath = path.join(daemonDir, 'intents.jsonl');
  const cursorPath = path.join(daemonDir, 'intents.cursor.json');
  await mkdir(daemonDir, { recursive: true });
  await initializeIntentCursor(intentsPath, cursorPath);

  const job: CapabilityJob = {
    id: run.id,
    capabilityId,
    inputSummary: goal.slice(0, 240),
    userId: 'local',
    userEmail: null,
    status: 'queued',
    budget: `local · ${maxSteps} steps`,
    logs: [`[${now}] operator approved bounded workspace run`],
    ledger: [{
      id: randomUUID(), jobId: run.id, capabilityId, actor: 'operator', type: 'approval',
      summary: `Approved local execution inside ${project.rootPath} with a ${maxSteps}-step limit.`, createdAt: now
    }],
    proofArtifacts: [],
    createdAt: now,
    updatedAt: now,
    metadata: { knowledgeRunId: run.id, projectId: run.projectId, workspaceRoot: project.rootPath, model, maxSteps }
  };
  await appendCapabilityJob(job);
  await appendFile(intentsPath, `${JSON.stringify(intent)}\n`, 'utf8');
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
