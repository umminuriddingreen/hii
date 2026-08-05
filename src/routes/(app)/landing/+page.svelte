<script lang="ts">
  import HiiLogo from '$lib/components/HiiLogo.svelte';

  const objects = ['Context Dock', 'Workspace', 'Knowledge', 'Terminal', 'Browser', 'Notch', 'Create', 'HII CLI'];

  const moves = [
    {
      mark: '⌖',
      title: 'See the real context.',
      copy: 'Bring in the project, notes, files, links, and live machine state that matter. HII keeps every source and boundary visible.'
    },
    {
      mark: '↳',
      title: 'Approve one move.',
      copy: 'Name the outcome, choose what an agent may use, and review the workspace, capability, and external-action boundary before it runs.'
    },
    {
      mark: '✓',
      title: 'Get proof back.',
      copy: 'The artifact, changed files, checks, logs, and receipt return to the same workspace—ready to inspect, continue, or reuse.'
    }
  ];

  const examples = [
    ['Workspace', 'Arrange sources, live tools, agent work, and receipts as connected objects on one spatial canvas.'],
    ['Knowledge', 'Write, link, search, graph, import, and export local knowledge without losing provenance.'],
    ['HII CLI', 'Use the same local runtime from HII’s native terminal: observe state, act within bounds, and verify the result.']
  ];
</script>

