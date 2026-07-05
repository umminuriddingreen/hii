import 'server-only';
import type { CapabilityJobStatus, CapabilityQuote } from '@/lib/capabilities/types';
import { supabaseAdmin } from './supabase';

export type CreditCurrency = CapabilityQuote['currency'];

export type CreditAccount = {
  user_id: string;
  currency: CreditCurrency;
  balance_cents: number;
  reserved_cents: number;
  created_at: string;
  updated_at: string;
};

export type CreditLedgerEntry = {
  id: string;
  user_id: string;
  job_id: string | null;
  capability_id: string | null;
  actor: 'hii' | 'operator' | 'agent' | 'stripe' | 'system';
  type:
    | 'credit_topup'
    | 'quote'
    | 'reservation'
    | 'approval'
    | 'compute_cost'
    | 'platform_fee'
    | 'proof'
    | 'refund';
  amount_cents: number | null;
  currency: CreditCurrency;
  external_id: string | null;
  summary: string;
  created_at: string;
};

export type DurableCapabilityJob = {
  id: string;
  user_id: string;
  user_email: string | null;
  capability_id: string;
  input_summary: string;
  status: CapabilityJobStatus;
  currency: CreditCurrency;
  quote: CapabilityQuote | null;
  reserved_cents: number;
  budget: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const creditCurrencies: CreditCurrency[] = ['usd', 'eur', 'gbp', 'credits'];
export const stripeTopUpCurrencies: CreditCurrency[] = ['usd', 'eur', 'gbp'];

export function parseCreditCurrency(value: unknown, fallback: CreditCurrency = 'usd'): CreditCurrency {
  return typeof value === 'string' && creditCurrencies.includes(value as CreditCurrency)
    ? (value as CreditCurrency)
    : fallback;
}

function db() {
  const client = supabaseAdmin();
  if (!client) throw new Error('Supabase service role not configured');
  return client;
}

export async function ensureCreditAccount(userId: string, currency: CreditCurrency) {
  const client = db();
  const { error: upsertError } = await client
    .from('credit_accounts')
    .upsert({ user_id: userId, currency }, { onConflict: 'user_id,currency', ignoreDuplicates: true });
  if (upsertError) throw upsertError;

  const { data, error } = await client
    .from('credit_accounts')
    .select('*')
    .eq('user_id', userId)
    .eq('currency', currency)
    .single();
  if (error) throw error;
  return data as CreditAccount;
}

export async function getCreditDashboard(userId: string, currency: CreditCurrency) {
  const client = db();
  const account = await ensureCreditAccount(userId, currency);
  const [{ data: accounts, error: accountsError }, { data: ledger, error: ledgerError }, { data: jobs, error: jobsError }] =
    await Promise.all([
      client
        .from('credit_accounts')
        .select('*')
        .eq('user_id', userId)
        .order('currency', { ascending: true }),
      client
        .from('credit_ledger_entries')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50),
      client
        .from('capability_jobs')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(25)
    ]);

  if (accountsError) throw accountsError;
  if (ledgerError) throw ledgerError;
  if (jobsError) throw jobsError;

  return {
    account,
    accounts: (accounts ?? []) as CreditAccount[],
    ledger: (ledger ?? []) as CreditLedgerEntry[],
    jobs: (jobs ?? []) as DurableCapabilityJob[]
  };
}

export async function applyCreditTopUp(args: {
  userId: string;
  currency: CreditCurrency;
  amountCents: number;
  stripeSessionId: string;
}) {
  const { error } = await db().rpc('apply_credit_topup', {
    target_user_id: args.userId,
    p_currency: args.currency,
    p_amount_cents: args.amountCents,
    p_external_id: `stripe_checkout:${args.stripeSessionId}`,
    p_summary: `Stripe Checkout top-up ${args.stripeSessionId}`
  });
  if (error) throw error;
}

export async function reserveCapabilityJob(args: {
  userId: string;
  userEmail?: string | null;
  quote: CapabilityQuote;
  transcript: Array<{ actor: string; text: string }>;
  metadata?: Record<string, unknown>;
}) {
  const status: CapabilityJobStatus = args.quote.status === 'needs-approval' ? 'waiting_approval' : 'queued';
  const { data, error } = await db().rpc('reserve_capability_job', {
    target_user_id: args.userId,
    p_user_email: args.userEmail ?? null,
    p_capability_id: args.quote.capabilityId,
    p_input_summary: args.quote.inputSummary,
    p_currency: args.quote.currency,
    p_quote: args.quote,
    p_reserved_cents: args.quote.totalCents,
    p_status: status,
    p_budget: String(args.quote.maxBudgetCents),
    p_metadata: args.metadata ?? {},
    p_transcript: args.transcript
  });
  if (error) throw error;

  const { data: job, error: jobError } = await db()
    .from('capability_jobs')
    .select('*')
    .eq('id', data as string)
    .single();
  if (jobError) throw jobError;
  return job as DurableCapabilityJob;
}

export async function finalizeCapabilityJob(args: {
  userId: string;
  jobId: string;
  status: Extract<CapabilityJobStatus, 'completed' | 'failed' | 'cancelled'>;
  computeCostCents: number;
  platformFeeCents: number;
  summary: string;
  proof?: Array<Record<string, unknown>>;
  transcript?: Array<{ actor: string; text: string }>;
}) {
  const { error } = await db().rpc('finalize_capability_job', {
    target_user_id: args.userId,
    p_job_id: args.jobId,
    p_status: args.status,
    p_compute_cost_cents: args.computeCostCents,
    p_platform_fee_cents: args.platformFeeCents,
    p_summary: args.summary,
    p_proof: args.proof ?? [],
    p_transcript: args.transcript ?? []
  });
  if (error) throw error;
}
