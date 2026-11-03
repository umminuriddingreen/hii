/**
 * Reading the one completion verdict.
 *
 * A surface must not infer success from a receipt existing, a summary existing,
 * one passing check, or an artifact node appearing. Those were four different de
 * facto definitions of "completed" and they disagreed. The CLI computes one
 * assessment and persists it in the receipt; everything here does is read it.
 *
 * Kept in its own module, free of storage imports, so any surface can consume
 * the verdict without pulling in the run store.
 */

export interface WorkspaceRunCompletion {
  completed: boolean;
  /** True when the receipt predates the assessment and only legacy proof exists. */
  legacy: boolean;
  proofStrength: string;
  reasons: string[];
}

function text(value: unknown, max = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function list(value: unknown) {
  return Array.isArray(value) ? value.map((entry) => text(entry)).filter(Boolean) : [];
}

export function workspaceRunCompletion(receipt: Record<string, unknown> | null): WorkspaceRunCompletion {
  if (!receipt) {
    return {
      completed: false,
      legacy: false,
      proofStrength: 'none',
      reasons: ['No receipt was produced for this run.']
    };
  }

  const assessment = receipt.completion as Record<string, unknown> | undefined;
  if (assessment && typeof assessment === 'object') {
    const completed = assessment.satisfied === true && receipt.status === 'completed';
    const reasons = [
      ...list(assessment.unmetRequirements),
      ...list(assessment.failedChecks).map((check) => `Declared check failed: ${check}`),
      ...list(assessment.missingArtifacts).map((entry) => `Required artifact missing: ${entry}`),
      ...list(assessment.invalidArtifacts).map((entry) => `Required artifact invalid: ${entry}`)
    ];
    // Surfaces disagreeing about one run is the failure this exists to prevent,
    // so a disagreement is reported rather than resolved in favour of either.
    if (assessment.satisfied === true && receipt.status !== 'completed') {
      reasons.push(`Receipt status is ${text(receipt.status, 40) || 'unknown'} despite a satisfied assessment.`);
    }
    return {
      completed,
      legacy: false,
      proofStrength: text(assessment.proofStrength, 40) || 'none',
      reasons: completed ? [] : reasons.length ? reasons : ['The completion assessment was not satisfied.']
    };
  }

  const hasPassingCheck =
    Array.isArray(receipt.verification) &&
    receipt.verification.some(
      (entry) => Boolean(entry) && typeof entry === 'object' && (entry as Record<string, unknown>).ok === true
    );
  const completed = receipt.status === 'completed' && hasPassingCheck;
  return {
    completed,
    legacy: true,
    proofStrength: 'legacy',
    reasons: completed
      ? []
      : [
          `Legacy receipt: status ${text(receipt.status, 40) || 'unknown'}${
            hasPassingCheck ? '' : ' with no passing verification'
          }.`
        ]
  };
}
