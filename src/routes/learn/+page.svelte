<script lang="ts">
  import HiiLogo from '$lib/components/HiiLogo.svelte';

  type Path = {
    id: string;
    label: string;
    example: string;
    firstMove: string;
    proof: string;
  };

  const paths: Path[] = [
    {
      id: 'understand',
      label: 'Understand something',
      example: 'Help me understand this project and show me what to learn next.',
      firstMove: 'Read only the sources you approve, then explain the project in plain language.',
      proof: 'A source-linked map and one next action you can explain back.'
    },
    {
      id: 'make',
      label: 'Make something',
      example: 'Turn my rough idea into one portfolio-ready artifact.',
      firstMove: 'Propose the smallest finished version before changing anything.',
      proof: 'A real artifact, the files changed, and the checks that passed.'
    },
    {
      id: 'improve',
      label: 'Improve my work',
      example: 'Find one high-value improvement I can finish today.',
      firstMove: 'Inspect the current work, rank safe improvements, and ask before acting.',
      proof: 'A before-and-after result with an inspectable receipt.'
    }
  ];

  let selected = paths[1];
  let intent = selected.example;
  let shaped = false;

  function choose(path: Path) {
    selected = path;
    intent = path.example;
    shaped = false;
  }

  function shapeIntent() {
    if (!intent.trim()) return;
    shaped = true;
  }
</script>

<svelte:head>
  <title>HII Learner — One idea. One proved result.</title>
  <meta name="description" content="A guided introduction to agentic work: shape an idea, approve the boundaries, and keep the proof." />
  <meta property="og:title" content="HII Learner — One idea. One proved result." />
  <meta property="og:description" content="Agentic AI made legible: intent, approval, bounded work, and proof." />
</svelte:head>

