#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-skill-replay-'));
process.env.HII_RUNTIME_DIR = path.join(temporary, 'runtime');

const registry = await import('../aii/skills/registry.mjs');
const replay = await import('../lib/skills/replay.ts');

try {
  const report = registry.reportAgentAction({
    agent: { id: 'hii-replay-smoke', kind: 'test' },
    projectId: 'hii',
    coordinate: temporary,
    intent: 'Create a verified replay fixture.',
    summary: 'Created a verified replay fixture.',
    outcome: 'completed',
    verificationStatus: 'verified',
    checks: ['test -f proof.txt'],
    proof: ['proof.txt'],
    permissions: ['read fixture'],
    sideEffects: ['write fixture receipt'],
    repeatable: true,
    skillId: 'verified-replay-fixture',
    skillName: 'Verified Replay Fixture',
    skillDescription: 'Exercise review and replay comparison without external work.'
  });
  assert.equal(report.proposal.id, 'verified-replay-fixture');
  const registered = registry.registerSkillProposal('verified-replay-fixture', 'HII smoke operator');
  assert.equal(registered.skill.status, 'registered');
  const manifest = JSON.parse(fs.readFileSync(
    path.join(process.env.HII_RUNTIME_DIR, 'skills', 'registered', 'verified-replay-fixture', 'manifest.json'),
    'utf8'
  ));
  assert.equal(manifest.reviewedBy, 'HII smoke operator');
  assert.equal(manifest.sourceReceiptIds.length, 1);

  const events = replay.latestSkillExecutionEvents([
    {
      id: 'first', skillId: manifest.id, daemonRunId: 'codex-first', status: 'queued',
      startedAt: '2026-07-30T10:00:00.000Z', updatedAt: '2026-07-30T10:00:01.000Z'
    },
    {
      id: 'second', skillId: manifest.id, daemonRunId: 'codex-second', status: 'queued',
      startedAt: '2026-07-30T11:00:00.000Z', updatedAt: '2026-07-30T11:00:01.000Z'
    }
  ]);
  const receipts = [
    {
      id: 'receipt-first', intent: replay.skillReplayReceiptIntent('first'), outcome: 'completed',
      verification: { status: 'verified', checks: ['one'], proof: ['receipt'] }
    },
    {
      id: 'receipt-second', intent: replay.skillReplayReceiptIntent('second'), outcome: 'completed',
      verification: { status: 'verified', checks: ['one', 'two'], proof: ['receipt', 'artifact'] }
    }
  ];
  const current = replay.summarizeSkillReplay(events[0], {
    id: 'codex-second', status: 'completed', startedAt: '2026-07-30T11:00:00.000Z',
    completedAt: '2026-07-30T11:00:12.000Z', outputBytes: 2400
  }, receipts);
  const previous = replay.summarizeSkillReplay(events[1], {
    id: 'codex-first', status: 'completed', startedAt: '2026-07-30T10:00:00.000Z',
    completedAt: '2026-07-30T10:00:20.000Z', outputBytes: 3000
  }, receipts);
  const comparison = replay.compareSkillReplays(current, previous);
  assert.equal(current.verified, true);
  assert.equal(comparison.durationDeltaMs, -8000);
  assert.equal(comparison.checkCountDelta, 1);
  assert.equal(comparison.proofCountDelta, 1);

  console.log('HII skill replay smoke');
  console.log('status:       ok');
  console.log('review:       verified draft -> explicit operator registration');
  console.log('lineage:      registered skill retains source receipt provenance');
  console.log('replay:       exact receipt intent gates trusted replay status');
  console.log('comparison:   duration, output, checks, and proof deltas verified');
  console.log('network:      no external action used');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
