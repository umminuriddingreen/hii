import type { CapabilityQuote } from '@/lib/capabilities/types';

export type HiiCurrency = 'usd' | 'eur' | 'gbp' | 'credits';

export type HiiQuoteInput = {
  task: string;
  currency: HiiCurrency;
  maxBudgetCents?: number;
  capabilityId?: string;
};

export type HiiQuote = CapabilityQuote & {
  task: string;
  transcript: Array<{
    actor: 'user' | 'hii' | 'agent' | 'ledger';
    text: string;
  }>;
};

export const hiiCurrencies: Array<{ code: HiiCurrency; label: string; symbol: string }> = [
  { code: 'usd', label: 'USD', symbol: '$' },
  { code: 'eur', label: 'EUR', symbol: '€' },
  { code: 'gbp', label: 'GBP', symbol: '£' },
  { code: 'credits', label: 'HII credits', symbol: 'cr ' }
];

const currencySymbols = new Map(hiiCurrencies.map((currency) => [currency.code, currency.symbol]));

export function formatHiiMoney(cents: number, currency: HiiCurrency) {
  if (currency === 'credits') return `${Math.round(cents / 100)} credits`;
  const symbol = currencySymbols.get(currency) ?? '$';
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function quoteId(task: string, currency: HiiCurrency) {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20);
  return `hii-${currency}-${slug || 'task'}`;
}

export function createHiiQuote(input: HiiQuoteInput): HiiQuote {
  const task = input.task.trim() || 'Run a bounded computer task and return proof.';
  const capabilityId = input.capabilityId || 'hii.agent.spawn';
  const wordCount = task.split(/\s+/).filter(Boolean).length;
  const complexity = clamp(Math.ceil(wordCount / 9), 1, 8);
  const estimatedMinutes = clamp(4 + complexity * 3, 6, 35);
  const estimatedTokens = clamp(2500 + complexity * 1400, 3000, 18000);
  const computeCostCents = Math.ceil(estimatedMinutes * 18 + estimatedTokens * 0.003);
  const platformFeeCents = Math.max(125, Math.ceil(computeCostCents * 0.22));
  const totalCents = computeCostCents + platformFeeCents;
  const maxBudgetCents = input.maxBudgetCents ?? 1500;
  const status =
    totalCents > maxBudgetCents ? 'over-budget' : totalCents > maxBudgetCents * 0.75 ? 'needs-approval' : 'ready';

  return {
    id: quoteId(task, input.currency),
    capabilityId,
    inputSummary: task,
    task,
    currency: input.currency,
    estimatedTokens,
    estimatedMinutes,
    computeCostCents,
    platformFeeCents,
    totalCents,
    maxBudgetCents,
    status,
    createdAt: new Date().toISOString(),
    transcript: [
      {
        actor: 'user',
        text: task
      },
      {
        actor: 'hii',
        text: `I can run ${capabilityId} as a bounded capability job. Estimate: ${estimatedMinutes} minutes, ${estimatedTokens.toLocaleString()} tokens, ${formatHiiMoney(totalCents, input.currency)} total.`
      },
      {
        actor: 'ledger',
        text: `${formatHiiMoney(computeCostCents, input.currency)} reimburses approved computer/model cost; ${formatHiiMoney(platformFeeCents, input.currency)} is the HII coordination fee.`
      },
      {
        actor: 'agent',
        text:
          status === 'over-budget'
            ? 'Waiting for a higher budget or a smaller scope before execution.'
            : 'Ready to run after explicit approval, then append logs, proof, and receipt to this transcript.'
      }
    ]
  };
}
