import { afterEach, describe, expect, it, vi } from 'vitest';
import { storeWorkspaceAsset } from '@/lib/workspace/ingest';

describe('Space image upload contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the camera image to the T4 Space endpoint and uses its stable URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      name: 'blob.webp', mime: 'image/webp', size: 4, path: '/safe/blob.webp',
      url: '/api/spaces/place/blobs/blob.webp', sha256: 'abc', width: 20, height: 10
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'camera.jpg', { type: 'image/jpeg' });
    const stored = await storeWorkspaceAsset(file, { spaceId: 'place' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/spaces/place/blobs');
    expect(stored?.url).toBe('/api/spaces/place/blobs/blob.webp');
    expect(stored).toMatchObject({ width: 20, height: 10, sha256: 'abc' });
  });
});
