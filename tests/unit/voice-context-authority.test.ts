import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { WorkspaceDoc, WorkspaceNode } from '@/lib/workspace/types';

const queueApprovedWorkspaceRun = vi.fn(async () => ({ job: { id: 'run-1', proofArtifacts: [], status: 'queued' } }));
const previewWorkspaceRunContext = vi.fn(async () => ({
  blocked: false,
  blockers: [],
  fingerprint: 'fp',
  summary: {},
  items: []
}));

vi.mock('@/lib/server/hii-workspace-runs', () => ({
  discoverWorkspaceRunModels: vi.fn(async () => ({
    available: true,
    defaultModel: 'test-model',
    models: ['test-model'],
    source: 'environment',
    message: 'mocked model'
  })),
  getWorkspaceRun: vi.fn(async () => null),
  previewWorkspaceRunContext,
  queueApprovedWorkspaceRun,
  requestWorkspaceRunCancellation: vi.fn(async () => ({ queued: false, terminal: true, job: { status: 'cancelled' } }))
}));

vi.mock('@/lib/server/hii-ecosystem', () => ({
  recordEcosystemEvent: vi.fn(async () => ({ id: 'mock-event' }))
}));

vi.mock('@/lib/capabilities/local-store', () => ({
  appendCapabilityJob: vi.fn(async () => undefined),
  listCapabilityJobs: vi.fn(async () => [])
}));

vi.mock('@/lib/voice/context', () => ({
  buildVoiceContextSnapshot: vi.fn(async () => ({
    snapshotAt: new Date().toISOString(),
    platform: 'mac',
    projectPath: '/tmp/hii-project'
  })),
  normalizeContextReferences: vi.fn(() => [])
}));

const workspaceDoc: { current: WorkspaceDoc } = {
  current: {
    version: 1,
    revision: 7,
    updatedAt: new Date().toISOString(),
    viewport: { x: 0, y: 0, zoom: 1 },
    nextZ: 3,
    nodes: [],
    links: []
  }
};

vi.mock('@/lib/server/workspace-store', () => ({
  readWorkspace: vi.fn(async () => workspaceDoc.current)
}));

function node(id: string, payload: Record<string, unknown>, type = 'note'): WorkspaceNode {
  return {
    id,
    type: type as WorkspaceNode['type'],
    x: 0,
    y: 0,
    w: 320,
    h: 200,
    z: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    payload
  };
}

