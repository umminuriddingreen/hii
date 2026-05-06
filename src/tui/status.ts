import os from 'node:os';
import { getHiiHealth } from '../health.js';
import { TuiRuntime, formatKeyValue, percentBar, wrapText, type TuiFrame, type TuiInput } from './runtime.js';

type StatusState = {
  health: Awaited<ReturnType<typeof getHiiHealth>> | null;
  focus: 0 | 1 | 2;
  pathScroll: number;
};

function formatBytes(value: number): string {
  return `${(value / (1024 ** 3)).toFixed(1)}G`;
}

function buildHeader(state: StatusState): string[] {
  return [
    'HII STATUS  live operational surface for runtime, storage, remotes, and desktop',
    `focus: ${['runtime', 'paths', 'detail'][state.focus]}  refresh: live  host: ${os.hostname()}`,
  ];
}

function buildStatusRail(health: Awaited<ReturnType<typeof getHiiHealth>> | null): string[] {
  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  const memRatio = totalMem > 0 ? usedMem / totalMem : 0;
  const cpuRatio = Math.max(0, Math.min(1, (os.loadavg()[0] || 0) / Math.max(1, os.cpus().length)));
  return [
    `cpu ${percentBar(cpuRatio, 12)} ${(cpuRatio * 100).toFixed(0).padStart(3, ' ')}%  load ${os.loadavg()[0].toFixed(2)}  cores ${os.cpus().length}`,
    `mem ${percentBar(memRatio, 12)} ${(memRatio * 100).toFixed(0).padStart(3, ' ')}%  ${formatBytes(usedMem)} / ${formatBytes(totalMem)}`,
    `generation ${health?.generation?.name || 'none'}  remotes ${health?.remotes?.total ?? 0}  desktop ${health?.desktop?.space?.running ? 'running' : 'idle'}`,
  ];
}

function runtimeLines(health: Awaited<ReturnType<typeof getHiiHealth>> | null): string[] {
  if (!health) return ['health data not loaded'];
  return [
    formatKeyValue('timestamp', health.timestamp),
    formatKeyValue('ollama', health.runtime.ollamaInstalled ? 'installed' : 'missing'),
    formatKeyValue('memory', health.runtime.memoryEnabled ? 'enabled' : 'disabled'),
    formatKeyValue('search', health.runtime.allowSearch ? 'enabled' : 'disabled'),
    formatKeyValue('shell', health.runtime.allowShell ? 'enabled' : 'disabled'),
    formatKeyValue('offline', health.runtime.offline ? 'yes' : 'no'),
    formatKeyValue('generation', health.generation.name || 'none'),
    formatKeyValue('desktop', health.desktop.space.backend),
    formatKeyValue('desktop_ok', health.desktop.space.running ? 'running' : 'idle'),
  ];
}

function pathLines(health: Awaited<ReturnType<typeof getHiiHealth>> | null): string[] {
  if (!health) return ['paths unavailable'];
  return Object.entries(health.paths).flatMap(([key, value]) => {
    if (!value) return [formatKeyValue(key, 'not configured')];
    return [
      formatKeyValue(key, value.exists ? 'present' : 'missing'),
      ...wrapText(`  ${value.path}`, 48),
      '',
    ];
  });
}

function detailLines(health: Awaited<ReturnType<typeof getHiiHealth>> | null): string[] {
  if (!health) return ['No health detail available.'];
  const remoteNames = health.remotes.names.length ? health.remotes.names.join(', ') : 'none';
  return [
    formatKeyValue('space_backend', health.desktop.space.backend),
    formatKeyValue('space_error', health.desktop.space.error || 'none'),
    formatKeyValue('generation_id', health.generation.id || 'none'),
    formatKeyValue('generation_total', String(health.generation.total)),
    formatKeyValue('remotes', remoteNames),
    '',
    ...wrapText('This surface replaces JSON-first health output with an operator-grade cockpit for runtime state, jobs, skills, and local machine health.', 52),
  ];
}

function renderFrame(state: StatusState): TuiFrame {
  return {
    header: buildHeader(state),
    status: buildStatusRail(state.health),
    boxes: [
      { title: 'Runtime', lines: runtimeLines(state.health), width: 36, active: state.focus === 0 },
      { title: 'Paths', lines: pathLines(state.health).slice(state.pathScroll), width: 52, active: state.focus === 1 },
      { title: 'Detail', lines: detailLines(state.health), width: 48, active: state.focus === 2 },
    ],
    footer: ['tab switch focus | ↑↓ move path panel | r refresh | q quit'],
  };
}

export async function runStatusSurface(): Promise<void> {
  const state: StatusState = {
    health: null,
    focus: 0,
    pathScroll: 0,
  };

  const runtime = new TuiRuntime<'exit'>({
    fps: 24,
    tickMs: 2500,
    initialState: async () => {
      state.health = await getHiiHealth();
    },
    onTick: async () => {
      state.health = await getHiiHealth().catch(() => state.health);
    },
    render: () => renderFrame(state),
    onInput: async (input: TuiInput) => {
      if (input.key === 'ctrl-c' || input.raw === 'q') return 'exit';
      if (input.raw === 'r') {
        state.health = await getHiiHealth().catch(() => state.health);
        return;
      }
      if (input.key === 'tab') {
        state.focus = ((state.focus + 1) % 3) as StatusState['focus'];
        return;
      }
      if (input.key === 'shift-tab') {
        state.focus = ((state.focus + 2) % 3) as StatusState['focus'];
        return;
      }
      if ((input.key === 'down' || input.raw === 'j') && state.focus === 1) {
        state.pathScroll += 1;
        return;
      }
      if ((input.key === 'up' || input.raw === 'k') && state.focus === 1) {
        state.pathScroll = Math.max(0, state.pathScroll - 1);
      }
    },
  });

  await runtime.run();
}
