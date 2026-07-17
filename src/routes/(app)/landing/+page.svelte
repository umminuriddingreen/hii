<script lang="ts">
  import HiiLogo from '$lib/components/HiiLogo.svelte';

  const loop = [
    ['01', 'Intent', 'Name the outcome, scope, and authority.'],
    ['02', 'Context', 'Compile only the sources the work needs.'],
    ['03', 'Work', 'Run bounded agents and tools under human control.'],
    ['04', 'Proof', 'Return artifacts, tests, logs, and a receipt.']
  ];
  const productProof = [
    { label: 'Knowledge workspace', title: 'Your context becomes infrastructure.', copy: 'Local Markdown, links, backlinks, tags, search, history, graph navigation, and export—built for humans and agents to share without losing provenance.', href: '/knowledge', cta: 'Open knowledge' },
    { label: 'Governed execution', title: 'Agent work gets a control surface.', copy: 'Capabilities declare ownership and trust. Approval stays separate from execution. Every serious run can carry status, evidence, and a durable receipt.', href: '/', cta: 'Open HII' },
    { label: 'Reusable capability', title: 'Every verified win compounds.', copy: 'Successful workflows do not disappear into chat history. HII turns proven work into reusable, operator-reviewed capability for the next project.', href: '/console', cta: 'See control plane' }
  ];
  const advantages = [
    ['User-owned context', 'Files stay in place. Sources, boundaries, and provenance remain visible.'],
    ['Model-agnostic', 'Models are replaceable engines; durable context and proof are the product moat.'],
    ['Human authority', 'HII can prepare and propose. The operator controls consequential action.'],
    ['Compounding memory', 'Receipts and decisions turn finished work into trusted project memory.']
  ];
</script>

<svelte:head><title>HII — Turn thought into proof</title></svelte:head>