async function withRuntime<T>(action: (runtimeDir: string, voice: typeof import('@/lib/server/hii-voice')) => Promise<T>) {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-voice-authority-'));
  const original = process.env.HII_RUNTIME_DIR;
  process.env.HII_RUNTIME_DIR = runtimeDir;
  try {
    vi.resetModules();
    const voice = await import('@/lib/server/hii-voice');
    await fs.mkdir(path.join(runtimeDir, 'voice'), { recursive: true });
    return await action(runtimeDir, voice);
  } finally {
    if (original === undefined) delete process.env.HII_RUNTIME_DIR;
    else process.env.HII_RUNTIME_DIR = original;
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe('voice context authority', () => {
  beforeEach(() => {
    queueApprovedWorkspaceRun.mockClear();
    previewWorkspaceRunContext.mockClear();
    workspaceDoc.current = { ...workspaceDoc.current, nodes: [] };
  });

  afterEach(() => {
    delete process.env.HII_RUNTIME_DIR;
  });

  it('resolves spoken context from the persisted workspace and reports what is missing', async () => {
    workspaceDoc.current = {
      ...workspaceDoc.current,
      nodes: [
        node('node-a', { title: 'Kitchen plan', content: 'north wall is load bearing', path: 'docs/kitchen.md' }),
        node('scene-1', { title: 'Review scene' }, 'frame')
      ]
    };

    await withRuntime(async (_dir, voice) => {
      const state = await voice.interpretVoiceInput('change the north wall detail', {
        utterance: 'change the north wall detail',
        workspace: { nodeIds: ['node-a', 'ghost-node'], sceneId: 'scene-1' }
      });

      expect(state.workspaceContext.resolvedCount).toBe(1);
      expect(state.workspaceContext.unresolvedNodeIds).toEqual(['ghost-node']);
      expect(state.workspaceContext.notice).toContain('could not be found');

      const proposal = state.proposal!;
      expect(proposal.context).toHaveLength(1);
      expect(proposal.context?.[0]).toMatchObject({ id: 'node-a', title: 'Kitchen plan', source: 'docs/kitchen.md' });
      expect(proposal.contextSnapshot.workspace?.selectedNodeIds).toEqual(['node-a']);
      expect(proposal.contextSnapshot.workspace?.sceneTitle).toBe('Review scene');
    });
  });

  it('carries the reviewed context into the queued run instead of an empty set', async () => {
    workspaceDoc.current = {
      ...workspaceDoc.current,
      nodes: [node('node-a', { title: 'Kitchen plan', content: 'north wall', path: 'docs/kitchen.md' })]
    };

    await withRuntime(async (_dir, voice) => {
      const state = await voice.interpretVoiceInput('change the north wall detail', {
        utterance: 'change the north wall detail',
        workspace: { nodeIds: ['node-a'] }
      });
      await voice.executeVoiceProposal({ proposalId: state.proposalId!, requestedBy: 'test' });

      const queued = queueApprovedWorkspaceRun.mock.calls[0][0] as { context: unknown[] };
      expect(queued.context).toHaveLength(1);
      expect(queued.context[0]).toMatchObject({ id: 'node-a' });

      const previewed = previewWorkspaceRunContext.mock.calls[0][0] as { context: unknown[] };
      expect(previewed.context).toHaveLength(1);
    });
  });

  it('never leaves a spoken action executable without approval', async () => {
    await withRuntime(async (_dir, voice) => {
      const state = await voice.interpretVoiceInput('open the workspace', {
        utterance: 'open the workspace'
      });
      expect(state.requiresUserAction).toBe(true);
      expect(state.queuedRunId).toBeUndefined();
      expect(state.proposal?.status).toBe('pending');
      expect(queueApprovedWorkspaceRun).not.toHaveBeenCalled();
    });
  });

  it('reports browser speech as browser-managed rather than local-only', async () => {
    await withRuntime(async (_dir, voice) => {
      const snapshot = await voice.snapshotVoiceRuntimeState();
      const engine = snapshot.activeEngines[0];
      expect(engine.speechProcessing).toBe('browser-managed');
      // No field may assert local-only privacy; only the notice may mention the phrase, to deny it.
      expect(Object.values(engine)).not.toContain('local-only');
      expect(engine.privacyNotice).toMatch(/not local-only/i);
    });
  });
});

describe('voice proposal persistence', () => {
  afterEach(() => {
    delete process.env.HII_RUNTIME_DIR;
  });

  it('keeps every proposal when concurrent status transitions race', async () => {
    await withRuntime(async (runtimeDir, voice) => {
      const proposalsPath = path.join(runtimeDir, 'voice', 'proposals.jsonl');
      const ids = Array.from({ length: 8 }, (_, index) => `proposal-${index + 1}`);
      await fs.writeFile(
        proposalsPath,
        `${ids
          .map((id) =>
            JSON.stringify({
              id,
              contextSnapshot: { snapshotAt: new Date().toISOString(), platform: 'mac' },
              utterance: `utterance ${id}`,
              normalizedText: `utterance ${id}`,
              mode: 'act',
              confidence: 0.9,
              purpose: 'act via voice intent',
              capabilityId: 'hii.agent.workspace_run',
              inputs: {},
              createdAt: new Date().toISOString(),
              status: 'pending'
            })
          )
          .join('\n')}\n`,
        'utf8'
      );

      await Promise.all(
        ids.map((id) => voice.cancelVoiceProposal({ proposalId: id, reason: `cancel ${id}`, requestedBy: 'test' }))
      );

      const written = await fs.readFile(proposalsPath, 'utf8');
      const records = written.trim().split('\n').map((line) => JSON.parse(line));
      // The ledger appends: the eight seeded snapshots survive verbatim and each
      // cancellation adds its own transition line.
      expect(records).toHaveLength(ids.length * 2);
      const transitions = records.filter((entry) => entry.kind === 'proposal.transitioned');
      expect(transitions.map((entry) => entry.proposalId).sort()).toEqual([...ids].sort());
      expect(transitions.every((entry) => entry.previousStatus === 'pending')).toBe(true);

      const proposals = await voice.listVoiceProposals();
      expect(proposals.map((entry) => entry.id).sort()).toEqual([...ids].sort());
      expect(proposals.every((entry) => entry.status === 'cancelled')).toBe(true);
    });
  });

  it('never trusts an unparseable record, and never erases it either', async () => {
    await withRuntime(async (runtimeDir, voice) => {
      const proposalsPath = path.join(runtimeDir, 'voice', 'proposals.jsonl');
      await fs.writeFile(
        proposalsPath,
        [
          '{ not json',
          JSON.stringify({ id: 'no-status', capabilityId: 'hii.agent.workspace_run', createdAt: 'now', normalizedText: 'x' }),
          JSON.stringify({
            id: 'valid-1',
            contextSnapshot: { snapshotAt: new Date().toISOString(), platform: 'mac' },
            utterance: 'do a thing',
            normalizedText: 'do a thing',
            mode: 'act',
            confidence: 0.9,
            purpose: 'act via voice intent',
            capabilityId: 'hii.agent.workspace_run',
            inputs: {},
            createdAt: new Date().toISOString(),
            status: 'pending'
          })
        ].join('\n') + '\n',
        'utf8'
      );

      const proposals = await voice.listVoiceProposals();
      expect(proposals.map((entry) => entry.id)).toEqual(['valid-1']);

      // Corruption is reported, not silently absorbed...
      const state = await voice.snapshotVoiceRuntimeState();
      expect(state.ledger.corruptRecords).toBe(2);
      expect(state.ledger.corruption.map((entry) => entry.reason)).toEqual([
        'unparseable-json',
        'invalid-proposal'
      ]);

      // ...and the damaged lines are still on disk for recovery.
      const after = await fs.readFile(proposalsPath, 'utf8');
      expect(after).toContain('{ not json');
      expect(after).toContain('"no-status"');
    });
  });
});
