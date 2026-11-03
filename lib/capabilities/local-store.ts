import { appendFile, mkdir, readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { CapabilityJob } from './types';

function runtimeDir() {
  return process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
}

function jobsPath() {
  return path.join(runtimeDir(), 'capability-jobs.jsonl');
}

const legacyJobsPath = path.join(process.cwd(), '.hii', 'capability-jobs.jsonl');

export async function appendCapabilityJob(job: CapabilityJob) {
  await mkdir(runtimeDir(), { recursive: true });
  await appendFile(jobsPath(), `${JSON.stringify(job)}\n`, 'utf8');
  return job;
}

export async function listCapabilityJobs(options: { userId?: string; limit?: number } = {}) {
  const readJobs = async (file: string) => {
    try {
      return (await readFile(file, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CapabilityJob);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  try {
    const files = legacyJobsPath === jobsPath() ? [jobsPath()] : [legacyJobsPath, jobsPath()];
    const records = (await Promise.all(files.map(readJobs))).flat();
    const byId = new Map<string, CapabilityJob>();
    const jobs = records.filter((job) => !options.userId || job.userId === options.userId);
    for (const job of jobs) byId.set(job.id, job);
    return Array.from(byId.values())
      .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
      .slice(0, options.limit ?? 25);
  } catch (error) { throw error; }
}
