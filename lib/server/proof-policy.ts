/**
 * One policy for what counts as proof strong enough to act on.
 *
 * Slice 2 established that a run carries a completion assessment and a proof
 * strength. This decides the separate question of which *behaviours* that proof
 * unlocks. Kept in one helper rather than scattered `=== 'declared'` string
 * comparisons, because every place that drifts is a place where a run the user
 * never asked to be verified quietly becomes a verified thing.
 *
 * Storage-free on purpose, so the daemon, the CLI-facing APIs, the graph and the
 * UI can all read the same rule.
 */

import type { WorkspaceRunCompletion } from '@/lib/server/workspace-run-completion';

/** The only proof strength that unlocks high-trust behaviour. */
export const HIGH_TRUST_PROOF_STRENGTH = 'declared';

/**
 * Behaviours that require declared, satisfied proof. Named so a caller states
 * which door it is opening and the refusal can say so too.
 */
export type HighTrustBehaviour =
  | 'capability-draft'
  | 'skill-promotion'
  | 'verified-workflow'
  | 'verified-by-relation'
  | 'trusted-generated-provenance'
  | 'external-effect'
  | 'verified-label';

const behaviourLabels: Record<HighTrustBehaviour, string> = {
  'capability-draft': 'drafting a capability from this run',
  'skill-promotion': 'proposing or promoting a skill from this run',
  'verified-workflow': 'creating a verified workflow from this run',
  'verified-by-relation': 'recording a VERIFIED_BY relation from this run',
  'trusted-generated-provenance': 'marking generated objects as verified provenance',
  'external-effect': 'treating this run as ready for automatic external effects',
  'verified-label': 'labelling this run as verified'
};

export interface HighTrustDecision {
  qualifies: boolean;
  /** Empty when it qualifies; otherwise why not, in user-facing words. */
  reason: string;
}

/** The shape this policy needs — a full `WorkspaceRunCompletion` satisfies it. */
export interface ProofCandidate {
  completed?: boolean;
  legacy?: boolean;
  proofStrength?: string | null;
  reasons?: string[];
}

/**
 * Whether a run's proof qualifies for a high-trust behaviour.
 *
 * `incidental`, `none`, `legacy` and a missing strength all fail. Those are not
 * degrees of verification — they mean nobody declared what the run had to prove,
 * so there is no claim to have satisfied.
 */
export function qualifiesForHighTrust(
  candidate: ProofCandidate | null | undefined,
  behaviour: HighTrustBehaviour
): HighTrustDecision {
  const what = behaviourLabels[behaviour] ?? 'this action';
  if (!candidate) {
    return { qualifies: false, reason: `No completion proof exists for this run, so ${what} is not available.` };
  }
  if (candidate.completed !== true) {
    const why = (candidate.reasons ?? []).join(' ').trim();
    return {
      qualifies: false,
      reason: `This run did not meet its declared outcome, so ${what} is not available. ${why}`.trim()
    };
  }
  const strength = String(candidate.proofStrength ?? '').trim();
  if (candidate.legacy === true) {
    return {
      qualifies: false,
      reason: `This run predates declared outcomes, so its proof is legacy and unclassified. Re-run it with a declared outcome before ${what}.`
    };
  }
  if (strength !== HIGH_TRUST_PROOF_STRENGTH) {
    return {
      qualifies: false,
      reason: `This run's proof is ${strength || 'unclassified'}, not declared. Nothing was declared for it to prove, so ${what} is not available.`
    };
  }
  return { qualifies: true, reason: '' };
}

/** Throwing form, for API paths whose refusal is already an error message. */
export function requireHighTrust(
  candidate: ProofCandidate | null | undefined,
  behaviour: HighTrustBehaviour
): void {
  const decision = qualifiesForHighTrust(candidate, behaviour);
  if (!decision.qualifies) throw new Error(decision.reason);
}

/** Narrowing helper for callers holding a full completion verdict. */
export function completionQualifies(
  completion: WorkspaceRunCompletion | null | undefined,
  behaviour: HighTrustBehaviour
): HighTrustDecision {
  return qualifiesForHighTrust(completion, behaviour);
}
