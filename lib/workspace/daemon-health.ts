export type DaemonHealthState = 'ready' | 'busy' | 'attention' | 'offline';

type StatusLike = {
  updatedAt?: unknown;
};

type InstanceLike = {
  owned?: unknown;
  status?: unknown;
  type?: unknown;
};

type RunLike = {
  status?: unknown;
};

type EventLike = {
  ts?: unknown;
  type?: unknown;
  text?: unknown;
};

export type HiiDaemonHealth = {
  state: DaemonHealthState;
  label: string;
  summary: string;
  recoveryAction: 'start' | 'restart' | null;
  recoveryLabel: string | null;
  heartbeatAgeSeconds: number | null;
  activeRuns: number;
  queuedRuns: number;
  ownedServices: number;
  observedProcesses: number;
  recentError: string | null;
};

function timestamp(value: unknown) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function summarizeHiiDaemonHealth(input: {
  alive: boolean;
  status?: StatusLike;
  instances?: InstanceLike[];
  runs?: RunLike[];
  workspaceJobs?: RunLike[];
  events?: EventLike[];
  now?: number;
}): HiiDaemonHealth {
  const now = input.now ?? Date.now();
  const instances = input.instances || [];
  const runs = [...(input.runs || []), ...(input.workspaceJobs || [])];
  const heartbeatAt = timestamp(input.status?.updatedAt);
  const heartbeatAgeSeconds = heartbeatAt === null ? null : Math.max(0, Math.round((now - heartbeatAt) / 1000));
  const ownedServices = instances.filter((item) => item.owned === true && item.status === 'running').length;
  const observedProcesses = instances.filter((item) => item.owned !== true && item.status === 'running').length;
  const activeRuns = runs.filter((run) => run.status === 'running').length;
  const queuedRuns = runs.filter((run) => run.status === 'queued').length;
  const recentErrorEvent = (input.events || [])
    .filter((event) => event.type === 'daemon.error' && timestamp(event.ts) !== null)
    .sort((a, b) => (timestamp(b.ts) || 0) - (timestamp(a.ts) || 0))
    .find((event) => now - (timestamp(event.ts) || 0) <= 60_000);
  const recentError = recentErrorEvent ? String(recentErrorEvent.text || 'AII reported a runtime error.') : null;

  if (!input.alive) {
    return {
      state: 'offline',
      label: 'AII offline',
      summary: 'Approved local runs cannot start until AII is available.',
      recoveryAction: 'start',
      recoveryLabel: 'Start AII',
      heartbeatAgeSeconds,
      activeRuns: 0,
      queuedRuns,
      ownedServices: 0,
      observedProcesses,
      recentError
    };
  }

  if (heartbeatAgeSeconds === null || heartbeatAgeSeconds > 15 || recentError) {
    return {
      state: 'attention',
      label: 'AII needs attention',
      summary: recentError || `AII's heartbeat is ${heartbeatAgeSeconds ?? 'unknown'} seconds old.`,
      recoveryAction: 'restart',
      recoveryLabel: 'Restart AII',
      heartbeatAgeSeconds,
      activeRuns,
      queuedRuns,
      ownedServices,
      observedProcesses,
      recentError
    };
  }

  if (activeRuns > 0 || queuedRuns > 0) {
    return {
      state: 'busy',
      label: 'AII working',
      summary: `${activeRuns} approved run${activeRuns === 1 ? '' : 's'} active · ${queuedRuns} queued.`,
      recoveryAction: null,
      recoveryLabel: null,
      heartbeatAgeSeconds,
      activeRuns,
      queuedRuns,
      ownedServices,
      observedProcesses,
      recentError: null
    };
  }

  return {
    state: 'ready',
    label: 'AII ready',
    summary: 'Ready for approved local work.',
    recoveryAction: null,
    recoveryLabel: null,
    heartbeatAgeSeconds,
    activeRuns,
    queuedRuns,
    ownedServices,
    observedProcesses,
    recentError: null
  };
}
