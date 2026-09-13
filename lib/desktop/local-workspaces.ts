'use client';

import { normalizeWorkspace, type WorkspaceDoc } from '@/lib/workspace/types';

export type LocalWorkspaceInventory = {
  selectedWorkspaceId: string;
  workspaces: { id: string; objects: number | null; unreadable: boolean }[];
};

export async function listLocalWorkspaces(): Promise<LocalWorkspaceInventory> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('local_workspace_list');
}

export async function selectLocalWorkspace(workspaceId: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('local_workspace_select', { workspaceId });
}

export async function readLocalWorkspace(workspaceId: string): Promise<WorkspaceDoc> {
  const { invoke } = await import('@tauri-apps/api/core');
  return normalizeWorkspace(await invoke('local_workspace_read', { workspaceId }));
}
