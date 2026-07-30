// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activationFunnelSummary,
  readActivationJourney,
  recordActivationJourneyMilestone
} from '../../lib/server/hii-activation-journey';

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-activation-journey-'));
  process.env.HII_RUNTIME_DIR = directory;
});

afterEach(() => {
  delete process.env.HII_RUNTIME_DIR;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('local activation journey evidence', () => {
  it('records a privacy-minimized first-win journey append-only', async () => {
    const journeyId = 'journey-00000001';
    await recordActivationJourneyMilestone({
      journeyId,
      milestone: 'agents_detected',
      at: '2026-07-30T10:00:00.000Z',
      metadata: { installedAgents: 3 }
    });
    await recordActivationJourneyMilestone({
      journeyId,
      milestone: 'context_previewed',
      at: '2026-07-30T10:00:05.000Z',
      metadata: { itemCount: 12, totalBytes: 4096 }
    });
    await recordActivationJourneyMilestone({
      journeyId,
      activationId: 'activation-00000001',
      milestone: 'run_started',
      at: '2026-07-30T10:00:10.000Z',
      metadata: {
        agent: 'codex',
        runKind: 'codex-exec',
        secretPath: '/Users/example/private'
      } as never
    });
    await recordActivationJourneyMilestone({
      journeyId,
      activationId: 'activation-00000001',
      milestone: 'receipt_verified',
      at: '2026-07-30T10:00:42.000Z'
    });

    const journey = await readActivationJourney(journeyId);
    expect(journey).toMatchObject({
      status: 'completed',
      elapsedSeconds: 42
    });
    expect(journey?.milestones.map((event) => event.milestone)).toEqual([
      'agents_detected',
      'context_previewed',
      'run_started',
      'receipt_verified'
    ]);
    const raw = fs.readFileSync(path.join(directory, 'activations', 'events.jsonl'), 'utf8');
    expect(raw).not.toContain('/Users/example/private');
    expect(raw).not.toContain('task');
  });

  it('deduplicates polling milestones and keeps terminal journeys immutable', async () => {
    const journeyId = 'journey-00000002';
    await recordActivationJourneyMilestone({ journeyId, milestone: 'agents_detected' });
    const first = await recordActivationJourneyMilestone({
      journeyId,
      activationId: 'activation-00000002',
      milestone: 'receipt_verified'
    });
    const duplicate = await recordActivationJourneyMilestone({
      journeyId,
      activationId: 'activation-00000002',
      milestone: 'receipt_verified'
    });
    const lateFailure = await recordActivationJourneyMilestone({
      journeyId,
      activationId: 'activation-00000002',
      milestone: 'run_failed'
    });

    expect(duplicate.id).toBe(first.id);
    expect(lateFailure.id).toBe(first.id);
    expect((await readActivationJourney(journeyId))?.milestones).toHaveLength(2);
  });

  it('aggregates cohort conversion without exposing raw journey records', async () => {
    await recordActivationJourneyMilestone({
      journeyId: 'journey-00000003',
      milestone: 'agents_detected',
      at: '2026-07-30T10:00:00.000Z'
    });
    await recordActivationJourneyMilestone({
      journeyId: 'journey-00000003',
      milestone: 'context_previewed',
      at: '2026-07-30T10:00:02.000Z'
    });
    await recordActivationJourneyMilestone({
      journeyId: 'journey-00000003',
      milestone: 'context_approved',
      at: '2026-07-30T10:00:04.000Z'
    });
    await recordActivationJourneyMilestone({
      journeyId: 'journey-00000003',
      milestone: 'run_started',
      at: '2026-07-30T10:00:06.000Z'
    });
    await recordActivationJourneyMilestone({
      journeyId: 'journey-00000003',
      milestone: 'receipt_verified',
      at: '2026-07-30T10:00:30.000Z'
    });
    await recordActivationJourneyMilestone({
      journeyId: 'journey-00000004',
      milestone: 'agents_detected',
      at: '2026-07-30T11:00:00.000Z'
    });
    await recordActivationJourneyMilestone({
      journeyId: 'journey-00000004',
      milestone: 'run_failed',
      at: '2026-07-30T11:00:12.000Z'
    });

    await expect(activationFunnelSummary()).resolves.toEqual({
      localOnly: true,
      journeys: 2,
      agentsDetected: 2,
      contextPreviewed: 1,
      contextApproved: 1,
      runsStarted: 1,
      receiptsVerified: 1,
      runsFailed: 1,
      completionRate: 0.5,
      medianSecondsToReceipt: 30,
      lastEventAt: '2026-07-30T11:00:12.000Z'
    });
  });
});
