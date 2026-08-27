import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Registry = {
  schemaVersion: number;
  kind: string;
  products: string[];
  classifications: string[];
  statuses: string[];
  features: Array<{
    id: string;
    name: string;
    classification: string;
    product: string;
    status: string;
  }>;
};

describe('HII feature registry', () => {
  const registry = parse(
    fs.readFileSync(path.join(process.cwd(), 'docs/HII_FEATURE_REGISTRY.yaml'), 'utf8')
  ) as Registry;

  it('keeps exactly three products over the shared Runtime', () => {
    expect(registry.schemaVersion).toBe(1);
    expect(registry.kind).toBe('hii.product.feature-registry');
    expect(registry.products).toEqual(['harness', 'space', 'network']);
  });

  it('classifies every remembered feature once with a known lifecycle state', () => {
    const ids = registry.features.map((feature) => feature.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(registry.features.length).toBeGreaterThanOrEqual(40);
    for (const feature of registry.features) {
      expect(feature.id).toMatch(/^[a-z0-9][a-z0-9.-]+$/);
      expect(feature.name.trim()).not.toBe('');
      expect(registry.products).toContain(feature.product);
      expect(registry.classifications).toContain(feature.classification);
      expect(registry.statuses).toContain(feature.status);
    }
  });

  it('keeps launch invariants and terminal/network slices visible', () => {
    const byId = new Map(registry.features.map((feature) => [feature.id, feature]));
    for (const id of [
      'runtime.object-graph',
      'runtime.authority',
      'runtime.verification',
      'space.canvas',
      'space.terminal',
      'network.live-reference',
      'network.direct-relay'
    ]) {
      expect(byId.get(id)?.status).toBe('now');
    }
  });
});
