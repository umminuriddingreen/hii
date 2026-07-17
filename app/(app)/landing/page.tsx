import Link from 'next/link';
import type { Metadata } from 'next';
import { HiiLogo } from '../../../components/brand/HiiLogo';

export const metadata: Metadata = {
  title: 'HII — Turn thought into proof',
  description: 'HII is the local-first interface where human knowledge becomes bounded agent work and finished work comes back with evidence.'
};

const loop = [
  ['01', 'Intent', 'Name the outcome, scope, and authority.'],
  ['02', 'Context', 'Compile only the sources the work needs.'],
  ['03', 'Work', 'Run bounded agents and tools under human control.'],
  ['04', 'Proof', 'Return artifacts, tests, logs, and a receipt.']
];

const productProof = [
  {
    label: 'Knowledge workspace',
    title: 'Your context becomes infrastructure.',
    copy: 'Local Markdown, links, backlinks, tags, search, history, graph navigation, and export—built for humans and agents to share without losing provenance.',
    href: '/knowledge',
    cta: 'Open knowledge'
  },
  {
    label: 'Governed execution',
    title: 'Agent work gets a control surface.',
    copy: 'Capabilities declare ownership and trust. Approval stays separate from execution. Every serious run can carry status, evidence, and a durable receipt.',
    href: '/',
    cta: 'Open HII'
  },
  {
    label: 'Reusable capability',
    title: 'Every verified win compounds.',
    copy: 'Successful workflows do not disappear into chat history. HII turns proven work into reusable, operator-reviewed capability for the next project.',
    href: '/console',
    cta: 'See control plane'
  }
];

const advantages = [
  ['User-owned context', 'Files stay in place. Sources, boundaries, and provenance remain visible.'],
  ['Model-agnostic', 'Models are replaceable engines; durable context and proof are the product moat.'],
  ['Human authority', 'HII can prepare and propose. The operator controls consequential action.'],
  ['Compounding memory', 'Receipts and decisions turn finished work into trusted project memory.']
];

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

