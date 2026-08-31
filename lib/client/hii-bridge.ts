'use client';

import { emptyWorkspace, normalizeWorkspace, type WorkspaceDoc } from '@/lib/workspace/types';
import type { CanvasModeId } from '@/lib/workspace/canvas-modes';
import type { HiiNotification } from '@/lib/notifications/types';

export type AgentRequestV1 = {
  version: 1;
  intent: string;
  mode?: CanvasModeId;
  workspaceRoot?: string;
  spaceId?: string;
  contextNodeIds: string[];
  contextPackId: string;
  contextFingerprint: string;
};

export type ContextPackItemV1 = {
  ref: { kind: string; id: string; scope?: string; anchor?: unknown };
  title: string;
  itemType: string;
  summary: string;
  source?: string;
  revision?: string;
  sha256?: string;
  provenance: string;
  transmissionScope: string;
  relevanceReasons: string[];
  estimatedTokens: number;
  selected: boolean;
};

export type ContextPackV1 = {
  version: 1;
  id: string;
  status: 'draft' | 'approved' | 'stale' | 'blocked';
  intent: string;
  spaceId: string;
  workspaceRoot: string;
  actor: RuntimeIdentityRefV1;
  authority: string;
  mode: CanvasModeId;
  items: ContextPackItemV1[];
  excluded: Array<{ ref: { kind: string; id: string }; title: string; reason: string }>;
  sourceErrors: string[];
  budget: { maximumTokens: number; usedTokens: number; remainingTokens: number };
  transmissionScope: string;
  fingerprint: string;
  changedSincePrevious: boolean;
  risk: { action: 'autoStart' | 'review' | 'blocked'; reasons: string[] };
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
};

export type AgentStartResult = { runId: string };
export type AgentEventV1 = {
  version: 1;
  runId: string;
  status: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';
  kind?: 'activity' | 'result' | 'status';
  text?: string;
  receiptPath?: string;
};

export type TerminalOutputV1 = {
  version: 1;
  sessionId: string;
  data: string;
};

export type TerminalExitV1 = {
  version: 1;
  sessionId: string;
};

export type TerminalStartResultV1 = {
  version: 1;
  sessionId: string;
  cwd: string;
  replay: string;
  created: boolean;
};

export type InformationImage = {
  id: string;
  sourceId: string;
  url: string;
  alt: string;
  context: string;
  position: number;
};

export type InformationSource = {
  id: string;
  url: string;
  title: string;
  author: string;
  siteName: string;
  publishedAt?: string;
  excerpt: string;
  content: string;
  contentHash: string;
  rawHash: string;
  contentType: string;
  capturedAt: string;
};

export type InformationCaptureResult = {
  source: InformationSource;
  images: InformationImage[];
  changed: boolean;
  previousContentHash?: string;
  receiptId: string;
  receiptPath: string;
};

export type InformationSearchResult = {
  id?: string;
  url: string;
  title: string;
  excerpt: string;
  siteName: string;
  contentHash?: string;
  capturedAt?: string;
};

export type HiiApplicationManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  developer: string;
  summary: string;
  icon: string;
  surfaces: {
    canvas?: { surface: string; width: number; height: number; entryUrl?: string };
    native?: { bundleIdentifier: string };
  };
  capabilities: string[];
  builtIn: boolean;
};

export type ApplicationLaunchRequest = {
  schemaVersion: 1;
  id: string;
  applicationId: string;
  surface: 'canvas' | 'native' | 'bar';
  source: string;
  status: 'requested';
  requestedAt: string;
  receiptPath: string;
};

export type HiiContactCard = {
  schemaVersion: 1;
  kind: 'hii.contact-card/1';
  id: string;
  name: string;
  email?: string;
  publicKey: string;
  issuedAt: string;
  signature: string;
};

export type HiiVpnStatus = {
  initialized: boolean;
  accountId?: string;
  meshId?: string;
  phase?: 'local_ready' | 'endpoint_configured' | 'active' | 'revoked';
  localDevice?: {
    deviceId: string;
    displayName: string;
    platform: string;
    ipv4: string;
    ipv6: string;
    wireguardPublicKey: string;
    endpoint?: string;
    endpointSource?: string;
    listenPort?: number;
    status: 'local_ready' | 'pending' | 'active' | 'revoked';
    lastVerifiedHandshakeAt?: string;
  };
  peers: Array<{
    deviceId: string;
    displayName: string;
    platform: string;
    ipv4: string;
    ipv6: string;
    wireguardPublicKey: string;
    endpoint?: string;
    endpointSource?: string;
    listenPort?: number;
    status: 'local_ready' | 'pending' | 'active' | 'revoked';
    lastVerifiedHandshakeAt?: string;
  }>;
  peerCount: number;
  controlPlaneReady: boolean;
  dataPlaneLive: boolean;
  relayConfigured: boolean;
  nativeWireGuard: {
    backend: string;
    available: boolean;
    configReady: boolean;
    active: boolean;
    interfaceName: string;
    latestHandshakeAt?: string;
    receivedBytes: number;
    sentBytes: number;
    detail: string;
  };
  reasons: string[];
  next: string;
};

