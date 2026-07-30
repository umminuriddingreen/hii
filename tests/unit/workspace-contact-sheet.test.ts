import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedsFromFiles } from '../../lib/workspace/ingest';
import { contactSheetContextItems, normalizeContactSheetSelection } from '../../lib/workspace/contact-sheet';

afterEach(() => vi.unstubAllGlobals());

describe('workspace contact-sheet import', () => {
  it('groups image batches, omits exact duplicates, and keeps durable source proof', async () => {
    const store = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const file = (init?.body as FormData).get('file') as File;
      return new Response(JSON.stringify({
        name: file.name,
        mime: file.type,
        size: file.size,
        path: `/Users/ummi/.hii/workspace/assets/${file.name}`,
        url: `/api/workspace/assets/${file.name}`,
        sha256: `stored-${file.name}`
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', store);

    const seeds = await seedsFromFiles([
      new File(['same pixels'], 'reference-a.png', { type: 'image/png' }),
      new File(['same pixels'], 'reference-a-copy.png', { type: 'image/png' }),
      new File(['pixels-b'], 'reference-b.png', { type: 'image/png' }),
      new File(['pixels-c'], 'reference-c.png', { type: 'image/png' }),
      new File(['pixels-d'], 'reference-d.png', { type: 'image/png' })
    ]);

    expect(store).toHaveBeenCalledTimes(4);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      type: 'image',
      w: 760,
      h: 560,
      object: {
        kind: 'asset',
        owner: 'human',
        status: 'ready',
        capabilityId: 'hii.workspace.creative_canvas'
      },
      payload: {
        adapter: 'contact-sheet',
        uniqueCount: 4,
        duplicateCount: 1,
        duplicateNames: ['reference-a-copy.png']
      }
    });
    expect(seeds[0].payload.items).toHaveLength(4);
    expect(seeds[0].object?.proofRefs).toHaveLength(4);
  });

  it('keeps small image imports as directly manipulable individual nodes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const seeds = await seedsFromFiles([
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' })
    ]);
    expect(seeds).toHaveLength(2);
    expect(seeds.every((seed) => seed.type === 'image' && seed.payload.adapter !== 'contact-sheet')).toBe(true);
  });

  it('bounds a 164-image import into sheets without dropping a unique source', async () => {
    const store = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const file = (init?.body as FormData).get('file') as File;
      return new Response(JSON.stringify({
        name: file.name,
        mime: file.type,
        size: file.size,
        path: `/Users/ummi/.hii/workspace/assets/${file.name}`,
        url: `/api/workspace/assets/${file.name}`,
        sha256: `stored-${file.name}`
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', store);
    const files = Array.from({ length: 164 }, (_, index) =>
      new File([`unique pixels ${index}`], `reference-${index}.png`, { type: 'image/png' })
    );

    const sheets = await seedsFromFiles(files);
    expect(sheets).toHaveLength(3);
    expect(sheets.map((sheet) => (sheet.payload.items as unknown[]).length)).toEqual([80, 80, 4]);
    expect(sheets.reduce((total, sheet) => total + Number(sheet.payload.uniqueCount), 0)).toBe(164);
    expect(store).toHaveBeenCalledTimes(164);
  });

  it('promotes only exact selected thumbnails into separately hashed run context', () => {
    const items = Array.from({ length: 14 }, (_, index) => ({
      url: `/asset/${index}.png`, path: `/project/${index}.png`, name: `${index}.png`,
      mime: 'image/png', size: 10, sha256: (index + 1).toString(16).padStart(64, '0')
    }));
    const selectedItems = items.map((item, index) => ({ ...item, label: index === 2 ? 'facade rhythm' : '' }));
    expect(normalizeContactSheetSelection(items, selectedItems)).toHaveLength(12);
    const context = contactSheetContextItems({ nodeId: 'sheet', items, selectedItems, proofRefs: ['import-receipt'] });
    expect(context).toHaveLength(12);
    expect(context[2]).toMatchObject({
      title: 'facade rhythm',
      source: '/project/2.png',
      expectedSha256: '3'.padStart(64, '0'),
      excerpt: 'Human annotation: facade rhythm'
    });
    expect(context[2].proofRefs).toContain(`sha256:${'3'.padStart(64, '0')}`);
    expect(context.some((item) => item.source === '/project/13.png')).toBe(false);
  });
});
