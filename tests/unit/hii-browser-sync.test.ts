// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
let runtimeDir = '';
const key = 'correct horse battery staple';

beforeEach(async () => { runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-browser-sync-')); process.env.HII_RUNTIME_DIR = runtimeDir; vi.resetModules(); });
afterEach(async () => { delete process.env.HII_RUNTIME_DIR; await rm(runtimeDir, { recursive: true, force: true }); });

describe('HII browser sync', () => {
  it('rejects non-local requests and weak keys', async () => {
    const route = await import('../../app/api/browser-sync/route');
    expect((await route.GET(new Request('http://example.com/api/browser-sync'))).status).toBe(403);
    const weak = await route.GET(new Request('http://127.0.0.1:3000/api/browser-sync', { headers: { 'x-hii-sync-key': 'short' } }));
    expect(weak.status).toBe(400);
  });

  it('merges records deterministically and persists only a key hash', async () => {
    const route = await import('../../app/api/browser-sync/route');
    const request = (collections: unknown) => new Request('http://127.0.0.1:3000/api/browser-sync', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hii-sync-key': key }, body: JSON.stringify({ collections }) });
    await route.POST(request({ bookmarks: [{ id: 'https://hii.local', modifiedAt: 2, value: { title: 'new' } }] }));
    await route.POST(request({ bookmarks: [{ id: 'https://hii.local', modifiedAt: 1, value: { title: 'old' } }] }));
    const response = await route.GET(new Request('http://127.0.0.1:3000/api/browser-sync', { headers: { 'x-hii-sync-key': key } }));
    const data = await response.json();
    expect(data.collections.bookmarks['https://hii.local'].value.title).toBe('new');
    const files = await import('node:fs/promises').then((fs) => fs.readdir(path.join(runtimeDir, 'browser-sync')));
    const stored = await readFile(path.join(runtimeDir, 'browser-sync', files[0]), 'utf8');
    expect(stored).not.toContain(key);
  });

  it('serializes simultaneous updates without dropping either browser', async () => {
    const store = await import('../../lib/server/hii-browser-sync');
    await Promise.all([
      store.mergeBrowserSync(key, { bookmarks: [{ id: 'helium', modifiedAt: 1, value: { url: 'https://helium.computer' } }] }),
      store.mergeBrowserSync(key, { bookmarks: [{ id: 'chrome', modifiedAt: 1, value: { url: 'https://google.com/chrome' } }] })
    ]);
    const document = await store.readBrowserSync(key);
    expect(Object.keys(document.collections.bookmarks).sort()).toEqual(['chrome', 'helium']);
  });
});
