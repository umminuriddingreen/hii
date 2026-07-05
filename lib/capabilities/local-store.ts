import 'server-only';
import { appendFile, mkdir, readFile } from 'fs/promises';
import path from 'path';
import type { CapabilityJob } from './types';

const storeDir = path.join(process.cwd(), '.hii');
const jobsPath = path.join(storeDir, 'capability-jobs.jsonl');

export async function appendCapabilityJob(job: CapabilityJob) {
  await mkdir(storeDir, { recursive: true });
  await appendFile(jobsPath, `${JSON.stringify(job)}\n`, 'utf8');
  return job;
}

export async function listCapabilityJobs(options: { userId?: string; limit?: number } = {}) {
  try {
    const raw = await readFile(jobsPath, 'utf8');
    const jobs = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CapabilityJob)
      .filter((job) => !options.userId || job.userId === options.userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return jobs.slice(0, options.limit ?? 25);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