export type RuntimeIdentityRefV1 = {
  id: string;
  kind: 'human' | 'device' | 'agent' | 'service' | 'space';
};

export type RuntimeEventV1 = {
  version: 1;
  id: string;
  spaceId: string;
  sequence: number;
  actor: RuntimeIdentityRefV1;
  type: string;
  targetId?: string;
  payload: Record<string, unknown>;
  authorityGrantId?: string;
  runId?: string;
  createdAt: string;
};

export type RuntimeSpaceSnapshotV1 = {
  version: 1;
  spaceId: string;
  sequence: number;
  document: WorkspaceDoc;
  objects: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  recentEvents: RuntimeEventV1[];
};

export type RuntimeShareModeV1 = 'liveReference' | 'snapshot' | 'fork' | 'publish' | 'export';

export type RuntimeShareBundleV1 = {
  version: 1;
  kind: 'hii.runtime.share-bundle';
  id: string;
  mode: RuntimeShareModeV1;
  sourceSpaceId: string;
  sourceSequence: number;
  owner: RuntimeIdentityRefV1;
  recipientId?: string;
  createdAt: string;
  objects: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  document: WorkspaceDoc;
  contentHash: string;
};

export type RuntimeShareRecordV1 = {
  id: string;
  sourceSpaceId: string;
  mode: RuntimeShareModeV1;
  recipientId?: string;
  createdAt: string;
  revokedAt?: string;
};

export type ActiveStateDomainV1 = {
  id: string;
  state: 'active' | 'attention' | 'ready' | 'idle' | 'partial' | 'offline' | 'unknown';
  visibility: 'observed' | 'partial' | 'unavailable';
  source: string;
  updatedAt?: string | null;
  basis: string;
  counts: Record<string, unknown>;
};

export type AgentHomeV2 = {
  schemaVersion: 2;
  kind: 'hii.agent.home';
  generatedAt: string;
  activeState: {
    schemaVersion: 1;
    kind: 'hii.active-state';
    model: 'white-box operational state';
    observedAt: string;
    claim: string;
    transition: string;
    coverage: { registeredDomains: number; observed: number; partial: number; unavailable: number; exclusions: string[] };
    domains: ActiveStateDomainV1[];
    activeInstances: Array<{ id: string; type: string; status: string; owned: boolean; live: boolean | null; title: string; coordinate: string | null; heartbeatAt: string | null }>;
  };
};

export function formatActiveState(home: AgentHomeV2) {
  const state = home.activeState;
  const domains = state.domains.map((domain) => `${domain.id.toUpperCase()} · ${domain.state}\n${domain.basis}\nsource: ${domain.source}`);
  const instances = state.activeInstances.slice(0, 8).map((instance) =>
    `${instance.owned ? 'owned' : 'observed'} · ${instance.type} · ${instance.status}${instance.live === false ? ' · stale PID' : ''} · ${instance.title || instance.id}`
  );
  return [
    `HII ACTIVE STATE · ${new Date(state.observedAt).toLocaleString()}`,
    state.claim,
    `coverage: ${state.coverage.observed}/${state.coverage.registeredDomains} observed · ${state.coverage.partial} partial · ${state.coverage.unavailable} unavailable`,
    '',
    ...domains,
    ...(instances.length ? ['', 'ACTIVE INSTANCES', ...instances] : []),
    '',
    `Not visible: ${state.coverage.exclusions.join('; ')}.`
  ].join('\n');
}

function developmentRuntime() {
  if (typeof window === 'undefined') return 'http://127.0.0.1:3043';
  const port = Number(window.location.port);
  if (Number.isFinite(port) && port > 0) {
    return `${window.location.protocol}//${window.location.hostname}:${port + 1}`;
  }
  return 'http://127.0.0.1:3043';
}
const webAgentListeners = new Set<(event: AgentEventV1) => void>();

