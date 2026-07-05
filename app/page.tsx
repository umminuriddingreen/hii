import Link from 'next/link';

export default function Home() {
  return (
    <>
      <h1 className="max-w-4xl text-3xl font-bold tracking-normal">
        Make computer work feel like a conversation with a transcript and a receipt.
      </h1>
      <p className="mt-4 max-w-3xl text-neutral-600">
        HII is the human information interface for agent-operated work. A user asks for a task,
        HII quotes the cost, runs approved agents, streams the operation, and leaves behind proof,
        credits, reimbursement, fees, and handoff links in one durable conversation.
      </p>

      <div className="mt-8 flex gap-4">
        <Link
          href="/terminal"
          className="rounded bg-black px-5 py-2 font-medium text-white hover:bg-neutral-800"
        >
          Open HII terminal →
        </Link>
        <Link
          href="/credits"
          className="rounded border border-neutral-300 px-5 py-2 font-medium hover:bg-neutral-50"
        >
          Quote a task
        </Link>
        <Link
          href="/termite"
          className="rounded border border-neutral-300 px-5 py-2 font-medium hover:bg-neutral-50"
        >
          Download Termite alpha →
        </Link>
        <Link
          href="/upload"
          className="rounded border border-neutral-300 px-5 py-2 font-medium hover:bg-neutral-50"
        >
          Create an exchange →
        </Link>
        <Link
          href="/login"
          className="rounded border border-neutral-300 px-5 py-2 font-medium hover:bg-neutral-50"
        >
          Sign in
        </Link>
      </div>

      <section className="mt-10 grid gap-4 md:grid-cols-3">
        <div className="rounded border border-neutral-200 p-4">
          <h2 className="font-semibold">Conversation</h2>
          <p className="mt-2 text-sm text-neutral-600">
            The interface follows the Claude/Codex pattern: turns, approvals, logs, outputs, and
            resumable context.
          </p>
        </div>
        <div className="rounded border border-neutral-200 p-4">
          <h2 className="font-semibold">Credits</h2>
          <p className="mt-2 text-sm text-neutral-600">
            Account balance can reserve task budget, reimburse computer/model cost, and pay a HII
            coordination fee.
          </p>
        </div>
        <div className="rounded border border-neutral-200 p-4">
          <h2 className="font-semibold">Proof</h2>
          <p className="mt-2 text-sm text-neutral-600">
            Every agent run should end with transcript evidence, files changed, commands run,
            blockers, and next action.
          </p>
        </div>
      </section>

      <p className="mt-10 text-xs text-neutral-400">
        prompt · quote · approval · execution · ledger · proof
      </p>
    </>
  );
}
