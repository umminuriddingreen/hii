<script lang="ts">
  import { page } from '$app/state';
  import { createClient } from '@/lib/supabase/client';

  type SocialProvider = 'google' | 'apple';

  let { data } = $props();

  let email = $state('');
  let sent = $state(false);
  let busy = $state(false);
  let socialBusy = $state<SocialProvider | null>(null);
  let message = $state('');

  function callbackUrl() {
    const next = page.url.searchParams.get('next') ?? '/dashboard';
    return `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
  }

  async function signInWith(provider: SocialProvider) {
    if (!data.providers[provider]) return;
    socialBusy = provider;
    message = '';
    try {
      const { error } = await createClient().auth.signInWithOAuth({
        provider,
        options: { redirectTo: callbackUrl() }
      });
      if (error) throw error;
    } catch (error) {
      message = error instanceof Error ? error.message : `Could not continue with ${provider}.`;
      socialBusy = null;
    }
  }

  async function submit() {
    busy = true; message = '';
    try {
      const { error } = await createClient().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: callbackUrl() }
      });
      if (error) throw error;
      sent = true;
    } catch (error) {
      message = error instanceof Error ? error.message : 'Could not send sign-in link.';
    } finally { busy = false; }
  }
</script>

<div class="hii-page max-w-2xl">
  <header class="hii-page-header">
    <p class="hii-kicker">HII account</p>
    <h1 class="hii-page-title">Enter your workspace</h1>
    <p class="hii-page-copy">Sign in or create an account with Google, Apple, or a one-click email link.</p>
  </header>

  {#if sent}
    <div class="hii-card mt-6 bg-[var(--hii-soft-green)] text-emerald-700">
      Check <span class="font-mono">{email}</span> for your sign-in link.
    </div>
  {:else}
    <section class="hii-card auth-card mt-6" aria-labelledby="account-options">
      <h2 id="account-options" class="sr-only">Account sign-in options</h2>

      <div class="provider-grid">
        <button
          type="button"
          class="provider-button"
          disabled={!data.providers.google || socialBusy !== null || busy}
          onclick={() => signInWith('google')}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.32 2.98-7.4Z" />
            <path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.62-2.43l-3.24-2.54c-.9.6-2.05.97-3.38.97-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z" />
            <path fill="#FBBC05" d="M6.39 13.87A6 6 0 0 1 6.07 12c0-.65.11-1.28.32-1.87V7.51H3.04A10 10 0 0 0 2 12c0 1.61.39 3.14 1.04 4.49l3.35-2.62Z" />
            <path fill="#EA4335" d="M12 6c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.65 9.65 0 0 0 12 2a10 10 0 0 0-8.96 5.51l3.35 2.62C7.18 7.76 9.39 6 12 6Z" />
          </svg>
          <span>{socialBusy === 'google' ? 'Opening Google…' : data.providers.google ? 'Continue with Google' : 'Google · setup pending'}</span>
        </button>

        <button
          type="button"
          class="provider-button provider-button-dark"
          disabled={!data.providers.apple || socialBusy !== null || busy}
          onclick={() => signInWith('apple')}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M17.05 12.54c-.02-2.18 1.78-3.24 1.86-3.3a4 4 0 0 0-3.15-1.7c-1.33-.14-2.62.8-3.3.8-.7 0-1.75-.78-2.88-.76a4.2 4.2 0 0 0-3.53 2.15c-1.53 2.64-.39 6.52 1.08 8.66.74 1.06 1.6 2.24 2.73 2.2 1.1-.05 1.52-.7 2.85-.7 1.32 0 1.7.7 2.86.67 1.19-.02 1.94-1.06 2.65-2.13a8.7 8.7 0 0 0 1.2-2.45 3.78 3.78 0 0 1-2.37-3.44ZM14.9 6.13a3.83 3.83 0 0 0 .88-2.74 3.92 3.92 0 0 0-2.54 1.3 3.68 3.68 0 0 0-.91 2.63 3.25 3.25 0 0 0 2.57-1.19Z" />
          </svg>
          <span>{socialBusy === 'apple' ? 'Opening Apple…' : data.providers.apple ? 'Continue with Apple' : 'Apple · setup pending'}</span>
        </button>
      </div>

      {#if !data.providers.google || !data.providers.apple}
        <p class="provider-status">Social sign-in is wired into HII and will unlock when its provider credentials are enabled. Email sign-in is ready now.</p>
      {/if}

      <div class="auth-divider"><span>or use email</span></div>

      <form class="space-y-4" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label class="block">
          <span class="text-sm text-neutral-600">Email address</span>
          <input type="email" required bind:value={email} class="hii-field mt-1 w-full px-3 py-2" placeholder="you@example.com" autocomplete="email" />
        </label>
        <button disabled={busy || socialBusy !== null} class="hii-command-button disabled:opacity-50">{busy ? 'Sending…' : 'Send sign-in link'}</button>
      </form>

      {#if message || page.url.searchParams.get('error') === 'auth'}
        <p class="auth-error" role="alert">{message || 'Sign-in could not be completed. Please try again.'}</p>
      {/if}

      <p class="auth-note">One account, one private workspace. HII never receives your Google or Apple password.</p>
    </section>
  {/if}
</div>

<style>
  .auth-card {
    padding: clamp(1.25rem, 3vw, 2rem);
  }

  .provider-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .provider-button {
    display: inline-flex;
    min-height: 3rem;
    align-items: center;
    justify-content: center;
    gap: 0.65rem;
    border: 1px solid var(--hii-border);
    border-radius: 0.75rem;
    background: #fff;
    padding: 0.75rem 1rem;
    color: var(--hii-ink);
    font-size: 0.9rem;
    font-weight: 650;
    transition: border-color 140ms ease, transform 140ms ease, box-shadow 140ms ease;
  }

  .provider-button svg {
    width: 1.15rem;
    height: 1.15rem;
    flex: 0 0 auto;
  }

  .provider-button:hover:not(:disabled) {
    border-color: var(--hii-electric-blue);
    box-shadow: 0 4px 18px rgb(24 93 255 / 10%);
    transform: translateY(-1px);
  }

  .provider-button-dark {
    border-color: #111;
    background: #111;
    color: #fff;
  }

  .provider-button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .provider-status {
    margin-top: 0.75rem;
    color: #6d6a63;
    font-size: 0.75rem;
    line-height: 1.5;
  }

  .auth-divider {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    margin: 1.4rem 0;
    color: #777;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.68rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  .auth-divider::before,
  .auth-divider::after {
    height: 1px;
    flex: 1;
    background: var(--hii-border);
    content: '';
  }

  .auth-error {
    margin-top: 1rem;
    color: #b42318;
    font-size: 0.875rem;
  }

  .auth-note {
    margin-top: 1.4rem;
    color: #777;
    font-size: 0.75rem;
    line-height: 1.55;
  }

  @media (max-width: 560px) {
    .provider-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .provider-button {
      transition: none;
    }
  }
</style>
