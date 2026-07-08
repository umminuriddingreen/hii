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
    const byId = new Map<string, CapabilityJob>();
    const jobs = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CapabilityJob)
      .filter((job) => !options.userId || job.userId === options.userId);
    for (const job of jobs) byId.set(job.id, job);
    return Array.from(byId.values())
      .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
      .slice(0, options.limit ?? 25);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
