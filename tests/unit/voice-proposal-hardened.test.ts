import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';

vi.mock('@/lib/server/hii-workspace-runs', () => ({
  discoverWorkspaceRunModels: vi.fn(async () => ({ available: true, defaultModel: 'test-model', models: ['test-model'], source: 'environment', message: 'mocked model' })),
  getWorkspaceRun: vi.fn(async () => null),
  previewWorkspaceRunContext: vi.fn(async () => ({ blocked: false, blockers: [], fingerprint: 'fp', summary: {}, details: [] })),
  queueApprovedWorkspaceRun: vi.fn(async () => ({
    job: {
      id: 'run-1',
      proofArtifacts: [],
      status: 'queued'
    }
  }))
}));

vi.mock('@/lib/server/hii-ecosystem', () => ({
  recordEcosystemEvent: vi.fn(async () => ({ id: 'mock-event', kind: 'hii.ecosystem.event', schemaVersion: 1, object: { kind: 'run', id: 'mock-event-id' }, proofRefs: [], createdAt: new Date().toISOString(), mode: 'notch', projectId: 'default', status: 'ready', summary: 'mocked' }))
}));

vi.mock('@/lib/capabilities/local-store', () => ({
  appendCapabilityJob: vi.fn(async () => undefined),
  listCapabilityJobs: vi.fn(async () => [])
}));

vi.mock('@/lib/voice/context', () => ({
  buildVoiceContextSnapshot: vi.fn(async () => ({
    snapshotAt: new Date().toISOString(),
    platform: 'mac',
    projectPath: process.env.HII_RUNTIME_DIR || ''
  })),
  normalizeContextReferences: vi.fn(() => [])
}));

vi.mock('@/lib/voice/vocabulary', () => ({
  assembleVoiceVocabulary: vi.fn(() => [{ text: 'mock', scope: 'global', confidence: 0.8 }])
}));

async function withRuntime<T>(action: (runtimeDir: string, voiceModule: typeof import('@/lib/server/hii-voice')) => Promise<T>) {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-voice-runtime-'));
  const originalRuntimeDir = process.env.HII_RUNTIME_DIR;
  process.env.HII_RUNTIME_DIR = runtimeDir;

  try {
    // Module resolves runtime paths at load time, so import after env setup.
    vi.resetModules();
    const voiceModule = await import('@/lib/server/hii-voice');
    const proposalDir = path.join(runtimeDir, 'voice');
    await fs.mkdir(proposalDir, { recursive: true });
    return await action(runtimeDir, voiceModule);
  } finally {
    if (originalRuntimeDir === undefined) {
      delete process.env.HII_RUNTIME_DIR;
    } else {
      process.env.HII_RUNTIME_DIR = originalRuntimeDir;
    }
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe('voice proposal hardening', () => {
  it('marks a pending proposal cancelled with operator reason', async () => {
    await withRuntime(async (runtimeDir, voice) => {
      const proposalPath = path.join(runtimeDir, 'voice', 'proposals.jsonl');
      await fs.writeFile(
        proposalPath,
        `${JSON.stringify({
          id: 'proposal-1',
          contextSnapshot: { snapshotAt: new Date().toISOString(), platform: 'mac' },
          utterance: 'send a note',
          normalizedText: 'send a note',
          mode: 'act',
          confidence: 0.9,
          purpose: 'act via voice intent',
          capabilityId: 'hii.agent.workspace_run',
          inputs: { projectPath: runtimeDir },
          createdAt: new Date().toISOString(),
          status: 'pending'
        })}\n`
      );

      const canceled = await voice.cancelVoiceProposal({
        proposalId: 'proposal-1',
        reason: 'user asked',
        requestedBy: 'test'
      });
      expect(canceled.ok).toBe(true);
      expect(canceled.message).toBe('Voice proposal proposal-1 cancelled.');
      const proposals = await voice.listVoiceProposals();
      expect(proposals[0].status).toBe('cancelled');
      expect(proposals[0].lastError).toBe('user asked');
    });
  });

  it('rejects cancellation of executed proposals', async () => {
    await withRuntime(async (runtimeDir, voice) => {
      const proposalPath = path.join(runtimeDir, 'voice', 'proposals.jsonl');
      await fs.writeFile(
        proposalPath,
        `${JSON.stringify({
          id: 'proposal-2',
          contextSnapshot: { snapshotAt: new Date().toISOString(), platform: 'mac' },
          utterance: 'change file',
          normalizedText: 'change file',
          mode: 'edit',
          confidence: 0.7,
          purpose: 'edit via voice intent',
          capabilityId: 'hii.agent.workspace_run',
          inputs: { projectPath: runtimeDir },
          createdAt: new Date().toISOString(),
          status: 'executed',
          jobId: 'run-1'
        })}\n`
      );

      await expect(voice.cancelVoiceProposal({
        proposalId: 'proposal-2',
        requestedBy: 'test'
      })).rejects.toThrow(/Executed proposals cannot be cancelled/);
    });
  });

  afterEach(() => {
    delete process.env.HII_RUNTIME_DIR;
  });
});
