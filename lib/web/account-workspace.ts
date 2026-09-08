'use client';

import type { WorkspacePersistence } from '@/components/workspace/useWorkspace';
import { rebaseWorkspaceDoc } from '@/lib/workspace/rebase';
import { normalizeWorkspace, type WorkspaceDoc } from '@/lib/workspace/types';

export type AccountWorkspaceRole = 'owner' | 'admin' | 'editor' | 'viewer';

export type AccountWorkspaceSummary = {
  id: string;
  ownerAccountId: string;
  name: string;
  role: AccountWorkspaceRole;
  revision: number;
  updatedAt: number;
};

export type AccountWorkspace = AccountWorkspaceSummary & {
  createdAt: number;
  document: WorkspaceDoc;
};

export type AccountWorkspaceMember = {
  accountId: string;
  handle: string;
  role: AccountWorkspaceRole;
  grantedBy: string;
  createdAt: number;
};

export type AccountDevice = {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt?: number;
};

type WorkspaceEnvelope = { workspace: AccountWorkspace };

async function responseJson<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error || `workspace_request_${response.status}`);
  return value;
}

async function request<T>(path: string, options: RequestInit = {}, csrfToken = ''): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-HII-CSRF': csrfToken } : {}),
      ...(options.headers || {})
    }
  });
  return responseJson<T>(response);
}

function normalizeEnvelope(value: WorkspaceEnvelope): AccountWorkspace {
  return { ...value.workspace, document: normalizeWorkspace(value.workspace.document) };
}

export async function listAccountWorkspaces(): Promise<AccountWorkspaceSummary[]> {
  const value = await request<{ workspaces: AccountWorkspaceSummary[] }>('/api/workspaces');
  return value.workspaces;
}

export async function createAccountWorkspace(name: string, csrfToken: string): Promise<AccountWorkspace> {
  return normalizeEnvelope(await request<WorkspaceEnvelope>('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name })
  }, csrfToken));
}

export async function createWorkspaceShareCode(
  workspaceId: string,
  csrfToken: string,
  role: Exclude<AccountWorkspaceRole, 'owner'> = 'admin'
) {
  return request<{ shareId: string; code: string; expiresAt: number; role: string; singleUse: boolean }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/share-codes`,
    { method: 'POST', body: JSON.stringify({ role, ttlSeconds: 15 * 60 }) },
    csrfToken
  );
}

export async function redeemWorkspaceShareCode(code: string, csrfToken: string): Promise<AccountWorkspace> {
  return normalizeEnvelope(await request<WorkspaceEnvelope>('/api/workspaces/share-codes/redeem', {
    method: 'POST',
    body: JSON.stringify({ code })
  }, csrfToken));
}

export async function listWorkspaceMembers(workspaceId: string): Promise<AccountWorkspaceMember[]> {
  const value = await request<{ members: AccountWorkspaceMember[] }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/members`
  );
  return value.members;
}

export async function revokeWorkspaceMember(workspaceId: string, accountId: string, csrfToken: string) {
  await request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(accountId)}`,
    { method: 'DELETE' },
    csrfToken
  );
}

export async function createAccountDeviceLinkCode(csrfToken: string) {
  return request<{ code: string; expiresAt: number; singleUse: boolean }>(
    '/api/devices/link-codes',
    { method: 'POST', body: '{}' },
    csrfToken
  );
}

export async function listAccountDevices(): Promise<AccountDevice[]> {
  const value = await request<{ devices: AccountDevice[] }>('/api/devices');
  return value.devices;
}

export async function revokeAccountDevice(deviceId: string, csrfToken: string) {
  await request(`/api/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' }, csrfToken);
}

export class AccountWorkspacePersistence implements WorkspacePersistence {
  private authoritative: WorkspaceDoc | null = null;
  private readonly listeners = new Set<(document: WorkspaceDoc) => void>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private writing = false;
  private pollEpoch = 0;
  private readonly revisions = new Map<number, WorkspaceDoc>();

  private remember(document: WorkspaceDoc) {
    this.revisions.set(document.revision, document);
    if (this.revisions.size > 64) this.revisions.delete(this.revisions.keys().next().value!);
    if (!this.authoritative || document.revision >= this.authoritative.revision) this.authoritative = document;
  }

  constructor(
    readonly workspaceId: string,
    private readonly csrfToken: string,
    private readonly hydrate?: (document: WorkspaceDoc) => Promise<WorkspaceDoc>
  ) {}

  private async load(): Promise<WorkspaceDoc> {
    const envelope = await request<WorkspaceEnvelope>(
      `/api/workspaces/${encodeURIComponent(this.workspaceId)}`
    );
    const normalized = normalizeWorkspace(envelope.workspace.document);
    return this.hydrate ? this.hydrate(normalized) : normalized;
  }

  async read(): Promise<WorkspaceDoc> {
    const document = await this.load();
    this.remember(document);
    return document;
  }

  private async save(document: WorkspaceDoc, expectedRevision: number) {
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(this.workspaceId)}/document`,
      {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-HII-CSRF': this.csrfToken },
        body: JSON.stringify({ expectedRevision, document })
      }
    );
    const envelope = await response.json().catch(() => ({})) as WorkspaceEnvelope & { error?: string };
    if (response.status !== 409 && !response.ok) {
      throw new Error(envelope.error || `workspace_request_${response.status}`);
    }
    if (!envelope.workspace) throw new Error('workspace_response_invalid');
    return { conflict: response.status === 409, document: normalizeWorkspace(envelope.workspace.document) };
  }

  async write(document: WorkspaceDoc): Promise<WorkspaceDoc> {
    if (this.writing) throw new Error('workspace_save_already_running');
    this.writing = true;
    try {
      if (!this.authoritative) await this.read();
      const base = this.revisions.get(document.revision);
      if (!base) throw new Error('workspace_revision_not_loaded');
      const first = await this.save(document, document.revision);
      let saved = first.document;
      if (first.conflict) {
        const rebased = rebaseWorkspaceDoc(document, first.document, base);
        const retry = await this.save(rebased, first.document.revision);
        if (retry.conflict) throw new Error('workspace_conflict_retry_required');
        saved = retry.document;
      }
      this.remember(saved);
      return this.hydrate ? await this.hydrate(saved) : saved;
    } finally { this.writing = false; }
  }

  subscribe(listener: (document: WorkspaceDoc) => void, onError?: (error: unknown) => void) {
    this.disposed = false;
    this.listeners.add(listener);
    if (!this.pollTimer) {
      const scope = ++this.pollEpoch;
      this.pollTimer = setInterval(() => {
        if (this.disposed || this.writing || !this.authoritative || (typeof document !== 'undefined' && document.hidden)) return;
        void this.load().then((next) => {
          if (this.disposed || this.writing || scope !== this.pollEpoch) return;
          if (!this.authoritative || next.revision > this.authoritative.revision) {
            this.remember(next);
            for (const current of this.listeners) current(next);
          }
        }).catch((error) => { if (!this.disposed && scope === this.pollEpoch) onError?.(error); });
      }, 2_000);
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.pollEpoch += 1;
      }
    };
  }

  dispose() {
    this.disposed = true;
    this.pollEpoch += 1;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.listeners.clear();
  }
}
