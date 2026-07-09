import Link from 'next/link';

const toc = [
  ['A', 'Naming HII'],
  ['B', 'Capabilities'],
  ['C', 'Contracts'],
  ['D', 'Jobs'],
  ['E', 'Approvals'],
  ['F', 'Runners'],
  ['G', 'Traces'],
  ['H', 'Proofs'],
  ['I', 'Receipts'],
  ['J', 'Packs'],
  ['K', 'Local Models'],
  ['L', 'Publishing']
];

const surfaces = [
  ['Desk', '/'],
  ['Console', '/console'],
  ['Terminal', '/terminal'],
  ['Credits', '/credits'],
  ['Termite', '/termite'],
  ['Feed', '/feed'],
  ['Boards', '/boards']
];

const contracts = [
  'CapabilityDefinition',
  'CapabilityJob',
  'CapabilityQuote',
  'LedgerEntry',
  'ProofArtifact'
];

const capabilityExamples = [
  'hii.context',
  'hii.caps',
  'hii.jobs',
  'hii.runner',
  'hii.trace',
  'hii.proof'
];

const sections = [
  {
    marker: 'A',
    title: 'Naming HII',
    subtitle: 'Human intent becomes a local-first control plane, not a chat transcript.',
    command: 'hii context --json',
    panelTitle: 'Identity record',
    proof: ['repo /Users/ummi/hii', 'runtime ~/.hii', 'role verified agent work'],
    body: 'HII names the working surface and its runtime separately. The repo carries product code; ~/.hii carries append-only state, bridge logs, job receipts, board tasks, and local capability memory.',
    links: [['Open desk', '/'], ['Read console', '/console']]
  },
  {
    marker: 'B',
    title: 'Capabilities',
    subtitle: 'Every useful action has an owner, runtime, visibility, status, and trust level.',
    command: 'hii caps show',
    panelTitle: 'Registry examples',
    proof: ['hii.terminal.observe', 'hii.board.task_kanban', 'termite.rhino.managed_job'],
    body: 'Capabilities are the public grammar for what HII can do. They keep local tools, public routes, trusted runners, and experimental MCP sources visible without pretending they have the same maturity.',
    links: [['Capabilities API', '/api/capabilities'], ['Credits quote', '/credits']]
  },
  {
    marker: 'C',
    title: 'Contracts',
    subtitle: 'Typed records make agent work inspectable after the model stops talking.',
    command: 'npm run hii:sdk:check',
    panelTitle: 'SDK contracts',
    proof: contracts,
    body: 'The SDK layer is intentionally small: definitions describe available work, jobs carry execution state, quotes reserve budget, ledger entries explain money or approval movement, and proof artifacts point to evidence.',
    links: [['Contract notes', '/docs/hii-sdk-contracts'], ['Terminal', '/terminal']]
  },
  {
    marker: 'D',
    title: 'Jobs',
    subtitle: 'Bounded requests become queued, running, waiting, completed, failed, or cancelled records.',
    command: 'hii jobs',
    panelTitle: 'Job state machine',
    proof: ['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'],
    body: 'HII treats work as a durable object with logs and receipts. A model can propose the job, but the platform keeps the state machine legible to humans and downstream runners.',
    links: [['Job API', '/api/capabilities/jobs'], ['Boards', '/boards']]
  },
  {
    marker: 'E',
    title: 'Approvals',
    subtitle: 'Proposal, approval, and execution stay separate until the operator says yes.',
    command: 'hii loop decide yes|no',
    panelTitle: 'Approval gate',
    proof: ['proposal', 'y/n decision', 'execution receipt'],
    body: 'This is the main trust boundary. HII can draft plans, rank next actions, and prepare work, but publishing, pushing, spending, or running risky actions stays behind explicit approval.',
    links: [['Open power layer', '/console'], ['View credits', '/credits']]
  },
  {
    marker: 'F',
    title: 'Runners',
    subtitle: 'Operator-owned machines claim only whitelisted capability jobs.',
    command: 'hii runner start --once',
    panelTitle: 'Runner contract',
    proof: ['heartbeat', 'claim one job', 'stream logs', 'finalize proof'],
    body: 'Runners are not magic remote compute. They are owned execution surfaces with tokens, capability filters, and proof obligations. Termite is the first visible trusted-runner wedge.',
    links: [['Termite proof wedge', '/termite'], ['Runner jobs API', '/api/runners/jobs/next']]
  },
  {
    marker: 'G',
    title: 'Traces',
    subtitle: 'Model calls and operational decisions need durable local evidence.',
    command: '~/.hii/traces/llm_requests.jsonl',
    panelTitle: 'Trace surfaces',
    proof: ['bridge log', 'OG events', 'capability jobs', 'LLM request trace'],
    body: 'The trace layer keeps HII honest: what was asked, what was proposed, who approved, what ran, and what evidence came back. It is local-first and secret-redacted.',
    links: [['Operational graph', '/api/og/status'], ['Terminal stream', '/terminal']]
  },
  {
    marker: 'H',
    title: 'Proofs',
    subtitle: 'Logs, screenshots, downloads, receipts, links, and JSON are first-class artifacts.',
    command: 'ProofArtifact.kind',
    panelTitle: 'Allowed proof kinds',
    proof: ['log', 'screenshot', 'download', 'receipt', 'link', 'json'],
    body: 'Proof turns a completed job into something reviewable. The important rule is simple: HII does not call work done just because an agent says it is done.',
    links: [['Capability jobs', '/api/capabilities/jobs'], ['Feed', '/feed']]
  },
  {
    marker: 'I',
    title: 'Receipts',
    subtitle: 'The ledger explains approvals, costs, fees, proof, refunds, and reservations.',
    command: 'LedgerEntry',
    panelTitle: 'Ledger row',
    proof: ['actor', 'type', 'amount', 'currency', 'summary'],
    body: 'Receipts are the durable bridge between human trust and business logic. They are sparse by design: one row should explain the action, its actor, and the evidence that backs it.',
    links: [['Credits', '/credits'], ['Desk', '/']]
  },
  {
    marker: 'J',
    title: 'Packs',
    subtitle: 'Reusable capability bundles can ship without dragging the whole workstation with them.',
    command: 'hii pack list',
    panelTitle: 'Pack manifest',
    proof: ['capabilities', 'routes', 'files', 'verification'],
    body: 'Packs make HII modular. A terminal pack, credits pack, Termite pack, or link-stream pack can declare its owned files and checks before it becomes a productized surface.',
    links: [['Terminal', '/terminal'], ['Console', '/console']]
  },
  {
    marker: 'K',
    title: 'Local Models',
    subtitle: 'Cheap subroutines stay local when classification, ranking, or rewriting is enough.',
    command: 'hii money idea <idea>',
    panelTitle: 'Model discipline',
    proof: ['fast-local', 'qwen-work', 'qwen-deep', 'gemma-write'],
    body: 'HII uses local models for bounded assistance and keeps serious code edits, secret handling, destructive actions, and approval boundaries in the main operator loop.',
    links: [['Money loop', '/console'], ['Boards', '/boards']]
  },
  {
    marker: 'L',
    title: 'Publishing',
    subtitle: 'Local proof comes first; external publish remains an explicit action.',
    command: 'hii ship --push <message>',
    panelTitle: 'Publish rule',
    proof: ['build locally', 'commit locally', 'push only after approval'],
    body: 'HII can prepare link streams, pages, packs, and product surfaces, but public changes are not assumed. The public playbook points to live surfaces without bypassing the operator.',
    links: [['Public feed', '/feed'], ['Open desk', '/']]
  }
];

