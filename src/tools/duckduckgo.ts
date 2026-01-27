import fetch from 'node-fetch';

export async function duckduckgoSearch(query: string, count = 5): Promise<string> {
  const params = new URLSearchParams({ q: query, kl: 'us-en' });
  const url = `https://html.duckduckgo.com/html/?${params.toString()}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'hii-cli/0.1 (+https://github.com/umminuriddingreen/hii)' } });
  if (!res.ok) return `DuckDuckGo error: ${res.status}`;
  const html = await res.text();
  const items: { title: string; link: string }[] = [];
  const regex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gms;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) && items.length < count) {
    const link = m[1].replace(/&amp;/g, '&');
    const title = m[2].replace(/<[^>]+>/g, '');
    items.push({ title, link });
  }
  if (!items.length) return 'No web results';
  return items.map((r, i) => `${i + 1}. ${r.title}\n${r.link}`).join('\n\n');
}

