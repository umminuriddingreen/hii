'use client';

import { emptyWorkspace, normalizeWorkspace, type WorkspaceDoc } from '@/lib/workspace/types';
import type { CanvasModeId } from '@/lib/workspace/canvas-modes';

export type AgentRequestV1 = {
  version: 1;
  intent: string;
  mode?: CanvasModeId;
  workspaceRoot?: string;
  contextNodeIds: string[];
  context?: Record<string, unknown>;
};

export type AgentStartResult = { runId: string };
export type AgentEventV1 = {
  version: 1;
  runId: string;
  status: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';
  text?: string;
  receiptPath?: string;
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

export async function readWorkspace(): Promise<WorkspaceDoc> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return normalizeWorkspace(await invoke('workspace_read'));
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
    return normalizeWorkspace(await invoke('workspace_write', { document }));
  }
  localStorage.setItem('hii.workspace.v2', JSON.stringify(document));
  return document;
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
