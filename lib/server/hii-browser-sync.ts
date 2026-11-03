import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimeRoot } from './runtime-root.ts';

export type SyncRecord = {
  id: string;
  modifiedAt: number;
  deleted?: boolean;
  value?: unknown;
};

export type SyncCollection = 'bookmarks' | 'history' | 'tabs' | 'vault';

type SyncDocument = {
  version: 1;
  revision: number;
  updatedAt: string;
  collections: Record<SyncCollection, Record<string, SyncRecord>>;
};

const collections: SyncCollection[] = ['bookmarks', 'history', 'tabs', 'vault'];
let writeQueue: Promise<void> = Promise.resolve();
const empty = (): SyncDocument => ({
  version: 1,
  revision: 0,
  updatedAt: new Date(0).toISOString(),
  collections: { bookmarks: {}, history: {}, tabs: {}, vault: {} }
});

function runtimeDir() {
  return runtimeRoot();
}

function keyId(secret: string) {
  if (secret.length < 20 || secret.length > 512) throw new Error('Sync key must be 20 to 512 characters.');
  return createHash('sha256').update(secret).digest('hex');
}

function location(secret: string) {
  return path.join(runtimeDir(), 'browser-sync', `${keyId(secret)}.json`);
}

function validRecord(value: unknown): value is SyncRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SyncRecord>;
  return typeof record.id === 'string' && record.id.length > 0 && record.id.length <= 256
    && Number.isSafeInteger(record.modifiedAt) && Number(record.modifiedAt) >= 0;
}

async function load(secret: string): Promise<SyncDocument> {
  try {
    const parsed = JSON.parse(await readFile(location(secret), 'utf8')) as SyncDocument;
    return parsed.version === 1 && parsed.collections ? parsed : empty();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    throw error;
  }
}

export async function readBrowserSync(secret: string) {
  return load(secret);
}

export async function mergeBrowserSync(
  secret: string,
  updates: Partial<Record<SyncCollection, unknown[]>>
) {
  const previous = writeQueue;
  let release = () => {};
  writeQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
  const document = await load(secret);
  for (const collection of collections) {
    const incoming = updates[collection];
    if (incoming === undefined) continue;
    if (!Array.isArray(incoming) || incoming.length > 10_000) throw new Error(`Invalid ${collection} records.`);
    for (const candidate of incoming) {
      if (!validRecord(candidate)) throw new Error(`Invalid ${collection} record.`);
      const current = document.collections[collection][candidate.id];
      if (!current || candidate.modifiedAt > current.modifiedAt
        || (candidate.modifiedAt === current.modifiedAt && JSON.stringify(candidate) > JSON.stringify(current))) {
        document.collections[collection][candidate.id] = candidate;
      }
    }
  }
  document.revision += 1;
  document.updatedAt = new Date().toISOString();
  const file = location(secret);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return document;
  } finally {
    release();
  }
}
