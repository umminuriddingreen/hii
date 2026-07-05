'use client';

import { useEffect, useMemo, useState } from 'react';

type HiiCurrency = 'usd' | 'eur' | 'gbp' | 'credits';

type HiiQuote = {
  id: string;
  capabilityId: string;
  inputSummary: string;
  task: string;
  currency: HiiCurrency;
  estimatedTokens: number;
  estimatedMinutes: number;
  computeCostCents: number;
  platformFeeCents: number;
  totalCents: number;
  maxBudgetCents: number;
  status: 'ready' | 'needs-approval' | 'over-budget';
  createdAt: string;
  transcript: Array<{
    actor: 'user' | 'hii' | 'agent' | 'ledger';
    text: string;
  }>;
};

type CapabilityDefinition = {
  id: string;
  name: string;
  status: string;
};

type CreditAccount = {
  currency: HiiCurrency;
  balance_cents: number;
  reserved_cents: number;
};

type CreditLedgerEntry = {
  id: string;
  job_id: string | null;
  capability_id: string | null;
  actor: string;
  type: string;
  amount_cents: number | null;
  currency: HiiCurrency;
  summary: string;
  created_at: string;
};

type CapabilityJob = {
  id: string;
  capability_id: string;
  input_summary: string;
  status: string;
  currency: HiiCurrency;
  reserved_cents: number;
  quote?: HiiQuote | null;
  created_at: string;
};

