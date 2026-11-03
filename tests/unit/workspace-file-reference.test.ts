import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeNode, seedFromFile } from '@/lib/workspace/ingest';
import { workspaceNodeContextItem } from '@/lib/workspace/context-item';

describe('unrecognized file references', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stores an unrecognized LiDAR file and exposes its stable path to selected-object context', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      name: 'survey.laz', mime: 'application/octet-stream', size: 4,
      path: '/safe/assets/survey.laz', url: '/api/workspace/assets/survey.laz', sha256: 'abc'
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'survey.laz', { type: 'application/octet-stream' });
    const seed = await seedFromFile(file);
    const context = workspaceNodeContextItem(makeNode(seed, 0, 0, 1));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(seed.type).toBe('file');
    expect(seed.payload).toMatchObject({ path: '/safe/assets/survey.laz', metadataOnly: false, sha256: 'abc' });
    expect(context.source).toBe('/safe/assets/survey.laz');
    expect(context.expectedSha256).toBe('abc');
  });

  it('marks a failed asset write as details only without claiming a durable path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 413 })));
    const seed = await seedFromFile(new File(['data'], 'survey.las'));
    expect(seed.payload.metadataOnly).toBe(true);
    expect(seed.payload.path).toBeUndefined();
    expect(seed.object?.status).toBe('partial');
  });
});
