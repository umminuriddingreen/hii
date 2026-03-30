import fetch from 'node-fetch';
import { duckduckgoSearch } from './duckduckgo.js';

type SerpResult = {
  title: string;
  link: string;
  snippet?: string;
};

type SearchProvider = 'searxng' | 'serpapi' | 'duckduckgo';

const DEFAULT_SEARXNG_URL = process.env.SEARXNG_URL || 'http://127.0.0.1:8888';

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatResults(results: SerpResult[]): string {
  if (!results.length) return 'No web results';
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n${r.link}\n${r.snippet ?? ''}`.trim())
    .join('\n\n');
}

async function searxngSearch(query: string, count = 5): Promise<string> {
  try {
    const body = new URLSearchParams({
      q: query,
      language: 'auto',
      safesearch: '0',
      category_general: '1',
    });
    const res = await fetch(`${DEFAULT_SEARXNG_URL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'hii-cli/0.1',
      },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`SearxNG error: ${res.status}`);
    const html = await res.text();
    const results: SerpResult[] = [];
    const regex = /<article[^>]*class="[^"]*result[^"]*"[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/p>)?/gmi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) && results.length < count) {
      const link = match[1];
      const title = stripHtml(match[2] || '');
      const snippet = stripHtml(match[3] || '');
      if (!title || !link) continue;
      results.push({ title, link, snippet });
    }
    return formatResults(results);
  } catch (error: any) {
    return `SearxNG error: ${error?.message || String(error)}`;
  }
}

export async function webSearch(query: string, provider?: SearchProvider): Promise<string> {
  const selected: SearchProvider = provider || (process.env.SEARXNG_URL || DEFAULT_SEARXNG_URL ? 'searxng' : process.env.SERPAPI_KEY ? 'serpapi' : 'duckduckgo');
  if (selected === 'searxng') {
    const result = await searxngSearch(query, 5);
    if (!result.startsWith('SearxNG error:')) return result;
    if (process.env.SERPAPI_KEY) return webSearch(query, 'serpapi');
    return duckduckgoSearch(query, 5);
  }
  if (selected === 'duckduckgo') return duckduckgoSearch(query, 5);
  const key = process.env.SERPAPI_KEY;
  if (!key) return duckduckgoSearch(query, 5);
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('num', '5');
  url.searchParams.set('api_key', key);
  const res = await fetch(url.toString());
  if (!res.ok) return `Web search error: ${res.status} ${await res.text()}`;
  const data: any = await res.json();
  const results: SerpResult[] = (data.organic_results || []).slice(0, 5).map((r: any) => ({
    title: r.title,
    link: r.link,
    snippet: r.snippet
  }));
  return formatResults(results);
}
