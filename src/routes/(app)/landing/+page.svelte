<script lang="ts">
  import HiiLogo from '$lib/components/HiiLogo.svelte';

  const useSteps = [
    {
      label: 'Bring in context',
      title: 'Start with the work you already have.',
      copy: 'Drop in project folders, notes, links, images, and files. HII keeps the source and the boundary visible.'
    },
    {
      label: 'Work in place',
      title: 'Give the workspace an outcome.',
      copy: 'Open chat, terminal, browser, board, or live context as objects on the same canvas. Approve what agents can use.'
    },
    {
      label: 'Keep the proof',
      title: 'Finished work comes back inspectable.',
      copy: 'Review the changed files, checks, artifacts, and receipt. Reuse a proven workflow only after it earns trust.'
    }
  ];

  const trustPoints = [
    ['Your files stay yours', 'HII works from deliberate local sources instead of copying your life into another cloud.'],
    ['Authority stays visible', 'Context, permissions, execution, and publishing remain separate decisions.'],
    ['Receipts beat claims', 'A completed run points to the commands, artifacts, tests, and next action that prove it.']
  ];

  const lineage = [
    ['01', 'Your intention'],
    ['02', 'Approved information'],
    ['03', 'Agent work'],
    ['04', 'Verified result']
  ];
</script>