async function developmentRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${developmentRuntime()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) }
    });
  } catch {
    throw new Error('HII’s local inference service is unavailable. Start the current workspace preview and try again.');
  }
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error || `HII development runtime returned ${response.status}.`);
  return value;
}

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function readAgentHome(): Promise<AgentHomeV2> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<AgentHomeV2>('agent_home');
  }
  return developmentRequest<AgentHomeV2>('/home');
}

export async function readWorkspace(): Promise<WorkspaceDoc> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const snapshot = await invoke<RuntimeSpaceSnapshotV1>('runtime_space_snapshot_v1');
    return normalizeWorkspace(snapshot.document);
  }
  try {
    return normalizeWorkspace(JSON.parse(localStorage.getItem('hii.workspace.v2') || 'null'));
  } catch {
    return emptyWorkspace();
  }
}

export async function writeWorkspace(document: WorkspaceDoc): Promise<WorkspaceDoc> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const snapshot = await invoke<RuntimeSpaceSnapshotV1>('runtime_space_apply_v1', {
      request: {
        version: 1,
        expectedSequence: document.revision,
        actor: { id: 'human:local', kind: 'human' },
        idempotencyKey: `canvas:${document.revision}:${document.updatedAt}`,
        document
      }
    });
    return normalizeWorkspace(snapshot.document);
  }
  const saved = { ...document, revision: document.revision + 1 };
  localStorage.setItem('hii.workspace.v2', JSON.stringify(saved));
  return saved;
}

export async function readRuntimeSpaceHistory(limit = 100): Promise<RuntimeEventV1[]> {
  if (!isTauri()) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<RuntimeEventV1[]>('runtime_space_history_v1', { limit });
}

export async function createRuntimeShare(request: {
  mode: RuntimeShareModeV1;
  objectIds: string[];
  recipientId?: string;
}): Promise<RuntimeShareBundleV1> {
  if (!isTauri()) throw new Error('Object sharing is available in the HII desktop app.');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<RuntimeShareBundleV1>('runtime_share_create_v1', {
    request: {
      version: 1,
      mode: request.mode,
      objectIds: request.objectIds,
      recipientId: request.recipientId,
      actor: { id: 'human:local', kind: 'human' }
    }
  });
}

export async function listRuntimeShares(): Promise<RuntimeShareRecordV1[]> {
  if (!isTauri()) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<RuntimeShareRecordV1[]>('runtime_share_list_v1');
}

export async function revokeRuntimeShare(shareId: string): Promise<RuntimeShareRecordV1> {
  if (!isTauri()) throw new Error('Share revocation is available in the HII desktop app.');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<RuntimeShareRecordV1>('runtime_share_revoke_v1', {
    request: {
      version: 1,
      shareId,
      actor: { id: 'human:local', kind: 'human' }
    }
  });
}

export async function compileContextPack(request: {
  intent: string;
  mode: CanvasModeId;
  authority: string;
  selectedObjectIds: string[];
  spaceId?: string;
  workspaceRoot?: string;
  budgetTokens?: number;
}): Promise<ContextPackV1> {
  const payload = {
    version: 1,
    spaceId: request.spaceId || 'default',
    workspaceRoot: request.workspaceRoot,
    intent: request.intent,
    selectedObjectIds: request.selectedObjectIds,
    actor: { id: 'human:local', kind: 'human' },
    authority: request.authority,
    mode: request.mode,
    budgetTokens: request.budgetTokens
  };
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<ContextPackV1>('runtime_context_compile_v1', { request: payload });
  }
  return developmentRequest<ContextPackV1>('/context/compile', {
    method: 'POST', body: JSON.stringify(payload)
  });
}

export async function approveContextPack(pack: ContextPackV1, policy = false): Promise<ContextPackV1> {
  const request = {
    version: 1,
    packId: pack.id,
    fingerprint: pack.fingerprint,
    approvedBy: policy
      ? { id: 'policy:local-readonly', kind: 'service' }
      : { id: 'human:local', kind: 'human' }
  };
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<ContextPackV1>('runtime_context_approve_v1', { request });
  }
  return developmentRequest<ContextPackV1>('/context/approve', {
    method: 'POST', body: JSON.stringify(request)
  });
}

export async function getContextPack(id: string): Promise<ContextPackV1> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<ContextPackV1>('runtime_context_get_v1', { id });
  }
  return developmentRequest<ContextPackV1>(`/context/${encodeURIComponent(id)}`);
}

