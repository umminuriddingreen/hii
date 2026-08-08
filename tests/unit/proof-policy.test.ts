import { describe, expect, it } from 'vitest';
import {
  HIGH_TRUST_PROOF_STRENGTH,
  qualifiesForHighTrust,
  requireHighTrust,
  type HighTrustBehaviour
} from '@/lib/server/proof-policy';

const behaviours: HighTrustBehaviour[] = [
  'capability-draft',
  'skill-promotion',
  'verified-workflow',
  'verified-by-relation',
  'trusted-generated-provenance',
  'external-effect',
  'verified-label'
];

describe('high-trust proof gating', () => {
  it('admits only a satisfied run with declared proof', () => {
    const decision = qualifiesForHighTrust(
      { completed: true, legacy: false, proofStrength: 'declared', reasons: [] },
      'capability-draft'
    );
    expect(decision.qualifies).toBe(true);
    expect(decision.reason).toBe('');
    expect(HIGH_TRUST_PROOF_STRENGTH).toBe('declared');
  });

  it('refuses incidental proof, because nothing was declared to prove', () => {
    const decision = qualifiesForHighTrust(
      { completed: true, legacy: false, proofStrength: 'incidental', reasons: [] },
      'verified-by-relation'
    );
    expect(decision.qualifies).toBe(false);
    expect(decision.reason).toContain('incidental');
    expect(decision.reason).toContain('VERIFIED_BY');
  });

  it('refuses missing and unrecognised proof strength', () => {
    for (const proofStrength of [undefined, null, '', 'none', 'strong', 'verified']) {
      const decision = qualifiesForHighTrust(
        { completed: true, legacy: false, proofStrength, reasons: [] },
        'external-effect'
      );
      expect(decision.qualifies, String(proofStrength)).toBe(false);
    }
  });

  it('refuses legacy proof even when the legacy rule called the run completed', () => {
    const decision = qualifiesForHighTrust(
      { completed: true, legacy: true, proofStrength: 'legacy', reasons: [] },
      'skill-promotion'
    );
    expect(decision.qualifies).toBe(false);
    expect(decision.reason).toContain('legacy');
  });

  it('refuses an unsatisfied assessment and repeats its reasons', () => {
    const decision = qualifiesForHighTrust(
      {
        completed: false,
        legacy: false,
        proofStrength: 'declared',
        reasons: ['Required artifact missing: report.md']
      },
      'verified-workflow'
    );
    expect(decision.qualifies).toBe(false);
    expect(decision.reason).toContain('report.md');
  });

  it('refuses a missing verdict entirely', () => {
    expect(qualifiesForHighTrust(null, 'verified-label').qualifies).toBe(false);
    expect(qualifiesForHighTrust(undefined, 'verified-label').qualifies).toBe(false);
  });

  it('applies the same rule to every high-trust behaviour', () => {
    for (const behaviour of behaviours) {
      expect(
        qualifiesForHighTrust(
          { completed: true, legacy: false, proofStrength: 'declared', reasons: [] },
          behaviour
        ).qualifies,
        behaviour
      ).toBe(true);
      expect(
        qualifiesForHighTrust(
          { completed: true, legacy: false, proofStrength: 'incidental', reasons: [] },
          behaviour
        ).qualifies,
        behaviour
      ).toBe(false);
    }
  });

  it('throws with the refusal reason for API callers', () => {
    expect(() =>
      requireHighTrust(
        { completed: true, legacy: false, proofStrength: 'incidental', reasons: [] },
        'capability-draft'
      )
    ).toThrow(/incidental/);
    expect(() =>
      requireHighTrust(
        { completed: true, legacy: false, proofStrength: 'declared', reasons: [] },
        'capability-draft'
      )
    ).not.toThrow();
  });
});
