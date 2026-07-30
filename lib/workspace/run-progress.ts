export type RunProgressState = 'done' | 'current' | 'pending' | 'attention';

export type RunProgressStep = {
  id: 'approval' | 'queue' | 'work' | 'proof' | 'receipt';
  label: string;
  detail: string;
  state: RunProgressState;
};

export type RunJobLike = {
  id?: string;
  status?: string;
  budget?: string;
  logs?: string[];
  ledger?: Array<{
    actor?: string;
    type?: string;
    summary?: string;
    createdAt?: string;
  }>;
  proofArtifacts?: Array<{
    kind?: string;
    label?: string;
    path?: string;
    summary?: string;
    createdAt?: string;
  }>;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type RunReceiptLike = {
  id?: string;
  summary?: string;
  status?: string;
  verification?: Array<{ command?: string; ok?: boolean; output?: string }>;
  artifacts?: string[];
};

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

export function terminalRunMessage(status?: string) {
  return status === 'cancelled'
    ? 'AII stopped this bounded run. Its approval is closed.'
    : 'AII recorded this bounded run as failed. Inspect its evidence for the final execution output.';
}

function count(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function latestApproval(job?: RunJobLike | null) {
  return [...(job?.ledger || [])]
    .reverse()
    .find((entry) => entry.type === 'approval')
    ?.summary;
}

function durationLabel(job?: RunJobLike | null) {
  const start = Date.parse(String(job?.metadata?.startedAt || job?.createdAt || ''));
  const end = Date.parse(String(job?.updatedAt || ''));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function workspaceRunEvidence(job?: RunJobLike | null, receipt?: RunReceiptLike | null) {
  const checks = Array.isArray(receipt?.verification) ? receipt.verification : [];
  return {
    logs: (job?.logs || []).slice(-12),
    ledger: (job?.ledger || []).slice(-8),
    proofArtifacts: (job?.proofArtifacts || []).slice(-12),
    checks,
    passingChecks: checks.filter((check) => check.ok === true).length,
    failedChecks: checks.filter((check) => check.ok === false).length,
    duration: durationLabel(job)
  };
}

export function workspaceRunProgress(input: {
  status?: string;
  contextCount?: number;
  maxSteps?: number;
  workspaceRoot?: string;
  job?: RunJobLike | null;
  receipt?: RunReceiptLike | null;
}): RunProgressStep[] {
  const status = String(input.job?.status || input.status || 'waiting_approval');
  const terminal = terminalStatuses.has(status);
  const receipt = input.receipt || null;
  const evidence = workspaceRunEvidence(input.job, receipt);
  const contextCount = Math.max(0, Number(input.contextCount) || 0);
  const maxSteps = Math.max(1, Number(input.maxSteps) || 8);
  const workspaceRoot = String(input.workspaceRoot || input.job?.metadata?.workspaceRoot || '');
  const approval = latestApproval(input.job);

  const approvalState: RunProgressState = ['waiting_approval', 'proposed'].includes(status) ? 'current' : 'done';
  const queueState: RunProgressState = ['waiting_approval', 'proposed'].includes(status)
    ? 'pending'
    : status === 'queued'
      ? 'current'
      : 'done';
  const workState: RunProgressState = status === 'running'
    ? 'current'
    : status === 'completed'
      ? 'done'
      : ['failed', 'cancelled'].includes(status)
        ? 'attention'
        : 'pending';
  const proofState: RunProgressState = evidence.passingChecks > 0 || evidence.proofArtifacts.length > 0
    ? 'done'
    : terminal
      ? 'attention'
      : 'pending';
  const receiptState: RunProgressState = receipt
    ? 'done'
    : terminal
      ? 'attention'
      : 'pending';

  return [
    {
      id: 'approval',
      label: 'Intent approved',
      detail: approval || `${contextCount} canvas object${contextCount === 1 ? '' : 's'} · ${maxSteps} local tool-step limit`,
      state: approvalState
    },
    {
      id: 'queue',
      label: 'Accepted by AII',
      detail: status === 'queued' ? 'Waiting for bounded local execution to start.' : 'The approved intent entered the governed runner.',
      state: queueState
    },
    {
      id: 'work',
      label: status === 'running' ? 'Bounded work active' : 'Bounded work',
      detail: status === 'running'
        ? `Working inside ${workspaceRoot || 'the approved workspace'}.`
        : terminal
          ? `Execution ended ${status}${evidence.duration ? ` after ${evidence.duration}` : ''}.`
          : 'Execution begins only inside the approved workspace.',
      state: workState
    },
    {
      id: 'proof',
      label: 'Proof collected',
      detail: evidence.passingChecks || evidence.proofArtifacts.length
        ? `${evidence.passingChecks} passing check${evidence.passingChecks === 1 ? '' : 's'} · ${evidence.proofArtifacts.length} proof record${evidence.proofArtifacts.length === 1 ? '' : 's'}`
        : terminal
          ? 'No passing verification was returned.'
          : 'Verification remains pending.',
      state: proofState
    },
    {
      id: 'receipt',
      label: 'Receipt returned',
      detail: receipt?.summary || (terminal ? 'No verified receipt was returned.' : 'A receipt appears only after verification.'),
      state: receiptState
    }
  ];
}
