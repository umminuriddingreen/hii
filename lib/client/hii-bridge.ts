'use client';

import { emptyWorkspace, normalizeWorkspace, type WorkspaceDoc } from '@/lib/workspace/types';

export type AgentRequestV1 = {
  version: 1;
  intent: string;
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
  if (!isTauri()) throw new Error('Agent execution is available in the HII desktop app.');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<AgentStartResult>('agent_start', { request });
}

export async function cancelAgent(runId: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('agent_cancel', { runId });
}

export async function listenAgentEvents(handler: (event: AgentEventV1) => void) {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<AgentEventV1>('hii://agent-event', (event) => handler(event.payload));
}