<main class="learner">
  <nav aria-label="HII Learner navigation">
    <a class="brand" href="/landing" aria-label="HII home"><HiiLogo /><span>learner / one win</span></a>
    <p>guided demo · no agent runs on this page</p>
    <a class="nav-action" href="#try">Try it <span aria-hidden="true">↓</span></a>
  </nav>

  <section class="hero">
    <div class="hero-copy">
      <p class="eyebrow"><i></i> The people’s AI tool / first lesson</p>
      <h1>The pen made<br />thought <em>visible.</em><br />HII makes it <strong>actionable.</strong></h1>
      <p class="deck">You should not need to become an AI engineer to direct an agent. Start with something you care about. HII makes the plan, permission, work, and proof understandable.</p>
      <a class="primary" href="#try">Turn one idea into a path <span aria-hidden="true">↘</span></a>
    </div>

    <div class="pen-path" aria-label="HII turns intent into verified action">
      <svg viewBox="0 0 760 390" role="img" aria-labelledby="path-title">
        <title id="path-title">A continuous blue line connecting intent, approval, work, and proof</title>
        <path d="M45 70 C180 65 135 195 280 190 S420 85 500 140 S540 315 705 300" />
        <circle cx="45" cy="70" r="10" /><circle cx="280" cy="190" r="10" /><circle cx="500" cy="140" r="10" /><circle cx="705" cy="300" r="10" />
      </svg>
      <span class="path-label label-intent">your intent</span>
      <span class="path-label label-approve">you approve</span>
      <span class="path-label label-work">bounded work</span>
      <span class="path-label label-proof">proof you keep</span>
      <p>One continuous line.<br />You hold the pen.</p>
    </div>
  </section>

  <section class="workbench" id="try" aria-labelledby="workbench-title">
    <header>
      <p class="eyebrow"><i></i> Shape your first win</p>
      <h2 id="workbench-title">What do you want to<br />understand, make, or improve?</h2>
    </header>

    <div class="path-choices" aria-label="Choose a learning path">
      {#each paths as path}
        <button class:active={selected.id === path.id} on:click={() => choose(path)}>
          <span>{path.label}</span><i aria-hidden="true">↗</i>
        </button>
      {/each}
    </div>

    <div class="intent-editor">
      <label for="intent">Say it in your own words</label>
      <textarea id="intent" bind:value={intent} rows="3" placeholder="I want to…" on:input={() => shaped = false}></textarea>
      <div class="editor-foot">
        <p>Plain language is enough. HII shapes the work around the outcome.</p>
        <button class="primary" disabled={!intent.trim()} on:click={shapeIntent}>Shape my path <span aria-hidden="true">→</span></button>
      </div>
    </div>

    {#if shaped}
      <section class="learning-contract" aria-live="polite">
        <div class="contract-head">
          <div><span>HII / proposed learning contract</span><strong>Nothing runs until you approve it.</strong></div>
          <span class="ready"><i></i> ready to review</span>
        </div>
        <div class="contract-grid">
          <article><span>You bring</span><h3>{intent}</h3><p>Your goal stays the center of the work.</p></article>
          <article><span>HII proposes</span><h3>{selected.firstMove}</h3><p>You can change the plan or its boundaries first.</p></article>
          <article><span>You keep</span><h3>{selected.proof}</h3><p>A receipt shows what happened—not just what the AI said.</p></article>
        </div>
        <div class="contract-action">
          <p><b>Next lesson:</b> approve sample context, choose one bounded task, and open the finished receipt.</p>
          <a class="primary dark" href="/activate?mock=1">Open the safe demo <span aria-hidden="true">↗</span></a>
        </div>
      </section>
    {/if}
  </section>

  <section class="difference" aria-labelledby="difference-title">
    <div>
      <p class="eyebrow light"><i></i> AI you can see, steer, and keep</p>
      <h2 id="difference-title">Not magic.<br /><em>Agency.</em></h2>
    </div>
    <dl>
      <div><dt>What can it see?</dt><dd>Only the context you deliberately approve.</dd></div>
      <div><dt>What may it do?</dt><dd>One bounded task with a visible outcome.</dd></div>
      <div><dt>How do I trust it?</dt><dd>Open the files, checks, artifacts, and receipt.</dd></div>
      <div><dt>Can I do it again?</dt><dd>A proved workflow can become a reviewed skill.</dd></div>
    </dl>
  </section>

  <section class="founder-note">
    <p class="eyebrow"><i></i> A note from the founder</p>
    <blockquote>“The next version of the pen is not a chatbot. It is an interface between human intention and verified action.”</blockquote>
    <div>
      <p>HII is being built for learners, makers, career switchers, and curious people who deserve more than a mysterious answer box. The ambition is simple: make agentic tools feel as natural to direct as a pen—and as personal to keep.</p>
      <a href="/pilot">Bring one real task to the founder pilot <span aria-hidden="true">↗</span></a>
    </div>
  </section>

  <footer><HiiLogo /><span>Human intent → visible boundaries → proved result</span><a href="/landing">Human Information Interface</a></footer>
</main>

<style>
  :global(html){scroll-behavior:smooth}
  :global(body){margin:0;background:#f7f8fa}
  .learner{--ink:#101114;--paper:#f7f8fa;--blue:#165dff;--sky:#dbe8ff;--lime:#c9ff42;--quiet:#686d76;min-height:100vh;overflow:hidden;background:var(--paper);color:var(--ink);font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}
  .learner *{box-sizing:border-box}
  a:focus-visible,button:focus-visible,textarea:focus-visible{outline:3px solid var(--lime);outline-offset:3px}
  nav{display:grid;min-height:74px;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 clamp(18px,4vw,64px);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
  .brand{display:flex;align-items:center;gap:13px;width:max-content;color:inherit;text-decoration:none}.brand :global(.hii-wordmark){font-size:34px}.brand span{font-size:8px}nav p{color:#858a92}.nav-action{justify-self:end;border-radius:999px;background:var(--ink);padding:11px 16px;color:#fff;text-decoration:none}
  .hero{position:relative;display:grid;min-height:850px;grid-template-columns:minmax(0,1.05fr) minmax(420px,.95fr);align-items:center;gap:40px;padding:90px clamp(24px,7vw,108px) 120px}
  .hero:before{position:absolute;inset:0;z-index:0;background:radial-gradient(circle,rgba(16,17,20,.1) 1px,transparent 1px);background-size:32px 32px;content:"";mask-image:linear-gradient(to bottom,#000 50%,transparent)}
  .hero-copy,.pen-path{position:relative;z-index:1}.eyebrow{display:flex;align-items:center;gap:10px;margin:0;font:700 9px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase}.eyebrow i{width:8px;height:8px;border-radius:50%;background:var(--blue);box-shadow:0 0 0 4px rgba(22,93,255,.12)}
  h1{max-width:880px;margin:30px 0 0;font-size:clamp(70px,8vw,132px);font-weight:720;letter-spacing:-.085em;line-height:.79}h1 em{color:var(--blue);font-style:normal}h1 strong{font-weight:720}
  .deck{max-width:670px;margin:42px 0 0;color:#4f545d;font-size:clamp(19px,2vw,27px);font-weight:500;letter-spacing:-.03em;line-height:1.35}
  .primary{display:inline-flex;min-height:50px;align-items:center;justify-content:center;gap:24px;border:0;border-radius:999px;background:var(--blue);padding:0 22px;color:#fff;font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;text-decoration:none}.hero-copy>.primary{margin-top:32px}.primary:disabled{opacity:.4}
  .pen-path{min-height:510px;border-radius:50%;background:rgba(255,255,255,.75);box-shadow:0 36px 90px rgba(36,49,72,.12);transform:rotate(2deg)}.pen-path svg{position:absolute;inset:10% 3%;width:94%;height:78%;overflow:visible}.pen-path path{fill:none;stroke:var(--blue);stroke-width:6;stroke-linecap:round}.pen-path circle{fill:var(--lime);stroke:var(--ink);stroke-width:3}.path-label{position:absolute;border-radius:999px;background:#fff;padding:10px 13px;box-shadow:0 9px 25px rgba(23,31,44,.11);font:700 9px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}.label-intent{left:2%;top:10%}.label-approve{left:29%;top:48%}.label-work{right:22%;top:25%}.label-proof{right:1%;bottom:15%}.pen-path p{position:absolute;right:10%;top:8%;margin:0;color:var(--blue);font-size:18px;font-weight:650;letter-spacing:-.03em;line-height:1.15}
  .workbench{padding:130px clamp(24px,7vw,108px);background:#fff}.workbench>header{display:grid;grid-template-columns:.55fr 1fr;gap:60px;align-items:start}.workbench h2,.difference h2{margin:0;font-size:clamp(55px,7vw,108px);font-weight:690;letter-spacing:-.075em;line-height:.88}
  .path-choices{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:80px}.path-choices button{display:flex;min-height:90px;align-items:flex-end;justify-content:space-between;border:0;border-radius:18px;background:#f0f2f5;padding:18px;text-align:left}.path-choices button.active{background:var(--sky);box-shadow:inset 0 0 0 2px var(--blue)}.path-choices span{font-size:17px;font-weight:650;letter-spacing:-.025em}.path-choices i{font-style:normal}
  .intent-editor{margin-top:14px;border-radius:24px;background:var(--ink);padding:clamp(24px,4vw,50px);color:#fff}.intent-editor label{font:700 9px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase}.intent-editor textarea{display:block;width:100%;margin-top:25px;border:0;background:transparent;color:#fff;font:600 clamp(28px,4vw,54px)/1.08 "Helvetica Neue",Helvetica,Arial,sans-serif;letter-spacing:-.05em;resize:vertical}.intent-editor textarea::placeholder{color:#6f747c}.intent-editor textarea:focus{outline-color:var(--lime)}.editor-foot{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:30px}.editor-foot p{max-width:430px;margin:0;color:#9ea3ab;font-size:13px;line-height:1.5}
  .learning-contract{margin-top:18px;border-radius:24px;background:var(--lime);padding:clamp(24px,4vw,48px)}.contract-head,.contract-action{display:flex;align-items:center;justify-content:space-between;gap:30px}.contract-head>div{display:grid;gap:8px}.contract-head span{font:700 9px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase}.contract-head strong{font-size:20px}.ready{display:flex;align-items:center;gap:9px}.ready i{width:8px;height:8px;border-radius:50%;background:var(--blue)}.contract-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:42px}.contract-grid article{min-height:240px;border-radius:16px;background:rgba(255,255,255,.72);padding:22px}.contract-grid span{font:700 9px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}.contract-grid h3{margin:32px 0 0;font-size:22px;letter-spacing:-.035em;line-height:1.15}.contract-grid p{margin:20px 0 0;color:#565b55;font-size:13px;line-height:1.45}.contract-action{margin-top:34px}.contract-action p{max-width:600px;margin:0;font-size:14px;line-height:1.5}.primary.dark{background:var(--ink)}
  .difference{display:grid;grid-template-columns:1fr 1fr;gap:80px;padding:130px clamp(24px,7vw,108px);background:var(--ink);color:#fff}.difference h2{margin-top:28px}.difference h2 em{color:var(--lime);font-style:normal}.eyebrow.light i{background:var(--lime)}dl{margin:0}dl>div{display:grid;grid-template-columns:.8fr 1fr;gap:30px;padding:28px 0;border-bottom:1px solid rgba(255,255,255,.15)}dt{font-size:17px;font-weight:650}dd{margin:0;color:#aeb3bc;font-size:15px;line-height:1.45}
  .founder-note{display:grid;grid-template-columns:.4fr 1.1fr .75fr;gap:60px;padding:130px clamp(24px,7vw,108px);background:var(--sky)}blockquote{margin:0;font-size:clamp(34px,4vw,58px);font-weight:670;letter-spacing:-.055em;line-height:1.02}.founder-note>div p{margin:0;color:#4c5360;font-size:17px;line-height:1.55}.founder-note>div a{display:inline-block;margin-top:28px;color:var(--blue);font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}
  footer{display:grid;min-height:110px;grid-template-columns:1fr auto 1fr;align-items:center;padding:25px clamp(24px,4vw,64px);background:#fff;font:700 8px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase}footer :global(.hii-wordmark){font-size:34px}footer span{color:#858a92}footer a{justify-self:end;color:inherit;text-decoration:none}
  @media(max-width:920px){nav{grid-template-columns:1fr auto}nav p{display:none}.hero{grid-template-columns:1fr}.pen-path{min-height:430px}.workbench>header,.difference,.founder-note{grid-template-columns:1fr}.path-choices{margin-top:55px}.founder-note{gap:38px}}
  @media(max-width:640px){nav{min-height:64px}.brand span{display:none}.hero{min-height:auto;padding:75px 16px 80px}h1{font-size:clamp(65px,20vw,94px)}.pen-path{min-height:340px}.pen-path p{font-size:13px}.path-label{font-size:7px;padding:8px}.workbench,.difference,.founder-note{padding:90px 16px}.workbench>header{gap:28px}.path-choices,.contract-grid{grid-template-columns:1fr}.path-choices{gap:8px}.path-choices button{min-height:66px;align-items:center}.editor-foot,.contract-head,.contract-action{align-items:flex-start;flex-direction:column}.contract-grid article{min-height:auto}.difference{gap:55px}dl>div{grid-template-columns:1fr;gap:10px}footer{grid-template-columns:1fr auto}footer span{display:none}}
  @media(prefers-reduced-motion:reduce){:global(html){scroll-behavior:auto}}
</style>
