import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readVoiceProposalLedger,
  recordProposalCreated,
  recordProposalTransition
} from '@/lib/server/voice-proposal-ledger';
import type { VoiceProposal } from '@/lib/voice/types';

let dir = '';
let ledgerPath = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'hii-voice-ledger-'));
  ledgerPath = path.join(dir, 'voice', 'proposals.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function proposal(id: string, overrides: Partial<VoiceProposal> = {}): VoiceProposal {
  return {
    id,
    contextSnapshot: { snapshotAt: '2026-08-07T00:00:00.000Z', platform: 'mac' },
    utterance: `do ${id}`,
    normalizedText: `do ${id}`,
    mode: 'act',
    confidence: 0.9,
    purpose: 'act via voice intent',
    capabilityId: 'hii.agent.workspace_run',
    inputs: {},
    createdAt: '2026-08-07T00:00:00.000Z',
    status: 'pending',
    ...overrides
  };
}

async function lines() {
  return (await readFile(ledgerPath, 'utf8')).split('\n').filter(Boolean);
}

describe('voice proposal ledger', () => {
  it('records creation and each transition as separate immutable events', async () => {
    await recordProposalCreated(ledgerPath, proposal('p1'));
    await recordProposalTransition(ledgerPath, { proposalId: 'p1', status: 'queued' });
    await recordProposalTransition(ledgerPath, { proposalId: 'p1', status: 'executed', patch: { jobId: 'run-1' } });

    const written = await lines();
    expect(written).toHaveLength(3);

    const ledger = await readVoiceProposalLedger(ledgerPath);
    expect(ledger.events.map((event) => event.status)).toEqual(['pending', 'queued', 'executed']);
    expect(ledger.events.map((event) => event.previousStatus)).toEqual([null, 'pending', 'queued']);
    expect(ledger.proposals).toHaveLength(1);
    expect(ledger.proposals[0].status).toBe('executed');
    expect(ledger.proposals[0].jobId).toBe('run-1');
  });

  it('preserves event order across many appends', async () => {
    await recordProposalCreated(ledgerPath, proposal('p1'));
    const order: VoiceProposal['status'][] = ['queued', 'executed', 'failed', 'cancelled'];
    for (const status of order) {
      await recordProposalTransition(ledgerPath, { proposalId: 'p1', status });
    }
    const ledger = await readVoiceProposalLedger(ledgerPath);
    expect(ledger.events.slice(1).map((event) => event.status)).toEqual(order);
  });

  it('does not lose transitions when many proposals move at once', async () => {
    const ids = Array.from({ length: 8 }, (_, index) => `p${index}`);
    for (const id of ids) await recordProposalCreated(ledgerPath, proposal(id));

    await Promise.all(
      ids.map((id) => recordProposalTransition(ledgerPath, { proposalId: id, status: 'cancelled', patch: { lastError: id } }))
    );

    const ledger = await readVoiceProposalLedger(ledgerPath);
    expect(ledger.corruption).toEqual([]);
    expect(ledger.proposals).toHaveLength(8);
    expect(ledger.proposals.every((entry) => entry.status === 'cancelled')).toBe(true);
    expect(ledger.events.filter((event) => event.kind === 'proposal.transitioned')).toHaveLength(8);
  });

  it('treats a retried transition as one event', async () => {
    await recordProposalCreated(ledgerPath, proposal('p1'));
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        recordProposalTransition(ledgerPath, { proposalId: 'p1', status: 'cancelled', patch: { lastError: 'user asked' } })
      )
    );

    expect(results.every((entry) => entry?.status === 'cancelled')).toBe(true);
    const ledger = await readVoiceProposalLedger(ledgerPath);
    expect(ledger.events.filter((event) => event.status === 'cancelled')).toHaveLength(1);
    expect(ledger.proposals[0].lastError).toBe('user asked');
  });

  it('records a re-created proposal once', async () => {
    await recordProposalCreated(ledgerPath, proposal('p1'));
    await recordProposalCreated(ledgerPath, proposal('p1'));
    expect(await lines()).toHaveLength(1);
  });

  it('leaves malformed lines in the file and reports them', async () => {
    await recordProposalCreated(ledgerPath, proposal('p1'));
    const before = await readFile(ledgerPath, 'utf8');
    await writeFile(ledgerPath, `${before}{"broken":\n{"kind":"proposal.transitioned"}\n`, 'utf8');

    const ledger = await readVoiceProposalLedger(ledgerPath);
    expect(ledger.corruption.map((entry) => entry.reason)).toEqual(['unparseable-json', 'invalid-transition']);
    // The raw bytes are what a human would need to recover the record.
    expect(ledger.corruption[0].raw).toBe('{"broken":');

    const after = await readFile(ledgerPath, 'utf8');
    expect(after).toContain('{"broken":');
    expect(after.split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('keeps valid proposal state recoverable despite malformed lines', async () => {
    await recordProposalCreated(ledgerPath, proposal('p1'));
    await writeFile(ledgerPath, `${await readFile(ledgerPath, 'utf8')}not json at all\n`, 'utf8');
    await recordProposalTransition(ledgerPath, { proposalId: 'p1', status: 'executed', patch: { jobId: 'run-9' } });

    const ledger = await readVoiceProposalLedger(ledgerPath);
    expect(ledger.proposals).toHaveLength(1);
    expect(ledger.proposals[0].status).toBe('executed');
    expect(ledger.proposals[0].jobId).toBe('run-9');
    expect(ledger.corruption).toHaveLength(1);
    expect(await readFile(ledgerPath, 'utf8')).toContain('not json at all');
  });

  it('refuses to invent a proposal from an orphan transition', async () => {
    const missing = await recordProposalTransition(ledgerPath, { proposalId: 'nope', status: 'cancelled' });
    expect(missing).toBeUndefined();

    await recordProposalCreated(ledgerPath, proposal('p1'));
    await writeFile(
      ledgerPath,
      `${await readFile(ledgerPath, 'utf8')}${JSON.stringify({
        eventId: 'ghost:cancelled',
        kind: 'proposal.transitioned',
        proposalId: 'ghost',
        previousStatus: 'pending',
        status: 'cancelled',
        at: '2026-08-07T00:00:01.000Z'
      })}\n`,
      'utf8'
    );

    const ledger = await readVoiceProposalLedger(ledgerPath);
    expect(ledger.proposals.map((entry) => entry.id)).toEqual(['p1']);
    expect(ledger.corruption.map((entry) => entry.reason)).toEqual(['transition-without-proposal']);
  });

  it('reads pre-ledger proposal snapshots without rewriting them', async () => {
    const legacy = proposal('legacy-1', { status: 'pending' });
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, `${JSON.stringify(legacy)}\n`, 'utf8');

    const ledger = await readVoiceProposalLedger(ledgerPath);
    expect(ledger.corruption).toEqual([]);
    expect(ledger.proposals.map((entry) => entry.id)).toEqual(['legacy-1']);
    expect(ledger.proposals[0].status).toBe('pending');

    const updated = await recordProposalTransition(ledgerPath, { proposalId: 'legacy-1', status: 'cancelled' });
    expect(updated?.status).toBe('cancelled');
    const raw = await readFile(ledgerPath, 'utf8');
    // The original snapshot line survives untouched beneath the new transition.
    expect(raw.startsWith(`${JSON.stringify(legacy)}\n`)).toBe(true);
  });

  it('rejects an unsupported status instead of writing it', async () => {
    await recordProposalCreated(ledgerPath, proposal('p1'));
    await expect(
      recordProposalTransition(ledgerPath, { proposalId: 'p1', status: 'nonsense' as VoiceProposal['status'] })
    ).rejects.toThrow(/Unsupported proposal status/);
    expect(await lines()).toHaveLength(1);
  });
});
