import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { appendCapabilityJob, listCapabilityJobs } from '../capabilities/local-store.ts';
import type { CapabilityJob } from '../capabilities/types.ts';
import { createContextProject } from './hii-context-dock.ts';

const execFileAsync = promisify(execFile);
const capabilityId = 'hii.agent.workspace_run';
const supportedModels = new Set(['qwen3.6:27b-mlx', 'qwen3.6:35b-mlx']);
export const defaultWorkspaceRunModel = 'qwen3.6:35b-mlx';

export type WorkspaceRunContextItem = {
  id: string;
  title: string;
  type: string;
  source?: string;
};

function runtimeRoot() {
  return process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
}

function clean(value: unknown, max: number) {
  return String(value ?? '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanId(value: unknown) {
  return clean(value, 120).replace(/[^a-zA-Z0-9_-]/g, '');
}

function skillId(value: unknown) {
  return clean(value, 160)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function normalizeContext(value: unknown): WorkspaceRunContextItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const item = entry as Record<string, unknown>;
      const id = cleanId(item.id);
      const title = clean(item.title, 240);
      const type = clean(item.type, 80);
      if (!id || !title || !type) return null;
      const source = clean(item.source, 1000);
      return { id, title, type, ...(source ? { source } : {}) };
    })
    .filter((entry): entry is WorkspaceRunContextItem => Boolean(entry))
    .slice(0, 24);
}

async function initializeIntentCursor(intentsPath: string, cursorPath: string) {
  try {
    await stat(cursorPath);
  } catch {
    let processed = 0;
    try {
      processed = (await readFile(intentsPath, 'utf8')).split('\n').filter(Boolean).length;
    } catch {
      /* first intent */
    }
    await writeFile(cursorPath, `${JSON.stringify({ processed })}\n`, { flag: 'wx' }).catch(() => undefined);
  }
}

function executionGoal(goal: string, context: WorkspaceRunContextItem[]) {
  if (!context.length) return goal;
  return [
    goal,
    '',
    'Approved HII canvas context:',
    ...context.map((item) => `- ${item.title} (${item.type})${item.source ? ` — ${item.source}` : ''}`),
    '',
    'Use only the context above and the approved workspace root. Do not silently expand the context boundary.'
  ].join('\n');
}

export async function queueApprovedWorkspaceRun(input: {
  id?: unknown;
  projectId?: unknown;
  goal?: unknown;
  workspaceRoot?: unknown;
  model?: unknown;
  maxSteps?: unknown;
  context?: unknown;
  approved?: unknown;
  requestedBy?: unknown;
}) {
  if (input.approved !== true) throw new Error('Explicit approval is required before a run can be queued.');
  const id = cleanId(input.id) || randomUUID();
  const goal = clean(input.goal, 4000);
  if (goal.length < 8) throw new Error('Describe the bounded goal in at least 8 characters.');
  const requestedRoot = clean(input.workspaceRoot, 1000);
  const resolvedRoot = await realpath(requestedRoot).catch(() => '');
  if (!resolvedRoot) throw new Error('The selected workspace root does not exist.');
  if ([path.parse(resolvedRoot).root, os.homedir()].includes(resolvedRoot)) {
    throw new Error('Choose a specific project folder, not a filesystem or home-directory root.');
  }
  const projectId = clean(input.projectId, 120) || 'hii-spatial-workspace';
  const project = createContextProject({
    name: `${projectId} execution`,
    rootPath: resolvedRoot,
    approved: true
  });
  if (project.excluded || !project.approvedRoot) throw new Error('The selected workspace root is not approved.');

  const context = normalizeContext(input.context);
  const model = supportedModels.has(String(input.model)) ? String(input.model) : defaultWorkspaceRunModel;
  const maxSteps = Math.max(1, Math.min(24, Math.round(Number(input.maxSteps) || 8)));
  const requestedBy = clean(input.requestedBy, 120) || 'hii.workspace';
  const now = new Date().toISOString();
  const intent = {
    kind: 'workspace.run',
    id,
    capabilityId,
    goal: executionGoal(goal, context),
    workspaceRoot: project.rootPath,
    model,
    maxSteps,
    requestedAt: now,
    requestedBy,
    projectId,
    context
  };
  const daemonDir = path.join(runtimeRoot(), 'daemon');
  const intentsPath = path.join(daemonDir, 'intents.jsonl');
  const cursorPath = path.join(daemonDir, 'intents.cursor.json');
  await mkdir(daemonDir, { recursive: true });
  await initializeIntentCursor(intentsPath, cursorPath);

  const job: CapabilityJob = {
    id,
    capabilityId,
    inputSummary: goal.slice(0, 240),
    userId: 'local',
    userEmail: null,
    status: 'queued',
    budget: `local · ${maxSteps} steps`,
    logs: [`[${now}] operator approved bounded workspace run`],
    ledger: [{
      id: randomUUID(),
      jobId: id,
      capabilityId,
      actor: 'operator',
      type: 'approval',
      summary: `Approved ${context.length} canvas context object${context.length === 1 ? '' : 's'} and local execution inside ${project.rootPath}.`,
      createdAt: now
    }],
    proofArtifacts: [],
    createdAt: now,
    updatedAt: now,
    metadata: {
      projectId,
      workspaceRoot: project.rootPath,
      model,
      maxSteps,
      context,
      requestedBy,
      approvedAt: now,
      boundary: {
        read: context.length ? 'selected canvas context plus approved workspace root' : 'approved workspace root',
        write: project.rootPath,
        network: 'publishing, pushing, messaging, spending, and secret export are not authorized'
      }
    }
  };
  await appendCapabilityJob(job);
  await appendFile(intentsPath, `${JSON.stringify(intent)}\n`, 'utf8');
  return { job, intent, queued: true };
}