function slug(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export default function LandingPage() {
  return (
    <div className="hii-resource-page -m-10 min-h-screen bg-[var(--hii-warm-white)] px-4 pb-16 pt-4 text-[var(--hii-graphite)] sm:px-6 lg:px-8">
      <header className="hii-resource-header mx-auto grid max-w-7xl gap-4 border border-[var(--hii-electric-blue)] bg-[var(--hii-warm-white)] p-4 font-mono text-xs leading-5 lg:fixed lg:left-8 lg:right-8 lg:top-4 lg:z-30 lg:grid-cols-[minmax(0,0.74fr)_minmax(280px,0.44fr)]">
        <section aria-label="HII manifesto" className="space-y-3">
          <Link href="/" className="text-sm font-black uppercase text-[var(--hii-electric-blue)] underline decoration-1 underline-offset-2">
            HII
          </Link>
          <p className="max-w-3xl">
            HII is a local-first control plane for verified agent work: human intent, bounded tool execution, logs, proof, verification, receipts, and reusable capabilities.
          </p>
          <nav aria-label="HII surfaces" className="flex flex-wrap gap-x-4 gap-y-1">
            {surfaces.map(([label, href]) => (
              <Link key={href} href={href} className="hii-resource-link">
                {label}
              </Link>
            ))}
          </nav>
        </section>
        <nav aria-label="Table of contents" className="border-t border-[var(--hii-electric-blue)] pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          <p className="mb-2 font-black uppercase">FROM A-Z (TABLE OF CONTENTS)</p>
          <div className="grid grid-cols-2 gap-x-5 gap-y-1 sm:grid-cols-3 lg:grid-cols-2">
            {toc.map(([letter, title]) => (
              <a key={letter} href={`#${slug(title)}`} className="hii-resource-link">
                {letter}. {title}
              </a>
            ))}
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-7xl lg:pt-48 xl:pt-44">
        <section className="grid min-h-[54vh] place-items-center py-16 text-center sm:py-20">
          <div className="w-full">
            <p className="font-mono text-xs uppercase text-[var(--hii-electric-blue)]">
              local SDK / capability maturity / public playbook
            </p>
            <h1 className="mx-auto mt-5 max-w-5xl text-[clamp(4rem,16vw,12rem)] font-black uppercase leading-[0.78] tracking-normal">
              HII
            </h1>
            <p className="mx-auto mt-6 max-w-3xl font-mono text-sm leading-6 sm:text-base">
              A sparse resource center for the contracts, proof grammar, runner model, and control surfaces that make agent work verifiable.
            </p>
            <div className="hii-browser-window mx-auto mt-10 max-w-4xl text-left">
              <div className="hii-browser-bar">
                <span className="hii-browser-dot" />
                <span className="hii-browser-dot" />
                <span className="hii-browser-dot" />
                <span className="ml-2 truncate font-mono text-xs text-neutral-600">hii://sdk/control-plane-proof</span>
              </div>
              <div className="grid gap-0 border-t border-[rgba(23,23,23,0.08)] bg-white md:grid-cols-[0.9fr_1.1fr]">
                <div className="hii-scanline border-b border-[rgba(23,23,23,0.14)] p-5 md:border-b-0 md:border-r">
                  <p className="font-mono text-[11px] uppercase text-neutral-500">current contract surface</p>
                  <h2 className="mt-3 text-2xl font-black uppercase leading-none">Intent to proof</h2>
                  <p className="mt-4 font-mono text-xs leading-5 text-neutral-700">
                    HII turns vague work into named capabilities, quotes, jobs, approvals, logs, ledger rows, and proof artifacts.
                  </p>
                </div>
                <div className="grid gap-2 p-4 font-mono text-xs">
                  {capabilityExamples.map((item, index) => (
                    <div key={item} className="grid grid-cols-[3rem_minmax(0,1fr)_5rem] items-center border border-[rgba(23,23,23,0.14)] bg-[var(--hii-warm-white)] px-3 py-2">
                      <span className="text-[var(--hii-electric-blue)]">0{index + 1}</span>
                      <span className="font-bold">{item}</span>
                      <span className="justify-self-end bg-[var(--hii-soft-green)] px-2 py-1 text-[10px] uppercase">visible</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="introduction" className="scroll-mt-44 border-y border-[var(--hii-electric-blue)] py-8">
          <div className="grid gap-6 md:grid-cols-[0.32fr_1fr]">
            <p className="font-mono text-xs font-black uppercase text-[var(--hii-electric-blue)]">INTRODUCTION</p>
            <div className="max-w-4xl space-y-4 font-mono text-sm leading-7">
              <p>
                HII is not a marketplace claim or a decorative AI shell. It is a local workstation control plane that makes agent work inspectable before, during, and after execution.
              </p>
              <p>
                The maturity target is SDK-grade: every capability has a registry entry, every job has allowed states, every approval has a boundary, every runner has a narrow contract, and every completed task has proof.
              </p>
            </div>
          </div>
        </section>

        <div className="divide-y divide-[var(--hii-electric-blue)]">
          {sections.map((section, index) => (
            <section key={section.marker} id={slug(section.title)} className="scroll-mt-44 py-8">
              <div className="grid gap-5 lg:grid-cols-[7rem_minmax(0,0.74fr)_minmax(320px,0.54fr)]">
                <div className="font-mono text-6xl font-black leading-none text-[var(--hii-electric-blue)]">
                  {section.marker}
                </div>
                <article>
                  <p className="font-mono text-xs uppercase text-neutral-500">No. {String(index + 1).padStart(2, '0')}</p>
                  <h2 className="mt-2 text-3xl font-black uppercase leading-none sm:text-5xl">{section.title}</h2>
                  <p className="mt-4 max-w-2xl text-lg font-bold leading-7">{section.subtitle}</p>
                  <p className="mt-5 max-w-3xl font-mono text-sm leading-7">{section.body}</p>
                  <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 font-mono text-sm">
                    {section.links.map(([label, href]) => (
                      <Link key={href} href={href} className="hii-resource-link">
                        {label}
                      </Link>
                    ))}
                  </div>
                </article>
                <aside className="hii-browser-window">
                  <div className="hii-browser-bar">
                    <span className="hii-browser-dot" />
                    <span className="hii-browser-dot" />
                    <span className="hii-browser-dot" />
                    <span className="ml-2 truncate font-mono text-[11px] text-neutral-600">{section.command}</span>
                  </div>
                  <div className="bg-white p-4">
                    <p className="font-mono text-[11px] uppercase text-neutral-500">{section.panelTitle}</p>
                    <div className="mt-3 grid gap-2">
                      {section.proof.map((item) => (
                        <div key={item} className="border border-[rgba(23,23,23,0.16)] bg-[var(--hii-warm-white)] px-3 py-2 font-mono text-xs">
                          {item}
                        </div>
                      ))}
                    </div>
                  </div>
                </aside>
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