export default function LandingPage() {
  return (
    <div className="hii-investor-page">
      <header className="hii-investor-nav">
        <Link href="/landing" className="hii-investor-mark" aria-label="HII investor home">
          <HiiLogo />
          <span>LOCAL 01</span>
        </Link>
        <nav aria-label="Investor page navigation">
          <a href="#product">Product</a>
          <a href="#loop">How it works</a>
          <a href="#thesis">Thesis</a>
        </nav>
        <Link href="/knowledge" className="hii-investor-nav-cta">
          Open the MVP <Arrow />
        </Link>
      </header>

      <main>
        <section className="hii-investor-hero" aria-labelledby="hero-title">
          <div className="hii-investor-hero-copy">
            <p className="hii-investor-eyebrow">
              <span /> Human Information Interface
            </p>
            <h1 id="hero-title">
              Turn thought<br />
              into <em>proof.</em>
            </h1>
            <p className="hii-investor-deck">
              HII is the local-first interface where human knowledge becomes bounded agent work—and finished work comes back with evidence.
            </p>
            <div className="hii-investor-actions">
              <Link href="/knowledge" className="hii-investor-primary">
                Enter the workspace <Arrow />
              </Link>
              <a href="#product" className="hii-investor-text-link">
                Explore the product <span aria-hidden="true">↓</span>
              </a>
            </div>
          </div>

          <div className="hii-proof-stage" aria-label="HII product preview: source-linked context becoming verified work">
            <div className="hii-proof-stage-meta">
              <span>LIVE PRODUCT / LOCAL MVP</span>
              <span className="hii-live-label"><i /> SYSTEM READY</span>
            </div>

            <div className="hii-context-window">
              <div className="hii-window-bar">
                <span className="hii-window-dots"><i /><i /><i /></span>
                <span>HII / Knowledge</span>
                <span>⌘ K</span>
              </div>
              <div className="hii-window-body">
                <aside>
                  <p>Workspace</p>
                  <strong>Founder thesis</strong>
                  <span>Product decisions</span>
                  <span>Market research</span>
                  <span>Build receipts</span>
                  <small>+ New source</small>
                </aside>
                <article>
                  <p className="hii-doc-path">HII / PRODUCT / NORTH_STAR.md</p>
                  <h2>Reduce the distance between thought and executed artifact.</h2>
                  <p>
                    Human intent becomes source-linked context, bounded work, verification, and durable memory.
                  </p>
                  <div className="hii-source-chip">● 7 linked sources</div>
                  <div className="hii-highlight-line" />
                  <div className="hii-text-line long" />
                  <div className="hii-text-line" />
                </article>
              </div>
            </div>

            <div className="hii-agent-card">
              <div className="hii-agent-card-head">
                <span>BOUNDED RUN</span>
                <span className="hii-approved">APPROVED</span>
              </div>
              <h3>Build investor-ready MVP</h3>
              <div className="hii-run-step complete"><i>✓</i><span>Context compiled</span><small>12 sources</small></div>
              <div className="hii-run-step complete"><i>✓</i><span>Work executed</span><small>local</small></div>
              <div className="hii-run-step active"><i /><span>Verifying artifact</span><small>now</small></div>
              <div className="hii-agent-card-foot"><span>Proof required</span><strong>3 / 4</strong></div>
            </div>

            <div className="hii-receipt-card">
              <span className="hii-receipt-check">✓</span>
              <div>
                <small>RECEIPT / HII-0716</small>
                <strong>Outcome verified</strong>
              </div>
              <Arrow />
            </div>

            <svg className="hii-proof-thread" viewBox="0 0 720 610" preserveAspectRatio="none" aria-hidden="true">
              <path d="M120 470 C 198 545, 312 518, 377 417 S 527 265, 631 329" />
              <circle cx="120" cy="470" r="5" />
              <circle cx="377" cy="417" r="5" />
              <circle cx="631" cy="329" r="5" />
            </svg>
          </div>
        </section>

        <section className="hii-investor-statement" id="thesis">
          <p className="hii-section-label">THE MISSING LAYER</p>
          <blockquote>
            Knowledge tools organize what you know.<br />
            Agent frameworks run what you ask.<br />
            <strong>HII connects the two—with proof.</strong>
          </blockquote>
          <p className="hii-statement-note">
            AI can generate almost anything. The scarce layer is trusted context, human control, and evidence that the work actually happened.
          </p>
        </section>

        <section className="hii-investor-loop" id="loop">
          <div className="hii-section-intro">
            <p className="hii-section-label">THE CORE LOOP</p>
            <h2>From an idea to a verified artifact—without losing the why.</h2>
          </div>
          <div className="hii-loop-grid">
            {loop.map(([number, title, copy]) => (
              <article key={number}>
                <span>{number}</span>
                <div className="hii-loop-icon" aria-hidden="true"><i /></div>
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="hii-investor-product" id="product">
          <div className="hii-section-intro hii-section-intro-light">
            <p className="hii-section-label">WORKING IN THIS BUILD</p>
            <h2>One product.<br />Three compounding layers.</h2>
            <p>Open the routes. Inspect the product. The MVP is running locally—not staged in a pitch deck.</p>
          </div>
          <div className="hii-product-list">
            {productProof.map((item, index) => (
              <article key={item.title}>
                <span className="hii-product-number">0{index + 1}</span>
                <div>
                  <p>{item.label}</p>
                  <h3>{item.title}</h3>
                  <span>{item.copy}</span>
                </div>
                <Link href={item.href}>{item.cta} <Arrow /></Link>
              </article>
            ))}
          </div>
        </section>

        <section className="hii-investor-advantage">
          <div className="hii-section-intro">
            <p className="hii-section-label">WHY HII CAN ENDURE</p>
            <h2>The interface gets better every time the work is real.</h2>
          </div>
          <div className="hii-advantage-grid">
            {advantages.map(([title, copy], index) => (
              <article key={title}>
                <span>{String.fromCharCode(65 + index)}</span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="hii-investor-close">
          <p className="hii-section-label">HUMAN INTENT / ARTIFICIAL LABOR / VERIFIABLE OUTCOMES</p>
          <h2>The future of work needs an interface.</h2>
          <div>
            <p>HII is building it locally first.</p>
            <Link href="/knowledge" className="hii-investor-primary hii-investor-primary-light">
              Open the local MVP <Arrow />
            </Link>
          </div>
          <HiiLogo className="hii-close-mark" />
        </section>
      </main>

      <footer className="hii-investor-footer">
        <div>
          <HiiLogo className="hii-footer-logo" />
          <span>Human Information Interface</span>
        </div>
        <p>Local-first. Human-controlled. Proof-backed.</p>
        <Link href="/">Enter HII <Arrow /></Link>
      </footer>
    </div>
  );
}