async function receiptForJob(job: CapabilityJob) {
  const receiptPath = job.proofArtifacts.find((artifact) => artifact.kind === 'receipt' && artifact.path)?.path;
  if (!receiptPath) return { path: null, receipt: null };
  try {
    return {
      path: receiptPath,
      receipt: JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>
    };
  } catch {
    return { path: receiptPath, receipt: null };
  }
}

export async function getWorkspaceRun(idValue: unknown) {
  const id = cleanId(idValue);
  if (!id) throw new Error('A workspace run id is required.');
  const job = (await listCapabilityJobs({ limit: 500 })).find((candidate) => candidate.id === id);
  if (!job) return null;
  return { job, ...(await receiptForJob(job)) };
}

function receiptChecks(receipt: Record<string, unknown> | null) {
  if (!receipt || !Array.isArray(receipt.verification)) return [];
  return receipt.verification
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .filter((entry) => entry.ok === true)
    .map((entry) => clean(entry.command, 500))
    .filter(Boolean);
}

export async function createWorkspaceRunCapabilityDraft(input: { id?: unknown; name?: unknown }) {
  const current = await getWorkspaceRun(input.id);
  if (!current) throw new Error('Workspace run not found.');
  if (current.job.status !== 'completed' || !current.receipt || !current.path) {
    throw new Error('Only a completed workspace run with a receipt can become a capability draft.');
  }
  const checks = receiptChecks(current.receipt);
  if (!checks.length) throw new Error('A verified receipt is required before capability drafting.');
  const existingId = clean(current.job.metadata?.skillDraftId, 120);
  const existingBundle = clean(current.job.metadata?.skillDraftBundle, 1000);
  if (existingId) return { id: existingId, bundle: existingBundle || null, reused: true, job: current.job };

  const name = clean(input.name, 160) || current.job.inputSummary;
  const id = skillId(name) || `workspace-run-${current.job.id.slice(0, 12).toLowerCase()}`;
  const script = path.join(os.homedir(), 'hii', 'scripts', 'hii-cli.mjs');
  const coordinate = clean(current.job.metadata?.workspaceRoot, 1000) || path.join(os.homedir(), 'hii');
  const result = await execFileAsync(process.execPath, [
    script,
    'skill',
    'report',
    '--agent', 'hii-spatial-workspace',
    '--agent-kind', 'managed-workspace-run',
    '--project', clean(current.job.metadata?.projectId, 120) || 'hii',
    '--coordinate', coordinate,
    '--intent', current.job.inputSummary,
    '--summary', `Completed and preserved ${name} as a reusable HII workflow.`,
    '--actions', 'Ran an explicitly approved bounded workspace capability from selected HII canvas context.',
    '--commands', checks.join(','),
    '--capabilities', capabilityId,
    '--outcome', 'completed',
    '--verification', 'verified',
    '--checks', checks.join(','),
    '--proof', current.path,
    '--risk', 'change',
    '--permissions', `workspace-local changes inside ${coordinate}`,
    '--side-effects', 'workspace-local changes and append-only HII receipts',
    '--repeatable',
    '--skill-id', id,
    '--skill-name', name,
    '--skill-description', `Repeat the verified ${name} workflow from approved HII context and return proof.`,
    '--next', 'Review the draft before registration or execution.'
  ], {
    cwd: path.join(os.homedir(), 'hii'),
    env: { ...process.env, HII_RUNTIME_DIR: runtimeRoot() },
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  const draftId = result.stdout.match(/^draft:\s+(.+)$/m)?.[1]?.trim() || id;
  const bundle = result.stdout.match(/^bundle:\s+(.+)$/m)?.[1]?.trim() || null;
  const now = new Date().toISOString();
  const job: CapabilityJob = {
    ...current.job,
    updatedAt: now,
    ledger: [
      ...current.job.ledger,
      {
        id: randomUUID(),
        jobId: current.job.id,
        capabilityId,
        actor: 'hii',
        type: 'proof',
        summary: `Created operator-review capability draft ${draftId}.`,
        createdAt: now
      }
    ],
    metadata: {
      ...current.job.metadata,
      skillDraftId: draftId,
      skillDraftBundle: bundle,
      skillDraftCreatedAt: now
    }
  };
  await appendCapabilityJob(job);
  return { id: draftId, bundle, reused: false, job };
}
