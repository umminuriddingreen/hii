import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchResult = { title: string; url: string; description: string };

export async function GET(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'local-only' }, { status: 403 });
  }
  const q = new URL(request.url).searchParams.get('q')?.trim();
  if (!q) return NextResponse.json({ error: 'q required' }, { status: 400 });
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: 'set BRAVE_SEARCH_API_KEY in .env.local to enable web search' },
      { status: 501 }
    );
  }
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=8`,
      {
        headers: { accept: 'application/json', 'x-subscription-token': key },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!res.ok) {
      return NextResponse.json({ error: `search failed (${res.status})` }, { status: 502 });
    }
    const data = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    const results: SearchResult[] = (data.web?.results ?? [])
      .filter((r) => r.url && r.title)
      .map((r) => ({
        title: String(r.title),
        url: String(r.url),
        description: String(r.description ?? '').replace(/<[^>]+>/g, '')
      }));
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ error: 'search timed out' }, { status: 504 });
  }
}
