import 'server-only';
import { appendFile, mkdir, readFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { appendCapabilityJob, listCapabilityJobs } from '@/lib/capabilities/local-store';
import type { CapabilityJob } from '@/lib/capabilities/types';

export type TermiteJob = CapabilityJob & {
  workflow: string;
  prompt: string;
};

type CreateJobInput = {
  userId: string;
  email: string | null;
  workflow: string;
  prompt: string;
  budget: string;
};

const storeDir = path.join(process.cwd(), '.hii');
const storePath = path.join(storeDir, 'termite-jobs.jsonl');
const capabilityId = 'termite.rhino.managed_job';

export async function createTermiteJob(input: CreateJobInput): Promise<TermiteJob> {
  await mkdir(storeDir, { recursive: true });
  const now = new Date().toISOString();
  const job: TermiteJob = {
    id: randomUUID(),
    capabilityId,
    inputSummary: `${input.workflow}: ${input.prompt.slice(0, 240)}`,
    userId: input.userId,
    userEmail: input.email,
    workflow: input.workflow,
    prompt: input.prompt,
    budget: input.budget,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    logs: [
      `[${now}] job queued`,
      'HII accepted the managed Termite request.',
      'Operator next step: open Rhino 8, run StartTermiteBridge, run Termite doctor, then execute the workflow manually through Codex/Termite.',
      'No client-side Rhino or Codex install is required for this managed alpha.'
    ],
    ledger: [
      {
        id: randomUUID(),
        jobId: '',
        capabilityId,
        actor: 'hii',
        type: 'approval',
        summary: `Accepted ${input.budget} managed Termite job for operator review.`,
        createdAt: now
      }
    ],
    proofArtifacts: [
      {
        id: randomUUID(),
        kind: 'log',
        label: 'Queued job log',
        summary: 'Initial managed Termite alpha queue receipt.',
        createdAt: now
      }
    ],
    metadata: {
      workflow: input.workflow
    }
  };
  job.ledger = job.ledger.map((entry) => ({ ...entry, jobId: job.id }));
  await appendFile(storePath, `${JSON.stringify(job)}\n`, 'utf8');
  await appendCapabilityJob(job);
  return job;
}

export async function listTermiteJobs(userId: string): Promise<TermiteJob[]> {
  try {
    const capabilityJobs = await listCapabilityJobs({ userId, limit: 50 });
    if (capabilityJobs.length > 0) {
      return capabilityJobs
        .filter((job) => job.capabilityId === capabilityId)
        .map((job) => ({
          ...job,
          workflow: String(job.metadata?.workflow ?? 'custom-managed-run'),
          prompt: job.inputSummary
        })) as TermiteJob[];
    }
    const raw = await readFile(storePath, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TermiteJob)
      .filter((job) => job.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