<div class="hii-investor-page">
  <header class="hii-investor-nav">
    <a href="/landing" class="hii-investor-mark" aria-label="HII investor home"><HiiLogo /><span>LOCAL 01</span></a>
    <nav aria-label="Investor page navigation"><a href="#product">Product</a><a href="#loop">How it works</a><a href="#thesis">Thesis</a></nav>
    <a href="/knowledge" class="hii-investor-nav-cta">Open the MVP <span aria-hidden="true">↗</span></a>
  </header>
  <main>
    <section class="hii-investor-hero" aria-labelledby="hero-title">
      <div class="hii-investor-hero-copy">
        <p class="hii-investor-eyebrow"><span></span> Human Information Interface</p>
        <h1 id="hero-title">Turn thought<br />into <em>proof.</em></h1>
        <p class="hii-investor-deck">HII is the local-first interface where human knowledge becomes bounded agent work—and finished work comes back with evidence.</p>
        <div class="hii-investor-actions"><a href="/knowledge" class="hii-investor-primary">Enter the workspace <span aria-hidden="true">↗</span></a><a href="#product" class="hii-investor-text-link">Explore the product <span aria-hidden="true">↓</span></a></div>
      </div>
      <div class="hii-proof-stage" aria-label="HII product preview: source-linked context becoming verified work">
        <div class="hii-proof-stage-meta"><span>LIVE PRODUCT / LOCAL MVP</span><span class="hii-live-label"><i></i> SYSTEM READY</span></div>
        <div class="hii-context-window">
          <div class="hii-window-bar"><span class="hii-window-dots"><i></i><i></i><i></i></span><span>HII / Knowledge</span><span>⌘ K</span></div>
          <div class="hii-window-body"><aside><p>Workspace</p><strong>Founder thesis</strong><span>Product decisions</span><span>Market research</span><span>Build receipts</span><small>+ New source</small></aside><article><p class="hii-doc-path">HII / PRODUCT / NORTH_STAR.md</p><h2>Reduce the distance between thought and executed artifact.</h2><p>Human intent becomes source-linked context, bounded work, verification, and durable memory.</p><div class="hii-source-chip">● 7 linked sources</div><div class="hii-highlight-line"></div><div class="hii-text-line long"></div><div class="hii-text-line"></div></article></div>
        </div>
        <div class="hii-agent-card"><div class="hii-agent-card-head"><span>BOUNDED RUN</span><span class="hii-approved">APPROVED</span></div><h3>Build investor-ready MVP</h3><div class="hii-run-step complete"><i>✓</i><span>Context compiled</span><small>12 sources</small></div><div class="hii-run-step complete"><i>✓</i><span>Work executed</span><small>local</small></div><div class="hii-run-step active"><i></i><span>Verifying artifact</span><small>now</small></div><div class="hii-agent-card-foot"><span>Proof required</span><strong>3 / 4</strong></div></div>
        <div class="hii-receipt-card"><span class="hii-receipt-check">✓</span><div><small>RECEIPT / HII-0716</small><strong>Outcome verified</strong></div><span aria-hidden="true">↗</span></div>
        <svg class="hii-proof-thread" viewBox="0 0 720 610" preserveAspectRatio="none" aria-hidden="true"><path d="M120 470 C 198 545, 312 518, 377 417 S 527 265, 631 329"></path><circle cx="120" cy="470" r="5"></circle><circle cx="377" cy="417" r="5"></circle><circle cx="631" cy="329" r="5"></circle></svg>
      </div>
    </section>
    <section class="hii-investor-statement" id="thesis"><p class="hii-section-label">THE MISSING LAYER</p><blockquote>Knowledge tools organize what you know.<br />Agent frameworks run what you ask.<br /><strong>HII connects the two—with proof.</strong></blockquote><p class="hii-statement-note">AI can generate almost anything. The scarce layer is trusted context, human control, and evidence that the work actually happened.</p></section>
    <section class="hii-investor-loop" id="loop"><div class="hii-section-intro"><p class="hii-section-label">THE CORE LOOP</p><h2>From an idea to a verified artifact—without losing the why.</h2></div><div class="hii-loop-grid">{#each loop as item}<article><span>{item[0]}</span><div class="hii-loop-icon" aria-hidden="true"><i></i></div><h3>{item[1]}</h3><p>{item[2]}</p></article>{/each}</div></section>
    <section class="hii-investor-product" id="product"><div class="hii-section-intro hii-section-intro-light"><p class="hii-section-label">WORKING IN THIS BUILD</p><h2>One product.<br />Three compounding layers.</h2><p>Open the routes. Inspect the product. The MVP is running locally—not staged in a pitch deck.</p></div><div class="hii-product-list">{#each productProof as item, index}<article><span class="hii-product-number">0{index + 1}</span><div><p>{item.label}</p><h3>{item.title}</h3><span>{item.copy}</span></div><a href={item.href}>{item.cta} <span aria-hidden="true">↗</span></a></article>{/each}</div></section>
    <section class="hii-investor-advantage"><div class="hii-section-intro"><p class="hii-section-label">WHY HII CAN ENDURE</p><h2>The interface gets better every time the work is real.</h2></div><div class="hii-advantage-grid">{#each advantages as item, index}<article><span>{String.fromCharCode(65 + index)}</span><h3>{item[0]}</h3><p>{item[1]}</p></article>{/each}</div></section>
    <section class="hii-investor-close"><p class="hii-section-label">HUMAN INTENT / ARTIFICIAL LABOR / VERIFIABLE OUTCOMES</p><h2>The future of work needs an interface.</h2><div><p>HII is building it locally first.</p><a href="/knowledge" class="hii-investor-primary hii-investor-primary-light">Open the local MVP <span aria-hidden="true">↗</span></a></div><HiiLogo className="hii-close-mark" /></section>
  </main>
  <footer class="hii-investor-footer"><div><HiiLogo className="hii-footer-logo" /><span>Human Information Interface</span></div><p>Local-first. Human-controlled. Proof-backed.</p><a href="/">Enter HII <span aria-hidden="true">↗</span></a></footer>
</div>