<svelte:head>
  <title>HII — Verified agent work, grounded in your context</title>
  <meta
    name="description"
    content="HII is a local-first workspace and native CLI for source-linked context, bounded agent work, proof, and durable receipts."
  />
  <link rel="canonical" href="https://humaninformationinterface.com/" />
  <meta property="og:title" content="HII — Verified agent work, grounded in your context" />
  <meta
    property="og:description"
    content="See the context. Approve the move. Inspect the proof."
  />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://humaninformationinterface.com/" />
  <meta property="og:image" content="https://humaninformationinterface.com/marketing/hii-run-receipt-live.png" />
  <meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<div class="home">
  <header class="nav">
    <a class="brand" href="#top" aria-label="HII home">
      <HiiLogo />
      <span>Human Information Interface</span>
    </a>
    <nav aria-label="Homepage">
      <a href="#how">The loop</a>
      <a href="#surfaces">Surfaces</a>
      <a href="#live-run">Live run</a>
    </nav>
    <a class="nav-cta" href="/learn">Open HII <span aria-hidden="true">↗</span></a>
  </header>

  <main id="top">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="kicker"><i></i> Local-first workspace + native CLI</p>
        <h1 id="hero-title">Your context.<br />Agent work<br /><em>you can verify.</em></h1>
        <p class="deck">
          HII turns your files, notes, repos, tools, and current machine state into approved,
          bounded agent work—then returns the artifact, the checks, and the receipt.
        </p>
        <div class="actions">
          <a class="primary" href="/learn">Try the workspace <span aria-hidden="true">↗</span></a>
          <a class="secondary" href="#download">Get the desktop app</a>
        </div>
        <p class="small-note">The browser demo uses sample data and cannot access your computer. The capture at right is from a completed local HII run.</p>
      </div>

      <figure class="workspace-window">
        <div class="window-bar">
          <span class="lights" aria-hidden="true"><i></i><i></i><i></i></span>
          <span>HII / VERIFIED RUN / 43S</span>
          <span class="live"><i></i> captured live</span>
        </div>
        <img
          src="/marketing/hii-run-receipt-live.png"
          alt="A live HII workspace showing approved context, a completed bounded run, its editable artifact, passing checks, and a saved receipt"
          width="1920"
          height="1080"
        />
        <div class="cursor-stamp" aria-hidden="true">
          <svg viewBox="0 0 22 28"><path d="M2 2L19 17L11 18L7 26Z" /></svg>
          <span>you + HII</span>
        </div>
        <figcaption>
          <span>3 sources approved</span>
          <span>2 checks passed</span>
          <span>receipt saved</span>
        </figcaption>
      </figure>
    </section>

    <section class="object-strip" aria-label="Things you can bring into HII">
      <p>One local runtime · multiple ways in</p>
      <div>
        {#each objects as object, index}
          <span>{object}</span>{#if index < objects.length - 1}<i>+</i>{/if}
        {/each}
      </div>
    </section>

    <section class="moves" id="how" aria-labelledby="moves-title">
      <header>
        <p class="kicker"><i></i> The HII loop</p>
        <h2 id="moves-title">See the state.<br /><em>Approve the move.</em><br />Keep the proof.</h2>
        <p>
          Models and tools can change. Your context, authority, project memory, and evidence stay
          with you in HII.
        </p>
      </header>
      <div class="move-list">
        {#each moves as move, index}
          <article>
            <span class="move-number">0{index + 1}</span>
            <b aria-hidden="true">{move.mark}</b>
            <h3>{move.title}</h3>
            <p>{move.copy}</p>
          </article>
        {/each}
      </div>
    </section>

    <section class="examples" id="surfaces" aria-labelledby="examples-title">
      <div class="example-intro">
        <p class="kicker"><i></i> One system, not one screen</p>
        <h2 id="examples-title">Work visually.<br />Work in text.<br />Keep one truth.</h2>
        <p>
          Workspace, Knowledge, Browser, Create, Notch, the native Terminal, and the HII CLI all
          read from the same local project state and proof history.
        </p>
      </div>
      <div class="example-board">
        {#each examples as example, index}
          <article class:tilt-left={index === 0} class:tilt-right={index === 2}>
            <div class="card-top">
              <span>{index === 2 ? 'HII / CLI / NATIVE TERMINAL' : `HII / ${example[0]}`}</span>
              <i aria-hidden="true">{index === 0 ? '⌖' : index === 1 ? '⌘I' : '>_'}</i>
            </div>
            <h3>{example[0]}</h3>
            <p>{example[1]}</p>
            {#if index === 2}
              <img src="/marketing/hii-cli-terminal-live.png" alt="The HII CLI running hii home inside HII's native terminal" width="680" height="440" />
            {/if}
            <span class="card-result">{index === 0 ? 'spatial control' : index === 1 ? 'source-linked memory' : 'observe → act → verify'} · same local runtime</span>
          </article>
        {/each}
      </div>
    </section>

    <section class="proof" id="live-run" aria-labelledby="proof-title">
      <figure>
        <div class="window-bar">
          <span>HII / ACTUAL LOCAL RUN</span>
          <span class="live"><i></i> completed + receipted</span>
        </div>
        <img
          src="/marketing/hii-run-receipt-live.png"
          alt="The actual HII spatial workspace with approved context, bounded work, an editable artifact, verification, and a receipt"
          width="1920"
          height="1080"
        />
      </figure>
      <div class="proof-copy">
        <p class="kicker kicker-light"><i></i> Captured from HII, not a mockup</p>
        <h2 id="proof-title">One run.<br />Five visible<br />states.</h2>
        <p>
          This run used three approved source objects, wrote one editable artifact, passed two
          checks, and returned an inspectable local receipt in 43 seconds.
        </p>
        <ul>
          <li><span>01</span><strong>Intent approved</strong></li>
          <li><span>02</span><strong>Accepted by AII</strong></li>
          <li><span>03</span><strong>Bounded work completed</strong></li>
          <li><span>04</span><strong>Proof collected</strong></li>
          <li><span>05</span><strong>Receipt returned</strong></li>
        </ul>
        <a href="/privacy">Read the plain-language boundary <span aria-hidden="true">↗</span></a>
      </div>
    </section>

    <section class="join" id="download" aria-labelledby="join-title">
      <div>
        <p class="kicker"><i></i> HII on your computer</p>
        <h2 id="join-title">Download.<br />Choose a project.<br />Make one move.</h2>
      </div>
      <div class="join-card">
        <span>Windows 10 / 11 · x64</span>
        <strong>Windows</strong>
        <p>A current-user installer with HII’s local runtime included. No administrator account required.</p>
        <a href="/download/windows">
          Download for Windows <span aria-hidden="true">↓</span>
        </a>
      </div>
      <div class="join-card founder">
        <span>macOS 13+ · Apple Silicon</span>
        <strong>Mac</strong>
        <p>The Mac build is ready locally; public download stays closed until Apple notarization passes.</p>
        <a href="mailto:hello@humaninformationinterface.com?subject=Notify%20me%20when%20HII%20for%20Mac%20is%20notarized">Get the Mac release notice <span aria-hidden="true">↗</span></a>
      </div>
      <p class="installer-note">
        HII keeps project state on your computer under <code>~/.hii</code>. We do not ask you to disable
        Gatekeeper or Windows security protections.
      </p>
    </section>
  </main>

  <footer>
    <HiiLogo />
    <p>Context → approval → work → proof → receipt.</p>
    <div>
      <a href="/architecture">Architecture example</a>
      <a href="/privacy">Privacy</a>
      <a href="mailto:hello@humaninformationinterface.com">Contact</a>
    </div>
  </footer>
</div>

<style>
  :global(html) { scroll-behavior:smooth; }
  :global(body) { background:#f4f6fa; }
  .home { --ink:#111216; --canvas:#f4f6fa; --blue:#4058ff; --lime:#dfff45; --coral:#ff735c; --line:#d9dde7; min-height:100vh; overflow:hidden; background:var(--canvas); color:var(--ink); font-family:"Helvetica Neue",Helvetica,Arial,sans-serif; }
  .home * { box-sizing:border-box; }
  .home a:focus-visible { outline:3px solid var(--coral); outline-offset:4px; }
  .nav { display:grid; min-height:72px; grid-template-columns:1fr auto 1fr; align-items:center; gap:24px; padding:0 clamp(20px,4vw,60px); border-bottom:1px solid var(--line); background:rgba(244,246,250,.9); backdrop-filter:blur(18px); }
  .brand { display:flex; align-items:center; gap:13px; width:max-content; color:inherit; text-decoration:none; }
  .brand :global(.hii-wordmark), footer :global(.hii-wordmark) { font-size:34px; }
  .brand span, .nav nav a, .nav-cta, .kicker, .small-note, .window-bar, .workspace-window figcaption, .object-strip p, .object-strip div, .move-number, .card-top, .card-result, .join-card > span, .join-card a, .installer-note, footer { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; text-transform:uppercase; letter-spacing:.1em; }
  .brand span { font-size:8px; font-weight:700; }
  .nav nav { display:flex; gap:30px; }
  .nav nav a { color:inherit; font-size:9px; font-weight:700; text-decoration:none; }
  .nav-cta { justify-self:end; border-radius:999px; background:var(--ink); padding:12px 17px; color:white; font-size:9px; font-weight:700; text-decoration:none; }
  .hero { display:grid; min-height:760px; grid-template-columns:minmax(330px,.72fr) minmax(520px,1.28fr); gap:clamp(44px,6vw,96px); align-items:center; padding:clamp(72px,9vw,126px) clamp(24px,5vw,76px); background-image:radial-gradient(circle,rgba(17,18,22,.1) 1px,transparent 1px); background-size:28px 28px; }
  .kicker { display:flex; align-items:center; gap:10px; margin:0; font-size:9px; font-weight:700; }
  .kicker i { width:8px; height:8px; border-radius:50%; background:var(--blue); box-shadow:0 0 0 4px rgba(64,88,255,.12); }
  .hero h1 { margin:28px 0 0; font-size:clamp(62px,6.5vw,108px); font-weight:680; letter-spacing:-.075em; line-height:.86; }
  .hero h1 em, .moves h2 em { color:var(--blue); font-style:normal; }
  .deck { max-width:610px; margin:35px 0 0; font-size:clamp(19px,1.7vw,25px); font-weight:500; letter-spacing:-.025em; line-height:1.35; }
  .actions { display:flex; flex-wrap:wrap; gap:12px; margin-top:30px; }
  .primary, .secondary { display:inline-flex; min-height:48px; align-items:center; justify-content:center; gap:18px; border-radius:999px; padding:0 22px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9px; font-weight:700; letter-spacing:.06em; text-decoration:none; }
  .primary { background:var(--blue); color:white; box-shadow:0 12px 26px rgba(64,88,255,.18); }
  .secondary { background:white; color:var(--ink); box-shadow:0 10px 26px rgba(36,40,55,.08); }
  .small-note { max-width:420px; margin:17px 0 0; color:#777d8a; font-size:7px; line-height:1.6; }
  .workspace-window, .proof figure { position:relative; overflow:visible; margin:0; border:1px solid #cfd4df; border-radius:20px; background:white; box-shadow:0 38px 80px rgba(32,38,54,.18); }
  .window-bar { display:flex; height:42px; align-items:center; justify-content:space-between; padding:0 14px; color:#7d8390; font-size:7px; }
  .lights { display:flex; gap:5px; }
  .lights i { width:7px; height:7px; border-radius:50%; background:#dfe2e9; }
  .lights i:first-child { background:var(--coral); }
  .lights i:nth-child(2) { background:var(--lime); }
  .live { display:flex; align-items:center; gap:7px; }
  .live i { width:6px; height:6px; border-radius:50%; background:var(--blue); }
  .workspace-window > img, .proof img { display:block; width:100%; height:auto; }
  .workspace-window figcaption { display:grid; grid-template-columns:repeat(3,1fr); padding:12px 14px; color:#737986; font-size:7px; }
  .workspace-window figcaption span:nth-child(2) { text-align:center; }
  .workspace-window figcaption span:last-child { text-align:right; }
  .cursor-stamp { position:absolute; right:-22px; bottom:56px; display:flex; align-items:center; gap:7px; border-radius:999px; background:var(--blue); padding:8px 11px 8px 8px; color:white; box-shadow:0 12px 24px rgba(64,88,255,.28); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:8px; font-weight:700; }
  .cursor-stamp svg { width:15px; fill:white; }
  .object-strip { display:grid; gap:24px; padding:28px clamp(24px,5vw,76px); border-top:1px solid var(--line); border-bottom:1px solid var(--line); background:white; }
  .object-strip p { margin:0; color:var(--blue); font-size:8px; font-weight:700; }
  .object-strip div { display:flex; flex-wrap:wrap; gap:12px 16px; align-items:center; font-size:clamp(12px,1.2vw,17px); font-weight:700; }
  .object-strip i { color:var(--coral); font-style:normal; }
  .moves { display:grid; grid-template-columns:minmax(300px,.78fr) minmax(0,1.22fr); gap:90px; padding:130px clamp(24px,6vw,92px); background:var(--lime); }
  .moves header h2, .examples h2, .proof h2, .join h2 { margin:23px 0 0; font-size:clamp(54px,6.5vw,100px); font-weight:680; letter-spacing:-.075em; line-height:.87; }
  .moves header > p:last-child, .example-intro > p:last-child { max-width:550px; margin:30px 0 0; font-size:18px; line-height:1.5; }
  .move-list { display:grid; gap:10px; }
  .move-list article { position:relative; min-height:215px; border-radius:18px; background:rgba(255,255,255,.8); padding:28px 28px 28px 104px; }
  .move-number { position:absolute; top:30px; left:27px; color:var(--blue); font-size:9px; }
  .move-list article > b { display:grid; width:42px; height:42px; place-items:center; border-radius:12px; background:var(--ink); color:white; font-size:18px; }
  .move-list h3 { margin:24px 0 10px; font-size:clamp(28px,3vw,44px); letter-spacing:-.05em; line-height:1; }
  .move-list p { max-width:580px; margin:0; color:#53584f; font-size:15px; line-height:1.5; }
  .examples { display:grid; grid-template-columns:minmax(320px,.78fr) minmax(0,1.22fr); gap:80px; padding:135px clamp(24px,6vw,92px); background:var(--canvas); }
  .example-board { position:relative; min-height:760px; }
  .example-board article { position:absolute; display:flex; width:min(78%,560px); min-height:330px; flex-direction:column; border:1px solid var(--line); border-radius:18px; background:white; padding:28px; box-shadow:0 28px 60px rgba(32,38,54,.12); }
  .example-board article:first-child { top:0; left:0; z-index:1; }
  .example-board article:nth-child(2) { top:175px; right:0; z-index:2; border-color:var(--blue); }
  .example-board article:last-child { bottom:0; left:7%; z-index:3; min-height:410px; background:var(--blue); color:white; }
  .tilt-left { transform:rotate(-2deg); }
  .tilt-right { transform:rotate(2deg); }
  .card-top { display:flex; align-items:center; justify-content:space-between; color:#858b97; font-size:8px; }
  .card-top i { display:grid; width:34px; height:34px; place-items:center; border-radius:10px; background:var(--lime); color:var(--ink); font-size:15px; font-style:normal; }
  .example-board h3 { max-width:390px; margin:42px 0 14px; font-size:clamp(34px,4vw,57px); letter-spacing:-.06em; line-height:.95; }
  .example-board p { max-width:430px; margin:0; color:#646a76; font-size:15px; line-height:1.5; }
  .example-board article:last-child p, .example-board article:last-child .card-top { color:#d9deff; }
  .example-board article img { display:block; width:100%; height:auto; margin:22px 0 18px; border:1px solid rgba(255,255,255,.22); border-radius:8px; background:white; }
  .card-result { margin-top:auto; border-top:1px solid currentColor; padding-top:15px; font-size:7px; opacity:.72; }
  .proof { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(340px,.85fr); gap:80px; align-items:center; padding:125px clamp(24px,6vw,92px); background:var(--ink); color:white; }
  .proof figure { overflow:hidden; border-color:#353740; border-radius:16px; background:#202127; box-shadow:none; }
  .kicker-light i { background:var(--lime); box-shadow:0 0 0 4px rgba(223,255,69,.12); }
  .proof h2 { font-size:clamp(51px,5.6vw,88px); }
  .proof-copy > p:not(.kicker) { max-width:580px; margin:29px 0 0; color:#aeb3bf; font-size:18px; line-height:1.5; }
  .proof ul { display:grid; gap:0; margin:37px 0 29px; padding:0; list-style:none; }
  .proof li { display:grid; grid-template-columns:45px 1fr; border-top:1px solid #343740; padding:17px 0; }
  .proof li span { color:var(--lime); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:8px; }
  .proof li strong { font-size:15px; }
  .proof-copy > a { color:white; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9px; font-weight:700; text-underline-offset:5px; }
  .join { display:grid; grid-template-columns:minmax(260px,.72fr) repeat(2,minmax(240px,.64fr)); gap:16px; align-items:stretch; padding:120px clamp(24px,6vw,92px); background:var(--coral); }
  .join > div:first-child { padding:12px 45px 0 0; }
  .join h2 { font-size:clamp(51px,5.5vw,86px); }
  .join-card { display:flex; min-height:380px; flex-direction:column; border-radius:18px; background:white; padding:28px; }
  .join-card > span { font-size:8px; font-weight:700; }
  .join-card > strong { margin-top:35px; font-size:58px; letter-spacing:-.07em; }
  .join-card p { margin:20px 0 0; color:#636976; font-size:15px; line-height:1.5; }
  .join-card a { display:flex; min-height:46px; align-items:center; justify-content:space-between; margin-top:auto; border-radius:999px; background:var(--ink); padding:0 17px; color:white; font-size:8px; font-weight:700; text-decoration:none; }
  .join-card.founder { background:var(--blue); color:white; }
  .founder p { color:#dce0ff; }
  .founder a { background:white; color:var(--blue); }
  .installer-note { grid-column:2/-1; max-width:650px; margin:8px 0 0; font-size:7px; line-height:1.6; }
  footer { display:grid; min-height:108px; grid-template-columns:1fr auto 1fr; align-items:center; gap:20px; padding:24px clamp(20px,4vw,60px); background:var(--ink); color:white; font-size:8px; }
  footer p { color:#8e929c; }
  footer div { display:flex; justify-self:end; gap:18px; }
  footer a { color:white; text-decoration:none; }
  @media (max-width:1000px) {
    .nav { grid-template-columns:1fr auto; }
    .nav nav { display:none; }
    .hero, .moves, .examples, .proof { grid-template-columns:1fr; }
    .hero { gap:65px; }
    .moves, .examples, .proof { gap:70px; }
    .example-board { width:min(100%,760px); }
    .join { grid-template-columns:1fr 1fr; }
    .join > div:first-child { grid-column:1/-1; }
    .installer-note { grid-column:1/-1; }
  }
  @media (max-width:600px) {
    .nav { min-height:64px; padding:0 16px; }
    .brand span { display:none; }
    .hero { min-height:auto; padding:75px 16px 80px; }
    .hero h1 { font-size:clamp(54px,16vw,74px); }
    .deck { font-size:18px; }
    .workspace-window { border-radius:12px; }
    .cursor-stamp { right:8px; bottom:44px; }
    .object-strip { padding:24px 16px; }
    .moves, .examples, .proof, .join { padding:90px 16px; }
    .moves header h2, .examples h2, .proof h2, .join h2 { font-size:clamp(48px,14vw,68px); }
    .move-list article { min-height:225px; padding:25px 22px 25px 72px; }
    .move-number { left:22px; }
    .example-board { min-height:auto; display:grid; gap:12px; }
    .example-board article { position:relative !important; inset:auto !important; width:100%; min-height:300px; transform:none; }
    .proof { grid-template-columns:1fr; }
    .proof figure { order:2; }
    .join { grid-template-columns:1fr; }
    .join > div:first-child, .installer-note { grid-column:auto; }
    .join-card { min-height:350px; }
    footer { grid-template-columns:1fr auto; }
    footer p { display:none; }
    footer div { gap:12px; }
    footer a:first-child { display:none; }
  }
  @media (prefers-reduced-motion:reduce) { :global(html) { scroll-behavior:auto; } }
</style>
