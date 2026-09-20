import { webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decryptBrowserSnapshot } from '../../lib/web/browser-snapshot-crypto';
import type { LocalChatDevice } from '../../lib/web/chat-crypto';
import { syncIndexedCapture } from '../../scripts/hii-browser-snapshot-sync.mjs';

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
      const result = await syncIndexedCapture({
        capturedAt: '2026-09-14T00:00:00Z',
        source: { url: 'https://example.com/article', title: 'Article' },
        capture: { method: 'extension-page-index', browserName: 'Helium' },
        content: { text: 'Visible rendered page content' },
      });
      expect(result.uploaded).toBe(true);
      expect(JSON.stringify(uploaded)).not.toContain('Visible rendered page content');
      const stored = JSON.parse(await readFile(join(runtime, 'browser-sync', 'device-keys.json'), 'utf8'));
      const ecdhPrivateKey = await webcrypto.subtle.importKey('jwk', stored.ecdhPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const local = { deviceId, ecdhPrivateKey } as LocalChatDevice;
      expect(await decryptBrowserSnapshot(uploaded as never, local)).toMatchObject({
        title: 'Article', content: 'Visible rendered page content', browser: 'Helium',
      });
    } finally {
      vi.unstubAllGlobals();
      if (previousRuntime === undefined) delete process.env.HII_RUNTIME_DIR;
      else process.env.HII_RUNTIME_DIR = previousRuntime;
    }
  });
});
