import { describe, expect, it, vi } from 'vitest';
import { loadRuntimeCatalog, normalizeRuntimeCatalog } from '@/components/ecosystem/runtime-catalog';

const resource = {
  id: 'windows-pc',
  kind: 'device',
  name: 'windows-pc',
  detail: 'windows · enrolled',
  status: 'unknown',
  nodeId: 'windows-pc',
  sourceRef: 'hii-runtime://systems/windows-pc',
  objectRef: { authority: 'hii-runtime', id: 'windows-pc', kind: 'device' }
};

describe('CLI-owned ecosystem runtime catalog adapter', () => {
  it('normalizes a bounded CLI catalog without copying runtime authority', () => {
    expect(normalizeRuntimeCatalog({ schemaVersion: 1, kind: 'hii.ecosystem.catalog', authority: 'hii-runtime', resources: [resource] }).resources[0]).toEqual(resource);
  });

  it('rejects unsupported authority and oversized catalogs', () => {
    expect(() => normalizeRuntimeCatalog({ schemaVersion: 1, kind: 'hii.ecosystem.catalog', authority: 'cloud', resources: [] })).toThrow(/unsupported/);
    expect(() => normalizeRuntimeCatalog({ schemaVersion: 1, kind: 'hii.ecosystem.catalog', authority: 'hii-runtime', resources: Array(129).fill(resource) })).toThrow(/oversized/);
  });

  it('drops malformed projections and sorts valid references deterministically', () => {
    const catalog = normalizeRuntimeCatalog({
      schemaVersion: 1,
      kind: 'hii.ecosystem.catalog',
      authority: 'hii-runtime',
      resources: [
        { ...resource, id: 'bad/id', objectRef: { ...resource.objectRef, id: 'bad/id' } },
        resource,
        { ...resource, id: 'a-cap', kind: 'capability', name: 'A', sourceRef: 'hii-runtime://ecosystem/workflows/a-cap', objectRef: { authority: 'hii-runtime', id: 'a-cap', kind: 'capability' } }
      ]
    });
    expect(catalog.resources.map(({ kind, id }) => `${kind}:${id}`)).toEqual(['capability:a-cap', 'device:windows-pc']);
  });

  it('fails closed in a normal browser and invokes only the fixed Tauri command', async () => {
    await expect(loadRuntimeCatalog({ isTauri: false })).resolves.toMatchObject({ resources: [] });
    const invoke = vi.fn(async () => ({ schemaVersion: 1, kind: 'hii.ecosystem.catalog', authority: 'hii-runtime', resources: [resource] }));
    await expect(loadRuntimeCatalog({ isTauri: true, invoke })).resolves.toMatchObject({ resources: [resource] });
    expect(invoke).toHaveBeenCalledWith('ecosystem_catalog');
  });
});
