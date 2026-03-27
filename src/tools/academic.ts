import fetch from 'node-fetch';

export type AcademicItem = {
  source: 'arxiv' | 'openalex' | 'crossref';
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  url: string;
  abstract?: string;
  id: string;
};

function dedupe(items: AcademicItem[]): AcademicItem[] {
  const seen = new Map<string, AcademicItem>();
  for (const it of items) {
    const key = (it.doi || it.id || `${it.title}|${it.authors.slice(0,2).join(',')}`).toLowerCase();
    if (!seen.has(key)) seen.set(key, it);
  }
  return Array.from(seen.values());
}

async function searchArxiv(query: string, max = 5): Promise<AcademicItem[]> {
  const url = new URL('http://export.arxiv.org/api/query');
  url.searchParams.set('search_query', `all:${query}`);
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(max));
  const res = await fetch(url.toString(), { headers: { 'User-Agent': 'hii-cli/0.1' } });
  if (!res.ok) return [];
  const xml = await res.text();
  const entries = xml.split('<entry>').slice(1);
  const items: AcademicItem[] = entries.map((chunk) => {
    const title = (chunk.match(/<title>([\s\S]*?)<\/title>/) || [,''])[1].replace(/\s+/g, ' ').trim();
    const abstract = (chunk.match(/<summary>([\s\S]*?)<\/summary>/) || [,''])[1].replace(/\s+/g, ' ').trim();
    const id = (chunk.match(/<id>([\s\S]*?)<\/id>/) || [,''])[1].trim();
    const year = parseInt((chunk.match(/<published>(\d{4})-/) || [,''])[1]) || undefined;
    const authors = Array.from(chunk.matchAll(/<name>([\s\S]*?)<\/name>/g)).map(m => m[1].trim());
    const url = (chunk.match(/<link rel="alternate" type="text\/html" href="([^"]+)"\/?/ ) || [,''])[1] || id;
    return { source: 'arxiv', title, abstract, id, authors, year, url };
  });
  return items;
}

async function searchOpenAlex(query: string, max = 5): Promise<AcademicItem[]> {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', query);
  url.searchParams.set('per-page', String(max));
  url.searchParams.set('mailto', 'hii-cli@example.com');
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const data = await res.json() as any;
  const items: AcademicItem[] = (data.results || []).map((w: any) => {
    const abstractIndex = w.abstract_inverted_index as Record<string, number[]> | undefined;
    const abstract = abstractIndex
      ? Object.entries(abstractIndex)
        .sort((a, b) => (a[1]?.[0] ?? 0) - (b[1]?.[0] ?? 0))
        .map(([word]) => word)
        .join(' ')
      : undefined;
    return {
      source: 'openalex',
      id: w.id,
      title: w.title,
      authors: (w.authorships || []).map((a: any) => a.author?.display_name).filter(Boolean),
      year: w.publication_year,
      venue: w.host_venue?.display_name,
      doi: w.doi,
      url: w.open_access?.oa_url || w.host_venue?.url || w.doi || w.id,
      abstract,
    };
  });
  return items;
}

async function searchCrossref(query: string, max = 5): Promise<AcademicItem[]> {
  const url = new URL('https://api.crossref.org/works');
  url.searchParams.set('query', query);
  url.searchParams.set('rows', String(max));
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const data = await res.json() as any;
  const items: AcademicItem[] = (data.message?.items || []).map((it: any) => ({
    source: 'crossref',
    id: it.DOI || it.URL,
    title: Array.isArray(it.title) ? it.title[0] : it.title,
    authors: (it.author || []).map((a: any) => [a.given, a.family].filter(Boolean).join(' ')),
    year: (it.issued?.['date-parts']?.[0]?.[0]) || undefined,
    venue: it['container-title']?.[0],
    doi: it.DOI,
    url: it.URL || (it.DOI ? `https://doi.org/${it.DOI}` : ''),
    abstract: typeof it.abstract === 'string' ? it.abstract.replace(/<[^>]+>/g, '') : undefined,
  }));
  return items;
}

export async function academicSearch(query: string, max = 10): Promise<AcademicItem[]> {
  const [a, o, c] = await Promise.all([
    searchArxiv(query, Math.min(5, max)),
    searchOpenAlex(query, Math.min(5, max)),
    searchCrossref(query, Math.min(5, max)),
  ]);
  return dedupe([...a, ...o, ...c]).slice(0, max);
}

export function formatAcademic(items: AcademicItem[]): string {
  if (!items.length) return 'No scholarly results';
  return items.map((it, i) => {
    const authors = it.authors.slice(0, 5).join(', ');
    const tail = it.authors.length > 5 ? ' et al.' : '';
    const venue = it.venue ? ` ${it.venue}` : '';
    const year = it.year ? ` (${it.year})` : '';
    const doi = it.doi ? ` DOI: ${it.doi}` : '';
    const src = `[${it.source}]`;
    return `${i + 1}. ${it.title}${year}${venue}\n${authors}${tail}\n${src} ${it.url}${doi}\n${it.abstract ? it.abstract.slice(0, 400) + (it.abstract.length > 400 ? '…' : '') : ''}`;
  }).join('\n\n');
}
