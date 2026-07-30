<script lang="ts">
  import HiiLogo from '$lib/components/HiiLogo.svelte';

  const sections = [
    {
      number: '01',
      title: 'The browser demo',
      body: 'The guided learner and activation demos use sample data. They do not run an agent, inspect your Mac, read your files, or request screen or microphone access.'
    },
    {
      number: '02',
      title: 'The local Mac workspace',
      body: 'HII stores workspace state, notes, provenance, and receipts locally on your Mac. It reads only folders or files you deliberately bring into a workspace. The current public beta does not continuously record your screen or microphone.'
    },
    {
      number: '03',
      title: 'External AI providers',
      body: 'If you choose a hosted agent such as Codex or Claude, the context included in that run may be sent to that provider. HII keeps the selected boundary visible before work begins. Choosing a local Ollama model keeps model inference on your Mac.'
    },
    {
      number: '04',
      title: 'Founder-pilot applications',
      body: 'The pilot form sends the details you enter—such as your name, email, project summary, agent preference, Mac type, desired task, and timeline—to HII’s Supabase project so the founder can evaluate and respond to your application.'
    }
  ];
</script>

<svelte:head>
  <title>Privacy — HII</title>
  <meta
    name="description"
    content="What HII keeps local, what may leave your Mac, and what the public launch site stores."
  />
  <link rel="canonical" href="https://humaninformationinterface.com/privacy" />
</svelte:head>

