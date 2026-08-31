'use client';

import type { WorkspacePersistence } from '@/components/workspace/useWorkspace';
import { rebaseWorkspaceDoc } from '@/lib/workspace/rebase';
import { normalizeWorkspace, type WorkspaceDoc } from '@/lib/workspace/types';

export type NativeAccountSyncStatus = {
  linked: boolean;
  deviceId?: string;
  api: string;
};

export type NativeAccountWorkspace = {
  id: string;
  ownerAccountId: string;
  name: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  revision: number;
  updatedAt: number;
};

type Envelope<T> = { status: number; body: T & { error?: string } };
type WorkspaceEnvelope = { workspace: NativeAccountWorkspace & { document: WorkspaceDoc } };

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const tauri = await import('@tauri-apps/api/core');
  return tauri.invoke<T>(command, args);
}

function unwrap<T>(envelope: Envelope<T>, expected = 200): T {
  if (envelope.status !== expected) {
    throw new Error(envelope.body.error || `account_sync_${envelope.status}`);
  }
  return envelope.body;
}

export function accountSyncStatus() {
  return invoke<NativeAccountSyncStatus>('account_sync_status');
}

export function linkAccountSync(code: string, deviceName: string) {
  return invoke<{ linked: boolean; deviceId: string }>('account_sync_link', { code, deviceName });
}

export async function listNativeAccountWorkspaces() {
  const envelope = await invoke<Envelope<{
    account: { handle: string };
    device: { id: string; name: string };
    workspaces: NativeAccountWorkspace[];
  }>>('account_workspace_list');
  return unwrap(envelope);
}

export class NativeAccountWorkspacePersistence implements WorkspacePersistence {
  private authoritative: WorkspaceDoc | null = null;
  private readonly listeners = new Set<(document: WorkspaceDoc) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly workspaceId: string) {}

  private async remoteRead() {
    const envelope = await invoke<Envelope<WorkspaceEnvelope>>('account_workspace_read', {
      workspaceId: this.workspaceId
    });
    return normalizeWorkspace(unwrap(envelope).workspace.document);
  }

  async read() {
    const document = await this.remoteRead();
    this.authoritative = document;
    return document;
  }

  private async save(document: WorkspaceDoc, expectedRevision: number) {
    const envelope = await invoke<Envelope<WorkspaceEnvelope>>('account_workspace_write', {
      workspaceId: this.workspaceId,
      expectedRevision,
      document
    });
    if (envelope.status !== 200 && envelope.status !== 409) {
      throw new Error(envelope.body.error || `account_sync_${envelope.status}`);
    }
    return {
      conflict: envelope.status === 409,
      document: normalizeWorkspace(envelope.body.workspace.document)
    };
  }

  async write(document: WorkspaceDoc) {
    const base = this.authoritative ?? await this.read();
    const first = await this.save(document, base.revision);
    let saved = first.document;
    if (first.conflict) {
      const rebased = rebaseWorkspaceDoc(document, first.document, base);
      const retry = await this.save(rebased, first.document.revision);
      if (retry.conflict) throw new Error('account_workspace_conflict_retry_required');
      saved = retry.document;
    }
    this.authoritative = saved;
    return saved;
  }

  subscribe(listener: (document: WorkspaceDoc) => void) {
    this.listeners.add(listener);
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        void this.remoteRead().then((next) => {
          if (!this.authoritative || next.revision > this.authoritative.revision) {
            this.authoritative = next;
            for (const current of this.listeners) current(next);
          }
        }).catch(() => undefined);
      }, 2_000);
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}
