import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { requireHighTrust } from './proof-policy.ts';
import { workspaceRunCompletion } from './workspace-run-completion.ts';
import { appendCapabilityJob, listCapabilityJobs } from '../capabilities/local-store.ts';
import type { CapabilityJob } from '../capabilities/types.ts';
import { createContextProject } from './hii-context-dock.ts';
import {
  normalizeWorkspaceRunContext,
  previewWorkspaceRunContext,
  resolveWorkspaceRunRoot,
  workspaceRunExecutionGoal
} from './hii-workspace-run-context.ts';

export type { WorkspaceRunContextItem } from './hii-workspace-run-context.ts';
export { previewWorkspaceRunContext } from './hii-workspace-run-context.ts';

const execFileAsync = promisify(execFile);
const capabilityId = 'hii.agent.workspace_run';
export const defaultWorkspaceRunModel = 'qwen3.6:35b-mlx';
const preferredModels = [defaultWorkspaceRunModel, 'qwen3.6:27b-mlx'];

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

export type WorkspaceRunModels = {
  models: string[];
  defaultModel: string | null;
  available: boolean;
  source: 'environment' | 'ollama' | 'unavailable';
  message: string;
};

function normalizeModelNames(value: unknown) {
  const names = Array.isArray(value)
    ? value
    : String(value ?? '').split(',');
  return Array.from(new Set(names
    .map((entry) => clean(typeof entry === 'object' && entry ? (entry as { name?: unknown }).name : entry, 160))
    .filter(Boolean)));
}

export async function discoverWorkspaceRunModels(): Promise<WorkspaceRunModels> {
  const configured = normalizeModelNames(process.env.HII_WORKSPACE_RUN_MODELS);
  if (configured.length) {
    const defaultModel = preferredModels.find((model) => configured.includes(model)) || configured[0];
    return {
      models: configured,
      defaultModel,
      available: true,
      source: 'environment',
      message: `${configured.length} configured local model${configured.length === 1 ? '' : 's'} available.`
    };
  }

  // One catalog, shared with Voice, Create and the CLI-facing APIs. Asking
  // Ollama directly here is what made each surface know a different subset.
  const { readModelCatalog, routeModel } = await import('./model-catalog.ts');
  const catalog = await readModelCatalog();
  // A bounded workspace run sends reviewed local context, so external providers
  // are not eligible without an explicit widening.
  const routed = routeModel(catalog, { privacy: 'local', outputModalities: ['text'] });
  const models = normalizeModelNames(
    routed.eligible.filter((model) => model.provider === 'ollama' || model.provider === 'lm-studio').map((model) => model.id)
  );
  const defaultModel = preferredModels.find((model) => models.includes(model)) || models[0] || null;
  const ollama = catalog.providers.find((provider) => provider.provider === 'ollama');
  return {
    models,
    defaultModel,
    available: models.length > 0,
    source: models.length ? 'ollama' : 'unavailable',
    message: models.length
      ? `${models.length} installed local model${models.length === 1 ? '' : 's'} available.`
      : ollama?.reachable
        ? 'Ollama is reachable, but no local models are installed.'
        : 'No local model runtime is available. Start Ollama or install a model before approval.'
  };
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

export async function queueApprovedWorkspaceRun(input: {
  id?: unknown;
  projectId?: unknown;
  goal?: unknown;
  workspaceRoot?: unknown;
  model?: unknown;
  maxSteps?: unknown;
  context?: unknown;
  contextFingerprint?: unknown;
  approved?: unknown;
  requestedBy?: unknown;
}) {
  if (input.approved !== true) throw new Error('Explicit approval is required before a run can be queued.');
  const id = cleanId(input.id) || randomUUID();
  const goal = clean(input.goal, 4000);
  if (goal.length < 8) throw new Error('Describe the bounded goal in at least 8 characters.');
  const resolvedRoot = await resolveWorkspaceRunRoot(input.workspaceRoot);
  const projectId = clean(input.projectId, 120) || 'hii-spatial-workspace';
  const project = createContextProject({
    name: `${projectId} execution`,
    rootPath: resolvedRoot,
    approved: true
  });
  if (project.excluded || !project.approvedRoot) throw new Error('The selected workspace root is not approved.');

  const context = normalizeWorkspaceRunContext(input.context);
  const contextPreview = await previewWorkspaceRunContext({
    runId: id,
    workspaceRoot: resolvedRoot,
    context
  });
  if (contextPreview.blocked) {
    throw new Error(`The selected context is not executable. ${contextPreview.blockers.join(' ')}`);
  }
  const approvedFingerprint = clean(input.contextFingerprint, 80);
  if (!approvedFingerprint) {
    throw new Error('Refresh and review the execution context manifest before approval.');
  }
  if (approvedFingerprint !== contextPreview.fingerprint) {
    throw new Error('The selected context changed after review. Refresh the execution context manifest before approval.');
  }
  const discovered = await discoverWorkspaceRunModels();
  if (!discovered.available || !discovered.defaultModel) throw new Error(discovered.message);
  const requestedModel = clean(input.model, 160);
  const model = requestedModel || discovered.defaultModel;
  if (!discovered.models.includes(model)) {
    throw new Error(`Local model "${model}" is not installed. Refresh the model list and choose an available model.`);
  }
  const maxSteps = Math.max(1, Math.min(24, Math.round(Number(input.maxSteps) || 8)));
  const requestedBy = clean(input.requestedBy, 120) || 'hii.workspace';
  const now = new Date().toISOString();
  const intent = {
    kind: 'workspace.run',
    id,
    capabilityId,
    goal: workspaceRunExecutionGoal(goal, contextPreview),
    workspaceRoot: project.rootPath,
    model,
    maxSteps,
    requestedAt: now,
    requestedBy,
    projectId,
    context,
    contextPreview,
    contextStaging: {
      required: contextPreview.summary.stagedLocalAssets > 0,
      policy: contextPreview.summary.stagedLocalAssets
        ? 'AII reverifies each selected managed asset, makes a read-only per-run copy inside the approved root, and removes only that disposable copy after terminal state.'
        : 'No per-run local asset staging is required.'
    }
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
      goal: intent.goal,
      model,
      maxSteps,
      context,
      contextPreview,
      contextStaging: intent.contextStaging,
      requestedBy,
      approvedAt: now,
      boundary: {
        read: context.length ? 'selected canvas context plus approved workspace root' : 'approved workspace root',
        write: project.rootPath,
        network: contextPreview.network.scope
      }
    }
  };
  await appendCapabilityJob(job);
  await appendFile(intentsPath, `${JSON.stringify(intent)}\n`, 'utf8');
  return { job, intent, queued: true };
}