export async function startAgent(request: AgentRequestV1): Promise<AgentStartResult> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<AgentStartResult>('agent_start', { request });
  }
  const started = await developmentRequest<AgentStartResult & AgentEventV1>('/agent', {
    method: 'POST',
    body: JSON.stringify(request)
  });
  let previousText = '';
  let previousStatus = 'started';
  const poll = async () => {
    try {
      const state = await developmentRequest<AgentEventV1>(`/agent/${started.runId}`);
      const nextText = state.text || '';
      const delta = nextText.startsWith(previousText) ? nextText.slice(previousText.length).trimStart() : nextText;
      if (delta || state.status !== previousStatus || state.receiptPath) {
        for (const listener of webAgentListeners) listener({ ...state, text: delta || undefined });
      }
      previousText = nextText;
      previousStatus = state.status;
      if (!['completed', 'failed', 'cancelled'].includes(state.status)) window.setTimeout(poll, 400);
    } catch (error) {
      for (const listener of webAgentListeners) {
        listener({ version: 1, runId: started.runId, status: 'failed', text: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  window.setTimeout(poll, 100);
  return { runId: started.runId };
}

export async function cancelAgent(runId: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('agent_cancel', { runId });
}

export async function listenAgentEvents(handler: (event: AgentEventV1) => void) {
  if (!isTauri()) {
    webAgentListeners.add(handler);
    return () => { webAgentListeners.delete(handler); };
  }
  const { listen } = await import('@tauri-apps/api/event');
  return listen<AgentEventV1>('hii://agent-event', (event) => handler(event.payload));
}

export async function startTerminalSession(request: {
  sessionId: string;
  cwd: string;
  cols: number;
  rows: number;
}): Promise<TerminalStartResultV1> {
  if (!isTauri()) throw new Error('Native shell terminals are available in the HII desktop app.');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<TerminalStartResultV1>('terminal_start', request);
}

export async function writeTerminalSession(sessionId: string, data: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('terminal_write', { sessionId, data });
}

export async function resizeTerminalSession(sessionId: string, cols: number, rows: number): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('terminal_resize', { sessionId, cols, rows });
}

export async function stopTerminalSession(sessionId: string): Promise<boolean> {
  if (!isTauri()) return false;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<boolean>('terminal_stop', { sessionId });
}

export async function listenTerminalEvents(handlers: {
  output: (event: TerminalOutputV1) => void;
  exit: (event: TerminalExitV1) => void;
}) {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  const [unlistenOutput, unlistenExit] = await Promise.all([
    listen<TerminalOutputV1>('hii://terminal-output', (event) => handlers.output(event.payload)),
    listen<TerminalExitV1>('hii://terminal-exit', (event) => handlers.exit(event.payload))
  ]);
  return () => {
    unlistenOutput();
    unlistenExit();
  };
}

export async function listNotifications(): Promise<HiiNotification[]> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<HiiNotification[]>('notification_list');
  }
  return [];
}

export async function markNotificationRead(id: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('notification_read', { id });
}

export async function listApplications(): Promise<HiiApplicationManifest[]> {
  if (!isTauri()) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  const value = await invoke<{ applications: HiiApplicationManifest[] }>('applications_list');
  return value.applications;
}

export async function listApplicationLaunchRequests(): Promise<ApplicationLaunchRequest[]> {
  if (!isTauri()) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  const value = await invoke<{ requests: ApplicationLaunchRequest[] }>('application_requests');
  return value.requests;
}

export async function acknowledgeApplicationLaunch(id: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('application_acknowledge', { id });
}

export async function getHiiContactCard(): Promise<HiiContactCard | null> {
  if (!isTauri()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<HiiContactCard>('link_contact_card');
}

export async function getHiiVpnStatus(): Promise<HiiVpnStatus | null> {
  if (!isTauri()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<HiiVpnStatus>('link_vpn_status');
}

export async function openHiiLinkHandoff(kind: 'messages' | 'facetime', recipient: string, body = ''): Promise<void> {
  if (!isTauri()) throw new Error('Install HII on macOS to open this handoff.');
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('link_open_handoff', { kind, recipient, body });
}

export async function captureInformation(url: string, workspaceRoot?: string): Promise<InformationCaptureResult> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<InformationCaptureResult>('information_capture', { url, workspaceRoot });
  }
  return developmentRequest<InformationCaptureResult>('/information/capture', {
    method: 'POST',
    body: JSON.stringify({ url, workspaceRoot })
  });
}

export async function findInformation(query: string, options: { web?: boolean; limit?: number } = {}) {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<InformationSearchResult[]>('information_find', {
      query,
      web: Boolean(options.web),
      limit: options.limit || 10
    });
  }
  const value = await developmentRequest<{ results: InformationSearchResult[] }>('/information/find', {
    method: 'POST',
    body: JSON.stringify({ query, web: Boolean(options.web), limit: options.limit || 10 })
  });
  return value.results;
}
