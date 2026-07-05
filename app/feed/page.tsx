import Link from 'next/link';
import { createLinkPost, listLinkPostsWithCache } from '@/lib/server/link-stream';

export const dynamic = 'force-dynamic';

async function saveLink(formData: FormData) {
  'use server';
  await createLinkPost(formData);
}

function cacheLabel(status: string | undefined) {
  if (status === 'cached') return 'offline cached';
  if (status === 'failed') return 'cache failed';
  return 'not cached';
}

export default async function FeedPage() {
  const posts = await listLinkPostsWithCache(80);
  const cachedCount = posts.filter((post) => post.cache?.status === 'cached').length;
  const failedCount = posts.filter((post) => post.cache?.status === 'failed').length;

  return (
    <div className="grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="space-y-2 text-sm">
        <Link href="/feed" className="block rounded border border-black px-3 py-2 font-medium">Offline feed</Link>
        <Link href="/dashboard" className="block rounded border border-neutral-200 px-3 py-2 text-neutral-700">Studio</Link>
        <Link href="/terminal" className="block rounded border border-neutral-200 px-3 py-2 text-neutral-700">Terminal</Link>
        <Link href="/upload" className="block rounded border border-neutral-200 px-3 py-2 text-neutral-700">Exchange</Link>
        <div className="pt-4 font-mono text-xs text-neutral-500">
          /api/links<br />
          npm run hii:links:cache<br />
          extensions/chrome-link-capture
        </div>
        <div className="rounded border border-neutral-200 p-3 text-xs text-neutral-600">
          <div className="font-mono text-neutral-400">local state</div>
          <div className="mt-2 flex justify-between"><span>links</span><span>{posts.length}</span></div>
          <div className="flex justify-between"><span>cached</span><span>{cachedCount}</span></div>
          <div className="flex justify-between"><span>failed</span><span>{failedCount}</span></div>
        </div>
      </aside>

      <div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-neutral-500">hii browser loop</p>
            <h1 className="mt-2 text-3xl font-bold">Stream links now. Let the local agent make them offline.</h1>
            <p className="mt-2 max-w-2xl text-sm text-neutral-600">
              A cheap sharing surface for HII: the browser captures useful pages, the downloader caches
              them on this machine, and Ollama turns the cache into local summaries for an offline feed.
            </p>
          </div>
          <a href="#save-link" className="w-fit rounded border border-black px-4 py-2 text-sm font-medium">
            save link
          </a>
        </div>

        <section id="save-link" className="mt-8 border border-neutral-200 p-4">
          <form action={saveLink} className="grid gap-3 lg:grid-cols-[1fr_1fr_auto]">
            <label className="text-sm">
              <span className="mb-1 block font-medium">URL</span>
              <input name="url" required placeholder="https://example.com/useful-page" className="w-full border border-neutral-300 px-3 py-2" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Title</span>
              <input name="title" required minLength={3} maxLength={120} placeholder="Why this matters" className="w-full border border-neutral-300 px-3 py-2" />
            </label>
            <button className="self-end border border-black bg-black px-4 py-2 text-sm font-medium text-white">
              Save
            </button>
            <label className="text-sm lg:col-span-2">
              <span className="mb-1 block font-medium">Note</span>
              <input name="note" maxLength={500} placeholder="Optional context for the agent" className="w-full border border-neutral-300 px-3 py-2" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Tags</span>
              <input name="tags" placeholder="hii, browser, local" className="w-full border border-neutral-300 px-3 py-2" />
            </label>
            <input name="source" type="hidden" value="manual" />
          </form>
        </section>

        <div className="mt-8 grid gap-4">
          {posts.map((post) => (
            <article key={post.id} className="border border-neutral-200 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs uppercase text-neutral-500">{post.source}</span>
                    <span className="border border-neutral-200 px-2 py-0.5 font-mono text-xs text-neutral-600">
                      {cacheLabel(post.cache?.status)}
                    </span>
                  </div>
                  <h2 className="mt-2 text-xl font-semibold">{post.title}</h2>
                  <a href={post.url} className="mt-1 block truncate font-mono text-xs text-neutral-500 underline underline-offset-4">
                    {post.url}
                  </a>
                </div>
                <time className="shrink-0 font-mono text-xs text-neutral-500">
                  {new Date(post.createdAt).toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit'
                  })}
                </time>
              </div>
              {post.note && <p className="mt-3 text-sm text-neutral-700">{post.note}</p>}
              {post.cache?.summary && (
                <div className="mt-4 border-l-2 border-black pl-3 text-sm text-neutral-700">
                  {post.cache.summary}
                </div>
              )}
              {post.cache?.error && (
                <div className="mt-4 font-mono text-xs text-red-700">{post.cache.error}</div>
              )}
              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                {post.tags.map((tag) => (
                  <span key={tag} className="border border-neutral-200 px-2 py-1 text-neutral-600">
                    {tag}
                  </span>
                ))}
              </div>
              {post.cache?.textPath && (
                <div className="mt-4 font-mono text-xs text-neutral-500">
                  cache: {post.cache.textPath}
                </div>
              )}
            </article>
          ))}
        </div>

        {posts.length === 0 && (
          <div className="mt-10 border border-dashed border-neutral-300 p-8 text-sm text-neutral-500">
            Save the first link here or load the Chrome extension from extensions/chrome-link-capture.
          </div>
        )}

        <section className="mt-8 grid gap-4 border-t border-neutral-200 pt-6 md:grid-cols-3">
          <div>
            <div className="font-mono text-xs uppercase text-neutral-500">browser</div>
            <p className="mt-2 text-sm text-neutral-700">Chrome captures active tabs and selected text into HII.</p>
          </div>
          <div>
            <div className="font-mono text-xs uppercase text-neutral-500">downloader</div>
            <p className="mt-2 text-sm text-neutral-700">The local cache agent writes HTML and readable text under .hii.</p>
          </div>
          <div>
            <div className="font-mono text-xs uppercase text-neutral-500">ollama</div>
            <p className="mt-2 text-sm text-neutral-700">Ollama summarizes cached pages for local recall without cloud inference.</p>
          </div>
        </section>
            </div>
    </div>
  );
}
