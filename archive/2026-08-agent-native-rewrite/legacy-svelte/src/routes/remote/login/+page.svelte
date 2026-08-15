<script lang="ts">
  import { enhance } from '$app/forms';
  import HiiLogo from '$lib/components/HiiLogo.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>HII remote workspace · sign in</title></svelte:head>

<main>
  <section>
    <HiiLogo title="HII" />
    <p class="eyebrow">REMOTE / EVENT WORKSPACE</p>
    <h1>Enter the blank canvas.</h1>
    <p class="lede">This browser-only demo cannot access the host Mac, local files, or an agent runtime.</p>
    <form method="POST" use:enhance>
      <label>Username<input name="username" autocomplete="username" autocapitalize="none" required /></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required /></label>
      {#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
      {#if !data.configured}<p class="error" role="alert">Remote workspace is not configured.</p>{/if}
      <button disabled={!data.configured}>Open workspace <span aria-hidden="true">↗</span></button>
    </form>
  </section>
</main>

<style>
  :global(body){margin:0;background:#f7f7f2;color:#0b0b0b;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}
  main{min-height:100svh;display:grid;place-items:center;padding:24px;box-sizing:border-box;background-image:radial-gradient(#cfcfc7 1px,transparent 1px);background-size:22px 22px}
  section{width:min(100%,440px);background:rgba(255,255,255,.94);border:1px solid #d8d8d1;padding:32px;box-shadow:0 24px 80px rgba(0,0,0,.1)}
  :global(.hii-wordmark){font-size:44px;color:#146cff}
  .eyebrow{margin:28px 0 12px;font:700 11px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em}
  h1{font-size:clamp(38px,11vw,58px);line-height:.92;letter-spacing:-.055em;margin:0;max-width:360px}
  .lede{font-size:16px;line-height:1.55;color:#555;margin:22px 0 28px}
  form{display:grid;gap:16px}
  label{display:grid;gap:7px;font:700 11px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em}
  input{font:500 18px ui-sans-serif,-apple-system,sans-serif;border:1px solid #bcbcb4;border-radius:0;padding:15px;background:white;min-width:0}
  input:focus{outline:3px solid rgba(20,108,255,.2);border-color:#146cff}
  button{border:0;background:#0b0b0b;color:white;padding:17px 20px;font:700 13px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;display:flex;justify-content:space-between}
  button:disabled{opacity:.45}
  .error{margin:0;color:#b42318;font-size:14px}
</style>
