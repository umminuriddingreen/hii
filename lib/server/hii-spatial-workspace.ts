import 'server-only';
import { listCapabilities } from '@/lib/capabilities';
import { listCapabilityJobs } from '@/lib/capabilities/local-store';
import type { CapabilityJobStatus, CapabilityStatus } from '@/lib/capabilities/types';
import type { WorkspaceNode, SpatialObjectStatus, WorkspaceDoc } from '@/lib/workspace/types';
import { emptyWorkspace } from '@/lib/workspace/types';
import { listBoardTasks, type BoardLane } from './hii-board';
import { getHiiDaemonSnapshot, type HiiDaemonEvent, type HiiDaemonRun } from './hii-daemon';

type SpatialSnapshotNode = WorkspaceNode & {
  id: string;
};

const generatedAt = () => new Date().toISOString();

const statusFromLane: Record<BoardLane, SpatialObjectStatus> = {
  backlog: 'proposed',
  next: 'queued',
  doing: 'running',
  blocked: 'blocked',
  done: 'completed'
};

const statusFromCapability: Record<CapabilityStatus, SpatialObjectStatus> = {
  ready: 'ready',
  partial: 'partial',
  blocked: 'blocked',
  planned: 'planned'
};

const statusFromJob: Record<CapabilityJobStatus, SpatialObjectStatus> = {
  queued: 'queued',
  running: 'running',
  waiting_approval: 'waiting_approval',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'archived'
};

function nodeBase(input: {
  id: string;
  type?: WorkspaceNode['type'];
  x: number;
  y: number;
  w?: number;
  h?: number;
  z: number;
  createdAt?: string;
  updatedAt?: string;
}): Omit<SpatialSnapshotNode, 'payload'> {
  const now = generatedAt();
  return {
    id: input.id,
    type: input.type ?? 'job',
    x: input.x,
    y: input.y,
    w: input.w ?? 360,
    h: input.h ?? 240,
    z: input.z,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? input.createdAt ?? now
  };
}

function daemonRunNode(run: HiiDaemonRun, index: number): SpatialSnapshotNode {
  return {
    ...nodeBase({
      id: `run:${run.id}`,
      x: 48,
      y: 48 + index * 280,
      z: 100 + index,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt
    }),
    object: {
      kind: 'agent',
      owner: 'HII daemon',
      status: normalizeStatus(run.status),
      source: 'hiid',
      runId: run.id,
      proofRefs: run.log ? [run.log] : undefined,
      audit: [
        { ts: run.createdAt, actor: 'hii', action: 'run.created' },
        { ts: run.updatedAt, actor: 'hii', action: `run.${run.status}` }
      ]
    },
    payload: {
      title: run.title || `Codex run ${run.id}`,
      status: run.status,
      command: run.kind,
      coordinate: run.coordinate,
      prompt: run.prompt.slice(0, 1200),
      log: run.log,
      nextAction: run.status === 'completed' ? 'inspect proof and approve or archive' : 'inspect logs before taking action'
    }
  };
}

function daemonEventNode(event: HiiDaemonEvent, index: number): SpatialSnapshotNode {
  return {
    ...nodeBase({
      id: `event:${event.id}`,
      type: 'note',
      x: 456,
      y: 48 + index * 220,
      w: 340,
      h: 180,
      z: 200 + index,
      createdAt: event.ts,
      updatedAt: event.ts
    }),
    object: {
      kind: 'event',
      owner: event.actor || event.source || 'hii',
      status: normalizeStatus(event.status),
      source: event.source,
      runId: event.target,
      audit: [{ ts: event.ts, actor: 'hii', action: event.type, note: event.text }]
    },
    payload: {
      title: `${event.type}${event.status ? ` · ${event.status}` : ''}`,
      content: [event.text, event.target ? `target: ${event.target}` : '', event.loop ? `loop: ${event.loop}` : '', event.ts]
        .filter(Boolean)
        .join('\n')
    }
  };
}

function normalizeStatus(value: unknown): SpatialObjectStatus {
  const status = String(value ?? 'unknown');
  if (
    [
      'proposed',
      'queued',
      'running',
      'waiting_approval',
      'blocked',
      'failed',
      'completed',
      'approved',
      'rejected',
      'archived',
      'ready',
      'partial',
      'planned'
    ].includes(status)
  ) {
    return status as SpatialObjectStatus;
  }
  if (status === 'stopped' || status === 'cancelled') return 'archived';
  return 'unknown';
}

function modelNodes(startZ: number): SpatialSnapshotNode[] {
  const models = [
    {
      id: 'fast-local',
      title: 'fast-local',
      use: 'cheap classification, short summaries, log triage',
      trust: 'local-first',
      speed: 'fast',
      cost: 'local compute'
    },
    {
      id: 'qwen-work',
      title: 'qwen-work',
      use: 'bounded implementation planning and candidate ranking',
      trust: 'local-first',
      speed: 'balanced',
      cost: 'local compute'
    },
    {
      id: 'qwen-deep',
      title: 'qwen-deep',
      use: 'slower reasoning passes and architecture review',
      trust: 'local-first',
      speed: 'slow',
      cost: 'local compute'
    },
    {
      id: 'gemma-write',
      title: 'gemma-write',
      use: 'rewrite drafts, concise status text, copy polishing',
      trust: 'local-first',
      speed: 'fast',
      cost: 'local compute'
    }
  ];
  return models.map((model, index) => ({
    ...nodeBase({
      id: `model:${model.id}`,
      x: 864,
      y: 48 + index * 188,
      w: 320,
      h: 148,
      z: startZ + index,
      createdAt: generatedAt(),
      updatedAt: generatedAt()
    }),
    object: {
      kind: 'model',
      owner: 'HII',
      status: 'ready',
      source: 'local model registry',
      audit: [{ ts: generatedAt(), actor: 'hii', action: 'model.snapshot' }]
    },
    payload: model
  }));
}

