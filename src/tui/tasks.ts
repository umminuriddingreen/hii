import { defaultServerHost, loadHiiAuthToken } from '../security.js';
import { TuiRuntime, formatKeyValue, wrapText, type TuiFrame, type TuiInput } from './runtime.js';

type WorkspaceTask = {
  id: string;
  title: string;
  status: 'Planned' | 'In Progress' | 'Completed' | 'Failed';
  priority: 'High' | 'Medium' | 'Low';
  due_date?: string | null;
  project_id?: string | null;
  project_title?: string | null;
  workflow_label?: string | null;
  details?: string | null;
  failure_reason?: string | null;
  suggested_fix?: string | null;
};

type TaskSurfaceState = {
  tasks: WorkspaceTask[];
  cursor: number;
  statusLine: string;
  detailScroll: number;
};

const API_BASE = `http://${defaultServerHost()}:${process.env.HII_PORT || '8888'}`;
const AUTH_TOKEN = loadHiiAuthToken();

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AUTH_TOKEN}`,
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function listTasks(): Promise<WorkspaceTask[]> {
  return api<WorkspaceTask[]>('/api/tasks');
}

async function updateTask(task: WorkspaceTask, status: WorkspaceTask['status']): Promise<{ suggestions?: string[] }> {
  const body: Record<string, string> = { status };
  if (status === 'Failed' && task.failure_reason) body.failure_reason = task.failure_reason;
  return api(`/api/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify(body) });
}

function selectedTask(state: TaskSurfaceState): WorkspaceTask | null {
  return state.tasks[state.cursor] ?? null;
}

function taskListLines(state: TaskSurfaceState, width: number): string[] {
  return state.tasks.map((task, index) => {
    const marker = index === state.cursor ? '>' : ' ';
    const project = task.project_title ? ` · ${task.project_title}` : '';
    const due = task.due_date ? ` · due ${task.due_date}` : '';
    return `${marker} ${task.status.padEnd(11, ' ')} ${task.priority.padEnd(6, ' ')} ${task.title}${project}${due}`.slice(0, width);
  });
}

function detailLines(task: WorkspaceTask | null, width: number): string[] {
  if (!task) return ['No tasks yet. Use the API or intent parser to create one.'];
  return [
    formatKeyValue('title', task.title),
    formatKeyValue('status', task.status),
    formatKeyValue('priority', task.priority),
    formatKeyValue('project', task.project_title || task.project_id || 'none'),
    formatKeyValue('due', task.due_date || 'none'),
    formatKeyValue('workflow', task.workflow_label || 'none'),
    '',
    ...wrapText(task.details || 'No task details provided.', width - 4),
    ...(task.failure_reason ? ['', `failure: ${task.failure_reason}`] : []),
    ...(task.suggested_fix ? wrapText(`fix: ${task.suggested_fix}`, width - 4) : []),
  ];
}

export async function runTaskSurface(): Promise<void> {
  const state: TaskSurfaceState = {
    tasks: [],
    cursor: 0,
    statusLine: 'loading tasks…',
    detailScroll: 0,
  };

  async function refresh() {
    state.tasks = await listTasks();
    state.cursor = Math.max(0, Math.min(state.cursor, Math.max(0, state.tasks.length - 1)));
    state.statusLine = `live polling every 2s · ${state.tasks.length} task${state.tasks.length === 1 ? '' : 's'}`;
  }

  async function cycleStatus(next: WorkspaceTask['status']) {
    const task = selectedTask(state);
    if (!task) return;
    const result = await updateTask(task, next);
    state.statusLine = result?.suggestions?.[0] || `updated ${task.title}`;
    await refresh();
  }

  const runtime = new TuiRuntime<'exit'>({
    fps: 24,
    tickMs: 2000,
    initialState: refresh,
    onTick: async () => {
      await refresh().catch((error) => {
        state.statusLine = error instanceof Error ? error.message : String(error);
      });
    },
    render: ({ width }) => {
      const listWidth = Math.max(44, Math.floor(width * 0.55));
      const detailsWidth = Math.max(34, width - listWidth - 1);
      const task = selectedTask(state);
      return {
        header: ['HII TASKBOARD  live database-backed workflow surface'],
        status: [state.statusLine],
        boxes: [
          { title: 'Tasks', lines: taskListLines(state, listWidth - 4), width: listWidth, active: true },
          { title: 'Details', lines: detailLines(task, detailsWidth).slice(state.detailScroll), width: detailsWidth },
        ],
        footer: ['j/k or ↑↓ move | i in progress | c completed | f failed | r refresh | q quit'],
      };
    },
    onInput: async (input: TuiInput) => {
      if (input.key === 'ctrl-c' || input.raw === 'q') return 'exit';
      if ((input.key === 'down' || input.raw === 'j') && state.cursor < state.tasks.length - 1) {
        state.cursor += 1;
        state.detailScroll = 0;
        return;
      }
      if ((input.key === 'up' || input.raw === 'k') && state.cursor > 0) {
        state.cursor -= 1;
        state.detailScroll = 0;
        return;
      }
      if (input.raw === 'r') {
        await refresh();
        return;
      }
      if (input.raw === 'i') {
        await cycleStatus('In Progress');
        return;
      }
      if (input.raw === 'c') {
        await cycleStatus('Completed');
        return;
      }
      if (input.raw === 'f') {
        await cycleStatus('Failed');
      }
    },
  });

  await runtime.run();
}
