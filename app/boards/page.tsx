import Link from 'next/link';

export const dynamic = 'force-dynamic';

const boardTypes = [
  {
    title: 'research boards',
    body: 'browser-saved links, screenshots, notes, source pages, and files grouped into a private or connected trail.'
  },
  {
    title: 'information boards',
    body: 'video, image, audio, documents, market notes, directories, and saved pages arranged around a person or topic.'
  },
  {
    title: 'service boards',
    body: 'plugins, agents, terminal recipes, and proof artifacts packaged into sellable services for connected users.'
  }
];

export default function BoardsPage() {
  return (
    <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="space-y-2 text-sm">
        <Link href="/feed" className="block rounded border border-neutral-200 px-3 py-2 text-neutral-700">Home feed</Link>
        <Link href="/boards" className="block rounded border border-black px-3 py-2 font-medium">Boards</Link>
        <Link href="/upload" className="block rounded border border-neutral-200 px-3 py-2 text-neutral-700">New post</Link>
        <Link href="/credits" className="block rounded border border-neutral-200 px-3 py-2 text-neutral-700">Services</Link>
      </aside>

      <div>
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-neutral-500">owned information</p>
        <h1 className="mt-2 text-3xl font-bold">Boards organize what you know.</h1>
        <p className="mt-2 max-w-2xl text-sm text-neutral-600">
          A board turns saved information into a portable, attributable collection. It feels like a familiar
          moodboard, but every item can carry source, access, price, proof, and plugin metadata.
        </p>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {boardTypes.map((board) => (
          <section key={board.title} className="rounded border border-neutral-200 p-5">
            <h2 className="text-lg font-semibold">{board.title}</h2>
            <p className="mt-3 text-sm text-neutral-600">{board.body}</p>
          </section>
        ))}
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/feed" className="rounded border border-black px-4 py-2 text-sm font-medium">
          browse feed
        </Link>
        <Link href="/upload" className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium">
          publish asset
        </Link>
      </div>
      </div>
    </div>
  );
}
