import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readWorkspace, writeWorkspace } from './workspace-store.ts';
import type { SpatialObjectStatus, WorkspaceDoc, WorkspaceNode } from '../workspace/types.ts';

type SystemTransport = 'ssh' | 'local' | 'tailscale' | 'manual';
type JobStatus = 'queued' | 'running' | 'blocked' | 'failed' | 'completed' | 'unknown';

export type SystemSyncInput = {
  system?: {
    id?: unknown;
    label?: unknown;
    address?: unknown;
    transport?: unknown;
  };
  terminal?: {
    sessionId?: unknown;
    title?: unknown;
    cwd?: unknown;
    status?: unknown;
    lines?: unknown;
  };
  job?: {
    id?: unknown;
    title?: unknown;
    status?: unknown;
    proofRefs?: unknown;
  };
  workspaceId?: unknown;
};

type SyncedSystem = {
  id: string;
  label: string;
  address: string | null;
  transport: SystemTransport;
  updatedAt: string;
};

type SyncedTerminal = {
  id: string;
  systemId: string;
  title: string;
  cwd: string;
  status: JobStatus;
  lines: string[];
  jobId: string | null;
  proofRefs: string[];
  nodeId: string;
  updatedAt: string;
};

type SystemSyncDocument = {
  version: 1;
  revision: number;
  updatedAt: string;
  systems: Record<string, SyncedSystem>;
  terminals: Record<string, SyncedTerminal>;
};

const transports: SystemTransport[] = ['ssh', 'local', 'tailscale', 'manual'];
const statuses: JobStatus[] = ['queued', 'running', 'blocked', 'failed', 'completed', 'unknown'];
let writeQueue: Promise<void> = Promise.resolve();

function runtimeDir() {
  return process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
}

