/**
 * HII Task Queue — File-backed persistent task queue
 *
 * Uses a JSON file instead of SQLite to keep deps minimal.
 * Tasks are assigned to either 'local' (Ollama — scripts only)
 * or 'architect' (Claude — reasoning). Local tasks MUST have
 * a predetermined script/command — no free-form reasoning.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HII_DIR = path.join(process.env.HOME || '/tmp', '.hii');
const QUEUE_FILE = path.join(HII_DIR, 'taskq.json');

export type TaskTarget = 'local' | 'architect';
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed';

export interface HiiTask {
  id: string;
  name: string;
  target: TaskTarget;
  status: TaskStatus;
  /** For local tasks: the exact script/command to run. No reasoning. */
  script?: string;
  /** For architect tasks: the prompt/intent */
  prompt?: string;
  result?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  retries: number;
  maxRetries: number;
}

function loadQueue(): HiiTask[] {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveQueue(tasks: HiiTask[]): void {
  fs.mkdirSync(HII_DIR, { recursive: true });
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(tasks, null, 2));
}

export function addTask(opts: {
  name: string;
  target: TaskTarget;
  script?: string;
  prompt?: string;
  maxRetries?: number;
}): HiiTask {
  // Enforce: local tasks MUST have a script, never free-form
  if (opts.target === 'local' && !opts.script) {
    throw new Error('Local model tasks MUST have a predetermined script. Local models are dumb — no reasoning.');
  }

  const task: HiiTask = {
    id: crypto.randomUUID().slice(0, 8),
    name: opts.name,
    target: opts.target,
    status: 'queued',
    script: opts.script,
    prompt: opts.prompt,
    createdAt: new Date().toISOString(),
    retries: 0,
    maxRetries: opts.maxRetries ?? 2,
  };

  const q = loadQueue();
  q.push(task);
  saveQueue(q);
  return task;
}

export function listTasks(filter?: { status?: TaskStatus; target?: TaskTarget }): HiiTask[] {
  let q = loadQueue();
  if (filter?.status) q = q.filter(t => t.status === filter.status);
  if (filter?.target) q = q.filter(t => t.target === filter.target);
  return q;
}

export function getTask(id: string): HiiTask | undefined {
  return loadQueue().find(t => t.id === id);
}

export function updateTask(id: string, update: Partial<Pick<HiiTask, 'status' | 'result' | 'error' | 'startedAt' | 'completedAt' | 'retries'>>): void {
  const q = loadQueue();
  const idx = q.findIndex(t => t.id === id);
  if (idx === -1) throw new Error(`Task ${id} not found`);
  Object.assign(q[idx], update);
  saveQueue(q);
}

export function claimNext(target: TaskTarget): HiiTask | null {
  const q = loadQueue();
  const task = q.find(t => t.status === 'queued' && t.target === target);
  if (!task) return null;
  task.status = 'running';
  task.startedAt = new Date().toISOString();
  saveQueue(q);
  return task;
}

export function completeTask(id: string, result: string): void {
  updateTask(id, { status: 'done', result, completedAt: new Date().toISOString() });
}

export function failTask(id: string, error: string): void {
  const q = loadQueue();
  const task = q.find(t => t.id === id);
  if (!task) return;
  task.retries++;
  if (task.retries >= task.maxRetries) {
    task.status = 'failed';
    task.error = error;
    task.completedAt = new Date().toISOString();
  } else {
    task.status = 'queued'; // re-queue for retry
  }
  saveQueue(q);
}

export function purgeCompleted(): number {
  const q = loadQueue();
  const before = q.length;
  const remaining = q.filter(t => t.status !== 'done');
  saveQueue(remaining);
  return before - remaining.length;
}
