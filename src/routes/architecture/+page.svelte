<script lang="ts">
  import { onMount } from 'svelte';
  import HiiLogo from '$lib/components/HiiLogo.svelte';

  let proofVideo: HTMLVideoElement;

  onMount(() => {
    proofVideo?.play().catch(() => {
      // Native controls and the poster remain available when autoplay is blocked.
    });
  });

  const jobs = [
    {
      sheet: 'A-01',
      title: 'Trace a site decision',
      brief: 'Bring the brief, reports, notes, maps, and constraints.',
      result: 'A source-linked decision memo with unknowns called out.'
    },
    {
      sheet: 'A-02',
      title: 'Prepare a design review',
      brief: 'Bring the current package, comments, and design intent.',
      result: 'A ranked review set with changes, rationale, and open decisions.'
    },
    {
      sheet: 'A-03',
      title: 'Debug a computational workflow',
      brief: 'Bring the Rhino, Grasshopper, script, or model context you approve.',
      result: 'A working improvement, changed files, checks, and a receipt.'
    }
  ];
</script>

<svelte:head>
  <title>HII for Architecture — Context in. Defensible work out.</title>
  <meta
    name="description"
    content="A founder-led HII workflow for architects and computational designers: bring one real job, bound the context, and keep the result and proof together."
  />
  <link rel="canonical" href="https://humaninformationinterface.com/architecture" />
  <meta property="og:title" content="HII for Architecture — Context in. Defensible work out." />
  <meta
    property="og:description"
    content="Bring one source-heavy architecture or computational-design job. Keep its context, result, and proof together."
  />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://humaninformationinterface.com/architecture" />
  <meta
    property="og:image"
    content="https://humaninformationinterface.com/marketing/hii-workspace-live.png"
  />
</svelte:head>

