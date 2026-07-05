'use client';

import { useMemo, useState } from 'react';

type HiiCurrency = 'usd' | 'eur' | 'gbp' | 'credits';

type HiiQuote = {
  id: string;
  task: string;
  currency: HiiCurrency;
  estimatedTokens: number;
  estimatedMinutes: number;
  computeCostCents: number;
  platformFeeCents: number;
  totalCents: number;
  maxBudgetCents: number;
  status: 'ready' | 'needs-approval' | 'over-budget';
  transcript: Array<{
    actor: 'user' | 'hii' | 'agent' | 'ledger';
    text: string;
  }>;
};

const initialTask =
  'Use my computer to inspect the HII terminal, summarize what happened, and produce a demo-safe next action list.';

const currencyLabels: Record<HiiCurrency, string> = {
  usd: 'USD',
  eur: 'EUR',
  gbp: 'GBP',
  credits: 'HII credits'
};

const currencySymbols: Record<HiiCurrency, string> = {
  usd: '$',
  eur: '€',
  gbp: '£',
  credits: 'cr '
};

function money(cents: number, currency: HiiCurrency) {
  if (currency === 'credits') return `${Math.round(cents / 100)} credits`;
  return `${currencySymbols[currency]}${(cents / 100).toFixed(2)}`;
}

function statusLabel(status: HiiQuote['status']) {
  if (status === 'over-budget') return 'needs rescope';
  if (status === 'needs-approval') return 'needs approval';
  return 'ready';
}

export function HiiCredits() {
  const [task, setTask] = useState(initialTask);
  const [currency, setCurrency] = useState<HiiCurrency>('usd');
  const [budget, setBudget] = useState(15);
  const [quote, setQuote] = useState<HiiQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestQuote() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/credits/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          task,
          currency,
          maxBudgetCents: Math.round(budget * 100)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not quote this task.');
      setQuote(data.quote);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not quote this task.');
    } finally {
      setLoading(false);
    }
  }

  const activeQuote = useMemo(
    () =>
      quote ?? {
        id: 'hii-preview',
        task,
        currency,
        estimatedTokens: 0,
        estimatedMinutes: 0,
        computeCostCents: 0,
        platformFeeCents: 0,
        totalCents: 0,
        maxBudgetCents: Math.round(budget * 100),
        status: 'ready' as const,
        transcript: [
          {
            actor: 'user' as const,
            text: task
          },
          {
            actor: 'hii' as const,
            text:
              'Send this as a task request. HII turns it into a quote, execution transcript, proof, and cost ledger.'
          }
        ]
      },
    [budget, currency, quote, task]
  );

  return (
    <div className="min-h-[calc(100vh-9rem)]">
      <section className="border-b border-neutral-200 pb-6">
        <p className="text-sm font-medium text-neutral-500">HII credits</p>
        <h1 className="mt-3 max-w-4xl text-3xl font-bold tracking-normal">
          Make computer use feel like a conversation with a receipt.
        </h1>
        <p className="mt-4 max-w-3xl text-neutral-600">
          Every task becomes a transcript: user intent, quote, approval, agent logs, proof, and
          ledger entries for compute reimbursement and HII fees.
        </p>
      </section>

      <section className="grid gap-5 pt-6 lg:grid-cols-[minmax(18rem,25rem)_1fr]">
        <aside className="space-y-5">
          <div className="rounded border border-neutral-200 p-4">
            <h2 className="font-semibold">Task Request</h2>
            <label className="mt-4 block">
              <span className="text-sm text-neutral-600">What should HII do?</span>
              <textarea
                value={task}
                onChange={(event) => setTask(event.target.value)}
                className="mt-1 min-h-36 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm"
              />
            </label>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm text-neutral-600">Currency</span>
                <select
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value as HiiCurrency)}
                  className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2"
                >
                  {Object.entries(currencyLabels).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-sm text-neutral-600">Max budget</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={budget}
                  onChange={(event) => setBudget(Number(event.target.value))}
                  className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2"
                />
              </label>
            </div>
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <button
              type="button"
              onClick={requestQuote}
              disabled={loading}
              className="mt-4 w-full rounded bg-black px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              {loading ? 'Quoting...' : 'Quote task'}
            </button>
          </div>

          <div className="rounded border border-neutral-200 p-4">
            <h2 className="font-semibold">Commercial Rule</h2>
            <div className="mt-3 space-y-3 text-sm text-neutral-700">
              <p>Credits are stored as an account balance in a chosen currency or HII credits.</p>
              <p>Each approved task burns balance into two ledger rows: compute reimbursement and HII coordination fee.</p>
              <p>Real collection should use Stripe Checkout for top-ups and Billing or Metronome for subscriptions and usage.</p>
            </div>
          </div>
        </aside>

        <div className="space-y-5">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded border border-neutral-200 p-4">
              <p className="text-xs uppercase text-neutral-500">status</p>
              <p className="mt-2 font-semibold">{statusLabel(activeQuote.status)}</p>
            </div>
            <div className="rounded border border-neutral-200 p-4">
              <p className="text-xs uppercase text-neutral-500">tokens</p>
              <p className="mt-2 font-semibold">{activeQuote.estimatedTokens.toLocaleString()}</p>
            </div>
            <div className="rounded border border-neutral-200 p-4">
              <p className="text-xs uppercase text-neutral-500">runtime</p>
              <p className="mt-2 font-semibold">{activeQuote.estimatedMinutes} min</p>
            </div>
            <div className="rounded border border-neutral-200 p-4">
              <p className="text-xs uppercase text-neutral-500">total</p>
              <p className="mt-2 font-semibold">{money(activeQuote.totalCents, activeQuote.currency)}</p>
            </div>
          </div>

          <div className="rounded border border-neutral-900 bg-black">
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3 font-mono text-xs text-neutral-400">
              <span>hii://conversation/{activeQuote.id}</span>
              <span>{currencyLabels[activeQuote.currency]}</span>
            </div>
            <div className="space-y-3 p-4">
              {activeQuote.transcript.map((turn, index) => (
                <div
                  key={`${turn.actor}-${index}`}
                  className={`rounded border p-3 ${
                    turn.actor === 'user'
                      ? 'border-blue-900 bg-blue-950 text-blue-100'
                      : turn.actor === 'ledger'
                        ? 'border-amber-900 bg-amber-950 text-amber-100'
                        : 'border-neutral-800 bg-neutral-950 text-green-100'
                  }`}
                >
                  <p className="font-mono text-xs uppercase text-neutral-400">{turn.actor}</p>
                  <p className="mt-2 text-sm leading-6">{turn.text}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded border border-neutral-200 p-4">
            <h2 className="font-semibold">Ledger Preview</h2>
            <div className="mt-4 divide-y divide-neutral-100 text-sm">
              <div className="grid grid-cols-[1fr_auto] gap-3 py-2">
                <span>Credit reservation</span>
                <span>{money(activeQuote.maxBudgetCents, activeQuote.currency)}</span>
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-3 py-2">
                <span>Computer and model reimbursement</span>
                <span>{money(activeQuote.computeCostCents, activeQuote.currency)}</span>
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-3 py-2">
                <span>HII coordination fee</span>
                <span>{money(activeQuote.platformFeeCents, activeQuote.currency)}</span>
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-3 py-2 font-semibold">
                <span>Task quote total</span>
                <span>{money(activeQuote.totalCents, activeQuote.currency)}</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
