import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaceRunCompletion } from '@/lib/server/workspace-run-completion';

const root = resolve(__dirname, '../..');
const daemon = readFileSync(resolve(root, 'aii/daemon/hiid.mjs'), 'utf8');

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    status: 'completed',
    summary: 'done',
    verification: [{ command: 'cargo test', ok: true, output: '' }],
    ...overrides
  };
}

function assessment(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    satisfied: true,
    proofStrength: 'declared',
    unmetRequirements: [],
    failedChecks: [],
    missingArtifacts: [],
    invalidArtifacts: [],
    warnings: [],
    evidence: [],
    ...overrides
  };
}

describe('one canonical completion verdict', () => {
  it('completes a run whose assessment is satisfied', () => {
    const verdict = workspaceRunCompletion(receipt({ completion: assessment() }));
    expect(verdict.completed).toBe(true);
    expect(verdict.legacy).toBe(false);
    expect(verdict.proofStrength).toBe('declared');
    expect(verdict.reasons).toEqual([]);
  });

  it('does not complete a run with a missing required artifact, and says which', () => {
    const verdict = workspaceRunCompletion(
      receipt({
        status: 'incomplete',
        completion: assessment({
          satisfied: false,
          unmetRequirements: ['Required artifacts were not produced.'],
          missingArtifacts: ['out/report.md']
        })
      })
    );
    expect(verdict.completed).toBe(false);
    expect(verdict.reasons).toContain('Required artifacts were not produced.');
    expect(verdict.reasons).toContain('Required artifact missing: out/report.md');
  });

  it('does not complete a run with an invalid required artifact', () => {
    const verdict = workspaceRunCompletion(
      receipt({
        status: 'incomplete',
        completion: assessment({ satisfied: false, invalidArtifacts: ['out/report.md is empty'] })
      })
    );
    expect(verdict.completed).toBe(false);
    expect(verdict.reasons).toContain('Required artifact invalid: out/report.md is empty');
  });

  it('does not complete a run whose declared check failed', () => {
    const verdict = workspaceRunCompletion(
      receipt({
        status: 'incomplete',
        verification: [{ command: 'cargo test', ok: false, output: 'exit 101' }],
        completion: assessment({ satisfied: false, failedChecks: ['cargo test'] })
      })
    );
    expect(verdict.completed).toBe(false);
    expect(verdict.reasons).toContain('Declared check failed: cargo test');
  });

  it('refuses to complete when the assessment and the receipt status disagree', () => {
    // Two surfaces must never be able to disagree; if they do, the run is not
    // completed and the disagreement is stated.
    const verdict = workspaceRunCompletion(receipt({ status: 'incomplete', completion: assessment() }));
    expect(verdict.completed).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('despite a satisfied assessment');
  });

  it('never treats a passing check alone as completion once an assessment exists', () => {
    const verdict = workspaceRunCompletion(
      receipt({
        status: 'completed',
        verification: [{ command: 'ls', ok: true, output: '' }],
        completion: assessment({ satisfied: false, unmetRequirements: ['Required artifacts were not produced.'] })
      })
    );
    expect(verdict.completed).toBe(false);
  });

  it('reads a legacy receipt without an assessment, with limited proof semantics', () => {
    const verdict = workspaceRunCompletion(receipt());
    expect(verdict.completed).toBe(true);
    expect(verdict.legacy).toBe(true);
    expect(verdict.proofStrength).toBe('legacy');
  });

  it('does not complete a legacy receipt with no passing verification', () => {
    const verdict = workspaceRunCompletion(receipt({ verification: [{ command: 'cargo test', ok: false, output: '' }] }));
    expect(verdict.completed).toBe(false);
    expect(verdict.legacy).toBe(true);
  });

  it('does not complete a run with no receipt at all', () => {
    const verdict = workspaceRunCompletion(null);
    expect(verdict.completed).toBe(false);
    expect(verdict.reasons[0]).toContain('No receipt');
  });
});

describe('the daemon consumes the assessment instead of its own rule', () => {
  it('reads the receipt assessment rather than re-deriving completion', () => {
    expect(daemon).toContain('function receiptCompletion(');
    expect(daemon).toContain('const completion = receiptCompletion(');
    // The old weaker rule — status plus any passing check — must not survive at
    // the terminal decision points.
    expect(daemon).not.toContain('const hasVerifiedProof =');
    expect(daemon).not.toMatch(/const verified = receiptMatch\?\.receipt\?\.status === "completed"/);
  });

  it('fails the job when the assessment is unsatisfied, with structured reasons', () => {
    expect(daemon).toContain('!completion.completed || !cleanupPassed ? "failed" : "completed"');
    expect(daemon).toContain('Run did not meet its declared outcome.');
  });

  it('carries the verdict onto the CapabilityJob so surfaces do not re-derive it', () => {
    expect(daemon).toContain('completion: completion || previous?.metadata?.completion || null');
  });

  it('still cannot represent a cancelled run as completed', () => {
    expect(daemon).toContain('job.metadata?.cancelRequestedAt ? "cancelled"');
    expect(daemon).toContain('terminal?.status === "cancelled"');
  });
});
