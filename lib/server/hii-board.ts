import 'server-only';
import { appendFile, mkdir, readFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { runtimeRoot } from '@/lib/server/runtime-root';

export type BoardLane = 'backlog' | 'next' | 'doing' | 'blocked' | 'done';
export type BoardPriority = 'low' | 'normal' | 'high' | 'urgent';
export type BoardTaskOrigin = 'human' | 'agent' | 'system';
export type BoardTaskReviewState = 'proposed' | 'approved';
export type BoardTaskRunStatus =
  | 'waiting_approval'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type BoardTaskQuality = {
  ready: boolean;
  issues: string[];
};

export type BoardTask = {
  id: string;
  title: string;
  lane: BoardLane;
  priority: BoardPriority;
  owner: string;
  coordinate: string;
  notes: string;
  acceptanceCriteria?: string[];
  tags: string[];
  source: string;
  origin?: BoardTaskOrigin;
  reviewState?: BoardTaskReviewState;
  requestedLane?: BoardLane;
  approvedAt?: string;
  approvedBy?: string;
  runId?: string;
  runStatus?: BoardTaskRunStatus;
  receiptRef?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

type BoardTaskEvent =
  | { type: 'created'; task: BoardTask; ts: string }
  | { type: 'updated'; id: string; patch: Partial<BoardTask>; ts: string };

export const boardLanes: BoardLane[] = ['backlog', 'next', 'doing', 'blocked', 'done'];
export const boardPriorities: BoardPriority[] = ['low', 'normal', 'high', 'urgent'];
export const boardTaskOrigins: BoardTaskOrigin[] = ['human', 'agent', 'system'];
export const boardTaskRunStatuses: BoardTaskRunStatus[] = [
  'waiting_approval',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled'
];

const boardDir = path.join(runtimeRoot(), 'board');
const taskEventsPath = path.join(boardDir, 'tasks.jsonl');

export class BoardTaskError extends Error {
  code:
    | 'BOARD_TASK_APPROVAL_REQUIRED'
    | 'BOARD_TASK_DUPLICATE'
    | 'BOARD_TASK_LOW_QUALITY'
    | 'BOARD_TASK_RUN_TRANSITION'
    | 'BOARD_TASK_RECEIPT_REQUIRED';
  existingTask?: BoardTask;

  constructor(
    code: BoardTaskError['code'],
    message: string,
    options: { existingTask?: BoardTask } = {}
  ) {
    super(message);
    this.name = 'BoardTaskError';
    this.code = code;
    this.existingTask = options.existingTask;
  }
}

function normalizeLane(value: unknown): BoardLane {
  return boardLanes.includes(value as BoardLane) ? (value as BoardLane) : 'backlog';
}

function normalizePriority(value: unknown): BoardPriority {
  return boardPriorities.includes(value as BoardPriority) ? (value as BoardPriority) : 'normal';
}

function normalizeOrigin(value: unknown): BoardTaskOrigin {
  return boardTaskOrigins.includes(value as BoardTaskOrigin) ? (value as BoardTaskOrigin) : 'system';
}

function normalizeRunStatus(value: unknown): BoardTaskRunStatus | undefined {
  return boardTaskRunStatuses.includes(value as BoardTaskRunStatus)
    ? value as BoardTaskRunStatus
    : undefined;
}

function runTransitionAllowed(
  current: BoardTaskRunStatus | undefined,
  next: BoardTaskRunStatus
) {
  if (current === next) return true;
  if (!current) return next === 'waiting_approval';
  const allowed: Record<BoardTaskRunStatus, BoardTaskRunStatus[]> = {
    waiting_approval: ['queued', 'failed', 'cancelled'],
    queued: ['running', 'completed', 'failed', 'cancelled'],
    running: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: ['waiting_approval'],
    cancelled: ['waiting_approval']
  };
  return allowed[current].includes(next);
}

function patchChangesTask(task: BoardTask, patch: Partial<BoardTask>) {
  return Object.entries(patch).some(([key, value]) =>
    value !== undefined
    && JSON.stringify(task[key as keyof BoardTask]) !== JSON.stringify(value)
  );
}

function boardTaskKey(input: Pick<BoardTask, 'title' | 'coordinate'>) {
  return [input.title, input.coordinate]
    .map((value) => value.trim().toLocaleLowerCase().replace(/\s+/g, ' '))
    .join('\u0000');
}

function effectiveReviewState(task: BoardTask): BoardTaskReviewState {
  return task.reviewState ?? 'approved';
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

function parseAcceptanceCriteria(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\r?\n/)
      : [];
  return Array.from(new Set(
    values
      .map((criterion) => sanitizeText(criterion, 240))
      .filter(Boolean)
  )).slice(0, 8);
}

export function assessBoardTaskQuality(
  task: Pick<BoardTask, 'title' | 'notes' | 'acceptanceCriteria' | 'origin'>
): BoardTaskQuality {
  if ((task.origin ?? 'system') === 'human') return { ready: true, issues: [] };

  const issues: string[] = [];
  const title = task.title.trim();
  const vagueTitle = /^(?:review|fix|improve|update|task|todo|tbd|do this|work on it)$/i.test(title);
  if (title.split(/\s+/).filter(Boolean).length < 2 || vagueTitle) {
    issues.push('Name a bounded outcome, not a vague activity.');
  }
  if (task.notes.trim().length < 20) {
    issues.push('Explain why this work matters and what context it uses.');
  }
  if (!parseAcceptanceCriteria(task.acceptanceCriteria).length) {
    issues.push('Add at least one concrete “done when” criterion.');
  }
  return { ready: issues.length === 0, issues };
}

export function boardTaskView(task: BoardTask) {
  return {
    ...task,
    acceptanceCriteria: parseAcceptanceCriteria(task.acceptanceCriteria),
    proposalQuality: assessBoardTaskQuality(task)
  };
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
  acceptanceCriteria?: unknown;
  tags?: unknown;
  source?: unknown;
  origin?: unknown;
  approvedBy?: unknown;
}) {
  const title = sanitizeText(input.title, 1000);
  if (title.length < 2) throw new Error('Task title must be at least 2 characters.');
  if (title.length > 240) throw new Error('Task title must be 240 characters or less.');
  if (/^--?[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(title)) {
    throw new BoardTaskError(
      'BOARD_TASK_LOW_QUALITY',
      'Use an outcome-focused task title instead of a command flag.'
    );
  }

  const now = new Date().toISOString();
  const source = sanitizeText(input.source, 120) || 'hii board';
  const origin = normalizeOrigin(input.origin);
  const requestedLane = normalizeLane(input.lane);
  const reviewState: BoardTaskReviewState = origin === 'human' ? 'approved' : 'proposed';
  const lane = reviewState === 'proposed' && ['next', 'doing'].includes(requestedLane)
    ? 'backlog'
    : requestedLane;
  const coordinate = sanitizeText(input.coordinate, 240);
  const existingTask = (await listBoardTasks()).find((candidate) =>
    boardTaskKey(candidate) === boardTaskKey({ title, coordinate })
  );
  if (existingTask) {
    throw new BoardTaskError(
      'BOARD_TASK_DUPLICATE',
      `An open task already covers this outcome: ${existingTask.id.slice(0, 8)} ${existingTask.title}`,
      { existingTask }
    );
  }
  const approvedBy = reviewState === 'approved'
    ? sanitizeText(input.approvedBy, 80) || 'local operator'
    : undefined;
  const task: BoardTask = {
    id: randomUUID(),
    title,
    lane,
    priority: normalizePriority(input.priority),
    owner: sanitizeText(input.owner, 80) || 'main agent',
    coordinate,
    notes: sanitizeText(input.notes, 2000),
    acceptanceCriteria: parseAcceptanceCriteria(input.acceptanceCriteria),
    tags: parseTags(input.tags),
    source,
    origin,
    reviewState,
    ...(lane !== requestedLane ? { requestedLane } : {}),
    ...(reviewState === 'approved' ? { approvedAt: now, approvedBy } : {}),
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
    acceptanceCriteria?: unknown;
    tags?: unknown;
    title?: unknown;
    reviewState?: unknown;
    approvedBy?: unknown;
    runId?: unknown;
    runStatus?: unknown;
    receiptRef?: unknown;
  }
) {
  const task = (await listBoardTasks({ includeDone: true })).find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Task not found: ${id}`);

  const now = new Date().toISOString();
  const patch: Partial<BoardTask> = {};
  const approvalRequested = input.reviewState === 'approved';
  if (input.lane !== undefined) {
    const requestedLane = normalizeLane(input.lane);
    if (
      ['next', 'doing'].includes(requestedLane)
      && effectiveReviewState(task) === 'proposed'
      && !approvalRequested
    ) {
      throw new BoardTaskError(
        'BOARD_TASK_APPROVAL_REQUIRED',
        'Approve this proposal before moving it into active work.'
      );
    }
    patch.lane = requestedLane;
    patch.completedAt = patch.lane === 'done'
      ? task.lane === 'done' && task.completedAt
        ? task.completedAt
        : now
      : undefined;
  }
  if (input.priority !== undefined) patch.priority = normalizePriority(input.priority);
  if (typeof input.owner === 'string') patch.owner = sanitizeText(input.owner, 80) || task.owner;
  if (typeof input.coordinate === 'string') patch.coordinate = sanitizeText(input.coordinate, 240) || task.coordinate;
  if (typeof input.notes === 'string') patch.notes = sanitizeText(input.notes, 2000);
  if (input.acceptanceCriteria !== undefined) {
    patch.acceptanceCriteria = parseAcceptanceCriteria(input.acceptanceCriteria);
  }
  if (input.tags !== undefined) patch.tags = parseTags(input.tags);
  if (typeof input.title === 'string' && sanitizeText(input.title, 240)) patch.title = sanitizeText(input.title, 240);
  if (approvalRequested && effectiveReviewState(task) === 'proposed') {
    const quality = assessBoardTaskQuality({ ...task, ...patch });
    if (!quality.ready) {
      throw new BoardTaskError(
        'BOARD_TASK_LOW_QUALITY',
        `Define this proposal before approval: ${quality.issues.join(' ')}`
      );
    }
  }
  if (approvalRequested) {
    patch.reviewState = 'approved';
    patch.approvedAt = now;
    patch.approvedBy = sanitizeText(input.approvedBy, 80) || 'local operator';
  }
  if (input.runId !== undefined || input.runStatus !== undefined || input.receiptRef !== undefined) {
    if (effectiveReviewState(task) === 'proposed' && !approvalRequested) {
      throw new BoardTaskError(
        'BOARD_TASK_APPROVAL_REQUIRED',
        'Approve this proposal before preparing or recording a run.'
      );
    }
    const runId = input.runId === undefined ? task.runId : sanitizeText(input.runId, 120);
    const runStatus = input.runStatus === undefined ? task.runStatus : normalizeRunStatus(input.runStatus);
    const receiptRef = input.receiptRef === undefined
      ? task.receiptRef
      : sanitizeText(input.receiptRef, 1000);
    if (!runId) throw new Error('A board run link requires a run id.');
    if (!runStatus) throw new Error('Board run status is not recognized.');
    if (!runTransitionAllowed(task.runStatus, runStatus)) {
      throw new BoardTaskError(
        'BOARD_TASK_RUN_TRANSITION',
        `Board run cannot move from ${task.runStatus ?? 'unlinked'} to ${runStatus}.`
      );
    }
    if (task.runId && runId !== task.runId) {
      if (!['failed', 'cancelled'].includes(task.runStatus ?? '') || runStatus !== 'waiting_approval') {
        throw new BoardTaskError(
          'BOARD_TASK_RUN_TRANSITION',
          'An active or completed board run cannot be replaced.'
        );
      }
    }
    if (
      task.runId
      && runId === task.runId
      && ['failed', 'cancelled'].includes(task.runStatus ?? '')
      && runStatus === 'waiting_approval'
    ) {
      throw new BoardTaskError(
        'BOARD_TASK_RUN_TRANSITION',
        'Retrying blocked work requires a fresh run id.'
      );
    }
    if (task.receiptRef && receiptRef !== task.receiptRef) {
      throw new BoardTaskError(
        'BOARD_TASK_RUN_TRANSITION',
        'A linked board receipt is immutable.'
      );
    }
    if (receiptRef && runStatus !== 'completed') {
      throw new BoardTaskError(
        'BOARD_TASK_RUN_TRANSITION',
        'A receipt can only be linked to a completed board run.'
      );
    }
    if (runStatus === 'completed' && !receiptRef) {
      throw new BoardTaskError(
        'BOARD_TASK_RECEIPT_REQUIRED',
        'A completed board run requires a receipt reference.'
      );
    }
    patch.runId = runId;
    patch.runStatus = runStatus;
    if (receiptRef) patch.receiptRef = receiptRef;
  }
  const linkedRunId = patch.runId ?? task.runId;
  if (patch.lane === 'done' && linkedRunId) {
    const linkedStatus = patch.runStatus ?? task.runStatus;
    const linkedReceipt = patch.receiptRef ?? task.receiptRef;
    if (linkedStatus !== 'completed' || !linkedReceipt) {
      throw new BoardTaskError(
        'BOARD_TASK_RECEIPT_REQUIRED',
        'A run-linked task needs completed status and a receipt before entering done.'
      );
    }
  }

  if (!patchChangesTask(task, patch)) return task;
  patch.updatedAt = now;
  await appendEvent({ type: 'updated', id, patch, ts: now });
  return { ...task, ...patch };
}

export function boardStorePath() {
  return taskEventsPath;
}
