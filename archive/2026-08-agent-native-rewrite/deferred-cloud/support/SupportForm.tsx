'use client';

import { useState } from 'react';
import type { SupportCadence } from '@/lib/server/support';

export function SupportForm({
  amounts,
  stripeReady
}: {
  amounts: readonly number[];
  stripeReady: boolean;
}) {
  const [amount, setAmount] = useState<number>(amounts[1] ?? amounts[0] ?? 25);
  const [cadence, setCadence] = useState<SupportCadence>('once');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/support/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount, cadence })
      });
      const data = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !data.url) {
        throw new Error(data.error ?? 'Could not start checkout.');
      }
      window.location.href = data.url;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start checkout.');
      setPending(false);
    }
  }

  if (!stripeReady) {
    return (
      <p className="hii-next-support-note">
        Card support is not configured on this instance. GitHub Sponsors works either way.
      </p>
    );
  }

  return (
    <div className="hii-next-support-form">
      <div className="hii-next-support-row" role="group" aria-label="Amount">
        {amounts.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={amount === value}
            className={amount === value ? 'is-active' : undefined}
            onClick={() => setAmount(value)}
          >
            ${value}
          </button>
        ))}
        <label className="hii-next-support-custom">
          <span className="sr-only">Custom amount in US dollars</span>
          <input
            type="number"
            min={1}
            max={5000}
            step={1}
            value={amount}
            aria-label="Custom amount in US dollars"
            onChange={(event) => setAmount(Number(event.target.value))}
          />
        </label>
      </div>

      <div className="hii-next-support-row" role="group" aria-label="Frequency">
        {(['once', 'monthly'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={cadence === value}
            className={cadence === value ? 'is-active' : undefined}
            onClick={() => setCadence(value)}
          >
            {value === 'once' ? 'One time' : 'Monthly'}
          </button>
        ))}
      </div>

      <div className="hii-next-actions">
        <button type="button" onClick={start} disabled={pending}>
          {pending ? 'Opening checkout…' : `Support HII — $${amount}${cadence === 'monthly' ? '/mo' : ''}`}
        </button>
      </div>

      {error ? (
        <p className="hii-next-support-note" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