function clean(value: unknown, max = 240) {
  return String(value ?? '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanId(value: unknown, fallback: string) {
  const cleaned = clean(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
}

function keyId(secret: string) {
  if (secret.length < 20 || secret.length > 512) {
    throw new Error('System sync key must be 20 to 512 characters.');
  }
  return createHash('sha256').update(secret).digest('hex');
}

function syncPath(secret: string) {
  return path.join(runtimeDir(), 'system-sync', `${keyId(secret)}.json`);
}

function emptyDocument(): SystemSyncDocument {
  return {
    version: 1,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    systems: {},
    terminals: {}
  };
}

async function load(secret: string): Promise<SystemSyncDocument> {
  try {
    const parsed = JSON.parse(await readFile(syncPath(secret), 'utf8')) as SystemSyncDocument;
    return parsed.version === 1 && parsed.systems && parsed.terminals ? parsed : emptyDocument();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDocument();
    throw error;
  }
}

async function persist(secret: string, document: SystemSyncDocument) {
  const file = syncPath(secret);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function normalizedLines(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((line) => clean(line, 500))
    .filter(Boolean)
    .slice(-20);
}

function normalizedProofRefs(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((ref) => clean(ref, 500))
    .filter(Boolean)
    .slice(0, 12);
}

function nodeIdFor(systemId: string, terminalId: string) {
  const digest = createHash('sha256').update(`${systemId}:${terminalId}`).digest('hex').slice(0, 18);
  return `system-sync-${digest}`;
}

function statusForWorkspace(status: JobStatus): SpatialObjectStatus {
  if (status === 'queued') return 'queued';
  if (status === 'running') return 'running';
  if (status === 'blocked') return 'blocked';
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'completed';
  return 'unknown';
}

function buildTerminalNode(input: {
  system: SyncedSystem;
  terminal: SyncedTerminal;
  existing?: WorkspaceNode;
  z: number;
}): WorkspaceNode {
  const now = input.terminal.updatedAt;
  const title = input.terminal.title || `${input.system.label} terminal`;
  return {
    id: input.terminal.nodeId,
    type: 'terminal',
    x: input.existing?.x ?? 120,
    y: input.existing?.y ?? 120,
    w: input.existing?.w ?? 680,
    h: input.existing?.h ?? 440,
    z: input.existing?.z ?? input.z,
    createdAt: input.existing?.createdAt ?? now,
    updatedAt: now,
    object: {
      kind: 'terminal',
      owner: input.system.id,
      status: statusForWorkspace(input.terminal.status),
      source: `HII system sync via ${input.system.transport}`,
      capabilityId: 'hii.system.sync',
      runId: input.terminal.jobId ?? undefined,
      proofRefs: input.terminal.proofRefs.length ? input.terminal.proofRefs : undefined,
      audit: [
        ...(input.existing?.object?.audit ?? []).slice(-12),
        {
          ts: now,
          actor: 'system' as const,
          action: `synced ${input.system.label} terminal`,
          note: 'Observation only. HII did not execute a remote command through this sync.'
        }
      ]
    },
    payload: {
      title,
      job: input.terminal.jobId ?? title,
      cwd: input.terminal.cwd,
      status: input.terminal.status,
      role: 'system-terminal',
      scope: `${input.system.label} · ${input.system.transport}${input.system.address ? ` · ${input.system.address}` : ''}`,
      sessionId: input.terminal.id,
      systemId: input.system.id,
      systemLabel: input.system.label,
      systemAddress: input.system.address,
      transport: input.system.transport,
      proofRefs: input.terminal.proofRefs,
      lines: input.terminal.lines.length
        ? input.terminal.lines
        : ['HII system sync attached.', 'No terminal output has been reported yet.']
    }
  };
}

async function upsertWorkspaceNode(workspaceId: string | undefined, system: SyncedSystem, terminal: SyncedTerminal) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const workspace = await readWorkspace(workspaceId);
    const existing = workspace.nodes.find((node) => node.id === terminal.nodeId);
    const node = buildTerminalNode({
      system,
      terminal,
      existing,
      z: workspace.nextZ
    });
    const next: WorkspaceDoc = {
      ...workspace,
      nextZ: existing ? workspace.nextZ : Math.max(workspace.nextZ + 1, node.z + 1),
      nodes: existing
        ? workspace.nodes.map((candidate) => candidate.id === node.id ? node : candidate)
        : [...workspace.nodes, node]
    };
    try {
      return await writeWorkspace(next, workspace.revision, workspaceId);
    } catch (error) {
      if ((error as { code?: string }).code !== 'WORKSPACE_REVISION_CONFLICT' || attempt === 2) throw error;
    }
  }
  throw new Error('Could not attach system sync to the workspace.');
}

export async function readSystemSync(secret: string) {
  return load(secret);
}

export async function attachSystemSync(secret: string, input: SystemSyncInput) {
  const previous = writeQueue;
  let release = () => {};
  writeQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const now = new Date().toISOString();
    const systemId = cleanId(input.system?.id, 'system');
    const label = clean(input.system?.label, 120) || systemId;
    const transport = transports.includes(input.system?.transport as SystemTransport)
      ? input.system?.transport as SystemTransport
      : 'manual';
    const address = clean(input.system?.address, 160) || null;
    const terminalId = cleanId(input.terminal?.sessionId, 'terminal');
    const reportedStatus = input.terminal?.status ?? input.job?.status;
    const status = statuses.includes(reportedStatus as JobStatus)
      ? reportedStatus as JobStatus
      : 'unknown';
    const jobId = clean(input.job?.id, 160) || null;
    const terminal: SyncedTerminal = {
      id: terminalId,
      systemId,
      title: clean(input.terminal?.title ?? input.job?.title, 160) || `${label} terminal`,
      cwd: clean(input.terminal?.cwd, 500) || '~',
      status,
      lines: normalizedLines(input.terminal?.lines),
      jobId,
      proofRefs: normalizedProofRefs(input.job?.proofRefs),
      nodeId: nodeIdFor(systemId, terminalId),
      updatedAt: now
    };
    const system: SyncedSystem = { id: systemId, label, address, transport, updatedAt: now };
    const document = await load(secret);
    document.systems[systemId] = system;
    document.terminals[`${systemId}:${terminalId}`] = terminal;
    document.revision += 1;
    document.updatedAt = now;
    await persist(secret, document);
    const workspaceId = clean(input.workspaceId, 64) || undefined;
    const workspace = await upsertWorkspaceNode(workspaceId, system, terminal);
    return { document, workspace, nodeId: terminal.nodeId, system, terminal };
  } finally {
    release();
  }
}
