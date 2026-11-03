import 'server-only';
import { appendFile, mkdir, readFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { appendCapabilityJob, listCapabilityJobs } from '@/lib/capabilities/local-store';
import type { CapabilityJob } from '@/lib/capabilities/types';

export type HiiRhinoJob = CapabilityJob & { workflow: string; prompt: string };
type CreateJobInput = { userId: string; email: string | null; workflow: string; prompt: string; budget: string };

const storeDir = path.join(process.cwd(), '.hii');
const storePath = path.join(storeDir, 'rhino-jobs.jsonl');
const legacyStorePath = path.join(storeDir, 'termite-jobs.jsonl');
const capabilityId = 'hii.rhino.managed_job';
const legacyCapabilityId = 'termite.rhino.managed_job';

export async function createHiiRhinoJob(input: CreateJobInput): Promise<HiiRhinoJob> {
  await mkdir(storeDir, { recursive: true });
  const now = new Date().toISOString();
  const job: HiiRhinoJob = {
    id: randomUUID(), capabilityId,
    inputSummary: `${input.workflow}: ${input.prompt.slice(0, 240)}`,
    userId: input.userId, userEmail: input.email, workflow: input.workflow,
    prompt: input.prompt, budget: input.budget, status: 'queued', createdAt: now, updatedAt: now,
    logs: [`[${now}] HII Rhino job queued`, 'HII owns document discovery, RhinoCode execution, verification, and receipts.', 'No secondary bridge product is required.'],
    ledger: [{ id: randomUUID(), jobId: '', capabilityId, actor: 'hii', type: 'approval', summary: `Accepted ${input.budget} HII Rhino job for operator review.`, createdAt: now }],
    proofArtifacts: [{ id: randomUUID(), kind: 'log', label: 'Queued HII Rhino job log', summary: 'Initial HII-owned Rhino queue receipt.', createdAt: now }],
    metadata: { workflow: input.workflow, executor: 'RhinoCode' }
  };
  job.ledger = job.ledger.map((entry) => ({ ...entry, jobId: job.id }));
  await appendFile(storePath, `${JSON.stringify(job)}\n`, 'utf8');
  await appendCapabilityJob(job);
  return job;
}

export async function listHiiRhinoJobs(userId: string): Promise<HiiRhinoJob[]> {
  const capabilityJobs = await listCapabilityJobs({ userId, limit: 50 });
  if (capabilityJobs.length > 0) {
    return capabilityJobs
      .filter((job) => [capabilityId, legacyCapabilityId].includes(job.capabilityId))
      .map((job) => ({ ...job, workflow: String(job.metadata?.workflow ?? 'custom-managed-run'), prompt: job.inputSummary })) as HiiRhinoJob[];
  }
  const rows: HiiRhinoJob[] = [];
  for (const candidate of [storePath, legacyStorePath]) {
    try {
      const raw = await readFile(candidate, 'utf8');
      rows.push(...raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as HiiRhinoJob));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return rows.filter((job) => job.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