type AccountResponse = {
  account: CreditAccount;
  accounts: CreditAccount[];
  ledger: CreditLedgerEntry[];
  jobs: CapabilityJob[];
  warning?: string;
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

const topUpAmounts = [1000, 2500, 5000, 10000, 25000];

function money(cents: number, currency: HiiCurrency) {
  if (currency === 'credits') return `${Math.round(cents / 100)} credits`;
  return `${currencySymbols[currency]}${(cents / 100).toFixed(2)}`;
}

function signedMoney(cents: number | null, currency: HiiCurrency) {
  if (cents === null) return '-';
  const prefix = cents > 0 ? '+' : '';
  return `${prefix}${money(cents, currency)}`;
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
  const [capabilityId, setCapabilityId] = useState('hii.agent.spawn');
  const [capabilities, setCapabilities] = useState<CapabilityDefinition[]>([]);
  const [accountData, setAccountData] = useState<AccountResponse | null>(null);
  const [signedIn, setSignedIn] = useState(true);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeQuote = useMemo(
    () =>
      quote ?? {
        id: 'hii-preview',
        capabilityId,
        inputSummary: task,
        task,
        currency,
        estimatedTokens: 0,
        estimatedMinutes: 0,
        computeCostCents: 0,
        platformFeeCents: 0,
        totalCents: 0,
        maxBudgetCents: Math.round(budget * 100),
        status: 'ready' as const,
        createdAt: new Date().toISOString(),
        transcript: [
          {
            actor: 'user' as const,
            text: task
          },
          {
            actor: 'hii' as const,
            text:
              'Send this as a task request. HII turns it into a quote, credit reservation, execution transcript, proof, and cost ledger.'
          }
        ]
      },
    [budget, capabilityId, currency, quote, task]
  );

  async function loadAccount(nextCurrency = currency) {
    try {
      const res = await fetch(`/api/credits/account?currency=${nextCurrency}`, { cache: 'no-store' });
      const data = await res.json();
      if (res.status === 401) {
        setAccountData(null);
        setSignedIn(false);
        return;
      }
      if (!res.ok) throw new Error(data.error ?? 'Could not load credit account.');
      setSignedIn(true);
      setAccountData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load credit account.');
    }
  }

  async function requestQuote() {
    setLoading('quote');
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/credits/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          task,
          currency,
          maxBudgetCents: Math.round(budget * 100),
          capabilityId
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not quote this task.');
      setQuote(data.quote);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not quote this task.');
    } finally {
      setLoading(null);
    }
  }

  async function topUp(amountCents: number) {
    setLoading(`topup-${amountCents}`);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/credits/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currency, amountCents })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not start Checkout.');
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start Checkout.');
      setLoading(null);
    }
  }

  async function reserveJob() {
    setLoading('reserve');
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/capabilities/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          task,
          currency,
          capabilityId,
          maxBudgetCents: Math.round(budget * 100)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not reserve credits for this job.');
      setQuote(data.quote);
      setNotice(`Reserved ${money(data.quote.totalCents, data.quote.currency)} for job ${data.job.id.slice(0, 8)}.`);
      await loadAccount(currency);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reserve credits for this job.');
    } finally {
      setLoading(null);
    }
  }

  async function finalizeJob(job: CapabilityJob) {
    const jobQuote = job.quote ?? activeQuote;
    setLoading(`finalize-${job.id}`);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/capabilities/jobs/${job.id}/finalize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: 'completed',
          computeCostCents: jobQuote.computeCostCents,
          platformFeeCents: jobQuote.platformFeeCents,
          currency: job.currency,
          summary: 'Operator marked this HII capability job complete.',
          proof: [
            {
              kind: 'receipt',
              label: 'HII receipt',
              summary: 'Credits finalized into compute reimbursement, HII fee, and released reserve.'
            }
          ],
          transcript: [
            {
              actor: 'ledger',
              text: 'Finalized task costs and released unused reserved credits.'
            }
          ]
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not finalize this job.');
      setNotice(`Finalized job ${job.id.slice(0, 8)}.`);
      await loadAccount(currency);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not finalize this job.');
    } finally {
      setLoading(null);
    }
  }

  useEffect(() => {
    fetch('/api/capabilities', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setCapabilities(data?.capabilities ?? []))
      .catch(() => setCapabilities([]));
  }, []);

  useEffect(() => {
    void loadAccount(currency);
  }, [currency]);

  const account = accountData?.account;
  const availableCents = account ? account.balance_cents - account.reserved_cents : 0;
  const canStripeTopUp = currency !== 'credits';

  return (
    <div className="min-h-[calc(100vh-9rem)]">
      <section className="border-b border-neutral-200 pb-6">
        <p className="text-sm font-medium text-neutral-500">HII credits</p>
        <h1 className="mt-3 max-w-4xl text-3xl font-bold tracking-normal">
          Account balance, task quotes, receipts, and proof in one transcript.
        </h1>
        <p className="mt-4 max-w-3xl text-neutral-600">
          Buy prepaid balance, reserve it for bounded capability work, then finalize each job into
          compute reimbursement, HII coordination fee, transcript, and proof artifacts.
        </p>
      </section>

      <section className="grid gap-5 pt-6 lg:grid-cols-[minmax(18rem,26rem)_1fr]">
        <aside className="space-y-5">
          <div className="rounded border border-neutral-200 p-4">
            <h2 className="font-semibold">Account Balance</h2>
            <label className="mt-4 block">
              <span className="text-sm text-neutral-600">Currency</span>
              <select
                value={currency}
                onChange={(event) => {
                  setCurrency(event.target.value as HiiCurrency);
                  setQuote(null);
                }}
                className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2"
              >
                {Object.entries(currencyLabels).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
              <div className="rounded border border-neutral-200 p-3">
                <p className="text-xs uppercase text-neutral-500">balance</p>
                <p className="mt-1 font-semibold">{money(account?.balance_cents ?? 0, currency)}</p>
              </div>
              <div className="rounded border border-neutral-200 p-3">
                <p className="text-xs uppercase text-neutral-500">reserved</p>
                <p className="mt-1 font-semibold">{money(account?.reserved_cents ?? 0, currency)}</p>
              </div>
              <div className="rounded border border-neutral-200 p-3">
                <p className="text-xs uppercase text-neutral-500">available</p>
                <p className="mt-1 font-semibold">{money(availableCents, currency)}</p>
              </div>
            </div>
            {canStripeTopUp ? (
              <div className="mt-4 grid grid-cols-2 gap-2">
                {topUpAmounts.map((amount) => (
                  <button
                    key={amount}
                    type="button"
                    onClick={() => topUp(amount)}
                    disabled={Boolean(loading)}
                    className="rounded border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
                  >
                    Add {money(amount, currency)}
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-sm text-neutral-500">
                Use USD, EUR, or GBP for Stripe top-ups. HII credits stay as an internal quote unit.
              </p>
            )}
            {accountData?.warning && (
              <p className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                {accountData.warning}
              </p>
            )}
          </div>

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
              <label className="col-span-2 block">
                <span className="text-sm text-neutral-600">Capability</span>
                <select
                  value={capabilityId}
                  onChange={(event) => setCapabilityId(event.target.value)}
                  className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2"
                >
                  {capabilities.length === 0 && <option value="hii.agent.spawn">Spawn bounded agent session</option>}
                  {capabilities.map((capability) => (
                    <option key={capability.id} value={capability.id}>
                      {capability.name} ({capability.status})
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
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  onClick={requestQuote}
                  disabled={Boolean(loading)}
                  className="w-full rounded border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
                >
                  {loading === 'quote' ? 'Quoting...' : 'Quote'}
                </button>
                <button
                  type="button"
                  onClick={reserveJob}
                  disabled={Boolean(loading) || activeQuote.status === 'over-budget'}
                  className="w-full rounded bg-black px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
                >
                  {loading === 'reserve' ? 'Reserving...' : 'Reserve'}
                </button>
              </div>
            </div>
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            {notice && <p className="mt-3 text-sm text-green-700">{notice}</p>}
            {!signedIn && (
              <a
                href="/login?next=/credits"
                className="mt-3 block rounded border border-neutral-300 px-3 py-2 text-center text-sm font-medium hover:bg-neutral-50"
              >
                Sign in to reserve credits
              </a>
            )}
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
              <span>{activeQuote.capabilityId}</span>
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

          <section className="rounded border border-neutral-200 p-4">
            <h2 className="font-semibold">Recent Jobs</h2>
            <div className="mt-4 divide-y divide-neutral-100 text-sm">
              {(accountData?.jobs ?? []).length === 0 && <p className="text-neutral-500">No reserved jobs yet.</p>}
              {(accountData?.jobs ?? []).map((job) => (
                <div key={job.id} className="grid gap-3 py-3 md:grid-cols-[1fr_auto]">
                  <div>
                    <p className="font-mono text-xs text-neutral-500">{job.id}</p>
                    <p className="mt-1 font-medium">{job.input_summary}</p>
                    <p className="mt-1 text-xs uppercase text-neutral-500">
                      {job.capability_id} · {job.status} · {money(job.reserved_cents, job.currency)}
                    </p>
                  </div>
                  {!['completed', 'failed', 'cancelled'].includes(job.status) && (
                    <button
                      type="button"
                      onClick={() => finalizeJob(job)}
                      disabled={Boolean(loading)}
                      className="h-9 rounded border border-neutral-300 px-3 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
                    >
                      {loading === `finalize-${job.id}` ? 'Finalizing...' : 'Finalize'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="rounded border border-neutral-200 p-4">
            <h2 className="font-semibold">Ledger</h2>
            <div className="mt-4 divide-y divide-neutral-100 text-sm">
              {(accountData?.ledger ?? []).length === 0 && <p className="text-neutral-500">No ledger rows yet.</p>}
              {(accountData?.ledger ?? []).map((entry) => (
                <div key={entry.id} className="grid grid-cols-[1fr_auto] gap-3 py-2">
                  <div>
                    <p className="font-medium">{entry.summary}</p>
                    <p className="mt-1 text-xs uppercase text-neutral-500">
                      {entry.type} · {entry.actor} · {new Date(entry.created_at).toLocaleString()}
                    </p>
                  </div>
                  <span className="font-mono">{signedMoney(entry.amount_cents, entry.currency)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
