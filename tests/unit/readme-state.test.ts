import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STATE_BEGIN,
  STATE_END,
  renderStateBlock,
  snapshotFromObservations,
  stateFingerprint,
  synchronizeReadme
} from '../../scripts/hii-readme-state.mjs';

const root = path.resolve(import.meta.dirname, '../..');

function fixture(overrides: Record<string, unknown> = {}) {
  return snapshotFromObservations({
    home: {
      identity: { repo: '/work/hii', runtime: '/runtime/hii' },
      workspace: { branch: 'main' },
      context: {
        knowledge: { exists: true },
        skills: { hii: { indexed: 12 } }
      },
      capabilities: [
        { id: 'one', status: 'ready' },
        { id: 'two', status: 'ready' },
        { id: 'three', status: 'partial' }
      ]
    },
    version: 'hii 0.1.0',
    help: '  --max-steps <MAX_STEPS>\n      Optional ceiling [default: 60]',
    models: 'model-a available\nmodel-b default',
    presence: {
      model: { state: 'reachable', configuredModel: 'model-b' },
      supervisor: { state: 'stopped', liveExecutors: 0, managedInstances: 4 }
    },
    systems: {
      systems: [{ id: 'pc', os: 'windows', status: 'pending-agent', transport: 'tailscale-ssh' }]
    },
    space: 'HII Space\nstate: ready\ndetail: AeroSpace workspace features are offline.',
    health: 'env:\n  MISSING  A_KEY\n  OK       B_KEY',
    resolvedHii: '/bin/hii',
    ...overrides
  });
}

function readme(block: string) {
  return `# HII\n\n## Reality Snapshot\n\n${block}\n\n## What Exists Today\n`;
}

describe('generated README state', () => {
  it('is part of product CI and refreshes before hii ship validates', () => {
    const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const cli = readFileSync(path.join(root, 'scripts', 'hii-cli.mjs'), 'utf8');
    expect(packageJson.scripts['readme:update']).toBe('node scripts/hii-readme-state.mjs --write');
    expect(packageJson.scripts['readme:check']).toBe('node scripts/hii-readme-state.mjs --check');
    expect(packageJson.scripts['ci:product']).toContain('hii:readme:check');
    expect(cli.indexOf('if (!refreshReadmeState())')).toBeLessThan(cli.indexOf('if (!cmdCheck())'));
  });

  it('reduces live observations to bounded semantic state', () => {
    const state = fixture();
    expect(state).toMatchObject({
      source: { repo: '/work/hii', branch: 'main' },
      cli: { version: 'hii 0.1.0', path: '/bin/hii', defaultMaximumSteps: 60 },
      models: { state: 'reachable', installed: 2, default: 'model-b' },
      runtime: { indexedSkills: 12, readyCapabilities: 2, partialCapabilities: 1 },
      supervisor: { state: 'stopped', liveExecutors: 0, managedInstances: 4 },
      systems: { observed: true, entries: [{ id: 'pc', status: 'pending-agent' }] },
      cloud: { configured: 1, total: 2, observed: true }
    });
  });

  it('renders a fingerprinted block without secret values', () => {
    const state = fixture();
    const block = renderStateBlock(state, '2026-08-28T00:00:00.000Z');
    expect(block).toContain(`state-sha256:${stateFingerprint(state)}`);
    expect(block).toContain('| Installed CLI | `hii 0.1.0` at `/bin/hii` |');
    expect(block).toContain('1/2 required variables present');
    expect(block).not.toContain('A_KEY');
    expect(block).not.toContain('B_KEY');
  });

  it('distinguishes an unavailable systems probe from an observed empty list', () => {
    const unavailable = renderStateBlock(fixture({ systems: null }), '2026-08-28T00:00:00.000Z');
    const empty = renderStateBlock(fixture({ systems: { systems: [] } }), '2026-08-28T00:00:00.000Z');
    expect(unavailable).toContain('System enrollment state was not observed');
    expect(empty).toContain('No enrolled systems reported');
  });

  it('preserves the refresh time when semantic state has not changed', () => {
    const state = fixture();
    const initial = readme(renderStateBlock(state, '2026-08-28T00:00:00.000Z'));
    const result = synchronizeReadme(initial, state, {
      mode: 'write',
      now: '2026-08-29T00:00:00.000Z'
    });
    expect(result.changed).toBe(false);
    expect(result.content).toBe(initial);
  });

  it('updates the block and timestamp when state changes', () => {
    const state = fixture();
    const initial = readme(renderStateBlock(state, '2026-08-28T00:00:00.000Z'));
    const changed = fixture({ models: 'model-a available\nmodel-b available\nmodel-c default' });
    const result = synchronizeReadme(initial, changed, {
      mode: 'write',
      now: '2026-08-29T00:00:00.000Z'
    });
    expect(result.changed).toBe(true);
    expect(result.content).toContain('3 installed');
    expect(result.content).toContain('refreshed:2026-08-29T00:00:00.000Z');
  });

  it('fails closed on stale, edited, missing, or duplicate blocks', () => {
    const state = fixture();
    const initial = readme(renderStateBlock(state, '2026-08-28T00:00:00.000Z'));
    expect(() => synchronizeReadme(initial.replace('2 installed', '9 installed'), state, { mode: 'check' }))
      .toThrow(/stale/);
    expect(() => synchronizeReadme('# HII\n', state, { mode: 'check' })).toThrow(/must contain/);
    expect(() => synchronizeReadme(`${initial}\n${STATE_BEGIN}\n${STATE_END}`, state, { mode: 'check' }))
      .toThrow(/more than one/);
  });
});
