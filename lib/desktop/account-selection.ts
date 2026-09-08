'use client';

export type AccountWorkspaceSelection = {
  deviceId: string;
  workspaceId: string | null;
  configured: boolean;
};

export async function readAccountWorkspaceSelection(): Promise<AccountWorkspaceSelection> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('account_workspace_selection_get');
}

export async function saveAccountWorkspaceSelection(workspaceId: string | null): Promise<AccountWorkspaceSelection> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('account_workspace_selection_set', { workspaceId });
}

export function resolveAccountWorkspaceSelection(
  selection: AccountWorkspaceSelection,
  workspaces: { id: string; role: string }[]
): string {
  if (selection.configured) {
    if (selection.workspaceId === null) return 'local';
    if (!workspaces.some((workspace) => workspace.id === selection.workspaceId)) {
      throw new Error('The selected account workspace is unavailable. Choose another workspace.');
    }
    return selection.workspaceId;
  }
  return workspaces.find((workspace) => workspace.role === 'owner')?.id ?? workspaces[0]?.id ?? 'local';
}
