// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { ensureLocalChatDevice } from './chat-crypto';
import { pullBrowserSnapshots } from './browser-snapshot-sync';
import type { BrowserSnapshot } from './browser-snapshot-crypto';

const DATABASE = 'hii-browser-snapshots-v1';
const STORE = 'pages';
const META = 'meta';
const MAX_PAGES_PER_REFRESH = 10;
let refreshPromise: Promise<void> | null = null;
let lastRefresh = 0;

type StoredPage = { id: string; accountId: string; sourceId: string; snapshot: BrowserSnapshot };

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'id' });
      request.result.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('browser_snapshot_index_unavailable'));
  });
}

function read<T>(database: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error ?? new Error('browser_snapshot_index_unavailable'));
  });
}

function allPages(database: IDBDatabase): Promise<StoredPage[]> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as StoredPage[]);
    request.onerror = () => reject(request.error ?? new Error('browser_snapshot_index_unavailable'));
  });
}

async function session() {
  const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
  const value = await response.json() as { authenticated?: boolean; accountId?: string; csrfToken?: string };
  if (!response.ok || !value.authenticated || !value.accountId || !value.csrfToken) return null;
  return { accountId: value.accountId, csrfToken: value.csrfToken };
}

async function refreshIndex() {
  const identity = await session();
  if (!identity) return;
  const device = await ensureLocalChatDevice(identity.accountId, async (keys) => {
    const response = await fetch('/api/chat/devices', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-hii-csrf': identity.csrfToken },
      body: JSON.stringify(keys),
    });
    const value = await response.json() as { deviceId?: string; error?: string };
    if (!response.ok || !value.deviceId) throw new Error(value.error || 'browser_snapshot_device_required');
    return { deviceId: value.deviceId };
  });
  const database = await openDatabase();
  try {
    const key = `cursor:${identity.accountId}`;
    let cursor = await read<number>(database, META, key) ?? 0;
    for (let page = 0; page < MAX_PAGES_PER_REFRESH; page += 1) {
      const { changes, next } = await pullBrowserSnapshots(cursor, device);
      const transaction = database.transaction([STORE, META], 'readwrite');
      for (const { change, snapshot } of changes) {
        if (change.deletedAt !== null) transaction.objectStore(STORE).delete(change.id);
        else if (snapshot) transaction.objectStore(STORE).put({ id: change.id, accountId: identity.accountId, sourceId: change.sourceId, snapshot } satisfies StoredPage);
      }
      transaction.objectStore(META).put(next, key);
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('browser_snapshot_index_unavailable'));
      });
      if (next <= cursor || changes.length < 100) break;
      cursor = next;
    }
  } finally { database.close(); }
}

export async function searchSyncedBrowserSnapshots(query: string, limit = 20) {
  const identity = await session();
  if (!identity) return [];
  if (Date.now() - lastRefresh > 60_000 && !refreshPromise) {
    refreshPromise = refreshIndex().finally(() => { refreshPromise = null; lastRefresh = Date.now(); });
  }
  await refreshPromise;
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const database = await openDatabase();
  try {
    const pages = await allPages(database);
    return pages.filter(({ accountId, snapshot }) => accountId === identity.accountId && terms.every((term) => `${snapshot.title} ${snapshot.content}`.toLocaleLowerCase().includes(term)))
      .sort((a, b) => b.snapshot.capturedAt.localeCompare(a.snapshot.capturedAt))
      .slice(0, limit)
      .map(({ id, snapshot }) => ({
        id: `browser-snapshot:${id}`, versionId: id, browserName: snapshot.browser,
        url: snapshot.url, title: snapshot.title,
        excerpt: snapshot.content.slice(0, 360), siteName: new URL(snapshot.url).hostname,
        capturedAt: snapshot.capturedAt,
      }));
  } finally { database.close(); }
}
