import Link from 'next/link';

const records = [
  ['CapabilityDefinition', 'Names one HII action with owner, runtime, visibility, status, trust level, inputs, outputs, permissions, cost model, and evidence.'],
  ['CapabilityJob', 'Tracks bounded work through queued, running, waiting_approval, completed, failed, or cancelled state.'],
  ['CapabilityQuote', 'Captures estimated tokens, minutes, compute cost, platform fee, total, budget, currency, and quote status before execution.'],
  ['LedgerEntry', 'Explains approval, reservation, compute cost, platform fee, proof, refund, quote, or top-up movement.'],
  ['ProofArtifact', 'Points to reviewable evidence: log, screenshot, download, receipt, link, or JSON.']
];

export default function HiiSdkContractsPage() {
  return (
    <main className="-m-10 min-h-screen bg-[var(--hii-warm-white)] px-5 py-8 text-[var(--hii-graphite)] sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="border-b border-[var(--hii-electric-blue)] pb-6">
          <Link href="/landing" className="hii-resource-link font-mono text-xs uppercase">
            Back to HII playbook
          </Link>
          <h1 className="mt-5 text-4xl font-black uppercase leading-none sm:text-6xl">HII SDK Contracts</h1>
          <p className="mt-5 max-w-3xl font-mono text-sm leading-7">
            HII names what can run, tracks how work moves through state, records what budget was quoted, preserves ledger events, and points to proof artifacts.
          </p>
        </header>

        <section className="divide-y divide-[var(--hii-electric-blue)]">
          {records.map(([name, summary], index) => (
            <article key={name} className="grid gap-4 py-6 md:grid-cols-[5rem_1fr]">
              <p className="font-mono text-4xl font-black text-[var(--hii-electric-blue)]">{String(index + 1).padStart(2, '0')}</p>
              <div>
                <h2 className="text-2xl font-black">{name}</h2>
                <p className="mt-2 font-mono text-sm leading-7">{summary}</p>
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
