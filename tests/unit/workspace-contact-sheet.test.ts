import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedsFromFiles } from '../../lib/workspace/ingest';
import {
  contactSheetContextItems,
  contactSheetItemSeed,
  contactSheetStackItems,
  filterContactSheetItems,
  filterContactSheetStacks,
  labelContactSheetItems,
  normalizeContactSheetLabels,
  normalizeContactSheetSelection,
  normalizeContactSheetStacks,
  stackContactSheetSelection,
  unstackContactSheetItems
} from '../../lib/workspace/contact-sheet';

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

  it('stores a local perceptual signal when the image decoder is available', async () => {
    const decoded = vi.fn(async () => ({ close: vi.fn() }));
    const pixels = new Uint8ClampedArray(9 * 8 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const x = (offset / 4) % 9;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 255 - x * 20;
      pixels[offset + 3] = 255;
    }
    vi.stubGlobal('createImageBitmap', decoded);
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() {
        return { drawImage: vi.fn(), getImageData: () => ({ data: pixels }) };
      }
    });
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const file = (init?.body as FormData).get('file') as File;
      const sha256 = file.name.charCodeAt(0).toString(16).padStart(64, '0');
      return new Response(JSON.stringify({
        name: file.name,
        mime: file.type,
        size: file.size,
        path: `/project/${file.name}`,
        url: `/api/workspace/assets/${file.name}`,
        sha256
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const [sheet] = await seedsFromFiles(['a', 'b', 'c', 'd'].map((name) =>
      new File([name], `${name}.png`, { type: 'image/png' })
    ));
    expect(decoded).toHaveBeenCalledTimes(4);
    expect((sheet.payload.items as Array<Record<string, unknown>>).map((item) => item.perceptualHash)).toEqual([
      'ffffffffffffffff',
      'ffffffffffffffff',
      'ffffffffffffffff',
      'ffffffffffffffff'
    ]);
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

  it('keeps human batch labels durable, filterable, and exact in run context', () => {
    const items = Array.from({ length: 4 }, (_, index) => ({
      url: `/asset/${index}.png`, path: `/project/${index}.png`, name: `${index}-reference.png`,
      mime: 'image/png', size: 10, sha256: (index + 1).toString(16).padStart(64, '0')
    }));
    const selectedItems = [items[0], items[2]];
    const labels = labelContactSheetItems({
      items,
      labels: {
        [items[1].sha256]: 'material study',
        ['f'.repeat(64)]: 'unknown source'
      },
      selectedItems,
      label: 'facade rhythm'
    });

    expect(normalizeContactSheetLabels(items, labels)).toEqual({
      [items[0].sha256]: 'facade rhythm',
      [items[1].sha256]: 'material study',
      [items[2].sha256]: 'facade rhythm'
    });
    expect(filterContactSheetItems(items, labels, 'facade')).toEqual([items[0], items[2]]);
    expect(filterContactSheetItems(items, labels, 'material 1-reference')).toEqual([items[1]]);

    const context = contactSheetContextItems({
      nodeId: 'sheet',
      items,
      selectedItems: [items[2]],
      itemLabels: labels,
      proofRefs: ['import-receipt']
    });
    expect(context).toHaveLength(1);
    expect(context[0]).toMatchObject({
      title: 'facade rhythm',
      source: '/project/2.png',
      expectedSha256: '3'.padStart(64, '0'),
      excerpt: 'Human annotation: facade rhythm'
    });
  });

  it('collapses exact human-selected references into reversible duplicate-safe stacks', () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      url: `/asset/${index}.png`, path: `/project/${index}.png`, name: `${index}-reference.png`,
      mime: 'image/png', size: 10, sha256: (index + 1).toString(16).padStart(64, '0')
    }));
    const labels = {
      [items[0].sha256]: 'material palette',
      [items[1].sha256]: 'material palette'
    };
    const first = stackContactSheetSelection({
      items,
      labels,
      stacks: [],
      selectedItems: [items[0], items[1]],
      stackId: 'stack-materials'
    });
    expect(first).toEqual({
      created: true,
      stack: {
        id: 'stack-materials',
        title: 'material palette',
        sha256s: [items[0].sha256, items[1].sha256]
      },
      stacks: [{
        id: 'stack-materials',
        title: 'material palette',
        sha256s: [items[0].sha256, items[1].sha256]
      }]
    });
    expect(contactSheetStackItems(items, first.stack)).toEqual([items[0], items[1]]);
    expect(filterContactSheetStacks({ items, labels, stacks: first.stacks, query: '1-reference' })).toEqual(first.stacks);
    expect(stackContactSheetSelection({
      items,
      labels,
      stacks: first.stacks,
      selectedItems: [items[1], items[0]]
    })).toMatchObject({ created: false, stack: { id: 'stack-materials' } });
    expect(stackContactSheetSelection({
      items,
      labels,
      stacks: first.stacks,
      selectedItems: [items[0], items[1]],
      title: 'approved palette'
    })).toMatchObject({
      created: false,
      stack: { id: 'stack-materials', title: 'approved palette' },
      stacks: [{ id: 'stack-materials', title: 'approved palette' }]
    });

    const moved = stackContactSheetSelection({
      items,
      labels,
      stacks: first.stacks,
      selectedItems: [items[1], items[2]],
      title: 'alternate',
      stackId: 'stack-alternate'
    });
    expect(moved.stacks).toEqual([{
      id: 'stack-alternate',
      title: 'alternate',
      sha256s: [items[1].sha256, items[2].sha256]
    }]);
    expect(normalizeContactSheetStacks(items, [
      ...moved.stacks,
      { id: 'invalid', title: 'invalid overlap', sha256s: [items[2].sha256, items[3].sha256] },
      { id: 'stack-alternate', title: 'duplicate id', sha256s: [items[3].sha256, items[4].sha256] }
    ])).toEqual(moved.stacks);
    expect(unstackContactSheetItems(items, moved.stacks, 'stack-alternate')).toEqual([]);
  });

  it('promotes one durable thumbnail into a region-focusable child object', () => {
    const sha256 = 'a'.repeat(64);
    const seed = contactSheetItemSeed({
      url: '/api/workspace/assets/reference.png',
      path: '/project/reference.png',
      name: 'reference.png',
      mime: 'image/png',
      size: 1024,
      sha256
    }, 'sheet-one', 'facade rhythm');
    expect(seed).toMatchObject({
      type: 'image',
      object: {
        kind: 'asset',
        owner: 'human',
        status: 'ready',
        source: '/project/reference.png',
        parentId: 'sheet-one',
        proofRefs: [`sha256:${sha256}`]
      },
      payload: {
        adapter: 'contact-sheet-item',
        title: 'facade rhythm',
        path: '/project/reference.png',
        sha256,
        sourceContactSheetId: 'sheet-one'
      }
    });
  });
});
