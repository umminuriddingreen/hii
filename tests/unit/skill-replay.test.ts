import { describe, expect, it } from 'vitest';
import {
  compareSkillReplays,
  latestSkillExecutionEvents,
  skillReplayReceiptIntent,
  summarizeSkillReplay,
  type SkillExecutionEvent
} from '../../lib/skills/replay';

describe('HII skill replay evidence', () => {
  const first: SkillExecutionEvent = {
    id: 'replay-one',
    skillId: 'verified-workflow',
    daemonRunId: 'codex-one',
    status: 'queued',
    startedAt: '2026-07-30T10:00:00.000Z',
    updatedAt: '2026-07-30T10:00:01.000Z'
  };
  const second: SkillExecutionEvent = {
    id: 'replay-two',
    skillId: 'verified-workflow',
    daemonRunId: 'codex-two',
    status: 'queued',
    startedAt: '2026-07-30T11:00:00.000Z',
    updatedAt: '2026-07-30T11:00:01.000Z'
  };

  it('keeps the latest append-only execution event and sorts newest first', () => {
    const starting = { ...second, daemonRunId: null, status: 'starting' as const, updatedAt: second.startedAt };
    expect(latestSkillExecutionEvents([first, starting, second])).toEqual([second, first]);
  });

  it('requires an exactly linked verified receipt before trusting a replay', () => {
    const summary = summarizeSkillReplay(
      second,
      {
        id: 'codex-two',
        status: 'completed',
        startedAt: '2026-07-30T11:00:02.000Z',
        completedAt: '2026-07-30T11:00:12.000Z',
        outputBytes: 2400
      },
      [
        {
          id: 'wrong',
          intent: 'another replay',
          outcome: 'completed',
          verification: { status: 'verified', checks: ['one'], proof: ['receipt'] }
        },
        {
          id: 'receipt-two',
          intent: skillReplayReceiptIntent(second.id),
          outcome: 'completed',
          verification: { status: 'verified', checks: ['one', 'two'], proof: ['receipt'] }
        }
      ]
    );

    expect(summary.verified).toBe(true);
    expect(summary.receiptId).toBe('receipt-two');
    expect(summary.durationMs).toBe(10_000);
    expect(summary.checkCount).toBe(2);
    expect(summary.proofCount).toBe(1);
  });

  it('diffs duration, output, checks, proof, outcome, and verification', () => {
    const previous = summarizeSkillReplay(
      first,
      {
        id: 'codex-one',
        status: 'completed',
        startedAt: '2026-07-30T10:00:00.000Z',
        completedAt: '2026-07-30T10:00:20.000Z',
        outputBytes: 3000
      },
      [{
        id: 'receipt-one',
        intent: skillReplayReceiptIntent(first.id),
        outcome: 'completed',
        verification: { status: 'verified', checks: ['one'], proof: ['receipt'] }
      }]
    );
    const current = summarizeSkillReplay(
      second,
      {
        id: 'codex-two',
        status: 'completed',
        startedAt: '2026-07-30T11:00:00.000Z',
        completedAt: '2026-07-30T11:00:12.000Z',
        outputBytes: 2400
      },
      [{
        id: 'receipt-two',
        intent: skillReplayReceiptIntent(second.id),
        outcome: 'completed',
        verification: { status: 'verified', checks: ['one', 'two'], proof: ['receipt', 'artifact'] }
      }]
    );

    expect(compareSkillReplays(current, previous)).toMatchObject({
      durationDeltaMs: -8000,
      outputBytesDelta: -600,
      checkCountDelta: 1,
      proofCountDelta: 1,
      statusChanged: false,
      outcomeChanged: false,
      verificationChanged: false
    });
  });
});
