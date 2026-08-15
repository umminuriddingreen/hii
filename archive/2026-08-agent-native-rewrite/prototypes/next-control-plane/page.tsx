// SPDX-License-Identifier: LicenseRef-BSL-1.1
import { getHiiAgentContext } from '@/lib/server/hii-agent-context';
import { getHiiDaemonSnapshot } from '@/lib/server/hii-daemon';
import { listCapabilities } from '@/lib/capabilities';
import { capabilitySurfaces, surfaceStatus } from '@/lib/capabilities/surfaces';
import { HiiLogo } from '@/components/brand/HiiLogo';

type PipeStage = {
  id: string;
  label: string;
  detail: string;
};

const pipeStages: PipeStage[] = [
  { id: 'intent', label: 'Intent', detail: 'Human says what should change.' },
  { id: 'context', label: 'Context', detail: 'HII resolves source-linked state.' },
  { id: 'capability', label: 'Capability', detail: 'Available tools are checked before narration.' },
  { id: 'authority', label: 'Authority', detail: 'Risk and permission decide whether work can run.' },
  { id: 'execution', label: 'Execution', detail: 'Workers act while the coordinator stays alive.' },
  { id: 'proof', label: 'Proof', detail: 'Verification creates the receipt.' }
];

const surfaces = [
  { id: 'desk', label: 'Workspace', href: '/workspace', summary: 'Objects, sources, runs, and proof on one board.' },
  { id: 'knowledge', label: 'Knowledge', href: '/knowledge', summary: 'Local notes, links, search, provenance, and memory.' },
  { id: 'activate', label: 'Activate', href: '/activate', summary: 'Prepare bounded work and approve context.' },
  { id: 'console', label: 'Console', href: '/console', summary: 'Runtime, terminal, daemon, jobs, and receipts.' },
  { id: 'browser', label: 'Browser', href: '/browser', summary: 'Research and web context as HII-owned objects.' },
  { id: 'notch', label: 'Notch', href: '/notch', summary: 'Ambient state, voice, and quick intent capture.' }
];

function statusTone(status: string) {
  if (status === 'ready') return 'is-ready';
  if (status === 'partial') return 'is-partial';
  if (status === 'blocked') return 'is-blocked';
  return 'is-planned';
}

function countBy<T extends string>(values: T[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

export default async function HomePage() {
  const [context, daemon] = await Promise.all([
    Promise.resolve(getHiiAgentContext()),
    getHiiDaemonSnapshot().catch(() => null)
  ]);
  const capabilities = listCapabilities();
  const capabilityCounts = countBy(capabilities.map((capability) => capability.status));
  const dirtyFiles = context.git.worktree.counts.total;
  const activeRuns = daemon?.health?.activeRuns ?? 0;
  const queuedRuns = daemon?.health?.queuedRuns ?? 0;
  const surfaceRows = surfaces.map((surface) => ({
    ...surface,
    status: surfaceStatus(capabilities, surface.id),
    count: capabilities.filter((capability) => capabilitySurfaces[capability.id]?.id === surface.id).length
  }));
  const topCapabilities = capabilities
    .filter((capability) => capability.status === 'ready' || capability.status === 'partial')
    .slice(0, 8);

  return (
    <main className="hii-next-shell min-h-screen">
      <header className="hii-next-nav" aria-label="HII">
        <a className="hii-next-brand" href="/">
          <HiiLogo title="HII" />
        </a>
        <nav aria-label="Primary">
          <a href="/workspace">Workspace</a>
          <a href="/knowledge">Knowledge</a>
          <a href="/console">Console</a>
          <a href="/browser-sync">Browser Sync</a>
          <a href="/support">Support</a>
        </nav>
      </header>

      <section className="hii-next-hero">
        <div className="hii-next-hero-copy">
          <p className="hii-next-kicker">HII / local control plane</p>
          <h1>Reduce the distance between intent and verified consequence.</h1>
          <p className="hii-next-lede">
            A Next.js surface over HII-owned runtime state: capability truth, daemon health,
            bounded work, verification, and receipts.
          </p>
          <div className="hii-next-actions" aria-label="Primary HII surfaces">
            <a href="/workspace">Open workspace</a>
            <a href="/console">Inspect console</a>
          </div>
        </div>
        <div className="hii-next-live-panel" aria-label="Live HII summary">
          <div>
            <span>branch</span>
            <strong>{context.git.branch}</strong>
          </div>
          <div>
            <span>worktree</span>
            <strong>{dirtyFiles ? `${dirtyFiles} changes` : 'clean'}</strong>
          </div>
          <div>
            <span>daemon</span>
            <strong>{daemon?.health?.label ?? 'not available'}</strong>
          </div>
          <div>
            <span>runs</span>
            <strong>{activeRuns} active / {queuedRuns} queued</strong>
          </div>
        </div>
      </section>

      <section className="hii-next-grid" aria-label="HII pipe runtime">
        <div className="hii-next-section-heading">
          <p>pipe contract</p>
          <h2>Models reason. HII decides what actually happened.</h2>
        </div>
        <div className="hii-next-pipe">
          {pipeStages.map((stage) => (
            <article key={stage.id}>
              <span>{stage.id}</span>
              <h3>{stage.label}</h3>
              <p>{stage.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="hii-next-two-up" aria-label="Capability and surface state">
        <div>
          <div className="hii-next-section-heading">
            <p>capability truth</p>
            <h2>{capabilities.length} indexed capabilities</h2>
          </div>
          <div className="hii-next-counts">
            {['ready', 'partial', 'blocked', 'planned'].map((status) => (
              <div key={status}>
                <span className={`hii-next-dot ${statusTone(status)}`} />
                <strong>{capabilityCounts[status] ?? 0}</strong>
                <small>{status}</small>
              </div>
            ))}
          </div>
          <div className="hii-next-cap-list">
            {topCapabilities.map((capability) => (
              <a key={capability.id} href={capabilitySurfaces[capability.id]?.href ?? '/activate'}>
                <span className={`hii-next-dot ${statusTone(capability.status)}`} />
                <strong>{capability.name}</strong>
                <small>{capability.id}</small>
              </a>
            ))}
          </div>
        </div>

        <div>
          <div className="hii-next-section-heading">
            <p>surfaces</p>
            <h2>Interfaces stay thin; runtime stays canonical.</h2>
          </div>
          <div className="hii-next-surface-list">
            {surfaceRows.map((surface) => (
              <a key={surface.id} href={surface.href}>
                <span className={`hii-next-dot ${statusTone(surface.status)}`} />
                <strong>{surface.label}</strong>
                <small>{surface.count} capabilities · {surface.summary}</small>
              </a>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
