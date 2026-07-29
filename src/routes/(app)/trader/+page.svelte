<script lang="ts">
  import { onMount } from 'svelte';

  let snapshot: any = null;
  let loading = '';
  let error = '';
  let poll: ReturnType<typeof setInterval> | undefined;
  let profileDraft: any = null;

  const money = (value: number) => new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 10 ? 4 : 2
  }).format(Number(value || 0));
  const percent = (value: number) => `${Number(value || 0).toFixed(2)}%`;
  const time = (value: string | null) => value ? new Date(value).toLocaleString() : 'not yet';

  async function load() {
    try {
      const response = await fetch('/api/trader');
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load trader.');
      snapshot = body;
      if (!profileDraft) profileDraft = structuredClone(body.profile);
      error = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function act(action: string, extra: Record<string, unknown> = {}) {
    loading = action;
    error = '';
    try {
      const response = await fetch('/api/trader', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...extra })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Trader ${action} failed.`);
      snapshot = body;
      if (action === 'profile') profileDraft = structuredClone(body.profile);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = '';
    }
  }

  onMount(() => {
    load();
    poll = setInterval(load, 15_000);
    return () => poll && clearInterval(poll);
  });
</script>

<svelte:head>
  <title>Trader · HII</title>
  <meta name="description" content="Governed local autonomous paper trading with source-linked decisions and proof." />
</svelte:head>

<div class="trader-shell">
  <header class="trader-hero">
    <div>
      <p class="eyebrow">HII capability · local experimental</p>
      <h1>Trader</h1>
      <p class="lede">A professional paper-trading loop: evidence → thesis → deterministic risk → execution → attribution.</p>
    </div>
    <div class="mode-lock">
      <span class:active={snapshot?.status?.mode === 'paper'}></span>
      <div><small>mode</small><strong>{snapshot?.status?.mode || 'loading'}</strong></div>
      <b>LIVE LOCKED</b>
    </div>
  </header>

  {#if error}<div class="error" role="alert">{error}</div>{/if}

  <section class="command-strip">
    <button class="primary" disabled={Boolean(loading) || snapshot?.status?.mode === 'killed'} on:click={() => act('start')}>
      {loading === 'start' ? 'Starting…' : 'Start autonomous paper'}
    </button>
    <button disabled={Boolean(loading)} on:click={() => act('cycle')}>{loading === 'cycle' ? 'Reading markets + model…' : 'Run cycle now'}</button>
    <button disabled={Boolean(loading)} on:click={() => act('pause')}>Pause</button>
    <button class="danger" disabled={Boolean(loading) || snapshot?.status?.mode === 'killed'} on:click={() => act('kill')}>Emergency kill</button>
    <span>hiid checks every minute · strategy cycles no faster than every 5 minutes</span>
  </section>

  {#if snapshot}
    <section class="metrics">
      <article><small>paper equity</small><strong>{money(snapshot.status.equityUsd)}</strong><em>cash {money(snapshot.status.cashUsd)}</em></article>
      <article><small>drawdown</small><strong class:negative={snapshot.status.drawdownPct > 0}>{percent(snapshot.status.drawdownPct)}</strong><em>hard stop {percent(snapshot.profile.maximumDrawdownPct)}</em></article>
      <article><small>today</small><strong class:negative={snapshot.status.dailyPnlPct < 0}>{percent(snapshot.status.dailyPnlPct)}</strong><em>breaker −{percent(snapshot.profile.dailyLossPct)}</em></article>
      <article><small>closed trades</small><strong>{snapshot.metrics.closedTrades}</strong><em>{snapshot.metrics.paperDays} / 90 paper days</em></article>
      <article><small>fees modeled</small><strong>{money(snapshot.metrics.totalFeesUsd)}</strong><em>0.26% + slippage</em></article>
    </section>

    <main class="trader-grid">
      <div class="main-column">
        <section class="panel book">
          <header><div><small>live public API observations</small><h2>Market book</h2></div><span>Kraken + DEX Screener</span></header>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Asset</th><th>Class</th><th>Price</th><th>24h</th><th>Volume</th><th>Status</th></tr></thead>
              <tbody>
                {#each snapshot.market as asset}
                  <tr>
                    <td><strong>{asset.symbol}</strong><small>{asset.venue}</small></td>
                    <td>{asset.assetClass}</td>
                    <td>{money(asset.priceUsd)}</td>
                    <td class:positive={asset.change24hPct > 0} class:negative={asset.change24hPct < 0}>{percent(asset.change24hPct)}</td>
                    <td>{money(asset.volume24hUsd)}</td>
                    <td><span class:ready={asset.eligible} class="status">{asset.eligible ? 'eligible' : 'watch only'}</span></td>
                  </tr>
                  {#if !asset.eligible}<tr class="reason"><td colspan="6">{asset.ineligibleReasons.join(' · ')}</td></tr>{/if}
                {:else}
                  <tr><td colspan="6" class="empty">Run the first cycle to load verified market observations.</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel decisions">
          <header><div><small>model proposes · policy decides</small><h2>Decision journal</h2></div><span>Ollama {snapshot.dataCoverage.intelligence}</span></header>
          <div class="decision-list">
            {#each snapshot.decisions.slice(0, 12) as decision}
              <article>
                <div class="decision-top">
                  <strong>{decision.asset.symbol}</strong>
                  <b data-action={decision.proposal.action}>{decision.proposal.action}</b>
                  <span>{Math.round(decision.proposal.confidence * 100)}% confidence</span>
                  <time>{time(decision.createdAt)}</time>
                </div>
                <p>{decision.proposal.thesis}</p>
                <small>Invalidation: {decision.proposal.invalidation}</small>
                <div class="risk-line" class:approved={decision.risk.approved}>
                  {decision.risk.approved ? `approved ${money(decision.risk.notionalUsd)}` : decision.risk.reasons.join(' · ')}
                </div>
              </article>
            {:else}
              <p class="empty">No decisions yet. Start paper mode, then run a cycle.</p>
            {/each}
          </div>
        </section>
      </div>

      <aside>
        <section class="panel">
          <header><div><small>current inventory</small><h2>Positions</h2></div></header>
          {#each snapshot.positions as position}
            <div class="position">
              <div><strong>{position.symbol}</strong><small>{position.assetClass}</small></div>
              <div><strong>{money(position.marketValueUsd)}</strong><small class:positive={position.unrealizedPnlUsd >= 0} class:negative={position.unrealizedPnlUsd < 0}>{money(position.unrealizedPnlUsd)}</small></div>
            </div>
          {:else}<p class="empty">Cash only.</p>{/each}
        </section>

        <section class="panel gate">
          <header><div><small>capital boundary</small><h2>Live promotion</h2></div><b>LOCKED</b></header>
          <div class="progress"><i style={`width:${Math.min(100, snapshot.promotion.completedDays / snapshot.promotion.requiredDays * 100)}%`}></i></div>
          <strong>{snapshot.promotion.completedDays} / {snapshot.promotion.requiredDays} days</strong>
          <div class="progress"><i style={`width:${Math.min(100, snapshot.promotion.completedClosedTrades / snapshot.promotion.requiredClosedTrades * 100)}%`}></i></div>
          <strong>{snapshot.promotion.completedClosedTrades} / {snapshot.promotion.requiredClosedTrades} closed trades</strong>
          <ul>{#each snapshot.promotion.blockers as blocker}<li>{blocker}</li>{/each}</ul>
          <button disabled on:click={() => act('activate-live')}>Live activation unavailable</button>
        </section>

        {#if profileDraft}
          <section class="panel profile">
            <header><div><small>explicit questionnaire</small><h2>Risk profile v{snapshot.profile.version}</h2></div></header>
            <label>Maximum drawdown <span>{profileDraft.maximumDrawdownPct}%</span><input type="range" min="5" max="35" step="1" bind:value={profileDraft.maximumDrawdownPct} /></label>
            <label>Daily loss breaker <span>{profileDraft.dailyLossPct}%</span><input type="range" min="0.5" max="5" step="0.5" bind:value={profileDraft.dailyLossPct} /></label>
            <label>Meme allocation cap <span>{profileDraft.memeAllocationPct}%</span><input type="range" min="0" max="30" step="1" bind:value={profileDraft.memeAllocationPct} /></label>
            <label>Attention budget<select bind:value={profileDraft.attentionBudget}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
            <button disabled={Boolean(loading)} on:click={() => act('profile', { profile: profileDraft })}>Save reviewed profile</button>
          </section>
        {/if}

        <section class="panel provenance">
          <header><div><small>truth boundary</small><h2>Coverage</h2></div></header>
          <dl>
            <div><dt>Market</dt><dd>{snapshot.dataCoverage.market}</dd></div>
            <div><dt>DEX</dt><dd>{snapshot.dataCoverage.dex}</dd></div>
            <div><dt>On-chain safety</dt><dd>{snapshot.dataCoverage.onChainSecurity}</dd></div>
            <div><dt>Social</dt><dd>{snapshot.dataCoverage.social}</dd></div>
            <div><dt>Last cycle</dt><dd>{time(snapshot.status.lastCycleAt)}</dd></div>
          </dl>
          <code>{snapshot.receiptPath}</code>
        </section>
      </aside>
    </main>
  {:else}
    <div class="loading">Loading governed trader state…</div>
  {/if}
</div>

<style>
  :global(body){background:#eeefe9}
  .trader-shell{min-height:100vh;background:#eeefe9;color:#121410;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}
  .trader-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:30px;border-bottom:1px solid #b8bbb1;padding:42px clamp(22px,4vw,58px) 30px}
  .eyebrow,.panel small,.metrics small{font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:#72776d}
  h1{margin:5px 0 4px;font-size:clamp(48px,7vw,92px);line-height:.9;letter-spacing:-.075em} .lede{max-width:680px;margin:14px 0 0;color:#555b51;font-size:15px}
  .mode-lock{display:flex;align-items:center;gap:12px;border:1px solid #1b1e18;border-radius:999px;padding:9px 12px;background:#f8f9f4}.mode-lock>span{width:10px;height:10px;border-radius:50%;background:#8b9087}.mode-lock>span.active{background:#a5ff2f;box-shadow:0 0 0 4px #dfffb6}.mode-lock div{display:flex;flex-direction:column}.mode-lock small{font-size:8px;text-transform:uppercase}.mode-lock strong{font-size:12px}.mode-lock b{border-radius:999px;background:#111;color:#fff;padding:6px 9px;font:700 9px ui-monospace,monospace}
  .command-strip{display:flex;align-items:center;gap:8px;border-bottom:1px solid #c9ccc2;padding:13px clamp(22px,4vw,58px);background:#f8f9f4}.command-strip span{margin-left:auto;color:#777d73;font:10px ui-monospace,monospace}
  button,select{border:1px solid #aeb2a7;border-radius:9px;background:#fff;padding:9px 12px;color:#171914;font:650 12px inherit;cursor:pointer}button:hover{border-color:#111}button:disabled{cursor:not-allowed;opacity:.45}.primary{border-color:#111;background:#111;color:#fff}.danger{border-color:#d95c4f;color:#a7271b}
  .error{margin:16px clamp(22px,4vw,58px) 0;border:1px solid #d95c4f;border-radius:10px;background:#fff4f1;padding:12px;color:#8a2118}
  .metrics{display:grid;grid-template-columns:repeat(5,1fr);border-bottom:1px solid #b8bbb1}.metrics article{display:flex;min-height:100px;flex-direction:column;justify-content:center;border-right:1px solid #b8bbb1;padding:18px clamp(14px,2vw,28px)}.metrics article:last-child{border:0}.metrics strong{margin:7px 0 4px;font-size:24px;letter-spacing:-.04em}.metrics em{color:#757a72;font:10px ui-monospace,monospace;font-style:normal}
  .trader-grid{display:grid;grid-template-columns:minmax(0,1fr) 350px;gap:14px;padding:14px}.main-column,aside{display:flex;flex-direction:column;gap:14px}.panel{overflow:hidden;border:1px solid #c5c8be;border-radius:14px;background:#f8f9f4}.panel>header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #d5d8cf;padding:15px 17px}.panel h2{margin:3px 0 0;font-size:18px;letter-spacing:-.025em}.panel>header>span,.panel>header>b{color:#737970;font:9px ui-monospace,monospace;text-transform:uppercase}
  .table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left}th{padding:10px 14px;color:#777c73;font:700 9px ui-monospace,monospace;text-transform:uppercase}td{border-top:1px solid #e1e3dc;padding:10px 14px;font-size:12px}td strong,td small{display:block}td small{margin-top:3px;font-size:9px}.reason td{padding-top:4px;color:#8a6856;font:9px ui-monospace,monospace}.status{display:inline-block;border-radius:999px;background:#e7e8e2;padding:4px 7px;font:8px ui-monospace,monospace;text-transform:uppercase}.status.ready{background:#dfffb6;color:#24370a}
  .decision-list>article{padding:15px 17px;border-bottom:1px solid #e0e2da}.decision-list>article:last-child{border:0}.decision-top{display:flex;align-items:center;gap:9px}.decision-top b{border-radius:5px;background:#e5e7df;padding:4px 6px;font:8px ui-monospace,monospace;text-transform:uppercase}.decision-top b[data-action="buy"]{background:#dfffb6}.decision-top b[data-action="sell"]{background:#ffd7cf}.decision-top span,.decision-top time{color:#797e75;font:9px ui-monospace,monospace}.decision-top time{margin-left:auto}.decision-list p{margin:10px 0 5px;font-size:13px}.decision-list article>small{font-size:10px;text-transform:none}.risk-line{margin-top:9px;border-left:3px solid #d76558;padding-left:8px;color:#8e3128;font:9px ui-monospace,monospace}.risk-line.approved{border-color:#6f9f2c;color:#41631a}
  .position{display:flex;justify-content:space-between;border-bottom:1px solid #e0e2da;padding:13px 16px}.position>div{display:flex;flex-direction:column}.position>div:last-child{text-align:right}
  .gate{padding-bottom:16px}.gate>header b{color:#a4291e}.progress{height:5px;margin:16px 16px 7px;overflow:hidden;border-radius:99px;background:#dfe1da}.progress i{display:block;height:100%;background:#176bff}.gate>strong{margin:0 16px;font:10px ui-monospace,monospace}.gate ul{margin:16px;padding-left:18px;color:#656b62;font-size:11px;line-height:1.6}.gate>button{margin:0 16px;width:calc(100% - 32px)}
  .profile{padding-bottom:16px}.profile label{display:grid;grid-template-columns:1fr auto;gap:8px;margin:15px 16px;color:#555b52;font-size:11px}.profile label span{font-family:ui-monospace,monospace}.profile input,.profile select{grid-column:1/-1;width:100%;box-sizing:border-box}.profile button{margin:0 16px;width:calc(100% - 32px)}
  .provenance{padding-bottom:15px}.provenance dl{margin:0}.provenance dl div{display:flex;justify-content:space-between;border-bottom:1px solid #e0e2da;padding:9px 16px;font-size:10px}.provenance dt{color:#777c73}.provenance dd{margin:0;font-family:ui-monospace,monospace;text-align:right}.provenance code{display:block;overflow:hidden;margin:14px 16px 0;color:#777c73;font-size:9px;text-overflow:ellipsis}
  .positive{color:#4e7b16!important}.negative{color:#b23b30!important}.empty,.loading{padding:28px;color:#7a8076;text-align:center;font-size:12px}
  @media(max-width:1000px){.metrics{grid-template-columns:repeat(2,1fr)}.metrics article:last-child{border-right:1px solid #b8bbb1}.trader-grid{grid-template-columns:1fr}.trader-hero{align-items:flex-start;flex-direction:column}.command-strip{flex-wrap:wrap}.command-strip span{width:100%;margin:4px 0 0}}
  @media(max-width:600px){.metrics{grid-template-columns:1fr}.metrics article{border-right:0;border-bottom:1px solid #b8bbb1}.mode-lock{width:100%;box-sizing:border-box}.command-strip button{flex:1 1 45%}}
</style>