export async function getSpatialWorkspaceSnapshot(): Promise<WorkspaceDoc & { source: string; summary: Record<string, number> }> {
  const [tasks, jobs, daemon] = await Promise.all([
    listBoardTasks({ includeDone: false }),
    listCapabilityJobs({ limit: 20 }),
    getHiiDaemonSnapshot()
  ]);
  const capabilities = listCapabilities();
  const now = generatedAt();

  const taskNodes: SpatialSnapshotNode[] = tasks.slice(0, 24).map((task, index) => ({
    ...nodeBase({
      id: `task:${task.id}`,
      x: 48 + (index % 3) * 392,
      y: 960 + Math.floor(index / 3) * 248,
      z: 300 + index,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    }),
    object: {
      kind: 'task',
      owner: task.owner,
      status: task.reviewState === 'proposed' ? 'proposed' : statusFromLane[task.lane],
      source: task.source,
      memoryRefs: task.tags,
      audit: [
        { ts: task.createdAt, actor: task.origin ?? 'system', action: 'task.created' },
        ...(task.approvedAt
          ? [{ ts: task.approvedAt, actor: 'human' as const, action: 'task.approved', note: task.approvedBy }]
          : []),
        { ts: task.updatedAt, actor: 'hii', action: `task.${task.lane}` }
      ]
    },
    payload: {
      title: task.title,
      lane: task.lane,
      priority: task.priority,
      coordinate: task.coordinate,
      notes: task.notes,
      origin: task.origin ?? 'legacy',
      reviewState: task.reviewState ?? 'approved',
      requestedLane: task.requestedLane,
      nextAction: task.reviewState === 'proposed'
        ? 'review provenance and approve or archive'
        : task.lane === 'done'
          ? 'archive or attach proof'
          : 'choose model, assign agent, or mark blocked'
    }
  }));

  const capabilityNodes: SpatialSnapshotNode[] = capabilities.slice(0, 24).map((capability, index) => ({
    ...nodeBase({
      id: `capability:${capability.id}`,
      x: 1280 + (index % 2) * 392,
      y: 48 + Math.floor(index / 2) * 220,
      z: 400 + index,
      w: 360,
      h: 180,
      createdAt: now,
      updatedAt: now
    }),
    object: {
      kind: 'capability',
      owner: capability.owner,
      status: statusFromCapability[capability.status],
      source: capability.runtime,
      capabilityId: capability.id,
      audit: [{ ts: now, actor: 'hii', action: 'capability.snapshot' }]
    },
    payload: {
      title: capability.name,
      summary: capability.summary,
      visibility: capability.visibility,
      trustLevel: capability.trustLevel,
      permissions: capability.permissions,
      evidence: capability.evidence
    }
  }));

  const receiptNodes: SpatialSnapshotNode[] = jobs.slice(0, 16).map((job, index) => ({
    ...nodeBase({
      id: `receipt:${job.id}`,
      x: 2088,
      y: 48 + index * 228,
      z: 500 + index,
      w: 380,
      h: 188,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    }),
    object: {
      kind: 'receipt',
      owner: job.userId || 'hii',
      status: statusFromJob[job.status],
      source: 'capability job store',
      capabilityId: job.capabilityId,
      runId: job.id,
      proofRefs: job.proofArtifacts.map((artifact) => artifact.path || artifact.href || artifact.id).filter(Boolean),
      audit: [
        { ts: job.createdAt, actor: 'hii', action: 'job.created' },
        { ts: job.updatedAt, actor: 'hii', action: `job.${job.status}` }
      ]
    },
    payload: {
      title: job.inputSummary,
      capabilityId: job.capabilityId,
      status: job.status,
      logs: job.logs.slice(-5),
      ledger: job.ledger.slice(-5),
      proofArtifacts: job.proofArtifacts
    }
  }));

  const nodes = [
    ...daemon.runs.slice(0, 8).map(daemonRunNode),
    ...daemon.events.slice(0, 8).map(daemonEventNode),
    ...modelNodes(600),
    ...taskNodes,
    ...capabilityNodes,
    ...receiptNodes
  ];

  return {
    ...emptyWorkspace(),
    updatedAt: now,
    nextZ: nodes.length + 1000,
    nodes,
    source: 'hii spatial control plane snapshot',
    summary: {
      agents: daemon.runs.length,
      events: daemon.events.length,
      tasks: tasks.length,
      capabilities: capabilities.length,
      receipts: jobs.length,
      models: 4
    }
  };
}
