"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const params = useSearchParams();
  const next = params.get("next") ?? "/dashboard";
  const [email, setEmail] = useState("");
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
    <div className="hii-page max-w-2xl">
      <header className="hii-page-header">
        <p className="hii-kicker">HII auth</p>
        <h1 className="hii-page-title">Sign in to HII</h1>
        <p className="hii-page-copy">
          Enter your email and we&apos;ll send a one-click sign-in link. No password; new
          accounts are created automatically.
        </p>
      </header>

      {sent ? (
        <div className="hii-card mt-6 bg-[var(--hii-soft-green)] text-emerald-700">
          Check <span className="font-mono">{email}</span> for your sign-in link.
        </div>
      ) : (
        <form onSubmit={sendLink} className="hii-card mt-6 space-y-4">
          <label className="block">
            <span className="text-sm text-neutral-600">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="hii-field mt-1 w-full px-3 py-2"
              placeholder="you@example.com"
            />
          </label>
          {error && <p className="text-red-600">{error}</p>}
          <button
            disabled={busy}
            className="hii-command-button disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Send sign-in link'}
          </button>
        </form>
      )}
    </div>
  );
}
