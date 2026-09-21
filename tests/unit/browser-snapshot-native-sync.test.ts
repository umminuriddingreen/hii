import { webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decryptBrowserSnapshot } from '../../lib/web/browser-snapshot-crypto';
import type { LocalChatDevice } from '../../lib/web/chat-crypto';
import { shareCaptureToAccountWorkspace, syncBrowserCapture } from '../../scripts/hii-browser-snapshot-sync.mjs';

describe('native browser snapshot upload', () => {
  it('encrypts an indexed page before the linked-device upload', async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'hii-browser-snapshot-'));
    const previousRuntime = process.env.HII_RUNTIME_DIR;
    process.env.HII_RUNTIME_DIR = runtime;
    await mkdir(join(runtime, 'account'));
    const deviceId = 'a'.repeat(43);
    await writeFile(join(runtime, 'account', 'device.json'), JSON.stringify({ api: 'http://127.0.0.1:3000/api/device', deviceId, token: 'test-token' }));
    let publicDevice: Record<string, unknown> | null = null;
    let uploaded: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
      expect(options.headers).toMatchObject({ authorization: 'Bearer test-token' });
      if (url.endsWith('/keys')) {
        const body = JSON.parse(options.body as string);
        publicDevice = { id: deviceId, ecdhPublicJwk: body.ecdhPublicJwk, signingPublicJwk: body.signingPublicJwk };
        return new Response(JSON.stringify({ deviceId }), { status: 200 });
      }
      if (url.endsWith('/devices')) return new Response(JSON.stringify({ devices: [publicDevice] }), { status: 200 });
      uploaded = JSON.parse(options.body as string);
      return new Response(JSON.stringify({ id: uploaded?.id }), { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', webcrypto);
    try {
      const result = await syncBrowserCapture({
        capturedAt: '2026-09-14T00:00:00Z',
        source: { url: 'https://example.com/article', title: 'Article' },
        capture: { method: 'extension-action', browserName: 'Chrome' },
        content: { text: 'Visible rendered page content' },
      });
      expect(result.uploaded).toBe(true);
      expect(JSON.stringify(uploaded)).not.toContain('Visible rendered page content');
      const stored = JSON.parse(await readFile(join(runtime, 'browser-sync', 'device-keys.json'), 'utf8'));
      const ecdhPrivateKey = await webcrypto.subtle.importKey('jwk', stored.ecdhPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const local = { deviceId, ecdhPrivateKey } as LocalChatDevice;
      expect(await decryptBrowserSnapshot(uploaded as never, local)).toMatchObject({
        title: 'Article', content: 'Visible rendered page content', browser: 'Chrome',
      });
    } finally {
      vi.unstubAllGlobals();
      if (previousRuntime === undefined) delete process.env.HII_RUNTIME_DIR;
      else process.env.HII_RUNTIME_DIR = previousRuntime;
    }
  });

  it('adds an explicitly approved source link to the first writable account workspace', async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'hii-browser-account-share-'));
    const previousRuntime = process.env.HII_RUNTIME_DIR;
    process.env.HII_RUNTIME_DIR = runtime;
    await mkdir(join(runtime, 'account'));
    await writeFile(join(runtime, 'account', 'device.json'), JSON.stringify({
      api: 'http://127.0.0.1:3000/api/device', deviceId: 'a'.repeat(43), token: 'test-token',
    }));
    const workspaceId = 'w'.repeat(43);
    const document = { version: 1, revision: 4, updatedAt: '2026-09-14T00:00:00Z', viewport: { x: 0, y: 0, zoom: 1 }, nextZ: 1, nodes: [], links: [] };
    const fetchMock = vi.fn(async (url: string, options: RequestInit = {}) => {
      expect(options.headers).toMatchObject({ authorization: 'Bearer test-token' });
      if (url.endsWith('/workspaces')) return new Response(JSON.stringify({ workspaces: [{ id: workspaceId, role: 'owner' }] }));
      if (url.endsWith(`/workspaces/${workspaceId}`)) return new Response(JSON.stringify({ workspace: { id: workspaceId, revision: 4, document } }));
      const body = JSON.parse(options.body as string);
      expect(body.expectedRevision).toBe(4);
      expect(body.document.nodes[0]).toMatchObject({ type: 'link', payload: { title: 'Approved source', url: 'https://example.com/approved', note: 'Use this source' } });
      return new Response(JSON.stringify({ workspace: { id: workspaceId, revision: 5, document: body.document } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(shareCaptureToAccountWorkspace({
        captureId: 'capture-approved', capturedAt: '2026-09-14T00:00:00Z',
        source: { url: 'https://example.com/approved', title: 'Approved source' },
        capture: { method: 'extension-action', note: 'Use this source', tags: ['browser'] },
      }, { receiptId: 'receipt-approved' })).resolves.toMatchObject({ shared: true, workspaceId });
    } finally {
      vi.unstubAllGlobals();
      if (previousRuntime === undefined) delete process.env.HII_RUNTIME_DIR;
      else process.env.HII_RUNTIME_DIR = previousRuntime;
    }
  });
});
