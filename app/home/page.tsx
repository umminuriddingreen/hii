import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'HII — Verified agent work, grounded in your context',
  description:
    'HII turns your files, notes, repos, tools, and current machine state into approved, bounded agent work, then returns the artifact, the checks, and the receipt.'
};

const LOOP = [
  {
    step: '01',
    title: 'See the real context.',
    body: 'Bring in the project, notes, files, links, and live machine state that matter. HII keeps every source and boundary visible.'
  },
  {
    step: '02',
    title: 'Approve one move.',
    body: 'Name the outcome, choose what an agent may use, and review the workspace, capability, and external-action boundary before it runs.'
  },
  {
    step: '03',
    title: 'Get proof back.',
    body: 'The artifact, changed files, checks, logs, and receipt return to the same workspace, ready to inspect, continue, or reuse.'
  }
];

const SURFACES = [
  { name: 'Workspace', body: 'Arrange sources, live tools, agent work, and receipts as connected objects on one spatial canvas.' },
  { name: 'Knowledge', body: 'Write, link, search, graph, import, and export local knowledge without losing provenance.' },
  { name: 'HII CLI', body: 'Use the same local runtime from a native terminal: observe state, act within bounds, verify the result.' }
];

export default function HomePage() {
  return (
    <main className="public-home public-landing">
      <p className="public-name">HII / Human Information Interface</p>

      <h1>Your context. Agent work you can verify.</h1>

      <p>
        HII turns your files, notes, repos, tools, and current machine state into approved,
        bounded agent work — then returns the artifact, the checks, and the receipt.
      </p>

      <div className="public-cta">
        <a className="public-cta-primary" href="/download/windows">Download for Windows</a>
        <a href="/download">All platforms</a>
        <a href="/building">What is being built</a>
      </div>
      <p className="public-fine">
        Windows 10 / 11 · x64. A current-user installer with HII&rsquo;s local runtime included, no
        administrator account required. The Mac build waits on Apple notarization.
      </p>

      <section className="public-section">
        <h2>See the state. Approve the move. Keep the proof.</h2>
        <p className="public-lede">
          Models and tools can change. Your context, authority, project memory, and evidence stay
          with you in HII.
        </p>
        <ol className="public-loop">
          {LOOP.map((entry) => (
            <li key={entry.step}>
              <span className="public-step">{entry.step}</span>
              <h3>{entry.title}</h3>
              <p>{entry.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="public-section">
        <h2>One system, not one screen.</h2>
        <p className="public-lede">
          Workspace, Knowledge, Browser, Create, Notch, the native terminal, and the HII CLI all read
          from the same local project state and proof history.
        </p>
        <ul className="public-surfaces">
          {SURFACES.map((surface) => (
            <li key={surface.name}>
              <h3>{surface.name}</h3>
              <p>{surface.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="public-section">
        <h2>One run. Five visible states.</h2>
        <p className="public-lede">
          Captured from HII, not a mockup. This run used three approved source objects, wrote one
          editable artifact, passed two checks, and returned an inspectable local receipt in 43
          seconds.
        </p>
        <ol className="public-run">
          <li>Intent approved</li>
          <li>Accepted by AII</li>
          <li>Bounded work completed</li>
          <li>Proof collected</li>
          <li>Receipt returned</li>
        </ol>
      </section>

      <section className="public-section">
        <h2>Rather have it run against your own work?</h2>
        <p className="public-lede">
          That is a session: HII is pointed at a real problem of yours, and the workspace, the
          artifacts, and the receipts are yours to keep.{' '}
          <a href="mailto:hello@humaninformationinterface.com">hello@humaninformationinterface.com</a>
        </p>
      </section>

      <p className="public-fine">
        HII keeps project state on your computer under <code>~/.hii</code>. We do not ask you to
        disable Gatekeeper or Windows security protections.
      </p>

      <nav>
        <a href="/download">Download</a>
        <a href="/building">Building</a>
        <a href="/docs">Documentation</a>
        <a href="/privacy">Privacy</a>
      </nav>
    </main>
  );
}
