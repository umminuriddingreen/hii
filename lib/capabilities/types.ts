export type CapabilityRuntime =
  | 'next-route'
  | 'local-cli'
  | 'local-process'
  | 'managed-operator'
  | 'trusted-runner'
  | 'supabase-flow'
  | 'chrome-extension'
  | 'ollama'
  | 'cloudflare-worker';

export type CapabilityVisibility = 'local' | 'authenticated' | 'public';

export type CapabilityStatus = 'ready' | 'partial' | 'blocked' | 'planned';

export type CapabilityTrustLevel = 'first-party' | 'operator-reviewed' | 'experimental';

export type CapabilityCostModel =
  | { type: 'free' }
  | { type: 'quoted'; currency: 'usd' | 'eur' | 'gbp' | 'credits' }
  | { type: 'stripe-checkout'; currency: 'usd' };

export type CapabilityDefinition = {
  id: string;
  name: string;
  owner: string;
  runtime: CapabilityRuntime;
  summary: string;
  inputs: string[];
  outputs: string[];
  permissions: string[];
  visibility: CapabilityVisibility;
  costModel: CapabilityCostModel;
  evidence: string[];
  status: CapabilityStatus;
  trustLevel: CapabilityTrustLevel;
  runnerSupport?: {
    requiredCapabilityId: string;
    handler: string;
    expectedInputs: string[];
    expectedOutputs: string[];
    verification: string[];
  };
};

export type CapabilityJobStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ProofArtifact = {
  id: string;
  kind: 'log' | 'screenshot' | 'download' | 'receipt' | 'link' | 'json';
  label: string;
  href?: string;
  path?: string;
  summary?: string;
  createdAt: string;
};

export type CapabilityQuote = {
  id: string;
  capabilityId: string;
  inputSummary: string;
  currency: 'usd' | 'eur' | 'gbp' | 'credits';
  estimatedTokens: number;
  estimatedMinutes: number;
  computeCostCents: number;
  platformFeeCents: number;
  totalCents: number;
  maxBudgetCents: number;
  status: 'ready' | 'needs-approval' | 'over-budget';
  createdAt: string;
};

export type LedgerEntry = {
  id: string;
  jobId: string;
  capabilityId: string;
  actor: 'hii' | 'operator' | 'agent' | 'stripe' | 'system';
  type:
    | 'credit_topup'
    | 'quote'
    | 'reservation'
    | 'approval'
    | 'compute_cost'
    | 'platform_fee'
    | 'proof'
    | 'refund'
    | 'reconciliation';
  amountCents?: number;
  currency?: CapabilityQuote['currency'];
  summary: string;
  createdAt: string;
};

export type CapabilityJob = {
  id: string;
  capabilityId: string;
  inputSummary: string;
  userId: string;
  userEmail?: string | null;
  status: CapabilityJobStatus;
  budget?: string;
  quote?: CapabilityQuote;
  logs: string[];
  ledger: LedgerEntry[];
  proofArtifacts: ProofArtifact[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};