<main class="arch-page">
  <nav aria-label="HII architecture navigation">
    <a class="brand" href="/landing" aria-label="HII home">
      <HiiLogo />
      <span>architecture / founder cohort</span>
    </a>
    <div class="nav-index" aria-hidden="true">
      <span>drawing set</span>
      <b>HII / 001</b>
    </div>
    <a class="nav-action" href="#first-job">Bring one job <span aria-hidden="true">↘</span></a>
  </nav>

  <section class="hero" aria-labelledby="hero-title">
    <div class="revision-stamp" aria-hidden="true">
      <span>REV</span>
      <strong>01</strong>
      <small>FOUNDER<br />ISSUE</small>
    </div>

    <div class="hero-copy">
      <p class="eyebrow"><i></i> HII for architecture + computational design</p>
      <h1 id="hero-title">Context in.<br /><em>Defensible</em><br />work out.</h1>
      <p class="deck">
        Your real work is spread across drawings, reports, models, scripts, notes, and decisions.
        Give HII one job, choose what it may use, and keep the result and its proof in the same
        workspace.
      </p>
      <div class="hero-actions">
        <a class="primary" href="#first-job">Choose a first job <span aria-hidden="true">↓</span></a>
        <a class="secondary" href="/privacy">Read the context boundary</a>
      </div>
      <p class="availability">Five founder-led discovery sessions · Mac workflows · no general beta tour</p>
    </div>

    <div class="section-drawing" aria-label="A section drawing showing context becoming a verified result">
      <div class="drawing-head">
        <span>SECTION / WORKFLOW</span>
        <span>SCALE: ONE REAL JOB</span>
      </div>
      <svg viewBox="0 0 760 620" role="img" aria-labelledby="section-title">
        <title id="section-title">Approved source context moves through bounded work to a finished artifact and receipt</title>
        <defs>
          <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M24 0H0V24" fill="none" stroke="currentColor" stroke-opacity=".13" />
          </pattern>
          <marker id="arrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto">
            <path d="M0 0L8 3L0 6Z" fill="currentColor" />
          </marker>
        </defs>
        <rect width="760" height="620" fill="url(#grid)" />
        <path class="ground" d="M55 500H705" />
        <path class="building" d="M115 500V380H240V285H390V205H575V500" />
        <path class="floor" d="M115 380H575M240 285H575M390 205H575" />
        <path class="trace" d="M85 450C180 450 160 335 285 335S370 250 455 250S500 150 655 150" marker-end="url(#arrow)" />
        <circle class="node" cx="85" cy="450" r="10" />
        <circle class="node" cx="285" cy="335" r="10" />
        <circle class="node" cx="455" cy="250" r="10" />
        <circle class="node" cx="655" cy="150" r="10" />
        <path class="dimension" d="M90 530V570M240 530V570M90 555H240" />
        <path class="tick" d="M84 562L96 548M234 562L246 548" />
        <text x="134" y="548">APPROVED SPAN</text>
      </svg>
      <span class="callout context">01 / selected context</span>
      <span class="callout boundary">02 / visible boundary</span>
      <span class="callout artifact">03 / finished artifact</span>
      <span class="callout receipt">04 / receipt</span>
      <p class="drawing-note">The line stays continuous.<br />The authority stays yours.</p>
    </div>
  </section>

  <section class="job-section" id="first-job" aria-labelledby="jobs-title">
    <header>
      <div>
        <p class="eyebrow"><i></i> Issue one job for review</p>
        <h2 id="jobs-title">Start where<br />the work is <em>stuck.</em></h2>
      </div>
      <p>
        HII is not asking your practice to adopt an operating system. The founder cohort starts with
        one job whose result you can inspect and whose value you can judge.
      </p>
    </header>

    <div class="job-sheets">
      {#each jobs as job}
        <article>
          <div class="sheet-label">
            <span>{job.sheet}</span>
            <small>FIRST-WIN OPTION</small>
          </div>
          <h3>{job.title}</h3>
          <dl>
            <div><dt>You bring</dt><dd>{job.brief}</dd></div>
            <div><dt>You keep</dt><dd>{job.result}</dd></div>
          </dl>
          <a
            href={`mailto:hello@humaninformationinterface.com?subject=${encodeURIComponent(`HII architecture cohort / ${job.title}`)}&body=${encodeURIComponent(`The job I want to test:\n\nThe project context I would consider approving:\n\nThe finished result I need:\n\nMy Mac setup:`)}`}
          >
            Bring this job <span aria-hidden="true">↗</span>
          </a>
        </article>
      {/each}
    </div>
  </section>

  <section class="boundary-section" aria-labelledby="boundary-title">
    <div class="boundary-copy">
      <p class="eyebrow light"><i></i> Authority before automation</p>
      <h2 id="boundary-title">A model is not<br />a project boundary.</h2>
      <p>
        HII separates what an agent can read, what it may change, and what may leave your Mac. Local
        and external models are explicit choices. Publishing remains a separate decision.
      </p>
      <a href="/privacy">Open the plain-language privacy boundary <span aria-hidden="true">↗</span></a>
    </div>
    <div class="boundary-schedule">
      <div class="schedule-head"><span>AUTHORITY SCHEDULE</span><b>ISSUE / 01</b></div>
      <div><span>CONTEXT</span><strong>Folders, notes, drawings, links, and files you deliberately choose</strong><i>selected</i></div>
      <div><span>ACTION</span><strong>One agreed task with a visible outcome</strong><i>bounded</i></div>
      <div><span>MODEL</span><strong>Codex, Claude Code, or local Ollama—named before work begins</strong><i>declared</i></div>
      <div><span>PROOF</span><strong>Artifacts, changes, checks, provenance, and the next action</strong><i>retained</i></div>
      <div><span>PUBLISH</span><strong>Never implied by permission to work</strong><i>separate</i></div>
    </div>
  </section>

  <section class="proof-section" aria-labelledby="proof-title">
    <header>
      <p class="eyebrow"><i></i> Actual HII interface</p>
      <h2 id="proof-title">Open the work.<br />Open the proof.</h2>
      <p>The demonstration uses sample data and cannot inspect your Mac. A real session starts only after the job and context boundary are agreed.</p>
    </header>
    <figure>
      <div class="video-label"><span>HII / FIRST WIN</span><span>27 SEC · SILENT FIRST</span></div>
      <video
        bind:this={proofVideo}
        autoplay
        muted
        loop
        playsinline
        controls
        preload="metadata"
        poster="/marketing/hii-command-palette-live.png"
        aria-label="A 27-second demonstration of an actual HII first-win workspace"
      >
        <source src="/marketing/hii-first-win-demo.mp4" type="video/mp4" />
      </video>
      <figcaption>Actual interface · sample context · captions embedded</figcaption>
    </figure>
  </section>

  <section class="cohort-section" aria-labelledby="cohort-title">
    <div class="cohort-number" aria-hidden="true">05</div>
    <div>
      <p class="eyebrow"><i></i> Founder cohort / five seats</p>
      <h2 id="cohort-title">Bring the job<br />you already need done.</h2>
      <p>
        The discovery session defines the job and boundary. If a hands-on activation is the right
        next step, it is $500 and stays centered on your actual work.
      </p>
      <div class="cohort-actions">
        <a class="primary" href="mailto:hello@humaninformationinterface.com?subject=HII%20architecture%20cohort&body=The%20architecture%20or%20computational-design%20job%20I%20want%20to%20test%3A%0A%0AThe%20result%20I%20need%3A%0A">Name your first job <span aria-hidden="true">↗</span></a>
        <a class="secondary" href="/pilot">Apply for founder activation · $500</a>
      </div>
    </div>
  </section>

  <footer>
    <a href="/landing" aria-label="HII home"><HiiLogo /></a>
    <span>Human intent → bounded work → visible proof</span>
    <div><a href="/privacy">Privacy</a><a href="mailto:hello@humaninformationinterface.com">Contact</a></div>
  </footer>
</main>

<style>
  :global(html){scroll-behavior:smooth}
  :global(body){margin:0;background:#f1f0e8}
  .arch-page{--ink:#111317;--paper:#f1f0e8;--blue:#0e4c92;--blue-deep:#082f5d;--red:#e43f2b;--line:#a9adb3;--white:#fbfcfe;min-height:100vh;overflow:hidden;background:var(--paper);color:var(--ink);font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}
  .arch-page *{box-sizing:border-box}
  a:focus-visible,video:focus-visible{outline:3px solid var(--red);outline-offset:4px}
  nav{display:grid;min-height:78px;grid-template-columns:1fr auto 1fr;align-items:center;border-bottom:1px solid rgba(17,19,23,.28);padding:0 clamp(18px,4vw,64px);font:700 8px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.11em;text-transform:uppercase}
  .brand{display:flex;align-items:center;gap:14px;width:max-content;color:inherit;text-decoration:none}.brand :global(.hii-wordmark){color:var(--blue);font-size:34px}.brand span{font-size:8px}
  .nav-index{display:grid;grid-template-columns:auto auto;gap:20px;align-items:center}.nav-index span{color:#73777e}.nav-action{justify-self:end;border:1px solid var(--ink);padding:11px 15px;color:inherit;text-decoration:none}
  .hero{position:relative;display:grid;min-height:890px;grid-template-columns:minmax(0,.9fr) minmax(460px,.8fr);align-items:center;gap:clamp(55px,7vw,120px);padding:105px clamp(24px,7vw,108px) 125px}
  .hero:before{position:absolute;inset:0;background-image:linear-gradient(rgba(14,76,146,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(14,76,146,.08) 1px,transparent 1px);background-size:48px 48px;content:"";mask-image:linear-gradient(to bottom,#000 65%,transparent)}
  .hero-copy,.section-drawing{position:relative;z-index:1}.eyebrow{display:flex;align-items:center;gap:10px;margin:0;font:700 8px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase}.eyebrow i{width:18px;height:2px;background:var(--red)}
  h1{margin:31px 0 0;font-size:clamp(74px,8.7vw,138px);font-weight:690;letter-spacing:-.088em;line-height:.79}h1 em{color:var(--blue);font-style:normal}
  .deck{max-width:690px;margin:43px 0 0;color:#454951;font-size:clamp(18px,1.9vw,26px);font-weight:480;letter-spacing:-.027em;line-height:1.42}
  .hero-actions,.cohort-actions{display:flex;flex-wrap:wrap;gap:11px;margin-top:32px}.primary,.secondary{display:inline-flex;min-height:49px;align-items:center;justify-content:center;gap:20px;border:1px solid var(--ink);padding:0 19px;font:700 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-decoration:none;text-transform:uppercase}.primary{border-color:var(--blue);background:var(--blue);color:#fff}.secondary{color:var(--ink)}
  .availability{margin:20px 0 0;color:#73777e;font:700 8px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase}
  .revision-stamp{position:absolute;top:29px;right:clamp(24px,5vw,76px);z-index:2;display:grid;width:92px;grid-template-columns:.45fr .55fr;border:2px solid var(--red);color:var(--red);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;transform:rotate(2deg)}.revision-stamp span,.revision-stamp strong{display:grid;min-height:44px;place-items:center}.revision-stamp span{border-right:1px solid var(--red);font-size:9px}.revision-stamp strong{font-size:24px}.revision-stamp small{grid-column:1/-1;border-top:1px solid var(--red);padding:6px 8px;font-size:7px;line-height:1.35}
  .section-drawing{min-height:660px;border:1px solid rgba(14,76,146,.45);background:rgba(251,252,254,.76);box-shadow:14px 14px 0 rgba(14,76,146,.09)}.drawing-head,.video-label{display:flex;min-height:38px;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(14,76,146,.34);padding:0 14px;color:var(--blue);font:700 7px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em}.section-drawing svg{width:100%;height:620px;color:var(--blue)}.ground,.building,.floor{fill:none;stroke:var(--ink);stroke-width:3}.floor{stroke-width:1.5}.trace{fill:none;stroke:var(--red);stroke-width:5;stroke-linecap:round}.node{fill:var(--paper);stroke:var(--red);stroke-width:4}.dimension,.tick{fill:none;stroke:var(--blue);stroke-width:1.5}.section-drawing text{fill:var(--blue);font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em}.callout{position:absolute;border-left:3px solid var(--red);background:var(--white);padding:8px 10px;box-shadow:0 8px 18px rgba(17,19,23,.08);font:700 7px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}.context{left:2%;bottom:24%}.boundary{left:25%;bottom:43%}.artifact{right:25%;top:33%}.receipt{right:3%;top:18%}.drawing-note{position:absolute;right:7%;bottom:7%;margin:0;color:var(--blue);font-size:16px;font-weight:650;letter-spacing:-.025em;line-height:1.25}
  .job-section{padding:130px clamp(24px,7vw,108px);background:var(--white)}.job-section>header,.proof-section>header{display:grid;grid-template-columns:1fr minmax(280px,.42fr);gap:80px;align-items:end}.job-section h2,.boundary-section h2,.proof-section h2,.cohort-section h2{margin:25px 0 0;font-size:clamp(58px,7.2vw,108px);font-weight:670;letter-spacing:-.078em;line-height:.85}.job-section h2 em{color:var(--red);font-style:normal}.job-section>header>p,.proof-section>header>p{margin:0;color:#5c6067;font-size:17px;line-height:1.55}
  .job-sheets{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;margin-top:74px;border:1px solid var(--ink);background:var(--ink)}.job-sheets article{display:flex;min-height:470px;flex-direction:column;background:var(--white);padding:24px}.sheet-label{display:flex;align-items:start;justify-content:space-between;border-bottom:1px solid var(--ink);padding-bottom:15px}.sheet-label span{color:var(--blue);font:700 27px ui-monospace,SFMono-Regular,Menlo,monospace}.sheet-label small{font:700 7px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.09em}.job-sheets h3{max-width:360px;margin:54px 0 0;font-size:clamp(27px,2.6vw,41px);font-weight:650;letter-spacing:-.05em;line-height:.98}.job-sheets dl{display:grid;gap:19px;margin:44px 0 0}.job-sheets dl div{display:grid;grid-template-columns:72px 1fr;gap:15px}.job-sheets dt{color:var(--red);font:700 7px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}.job-sheets dd{margin:0;color:#5b6067;font-size:13px;line-height:1.48}.job-sheets a{margin-top:auto;border-top:1px solid var(--ink);padding-top:19px;color:var(--blue);font:700 9px ui-monospace,SFMono-Regular,Menlo,monospace;text-decoration:none;text-transform:uppercase}
  .boundary-section{display:grid;grid-template-columns:minmax(0,.75fr) minmax(430px,.85fr);gap:clamp(65px,9vw,150px);padding:130px clamp(24px,7vw,108px);background:var(--blue-deep);color:#fff}.eyebrow.light i{background:#ff705b}.boundary-copy>p:nth-of-type(2){max-width:650px;margin:40px 0 0;color:#b8c9dc;font-size:18px;line-height:1.55}.boundary-copy>a{display:inline-block;margin-top:28px;color:#fff;font:700 9px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}.boundary-schedule{align-self:start;border:1px solid rgba(255,255,255,.55)}.schedule-head,.boundary-schedule>div:not(.schedule-head){display:grid;grid-template-columns:90px 1fr auto;gap:20px;align-items:center;border-bottom:1px solid rgba(255,255,255,.28);padding:18px}.schedule-head{grid-template-columns:1fr auto;background:#fff;color:var(--blue-deep);font:700 8px ui-monospace,SFMono-Regular,Menlo,monospace}.boundary-schedule>div:last-child{border:0}.boundary-schedule span,.boundary-schedule i{font:700 7px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}.boundary-schedule strong{font-size:13px;line-height:1.45}.boundary-schedule i{color:#ff846f;font-style:normal}
  .proof-section{padding:130px clamp(24px,7vw,108px);background:var(--paper)}.proof-section figure{max-width:1320px;margin:72px auto 0;border:1px solid var(--ink);background:var(--white);box-shadow:18px 18px 0 rgba(14,76,146,.14)}.proof-section video{display:block;width:100%;height:auto}.proof-section figcaption{border-top:1px solid rgba(17,19,23,.28);padding:12px 14px;color:#6f737a;font:700 7px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}
  .cohort-section{position:relative;display:grid;grid-template-columns:minmax(260px,.45fr) 1fr;gap:50px;align-items:center;padding:130px clamp(24px,7vw,108px);background:var(--red);color:#fff}.cohort-number{font-size:clamp(190px,25vw,420px);font-weight:750;letter-spacing:-.12em;line-height:.65;opacity:.17}.cohort-section>div:last-child{position:relative}.cohort-section>div>p:nth-of-type(2){max-width:650px;margin:35px 0 0;font-size:18px;line-height:1.5}.cohort-section .primary{border-color:#fff;background:#fff;color:var(--red)}.cohort-section .secondary{border-color:#fff;color:#fff}
  footer{display:grid;min-height:112px;grid-template-columns:1fr auto 1fr;align-items:center;padding:25px clamp(24px,4vw,64px);background:var(--white);font:700 8px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.09em;text-transform:uppercase}footer :global(.hii-wordmark){color:var(--blue);font-size:34px}footer>a{width:max-content;color:inherit;text-decoration:none}footer>span{color:#757a81}footer div{display:flex;justify-self:end;gap:22px}footer div a{color:inherit}
  @media(max-width:980px){nav{grid-template-columns:1fr auto}.nav-index{display:none}.hero{grid-template-columns:1fr}.section-drawing{min-height:610px}.job-section>header,.proof-section>header,.boundary-section{grid-template-columns:1fr}.job-sheets{grid-template-columns:1fr}.job-sheets article{min-height:390px}.cohort-section{grid-template-columns:.45fr 1fr}}
  @media(max-width:640px){nav{min-height:66px}.brand span{display:none}.hero{min-height:auto;padding:80px 16px 90px}h1{font-size:clamp(69px,21vw,96px)}.revision-stamp{top:18px;right:16px;transform:scale(.82) rotate(2deg);transform-origin:top right}.section-drawing{min-height:440px}.section-drawing svg{height:410px}.callout{font-size:6px}.boundary{left:21%}.drawing-note{font-size:12px}.job-section,.boundary-section,.proof-section{padding:90px 16px}.job-section>header,.proof-section>header{gap:30px}.job-sheets{margin-top:50px}.boundary-schedule>div:not(.schedule-head){grid-template-columns:66px 1fr}.boundary-schedule i{display:none}.cohort-section{grid-template-columns:1fr;padding:90px 16px}.cohort-number{position:absolute;right:16px;top:45px;font-size:170px}.cohort-section>div:last-child{z-index:1}.cohort-actions{align-items:stretch;flex-direction:column}.primary,.secondary{width:100%}footer{grid-template-columns:1fr auto}footer>span{display:none}}
  @media(prefers-reduced-motion:reduce){:global(html){scroll-behavior:auto}}
</style>