<main class="privacy-page">
  <nav aria-label="Privacy page navigation">
    <a href="/" aria-label="HII home"><HiiLogo /><span>Human Information Interface</span></a>
    <a class="back" href="/">Back to HII <span aria-hidden="true">↗</span></a>
  </nav>

  <header>
    <p class="eyebrow"><i></i> Privacy in plain language</p>
    <h1>Local first.<br /><em>Transmission visible.</em></h1>
    <p class="intro">HII is built so you can tell what information an agent may use, what stays on your Mac, and when something leaves it.</p>
    <p class="updated">Last updated · July 30, 2026</p>
  </header>

  <section class="privacy-grid" aria-label="How HII handles information">
    {#each sections as section}
      <article>
        <span>{section.number}</span>
        <h2>{section.title}</h2>
        <p>{section.body}</p>
      </article>
    {/each}
  </section>

  <section class="site-data" aria-labelledby="site-data-title">
    <div>
      <p class="eyebrow light"><i></i> This website</p>
      <h2 id="site-data-title">No ad profile.<br />No mystery capture.</h2>
    </div>
    <dl>
      <div>
        <dt>Hosting</dt>
        <dd>Cloudflare serves this site and processes ordinary request metadata needed to deliver and protect it.</dd>
      </div>
      <div>
        <dt>Analytics</dt>
        <dd>HII does not currently use third-party advertising trackers or behavioral analytics on this launch site.</dd>
      </div>
      <div>
        <dt>Pilot data</dt>
        <dd>Applications are used only for beta recruitment, activation, and support. HII does not sell applicant information.</dd>
      </div>
      <div>
        <dt>Your choice</dt>
        <dd>You can request access, correction, or deletion by emailing the address below.</dd>
      </div>
    </dl>
  </section>

  <section class="contact" aria-labelledby="contact-title">
    <p class="eyebrow"><i></i> Questions or deletion requests</p>
    <h2 id="contact-title">Ask the founder directly.</h2>
    <a href="mailto:hello@humaninformationinterface.com?subject=HII%20privacy%20request">
      hello@humaninformationinterface.com <span aria-hidden="true">↗</span>
    </a>
  </section>

  <footer>
    <HiiLogo />
    <span>Human intent → visible boundaries → proved result</span>
    <a href="/">Home</a>
  </footer>
</main>

<style>
  :global(body) { margin:0; background:#f8f8f5; }
  .privacy-page { --ink:#151515; --blue:#176bff; --acid:#baff34; min-height:100vh; color:var(--ink); font-family:"Helvetica Neue",Helvetica,Arial,sans-serif; }
  .privacy-page * { box-sizing:border-box; }
  nav { display:flex; min-height:78px; align-items:center; justify-content:space-between; border-bottom:1px solid #dfe3e8; padding:0 clamp(20px,5vw,72px); }
  nav > a:first-child { display:flex; align-items:center; gap:14px; color:var(--ink); text-decoration:none; }
  nav :global(.hii-wordmark) { font-size:34px; }
  nav span, .back, .eyebrow, .updated, article > span, footer { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; }
  .back { color:var(--ink); text-decoration:none; }
  header { padding:110px clamp(20px,7vw,108px) 120px; background-image:radial-gradient(circle at 1px 1px,rgba(21,21,21,.12) 1px,transparent 0); background-size:34px 34px; }
  .eyebrow { display:flex; align-items:center; gap:12px; margin:0; }
  .eyebrow i { width:9px; height:9px; border-radius:50%; background:var(--blue); box-shadow:0 0 0 4px rgba(23,107,255,.11); }
  h1 { max-width:1100px; margin:40px 0 0; font-size:clamp(66px,10vw,154px); font-weight:650; letter-spacing:-.078em; line-height:.82; }
  h1 em { color:var(--blue); font-style:normal; }
  .intro { max-width:760px; margin:56px 0 0; font-size:clamp(21px,2.5vw,32px); font-weight:520; letter-spacing:-.035em; line-height:1.25; }
  .updated { margin:28px 0 0; color:#747975; }
  .privacy-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1px; background:#dfe3e8; border-top:1px solid #dfe3e8; border-bottom:1px solid #dfe3e8; }
  article { min-height:390px; background:white; padding:clamp(28px,5vw,70px); }
  article > span { color:var(--blue); }
  article h2 { max-width:580px; margin:60px 0 22px; font-size:clamp(34px,4vw,58px); font-weight:620; letter-spacing:-.055em; line-height:.95; }
  article p { max-width:620px; margin:0; color:#5f6461; font-size:18px; line-height:1.6; }
  .site-data { display:grid; grid-template-columns:.9fr 1.1fr; gap:90px; padding:130px clamp(20px,7vw,108px); background:#151515; color:white; }
  .eyebrow.light i { background:var(--acid); box-shadow:0 0 0 4px rgba(186,255,52,.12); }
  .site-data h2, .contact h2 { margin:28px 0 0; font-size:clamp(54px,7vw,105px); font-weight:640; letter-spacing:-.07em; line-height:.88; }
  dl { margin:0; }
  dl > div { display:grid; grid-template-columns:130px 1fr; gap:24px; border-top:1px solid #3d403e; padding:26px 0; }
  dt { color:var(--acid); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; }
  dd { margin:0; color:#c4c9c6; font-size:17px; line-height:1.55; }
  .contact { padding:130px clamp(20px,7vw,108px); background:var(--acid); }
  .contact h2 { max-width:900px; }
  .contact > a { display:inline-flex; align-items:center; gap:24px; margin-top:54px; border-radius:999px; background:var(--ink); padding:18px 24px; color:white; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; font-weight:700; text-decoration:none; }
  footer { display:grid; min-height:110px; grid-template-columns:1fr auto 1fr; align-items:center; gap:20px; padding:24px clamp(20px,5vw,72px); background:#151515; color:white; }
  footer :global(.hii-wordmark) { font-size:34px; }
  footer > span { color:#8f9491; }
  footer a { justify-self:end; color:white; text-decoration:none; }
  @media (max-width:760px) {
    nav { min-height:64px; }
    nav > a:first-child span { display:none; }
    header { padding:84px 16px 88px; }
    h1 { font-size:clamp(55px,16vw,78px); }
    .intro { margin-top:38px; font-size:20px; }
    .privacy-grid, .site-data { grid-template-columns:1fr; }
    article { min-height:auto; padding:64px 16px; }
    article h2 { margin-top:36px; }
    .site-data, .contact { gap:65px; padding:92px 16px; }
    dl > div { grid-template-columns:1fr; gap:10px; }
    footer { grid-template-columns:1fr auto; }
    footer > span { display:none; }
  }
</style>
