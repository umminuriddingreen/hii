import fetch from 'node-fetch';
import { duckduckgoSearch } from './duckduckgo.js';

type SerpResult = {
  title: string;
  link: string;
  snippet?: string;
};

export async function webSearch(query: string, provider?: 'serpapi' | 'duckduckgo'): Promise<string> {
  const selected = provider || (process.env.SERPAPI_KEY ? 'serpapi' : 'duckduckgo');
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
  if (!results.length) return 'No web results';
  return results.map((r, i) => `${i+1}. ${r.title}\n${r.link}\n${r.snippet ?? ''}`).join('\n\n');
}
