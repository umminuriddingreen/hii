import 'server-only';
import { appendFile, mkdir, readFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

export type TermiteJob = {
  id: string;
  userId: string;
  email: string | null;
  workflow: string;
  prompt: string;
  budget: string;
  status: 'queued';
  createdAt: string;
  logs: string[];
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

export async function createTermiteJob(input: CreateJobInput): Promise<TermiteJob> {
  await mkdir(storeDir, { recursive: true });
  const now = new Date().toISOString();
  const job: TermiteJob = {
    id: randomUUID(),
    userId: input.userId,
    email: input.email,
    workflow: input.workflow,
    prompt: input.prompt,
    budget: input.budget,
    status: 'queued',
    createdAt: now,
    logs: [
      `[${now}] job queued`,
      'HII accepted the managed Termite request.',
      'Operator next step: open Rhino 8, run StartTermiteBridge, run Termite doctor, then execute the workflow manually through Codex/Termite.',
      'No client-side Rhino or Codex install is required for this managed alpha.'
    ]
  };
  await appendFile(storePath, `${JSON.stringify(job)}\n`, 'utf8');
  return job;
}

export async function listTermiteJobs(userId: string): Promise<TermiteJob[]> {
  try {
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

