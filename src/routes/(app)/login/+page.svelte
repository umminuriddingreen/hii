<script lang="ts">
  import { page } from '$app/state';
  import { createClient } from '@/lib/supabase/client';
  let email = '';
  let sent = false;
  let busy = false;
  let message = '';

  async function submit() {
    busy = true; message = '';
    try {
      const next = page.url.searchParams.get('next') ?? '/dashboard';
      const { error } = await createClient().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}` }
      });
      if (error) throw error;
      sent = true;
    } catch (error) {
      message = error instanceof Error ? error.message : 'Could not send sign-in link.';
    } finally { busy = false; }
  }
</script>

<div class="hii-page max-w-2xl">
  <header class="hii-page-header"><p class="hii-kicker">HII auth</p><h1 class="hii-page-title">Sign in to HII</h1><p class="hii-page-copy">Enter your email and we’ll send a one-click sign-in link. No password; new accounts are created automatically.</p></header>
  {#if sent}<div class="hii-card mt-6 bg-[var(--hii-soft-green)] text-emerald-700">Check <span class="font-mono">{email}</span> for your sign-in link.</div>
  {:else}<form class="hii-card mt-6 space-y-4" on:submit|preventDefault={submit}><label class="block"><span class="text-sm text-neutral-600">Email</span><input type="email" required bind:value={email} class="hii-field mt-1 w-full px-3 py-2" placeholder="you@example.com" /></label>{#if message}<p class="text-red-600">{message}</p>{/if}<button disabled={busy} class="hii-command-button disabled:opacity-50">{busy?'Sending…':'Send sign-in link'}</button></form>{/if}
</div>
