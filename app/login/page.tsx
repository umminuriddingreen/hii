'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const params = useSearchParams();
  const next = params.get('next') ?? '/dashboard';
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const origin = window.location.origin;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` }
    });
    setBusy(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <>
      <h1 className="text-2xl font-bold">Sign in to HII</h1>
      <p className="mt-1 text-neutral-600">
        Enter your email and we&apos;ll send a one-click sign-in link. No password — new
        accounts are created automatically.
      </p>

      {sent ? (
        <div className="mt-6 rounded border border-emerald-300 bg-emerald-50 p-4 text-emerald-700">
          Check <span className="font-mono">{email}</span> for your sign-in link.
        </div>
      ) : (
        <form onSubmit={sendLink} className="mt-6 space-y-4">
          <label className="block">
            <span className="text-sm text-neutral-600">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2"
              placeholder="you@example.com"
            />
          </label>
          {error && <p className="text-red-600">{error}</p>}
          <button
            disabled={busy}
            className="rounded bg-black px-5 py-2 font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Send sign-in link'}
          </button>
        </form>
      )}
    </>
  );
}