<svelte:head>
  <title>HII — Your information and agents in one workspace</title>
  <meta name="description" content="HII is the local-first Mac workspace where your information and agents work together—with visible context, bounded execution, and proof." />
  <link rel="canonical" href="https://humaninformationinterface.com/" />
  <meta property="og:title" content="HII — Your information and agents in one workspace" />
  <meta property="og:description" content="Bring your information. Direct your agents. Keep the proof." />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://humaninformationinterface.com/" />
  <meta property="og:image" content="https://humaninformationinterface.com/marketing/hii-workspace-live.png" />
  <meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<div class="hii-launch-page">
  <header class="hii-launch-nav" aria-label="HII homepage navigation">
    <a class="hii-launch-brand" href="#top" aria-label="HII home">
      <HiiLogo />
      <span>Human Information Interface</span>
    </a>
    <nav>
      <a href="#product">Product</a>
      <a href="#how">How it works</a>
      <a href="#trust">Trust</a>
      <a href="#pricing">Pricing</a>
    </nav>
    <a class="hii-account-link" href="#download">Get HII for Mac <span aria-hidden="true">↓</span></a>
  </header>

  <main id="top">
    <section class="hii-launch-hero" aria-labelledby="hero-title">
      <div class="hii-launch-rail" aria-hidden="true"><i>✦</i><span>⊕</span><span>T</span></div>
      <div class="hii-live-pill"><i></i> local workspace</div>

      <div class="hii-launch-copy">
        <p class="hii-launch-eyebrow"><span></span> Human Information Interface</p>
        <h1 id="hero-title">Your information.<br />Your agents.<br /><em>One workspace.</em></h1>
        <p class="hii-launch-deck">HII is the local-first Mac app where you bring the information, direct the work, and inspect the result—all in the same place.</p>
        <div class="hii-launch-actions">
          <a class="hii-launch-primary" href="#download">Get the Mac beta <span aria-hidden="true">↓</span></a>
          <a class="hii-launch-secondary" href="/pilot">Build my first workflow <span aria-hidden="true">↗</span></a>
        </div>
        <p class="hii-launch-note">Apple Silicon · macOS 13+ · local by default · no credit card for the beta</p>
      </div>

      <figure class="hii-palette-proof">
        <div class="hii-window-meta"><span>HII / THE ACTUAL PRODUCT</span><span>⌘ K</span></div>
        <img src="/marketing/hii-command-palette-live.png" alt="The real HII workspace with its command palette open over a local project canvas" width="1280" height="720" />
        <figcaption>Actual interface · local project · no concept render</figcaption>
      </figure>
    </section>

    <section class="hii-product-proof" id="product" aria-labelledby="product-title">
      <div class="hii-product-intro">
        <p class="hii-launch-eyebrow"><span></span> One interface for human information</p>
        <h2 id="product-title">The work stays<br />in view.</h2>
        <p>Files, notes, live context, agent conversation, and proof stay together as objects you can arrange, inspect, and return to.</p>
      </div>

      <div class="hii-lineage" aria-label="HII verified work loop">
        {#each lineage as item, index}
          <div><b>{item[0]}</b><span>{item[1]}</span></div>
          {#if index < lineage.length - 1}<i aria-hidden="true">→</i>{/if}
        {/each}
      </div>

      <figure class="hii-workspace-proof">
        <div class="hii-window-meta"><span>LOCAL WORKSPACE / ONE COMPLETE JOB</span><span class="hii-proof-ready"><i></i> proof ready</span></div>
        <img src="/marketing/hii-workspace-live.png" alt="The real HII spatial workspace showing a launch brief, approved context, HII chat, and a verified receipt" width="1280" height="720" />
        <figcaption>
          <span>Human intent</span><span>Approved context</span><span>Bounded work</span><span>Receipt</span>
        </figcaption>
      </figure>
    </section>

    <section class="hii-use-section" id="how" aria-labelledby="use-title">
      <header>
        <p class="hii-launch-eyebrow"><span></span> Using HII</p>
        <h2 id="use-title">One loop.<br />No handoff fog.</h2>
      </header>
      <div class="hii-use-steps">
        {#each useSteps as step, index}
          <article>
            <span class="hii-step-index">0{index + 1}</span>
            <p>{step.label}</p>
            <h3>{step.title}</h3>
            <span>{step.copy}</span>
          </article>
        {/each}
      </div>
    </section>

    <section class="hii-trust-section" id="trust" aria-labelledby="trust-title">
      <div class="hii-trust-copy">
        <p class="hii-launch-eyebrow hii-launch-eyebrow-light"><span></span> Local-first by design</p>
        <h2 id="trust-title">Your context is not the price of admission.</h2>
        <p>HII is useful because it remembers what the work means—not because it quietly owns the work.</p>
      </div>
      <div class="hii-trust-list">
        {#each trustPoints as point}
          <article><i></i><div><h3>{point[0]}</h3><p>{point[1]}</p></div></article>
        {/each}
      </div>
    </section>

    <section class="hii-pricing-section" id="pricing" aria-labelledby="pricing-title">
      <header>
        <p class="hii-launch-eyebrow"><span></span> Simple from day one</p>
        <h2 id="pricing-title">The app is free.<br />Expert setup is not.</h2>
        <p>HII does not monetize your information. We charge when we take responsibility for setup, delivery, and support.</p>
      </header>
      <div class="hii-offers">
        <article>
          <p>Local beta</p>
          <h3>Free</h3>
          <span>Use HII on your own Mac with your own agents and local information.</span>
          <ul><li>Spatial workspace</li><li>Local knowledge</li><li>Bounded agent runs</li><li>Proof and receipts</li></ul>
          <a href="#download">Get release updates <span aria-hidden="true">↓</span></a>
        </article>
        <article class="hii-offer-featured">
          <p>Founder activation</p>
          <h3>$500 <small>one time</small></h3>
          <span>We set up HII around one valuable task and stay until the first verified result works.</span>
          <ul><li>60-minute workflow design</li><li>Hands-on Mac setup</li><li>One working agent workflow</li><li>Recorded proof and handoff</li></ul>
          <a href="/pilot">Apply for activation <span aria-hidden="true">↗</span></a>
        </article>
      </div>
    </section>

    <section class="hii-download-section" id="download" aria-labelledby="download-title">
      <div>
        <p class="hii-launch-eyebrow"><span></span> HII for macOS</p>
        <h2 id="download-title">Free local beta.<br />Coming to your Mac.</h2>
      </div>
      <div class="hii-download-actions">
        <a class="hii-launch-primary" href="mailto:hello@humaninformationinterface.com?subject=HII%20Mac%20beta">Get release updates <span aria-hidden="true">↗</span></a>
        <button type="button" disabled aria-describedby="download-status">Signed Mac installer · preparing</button>
        <p id="download-status">The app works locally. Public download opens after Developer ID signing and Apple notarization pass. We will never ask you to bypass Gatekeeper.</p>
      </div>
    </section>
  </main>

  <footer class="hii-launch-footer">
    <HiiLogo />
    <p>Human intent → bounded work → visible proof</p>
    <a href="mailto:hello@humaninformationinterface.com">hello@humaninformationinterface.com</a>
  </footer>
</div>

<style>
  :global(html) { scroll-behavior: smooth; }
  :global(body) { background: #f8f8f5; }
  .hii-launch-page { --paper:#f8f8f5; --ink:#151515; --blue:#176bff; --acid:#baff34; --muted:#7d817f; min-height:100vh; overflow:hidden; background:var(--paper); color:var(--ink); font-family:"Helvetica Neue",Helvetica,Arial,sans-serif; }
  .hii-launch-page * { box-sizing:border-box; }
  .hii-launch-page a:focus-visible, .hii-launch-page button:focus-visible { outline:3px solid var(--acid); outline-offset:3px; }
  .hii-launch-nav { position:relative; z-index:20; display:grid; min-height:76px; grid-template-columns:1fr auto 1fr; align-items:center; gap:28px; padding:0 clamp(22px,4vw,64px); background:rgba(248,248,245,.9); backdrop-filter:blur(18px); }
  .hii-launch-brand { display:flex; align-items:center; gap:14px; width:max-content; color:inherit; text-decoration:none; }
  .hii-launch-brand :global(.hii-wordmark) { font-size:34px; }
  .hii-launch-brand span, .hii-launch-nav nav a, .hii-account-link, .hii-launch-note, .hii-window-meta, figure figcaption, .hii-launch-footer { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; text-transform:uppercase; letter-spacing:.11em; }
  .hii-launch-brand span { font-size:8px; font-weight:700; }
  .hii-launch-nav nav { display:flex; gap:28px; }
  .hii-launch-nav nav a { color:inherit; font-size:9px; font-weight:700; text-decoration:none; }
  .hii-account-link { justify-self:end; border-radius:999px; background:var(--ink); color:white; padding:12px 17px; font-size:9px; font-weight:700; text-decoration:none; }
  .hii-launch-hero { position:relative; min-height:1120px; padding:clamp(72px,9vw,132px) clamp(24px,7vw,108px) 110px; background-image:radial-gradient(circle,rgba(21,21,21,.1) 1px,transparent 1px); background-size:32px 32px; }
  .hii-launch-rail { position:absolute; top:74px; left:18px; display:flex; width:44px; flex-direction:column; align-items:center; gap:4px; border-radius:14px; background:#111; padding:6px; box-shadow:0 14px 30px rgba(0,0,0,.14); color:white; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .hii-launch-rail i, .hii-launch-rail span { display:grid; width:32px; height:32px; place-items:center; border-radius:9px; font-size:12px; font-style:normal; }
  .hii-launch-rail i { background:var(--blue); }
  .hii-live-pill { position:absolute; top:30px; right:clamp(24px,5vw,72px); display:flex; align-items:center; gap:9px; border-radius:999px; background:var(--blue); padding:11px 16px; color:white; box-shadow:0 9px 22px rgba(23,107,255,.22); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9px; letter-spacing:.09em; }
  .hii-live-pill i, .hii-proof-ready i { width:7px; height:7px; border-radius:50%; background:var(--acid); box-shadow:0 0 0 3px rgba(186,255,52,.16); }
  .hii-launch-copy { position:relative; z-index:2; max-width:1120px; }
  .hii-launch-eyebrow { display:flex; align-items:center; gap:10px; margin:0; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; }
  .hii-launch-eyebrow span { width:8px; height:8px; border-radius:50%; background:var(--blue); box-shadow:0 0 0 4px rgba(23,107,255,.12); }
  .hii-launch-copy h1 { margin:32px 0 0; font-size:clamp(68px,8.6vw,136px); font-weight:700; letter-spacing:-.078em; line-height:.83; }
  .hii-launch-copy h1 em { color:var(--blue); font-style:normal; }
  .hii-launch-deck { max-width:690px; margin:48px 0 0; font-size:clamp(20px,2.2vw,31px); font-weight:500; letter-spacing:-.035em; line-height:1.22; }
  .hii-launch-actions { display:flex; flex-wrap:wrap; align-items:center; gap:15px; margin-top:34px; }
  .hii-launch-primary, .hii-launch-secondary, .hii-download-actions button { display:inline-flex; min-height:48px; align-items:center; justify-content:center; gap:18px; border:0; border-radius:999px; padding:0 22px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; font-weight:700; letter-spacing:.06em; text-decoration:none; }
  .hii-launch-primary { background:var(--blue); color:white; box-shadow:0 10px 24px rgba(23,107,255,.2); }
  .hii-launch-secondary { background:white; color:var(--ink); box-shadow:0 8px 24px rgba(21,21,21,.08); }
  .hii-launch-note { margin-top:20px; color:var(--muted); font-size:8px; line-height:1.7; }
  .hii-palette-proof, .hii-workspace-proof { position:relative; margin:82px auto 0; overflow:hidden; border-radius:24px; background:white; box-shadow:0 40px 90px rgba(35,38,37,.16); }
  .hii-palette-proof { max-width:1280px; transform:rotate(-.35deg); }
  .hii-window-meta { display:flex; height:42px; align-items:center; justify-content:space-between; padding:0 17px; color:#929694; font-size:8px; }
  .hii-palette-proof img, .hii-workspace-proof img { display:block; width:100%; height:auto; }
  .hii-palette-proof figcaption { padding:12px 17px 14px; color:#929694; font-size:7px; }
  .hii-product-proof { padding:130px clamp(24px,7vw,108px) 140px; background:white; }
  .hii-product-intro { display:grid; grid-template-columns:minmax(0,.8fr) minmax(300px,.45fr); align-items:end; gap:80px; }
  .hii-product-intro .hii-launch-eyebrow { grid-column:1/-1; }
  .hii-product-intro h2, .hii-use-section h2, .hii-trust-section h2, .hii-download-section h2 { margin:22px 0 0; font-size:clamp(54px,7.4vw,112px); font-weight:650; letter-spacing:-.075em; line-height:.88; }
  .hii-product-intro > p:last-child { margin:0; color:#5f6461; font-size:20px; line-height:1.45; }
  .hii-lineage { display:grid; grid-template-columns:1fr auto 1fr auto 1fr auto 1fr; align-items:center; gap:16px; margin-top:74px; border-top:1px solid #dfe3e8; border-bottom:1px solid #dfe3e8; padding:18px 0; }
  .hii-lineage div { display:flex; align-items:center; gap:12px; }
  .hii-lineage b { color:var(--blue); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9px; }
  .hii-lineage span { font-size:14px; font-weight:650; }
  .hii-lineage i { color:#9ca3af; font-style:normal; }
  .hii-workspace-proof { max-width:1440px; margin-top:76px; background:#f8f8f5; }
  .hii-proof-ready { display:flex; align-items:center; gap:8px; color:var(--blue); }
  .hii-workspace-proof figcaption { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; padding:14px 18px 16px; color:#747975; font-size:7px; }
  .hii-workspace-proof figcaption span:not(:first-child) { text-align:center; }
  .hii-workspace-proof figcaption span:last-child { text-align:right; }
  .hii-use-section { display:grid; grid-template-columns:minmax(300px,.9fr) minmax(0,1.1fr); gap:90px; padding:140px clamp(24px,7vw,108px); background:var(--paper); }
  .hii-use-section header { position:sticky; top:80px; align-self:start; }
  .hii-use-steps { display:grid; gap:70px; padding-top:10px; }
  .hii-use-steps article { position:relative; min-height:260px; padding-left:86px; }
  .hii-step-index { position:absolute; top:0; left:0; color:var(--blue); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .hii-use-steps article > p { margin:0; color:var(--blue); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9px; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }
  .hii-use-steps h3 { max-width:650px; margin:18px 0 16px; font-size:clamp(31px,4vw,58px); font-weight:600; letter-spacing:-.055em; line-height:.98; }
  .hii-use-steps article > span:last-child { display:block; max-width:580px; color:#656a67; font-size:18px; line-height:1.55; }
  .hii-trust-section { display:grid; grid-template-columns:1fr 1fr; gap:90px; padding:140px clamp(24px,7vw,108px); background:#151515; color:white; }
  .hii-launch-eyebrow-light span { background:var(--acid); box-shadow:0 0 0 4px rgba(186,255,52,.12); }
  .hii-trust-copy > p:last-child { max-width:650px; margin:34px 0 0; color:#aeb3b0; font-size:20px; line-height:1.5; }
  .hii-trust-list { display:grid; align-content:center; gap:40px; }
  .hii-trust-list article { display:grid; grid-template-columns:12px 1fr; gap:18px; }
  .hii-trust-list i { width:9px; height:9px; margin-top:8px; border-radius:50%; background:var(--acid); }
  .hii-trust-list h3 { margin:0; font-size:24px; font-weight:600; letter-spacing:-.03em; }
  .hii-trust-list p { max-width:550px; margin:8px 0 0; color:#aeb3b0; font-size:16px; line-height:1.55; }
  .hii-pricing-section { display:grid; grid-template-columns:minmax(300px,.8fr) minmax(0,1.2fr); gap:90px; padding:140px clamp(24px,7vw,108px); background:white; }
  .hii-pricing-section header > p:last-child { max-width:620px; margin:32px 0 0; color:#656a67; font-size:19px; line-height:1.5; }
  .hii-pricing-section h2 { margin:22px 0 0; font-size:clamp(52px,6vw,94px); font-weight:650; letter-spacing:-.07em; line-height:.9; }
  .hii-offers { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; align-content:start; }
  .hii-offers article { display:flex; min-height:510px; flex-direction:column; border:1px solid #dfe3e8; border-radius:22px; padding:32px; background:#f8f8f5; }
  .hii-offers article > p { margin:0; color:var(--blue); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
  .hii-offers h3 { margin:26px 0 18px; font-size:55px; letter-spacing:-.06em; }
  .hii-offers h3 small { font-size:12px; letter-spacing:0; }
  .hii-offers article > span { color:#656a67; font-size:16px; line-height:1.5; }
  .hii-offers ul { display:grid; gap:12px; margin:28px 0 34px; padding:0; list-style:none; }
  .hii-offers li { border-top:1px solid rgba(21,21,21,.12); padding-top:12px; font-size:13px; }
  .hii-offers a { display:flex; min-height:46px; align-items:center; justify-content:space-between; margin-top:auto; border-radius:999px; background:var(--ink); padding:0 18px; color:white; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9px; font-weight:700; text-decoration:none; }
  .hii-offers .hii-offer-featured { border-color:var(--blue); background:var(--blue); color:white; transform:translateY(28px); }
  .hii-offer-featured > p { color:white; }
  .hii-offers .hii-offer-featured > span { color:rgba(255,255,255,.76); }
  .hii-offer-featured li { border-color:rgba(255,255,255,.24); }
  .hii-offers .hii-offer-featured a { background:white; color:var(--blue); }
  .hii-download-section { display:grid; grid-template-columns:1.2fr .8fr; gap:80px; align-items:end; padding:150px clamp(24px,7vw,108px); background:var(--acid); }
  .hii-download-actions { display:flex; flex-direction:column; align-items:flex-start; gap:13px; }
  .hii-download-actions .hii-launch-primary { background:var(--ink); box-shadow:none; }
  .hii-download-actions button { color:#7d816f; background:rgba(255,255,255,.58); cursor:not-allowed; }
  .hii-download-actions p { max-width:480px; margin:8px 0 0; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9px; line-height:1.7; }
  .hii-launch-footer { display:grid; min-height:120px; grid-template-columns:1fr auto 1fr; align-items:center; gap:22px; padding:28px clamp(24px,4vw,64px); background:#151515; color:white; font-size:8px; }
  .hii-launch-footer :global(.hii-wordmark) { font-size:34px; }
  .hii-launch-footer p { color:#8f9491; }
  .hii-launch-footer a { justify-self:end; color:white; text-decoration:none; }
  @media (max-width:900px) {
    .hii-launch-nav { grid-template-columns:1fr auto; }
    .hii-launch-nav nav { display:none; }
    .hii-launch-brand span { display:none; }
    .hii-launch-hero { min-height:auto; padding-top:100px; }
    .hii-launch-rail { display:none; }
    .hii-live-pill { top:22px; }
    .hii-product-intro, .hii-use-section, .hii-trust-section, .hii-pricing-section, .hii-download-section { grid-template-columns:1fr; }
    .hii-product-intro { gap:28px; }
    .hii-use-section, .hii-trust-section, .hii-pricing-section, .hii-download-section { gap:70px; }
    .hii-use-section header { position:static; }
    .hii-offers .hii-offer-featured { transform:none; }
  }
  @media (max-width:1200px) and (min-width:901px) {
    .hii-launch-brand > span { display:none; }
    .hii-launch-nav { gap:18px; padding-inline:32px; }
    .hii-launch-nav nav { gap:20px; }
    .hii-account-link { white-space:nowrap; }
  }
  @media (max-width:600px) {
    .hii-launch-nav { min-height:64px; padding:0 16px; }
    .hii-account-link { padding:10px 12px; font-size:8px; }
    .hii-launch-hero { padding:90px 16px 76px; background-size:26px 26px; }
    .hii-live-pill { right:16px; }
    .hii-launch-copy h1 { font-size:clamp(52px,16.5vw,78px); line-height:.88; }
    .hii-launch-deck { margin-top:34px; font-size:19px; }
    .hii-palette-proof { margin-top:56px; border-radius:15px; }
    .hii-window-meta { height:34px; padding:0 11px; }
    .hii-palette-proof figcaption { display:none; }
    .hii-product-proof, .hii-use-section, .hii-trust-section, .hii-pricing-section, .hii-download-section { padding:92px 16px; }
    .hii-product-intro h2, .hii-use-section h2, .hii-trust-section h2, .hii-download-section h2 { font-size:clamp(48px,15vw,76px); }
    .hii-workspace-proof { margin-top:50px; border-radius:15px; }
    .hii-workspace-proof figcaption { grid-template-columns:1fr 1fr; }
    .hii-workspace-proof figcaption span { text-align:left !important; }
    .hii-lineage { grid-template-columns:1fr; gap:12px; }
    .hii-lineage i { display:none; }
    .hii-lineage div { justify-content:space-between; border-bottom:1px solid #edf0f2; padding-bottom:12px; }
    .hii-offers { grid-template-columns:1fr; }
    .hii-offers article { min-height:470px; padding:26px; }
    .hii-use-steps article { min-height:auto; padding-left:54px; }
    .hii-use-steps { gap:76px; }
    .hii-launch-footer { grid-template-columns:1fr auto; }
    .hii-launch-footer p { display:none; }
  }
  @media (prefers-reduced-motion:reduce) { :global(html) { scroll-behavior:auto; } }
</style>