export async function requestWorkspaceRunCancellation(input: { id?: unknown; requestedBy?: unknown }) {
  const id = cleanId(input.id);
  if (!id) throw new Error('A workspace run id is required.');
  const current = await getWorkspaceRun(id);
  if (!current) throw new Error('Workspace run not found.');
  if (['completed', 'failed', 'cancelled'].includes(current.job.status)) {
    return { job: current.job, queued: false, terminal: true };
  }
  if (!['queued', 'running'].includes(current.job.status)) {
    throw new Error(`Workspace run ${id} cannot be cancelled from ${current.job.status}.`);
  }
  if (current.job.metadata?.cancelRequestedAt) {
    return { job: current.job, queued: false, terminal: false };
  }

  const now = new Date().toISOString();
  const requestedBy = clean(input.requestedBy, 120) || 'hii.workspace';
  const job: CapabilityJob = {
    ...current.job,
    updatedAt: now,
    logs: [...current.job.logs, `[${now}] operator requested cancellation`].slice(-40),
    ledger: [
      ...current.job.ledger,
      {
        id: randomUUID(),
        jobId: id,
        capabilityId,
        actor: 'operator',
        type: 'reconciliation',
        summary: 'Requested that AII stop the bounded local workspace run.',
        createdAt: now
      }
    ],
    metadata: {
      ...current.job.metadata,
      cancelRequestedAt: now,
      cancelRequestedBy: requestedBy
    }
  };
  const daemonDir = path.join(runtimeRoot(), 'daemon');
  const intentsPath = path.join(daemonDir, 'intents.jsonl');
  const cursorPath = path.join(daemonDir, 'intents.cursor.json');
  await mkdir(daemonDir, { recursive: true });
  await initializeIntentCursor(intentsPath, cursorPath);
  await appendCapabilityJob(job);
  await appendFile(intentsPath, `${JSON.stringify({
    kind: 'workspace.cancel',
    id,
    requestedAt: now,
    requestedBy
  })}\n`, 'utf8');
  return { job, queued: true, terminal: false };
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
  const resolved = await receiptForJob(job);
  return { job, ...resolved, completion: workspaceRunCompletion(resolved.receipt) };
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
  // A draft is a claim that this run is worth repeating, and it writes a skill
  // marked `--verification verified`. That is high-trust: it needs declared,
  // satisfied proof, not just a receipt on disk and a passing command.
  requireHighTrust(current.completion, 'capability-draft');
  const checks = receiptChecks(current.receipt);
  if (!checks.length) throw new Error('A verified receipt is required before capability drafting.');
  const existingId = clean(current.job.metadata?.skillDraftId, 120);
  const existingBundle = clean(current.job.metadata?.skillDraftBundle, 1000);
  if (existingId) return { id: existingId, bundle: existingBundle || null, reused: true, job: current.job };

  const name = clean(input.name, 160) || current.job.inputSummary;
  const id = skillId(name) || `workspace-run-${current.job.id.slice(0, 12).toLowerCase()}`;
  const hiiRoot = process.env.HII_ROOT ? path.resolve(process.env.HII_ROOT) : path.resolve(process.cwd());
  const script = path.join(hiiRoot, 'scripts', 'hii-cli.mjs');
  const coordinate = clean(current.job.metadata?.workspaceRoot, 1000) || hiiRoot;
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
