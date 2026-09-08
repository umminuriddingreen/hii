'use client';

import type { WorkspacePersistence } from '@/components/workspace/useWorkspace';
import { ACCOUNT_CANVAS_SYNC_INTERVAL_MS } from '@/lib/workspace/account-sync-timing';
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
  private disposed = false;
  private writing = false;
  private pollEpoch = 0;
  private readonly revisions = new Map<number, WorkspaceDoc>();

  private remember(document: WorkspaceDoc) {
    this.revisions.set(document.revision, document);
    if (this.revisions.size > 64) this.revisions.delete(this.revisions.keys().next().value!);
    if (!this.authoritative || document.revision >= this.authoritative.revision) this.authoritative = document;
  }

  constructor(readonly workspaceId: string) {}

  private async remoteRead() {
    const envelope = await invoke<Envelope<WorkspaceEnvelope>>('account_workspace_read', {
      workspaceId: this.workspaceId
    });
    return normalizeWorkspace(unwrap(envelope).workspace.document);
  }

  async read() {
    const document = await this.remoteRead();
    this.remember(document);
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
    if (this.writing) throw new Error('account_workspace_save_already_running');
    this.writing = true;
    try {
      if (!this.authoritative) await this.read();
      const base = this.revisions.get(document.revision);
      if (!base) throw new Error('account_workspace_revision_not_loaded');
      const first = await this.save(document, document.revision);
      let saved = first.document;
      if (first.conflict) {
        const rebased = rebaseWorkspaceDoc(document, first.document, base);
        const retry = await this.save(rebased, first.document.revision);
        if (retry.conflict) throw new Error('account_workspace_conflict_retry_required');
        saved = retry.document;
      }
      this.remember(saved);
      return saved;
    } finally { this.writing = false; }
  }

  subscribe(listener: (document: WorkspaceDoc) => void, onError?: (error: unknown) => void) {
    this.disposed = false;
    this.listeners.add(listener);
    if (!this.timer) {
      const scope = ++this.pollEpoch;
      this.timer = setInterval(() => {
        if (this.disposed || this.writing || !this.authoritative || (typeof document !== 'undefined' && document.hidden)) return;
        void this.remoteRead().then((next) => {
          if (this.disposed || this.writing || scope !== this.pollEpoch) return;
          if (!this.authoritative || next.revision > this.authoritative.revision) {
            this.remember(next);
            for (const current of this.listeners) current(next);
          }
        }).catch((error) => { if (!this.disposed && scope === this.pollEpoch) onError?.(error); });
      }, ACCOUNT_CANVAS_SYNC_INTERVAL_MS);
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        this.pollEpoch += 1;
      }
    };
  }

  dispose() {
    this.disposed = true;
    this.pollEpoch += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}
