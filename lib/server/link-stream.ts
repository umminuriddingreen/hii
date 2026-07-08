import 'server-only';
import { randomUUID } from 'crypto';
import { appendFile, mkdir, readFile } from 'fs/promises';
import path from 'path';

export type LinkStreamPost = {
  id: string;
  url: string;
  title: string;
  note: string;
  tags: string[];
  source: string;
  createdAt: string;
};

export type LinkCacheEntry = {
  id: string;
  postId: string;
  url: string;
  status: 'cached' | 'failed';
  htmlPath?: string;
  textPath?: string;
  summary?: string;
  error?: string;
  cachedAt: string;
};

const storeDir = path.join(process.cwd(), '.hii');
const storePath = path.join(storeDir, 'link-posts.jsonl');
const cacheIndexPath = path.join(storeDir, 'link-cache.jsonl');

const seedPosts: LinkStreamPost[] = [
  {
    id: 'seed-hii-runner-proof',
    url: '/termite',
    title: 'Durable HII runner proof',
    note: 'A paid Termite capability job was quoted, reserved, claimed by a local runner, completed, and returned ledger/proof artifacts.',
    tags: ['hii', 'proof', 'termite'],
    source: 'local proof',
    createdAt: '2026-07-05T10:17:19.662Z'
  },
  {
    id: 'seed-capability-terminal',
    url: '/console',
    title: 'HII Console',
    note: 'The power surface shows processes, capabilities, jobs, console sessions, and proof receipts from one local command layer.',
    tags: ['agent-os', 'console'],
    source: 'hii',
    createdAt: '2026-07-05T09:44:07.595Z'
  },
  {
    id: 'seed-exchange-spine',
    url: '/upload',
    title: 'Exchange spine',
    note: 'The older asset flow still supports upload, exchange links, Stripe checkout, signed downloads, and download proof.',
    tags: ['exchange', 'links'],
    source: 'hii',
    createdAt: '2026-06-30T09:16:31.000Z'
  }
];

function normalizeUrl(value: string) {
  const url = value.trim();
  if (!url) throw new Error('A URL is required.');
  if (url.startsWith('/')) return url;
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https links are supported.');
  return parsed.toString();
}

function parseTags(value: string) {
  return value
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 6);
}

export async function createLinkPost(formData: FormData) {
  const url = normalizeUrl(String(formData.get('url') ?? ''));
  const title = String(formData.get('title') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();
  const source = String(formData.get('source') ?? '').trim() || 'manual';
  const tags = parseTags(String(formData.get('tags') ?? ''));

  if (title.length < 3) throw new Error('Give the link a short title.');
  if (title.length > 120) throw new Error('Keep titles under 120 characters.');
  if (note.length > 500) throw new Error('Keep notes under 500 characters.');

  await mkdir(storeDir, { recursive: true });
  const post: LinkStreamPost = {
    id: randomUUID(),
    url,
    title,
    note,
    tags,
    source,
    createdAt: new Date().toISOString()
  };
  await appendFile(storePath, `${JSON.stringify(post)}\n`, 'utf8');
  return post;
}

export async function createLinkPostFromInput(input: {
  url: string;
  title: string;
  note?: string;
  tags?: string[] | string;
  source?: string;
}) {
  const formData = new FormData();
  formData.set('url', input.url);
  formData.set('title', input.title);
  formData.set('note', input.note ?? '');
  formData.set('source', input.source ?? 'extension');
  formData.set('tags', Array.isArray(input.tags) ? input.tags.join(',') : input.tags ?? '');
  return createLinkPost(formData);
}

export async function listLinkPosts(limit = 40) {
  let posts: LinkStreamPost[] = [];
  try {
    const raw = await readFile(storePath, 'utf8');
    posts = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LinkStreamPost);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  return [...posts, ...seedPosts]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export async function listLinkCacheEntries() {
  try {
    const raw = await readFile(cacheIndexPath, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LinkCacheEntry)
      .sort((a, b) => b.cachedAt.localeCompare(a.cachedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function listLinkPostsWithCache(limit = 40) {
  const [posts, cacheEntries] = await Promise.all([listLinkPosts(limit), listLinkCacheEntries()]);
  const latestCacheByPost = new Map<string, LinkCacheEntry>();
  for (const entry of cacheEntries) {
    if (!latestCacheByPost.has(entry.postId)) latestCacheByPost.set(entry.postId, entry);
  }
  return posts.map((post) => ({
    ...post,
    cache: latestCacheByPost.get(post.id) ?? null
  }));
}
