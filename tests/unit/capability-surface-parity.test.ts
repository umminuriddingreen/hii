import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitySurfaces, surfaceForCapability } from '../../lib/capabilities/surfaces';
import type { CapabilityDefinition } from '../../lib/capabilities/types';

const root = process.cwd();
const registry = JSON.parse(
  readFileSync(resolve(root, 'aii/capabilities/registry.json'), 'utf8')
) as CapabilityDefinition[];

describe('capability surface parity', () => {
  it('gives every registered capability a reachable app surface', () => {
    const missing = registry
      .map((capability) => capability.id)
      .filter((id) => !surfaceForCapability(id));
    expect(missing).toEqual([]);
  });

  it('only points capabilities at routes the app ships', () => {
    const routeFiles: Record<string, string> = {
      '/': 'src/routes/+page.svelte',
      '/workspace': 'src/routes/workspace/+page.svelte',
      '/activate': 'src/routes/(app)/activate/+page.svelte',
      '/boards': 'src/routes/(app)/boards/+page.svelte',
      '/browser': 'src/routes/(app)/browser/+page.svelte',
      '/console': 'src/routes/(app)/console/+page.svelte',
      '/create': 'src/routes/(app)/create/+page.svelte',
      '/knowledge': 'src/routes/(workspace)/knowledge/+page.svelte',
      '/notch': 'src/routes/notch/+page.svelte'
    };
    for (const surface of Object.values(capabilitySurfaces)) {
      expect(routeFiles[surface.href], `route mapping for ${surface.href}`).toBeTruthy();
      expect(readFileSync(resolve(root, routeFiles[surface.href]), 'utf8')).toBeTruthy();
    }
  });

  it('does not expose the removed feed route in the command bar', () => {
    const commandBar = readFileSync(resolve(root, 'components/workspace/CommandBar.tsx'), 'utf8');
    expect(commandBar).not.toContain("location.href = '/feed'");
    expect(commandBar).toContain("fetch('/api/capabilities'");
  });
});
