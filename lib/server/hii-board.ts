import 'server-only';
import { appendFile, mkdir, readFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

export type BoardLane = 'backlog' | 'next' | 'doing' | 'blocked' | 'done';
export type BoardPriority = 'low' | 'normal' | 'high' | 'urgent';

export type BoardTask = {
  id: string;
  title: string;
  lane: BoardLane;
  priority: BoardPriority;
  owner: string;
  coordinate: string;
  notes: string;
  tags: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

type BoardTaskEvent =
  | { type: 'created'; task: BoardTask; ts: string }
  | { type: 'updated'; id: string; patch: Partial<BoardTask>; ts: string };

export const boardLanes: BoardLane[] = ['backlog', 'next', 'doing', 'blocked', 'done'];
export const boardPriorities: BoardPriority[] = ['low', 'normal', 'high', 'urgent'];

const boardDir = path.join(process.env.HII_RUNTIME_DIR || path.join(process.env.HOME || '.', '.hii'), 'board');
const taskEventsPath = path.join(boardDir, 'tasks.jsonl');

function normalizeLane(value: unknown): BoardLane {
  return boardLanes.includes(value as BoardLane) ? (value as BoardLane) : 'backlog';
}

function normalizePriority(value: unknown): BoardPriority {
  return boardPriorities.includes(value as BoardPriority) ? (value as BoardPriority) : 'normal';
}

function sanitizeText(value: unknown, maxLength: number) {
  return String(value ?? '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\b\r]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)=)([^\s]+)/gi, '$1[redacted]')
    .replace(/((?:OPENAI|ANTHROPIC|SUPABASE|STRIPE|GITHUB|VERCEL|CLOUDFLARE|AWS)[A-Z0-9_]*=)([^\s]+)/g, '$1[redacted]')
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, '$1[redacted]')
    .replace(/(--(?:api-key|token|secret|password|auth|key)\s+)([^\s]+)/gi, '$1[redacted]')
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[redacted]')
    .replace(/(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/g, '[redacted]')
    .trim()
    .slice(0, maxLength);
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((tag) => sanitizeText(tag, 48)).filter(Boolean).slice(0, 12);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((tag) => sanitizeText(tag, 48))
      .filter(Boolean)
      .slice(0, 12);
  }
  return [];
}

async function readEvents(): Promise<BoardTaskEvent[]> {
  try {
    const raw = await readFile(taskEventsPath, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BoardTaskEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function appendEvent(event: BoardTaskEvent) {
  await mkdir(boardDir, { recursive: true });
  await appendFile(taskEventsPath, `${JSON.stringify(event)}\n`, 'utf8');
}

export async function listBoardTasks(options: { includeDone?: boolean } = {}) {
  const tasks = new Map<string, BoardTask>();
  for (const event of await readEvents()) {
    if (event.type === 'created') {
      tasks.set(event.task.id, event.task);
      continue;
    }
    const existing = tasks.get(event.id);
    if (!existing) continue;
    tasks.set(event.id, {
      ...existing,
      ...event.patch,
      id: existing.id,
      updatedAt: event.patch.updatedAt ?? event.ts
    });
  }

  return Array.from(tasks.values())
    .filter((task) => options.includeDone || task.lane !== 'done')
    .sort((a, b) => {
      const laneDelta = boardLanes.indexOf(a.lane) - boardLanes.indexOf(b.lane);
      if (laneDelta !== 0) return laneDelta;
      const priorityDelta = boardPriorities.indexOf(b.priority) - boardPriorities.indexOf(a.priority);
      if (priorityDelta !== 0) return priorityDelta;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
}

export async function createBoardTask(input: {
  title: string;
  lane?: unknown;
  priority?: unknown;
  owner?: unknown;
  coordinate?: unknown;
  notes?: unknown;
  tags?: unknown;
  source?: unknown;
}) {
  const title = sanitizeText(input.title, 240);
  if (title.length < 2) throw new Error('Task title must be at least 2 characters.');
  if (title.length > 240) throw new Error('Task title must be 240 characters or less.');

  const now = new Date().toISOString();
  const task: BoardTask = {
    id: randomUUID(),
    title,
    lane: normalizeLane(input.lane),
    priority: normalizePriority(input.priority),
    owner: sanitizeText(input.owner, 80) || 'main agent',
    coordinate:
      sanitizeText(input.coordinate, 240)
        ? sanitizeText(input.coordinate, 240)
        : '/Users/ummi/hii',
    notes: sanitizeText(input.notes, 2000),
    tags: parseTags(input.tags),
    source: sanitizeText(input.source, 120) || 'hii board',
    createdAt: now,
    updatedAt: now
  };

  await appendEvent({ type: 'created', task, ts: now });
  return task;
}

export async function updateBoardTask(
  id: string,
  input: {
    lane?: unknown;
    priority?: unknown;
    owner?: unknown;
    coordinate?: unknown;
    notes?: unknown;
    tags?: unknown;
    title?: unknown;
  }
) {
  const task = (await listBoardTasks({ includeDone: true })).find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Task not found: ${id}`);

  const now = new Date().toISOString();
  const patch: Partial<BoardTask> = { updatedAt: now };
  if (input.lane !== undefined) {
    patch.lane = normalizeLane(input.lane);
    patch.completedAt = patch.lane === 'done' ? now : undefined;
  }
  if (input.priority !== undefined) patch.priority = normalizePriority(input.priority);
  if (typeof input.owner === 'string') patch.owner = sanitizeText(input.owner, 80) || task.owner;
  if (typeof input.coordinate === 'string') patch.coordinate = sanitizeText(input.coordinate, 240) || task.coordinate;
  if (typeof input.notes === 'string') patch.notes = sanitizeText(input.notes, 2000);
  if (input.tags !== undefined) patch.tags = parseTags(input.tags);
  if (typeof input.title === 'string' && sanitizeText(input.title, 240)) patch.title = sanitizeText(input.title, 240);

  await appendEvent({ type: 'updated', id, patch, ts: now });
  return { ...task, ...patch };
}

export function boardStorePath() {
  return taskEventsPath;
}
