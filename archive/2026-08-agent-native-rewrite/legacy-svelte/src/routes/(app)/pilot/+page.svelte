<script lang="ts">
  import { enhance } from '$app/forms';
  import { onMount } from 'svelte';

  let { data, form } = $props();
  let step = $state(1);
  let submitting = $state(false);
  let hasJs = $state(false);

  onMount(() => { hasJs = true; });

  const next = () => { if (step < 5) step += 1; };
  const back = () => { if (step > 1) step -= 1; };
</script>

<svelte:head>
  <title>HII Founder Pilot</title>
  <meta name="description" content="Apply for a hands-on HII founder pilot." />
</svelte:head>

<main class="pilot-page">
  <header class="pilot-header">
    <a href="/landing" class="wordmark">hii</a>
    <span>Founder pilot / $500</span>
  </header>

  {#if form?.success}
    <section class="success" aria-live="polite">
      <p class="eyebrow"><i></i> Application received</p>
      <h1>Let’s make the<br /><em>first win real.</em></h1>
      <p>Your pilot brief is in. Next, we’ll use a short call to choose one bounded task and define the proof together.</p>
      {#if data.bookingUrl}
        <a class="primary" href={data.bookingUrl}>Book your pilot call <span aria-hidden="true">↗</span></a>
      {:else}
        <p class="booking-pending">Booking link coming soon</p>
      {/if}
    </section>
  {:else}
    <div class="pilot-grid">
      <section class="intro">
        <p class="eyebrow"><i></i> HII / founder beta</p>
        <h1>Bring one<br /><em>real task.</em></h1>
        <p>We’ll turn a meaningful piece of your work into a bounded agent workflow—with visible context, proof, and a reusable receipt.</p>
        <div class="promise"><b>One focused pilot.</b><span>Hands-on setup · $500 · built around your actual work</span></div>
      </section>

      <section class="wizard" aria-labelledby="wizard-title">
        <div class="progress"><span>Step {step} of 5</span><div><i style={`width:${step * 20}%`}></i></div></div>
        <form method="POST" use:enhance={() => { submitting = true; return async ({ update }) => { await update(); submitting = false; }; }}>
          <h2 id="wizard-title">
            {#if step === 1}Start with you.{:else if step === 2}What are you building?{:else if step === 3}Your local setup.{:else if step === 4}Choose the first win.{:else}Timing and commitment.{/if}
          </h2>

          <fieldset class:hidden={hasJs && step !== 1}>
            <label>Name<input name="name" autocomplete="name" required value={form?.values?.name ?? ''} placeholder="Your name" /></label>
            <label>Email<input name="email" type="email" autocomplete="email" required value={form?.values?.email ?? ''} placeholder="you@example.com" /></label>
          </fieldset>
          <fieldset class:hidden={hasJs && step !== 2}>
            <label>Project description<textarea name="project_summary" required rows="6" placeholder="What are you working on, and why does it matter?">{form?.values?.project_summary ?? ''}</textarea></label>
          </fieldset>
          <fieldset class:hidden={hasJs && step !== 3}>
            <legend>Preferred agent</legend>
            <div class="choices">
              {#each [['codex','Codex'], ['claude-code','Claude Code'], ['ollama','Ollama']] as agent}
                <label class="choice"><input type="radio" name="agent_pref" value={agent[0]} required checked={form?.values?.agent_pref === agent[0]} /><span>{agent[1]}</span></label>
              {/each}
            </div>
            <legend>Are you on an Apple Silicon Mac?</legend>
            <div class="choices two">
              <label class="choice"><input type="radio" name="apple_silicon" value="yes" required checked={form?.values?.apple_silicon === 'yes'} /><span>Yes</span></label>
              <label class="choice"><input type="radio" name="apple_silicon" value="no" required checked={form?.values?.apple_silicon === 'no'} /><span>No</span></label>
            </div>
          </fieldset>
          <fieldset class:hidden={hasJs && step !== 4}>
            <label>Desired first task<textarea name="task_idea" required rows="6" placeholder="What concrete result would make this pilot immediately worthwhile?">{form?.values?.task_idea ?? ''}</textarea></label>
          </fieldset>
          <fieldset class:hidden={hasJs && step !== 5}>
            <label>Timeline<select name="timeline" required value={form?.values?.timeline ?? ''}><option value="" disabled>Select a timeline</option><option value="this-week">This week</option><option value="next-2-weeks">Within 2 weeks</option><option value="this-month">This month</option><option value="exploring">I’m exploring</option></select></label>
            <label class="consent"><input type="checkbox" name="pilot_consent" value="yes" required /><span>I understand the hands-on founder pilot costs <b>$500</b> and want to apply.</span></label>
          </fieldset>

          {#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
          <div class="actions">
            {#if step > 1}<button type="button" class="back" onclick={back}>Back</button>{/if}
            {#if step < 5}<button type="button" class="primary" onclick={next}>Continue <span aria-hidden="true">→</span></button>{:else}<button class="primary" disabled={submitting}>{submitting ? 'Submitting…' : 'Apply for the pilot →'}</button>{/if}
          </div>
          <noscript><p class="no-js">JavaScript is off: complete all fields, then use the submit button below.</p><button class="primary">Apply for the pilot →</button></noscript>
        </form>
      </section>
    </div>
  {/if}
</main>

<style>
  :global(body){margin:0;background:#f3f3ed}.pilot-page{--paper:#f3f3ed;--ink:#151515;--blue:#176bff;--acid:#baff34;min-height:100vh;background:var(--paper);color:var(--ink);font-family:Helvetica Neue,Helvetica,Arial,sans-serif}.pilot-header{display:flex;min-height:72px;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(21,21,21,.12);padding:0 clamp(20px,5vw,72px);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}.wordmark{color:var(--blue);font-family:Helvetica Neue,Helvetica,Arial,sans-serif;font-size:34px;font-weight:700;letter-spacing:-.08em;text-decoration:none;text-transform:lowercase}.pilot-grid{display:grid;grid-template-columns:minmax(0,.9fr) minmax(420px,.7fr);gap:clamp(50px,8vw,130px);padding:clamp(64px,8vw,120px) clamp(20px,7vw,108px)}.intro{max-width:720px}.eyebrow{display:flex;align-items:center;gap:10px;margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}.eyebrow i{width:8px;height:8px;border-radius:50%;background:var(--blue);box-shadow:0 0 0 4px rgba(23,107,255,.12)}h1{margin:30px 0 0;font-size:clamp(70px,8vw,126px);font-weight:700;letter-spacing:-.08em;line-height:.8}h1 em{color:var(--blue);font-style:normal}.intro>p:nth-of-type(2),.success>p:nth-of-type(2){max-width:620px;margin:42px 0 0;font-size:clamp(18px,2vw,25px);font-weight:500;letter-spacing:-.03em;line-height:1.35}.promise{display:grid;gap:7px;margin-top:46px;border-left:4px solid var(--acid);padding:4px 0 4px 18px}.promise b{font-size:14px}.promise span,.booking-pending{color:#696d69;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px;line-height:1.6}.wizard{align-self:start;border-radius:24px;background:#fff;padding:clamp(24px,4vw,48px);box-shadow:0 30px 80px rgba(35,38,37,.13)}.progress{display:flex;align-items:center;gap:18px;color:#777;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:8px;letter-spacing:.09em;text-transform:uppercase}.progress>div{height:3px;flex:1;overflow:hidden;border-radius:5px;background:#e7e7e1}.progress i{display:block;height:100%;background:var(--blue);transition:width .2s ease}.wizard h2{margin:42px 0 32px;font-size:clamp(31px,4vw,49px);font-weight:650;letter-spacing:-.055em;line-height:.95}fieldset{display:grid;gap:22px;margin:0;border:0;padding:0}fieldset.hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}label,legend{display:grid;gap:9px;color:#565956;font-size:11px;font-weight:700;letter-spacing:.04em}legend{margin:4px 0 2px}input,textarea,select{box-sizing:border-box;width:100%;border:1px solid #d8d8d1;border-radius:12px;background:#fafaf7;padding:14px 15px;color:var(--ink);font:500 15px/1.4 Helvetica Neue,Helvetica,Arial,sans-serif}textarea{resize:vertical}input:focus,textarea:focus,select:focus{border-color:var(--blue);outline:3px solid rgba(23,107,255,.12)}.choices{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}.choices.two{grid-template-columns:repeat(2,1fr)}.choice{display:block}.choice input{position:absolute;width:1px;height:1px;opacity:0}.choice span{display:grid;min-height:50px;place-items:center;border:1px solid #d8d8d1;border-radius:12px;background:#fafaf7;color:var(--ink)}.choice input:checked+span{border-color:var(--blue);background:rgba(23,107,255,.07);color:var(--blue)}.consent{grid-template-columns:20px 1fr;align-items:start;border-radius:12px;background:#f2f8e6;padding:16px;line-height:1.5}.consent input{width:18px;height:18px;margin:1px 0 0;accent-color:var(--blue)}.actions{display:flex;justify-content:flex-end;gap:12px;margin-top:34px}.primary,.back{display:inline-flex;min-height:48px;align-items:center;justify-content:center;gap:18px;border:0;border-radius:999px;padding:0 22px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;font-weight:700;text-decoration:none}.primary{background:var(--blue);color:#fff;box-shadow:0 10px 24px rgba(23,107,255,.2)}.back{background:#ecece7;color:var(--ink)}button:disabled{opacity:.55}.error{margin:22px 0 0;color:#b42318;font-size:13px}.no-js{font-size:12px}.success{max-width:950px;padding:clamp(80px,10vw,150px) clamp(20px,8vw,120px)}.success .primary{margin-top:34px}.booking-pending{margin-top:34px}@media(max-width:850px){.pilot-grid{grid-template-columns:1fr}.intro{max-width:none}.wizard{border-radius:18px}}@media(max-width:520px){.pilot-header{min-height:62px}.pilot-grid{padding-top:55px}.choices{grid-template-columns:1fr}.wizard{padding:22px 18px}h1{font-size:clamp(64px,21vw,92px)}}@media(prefers-reduced-motion:reduce){.progress i{transition:none}}
</style>
