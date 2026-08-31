import { describe, expect, it } from 'vitest';
import { formatActiveState, type AgentHomeV2 } from '@/lib/client/hii-bridge';

describe('white-box active state', () => {
  it('renders state, evidence source, coverage, and visibility limits', () => {
    const home = {
      schemaVersion: 2,
      kind: 'hii.agent.home',
      generatedAt: '2026-08-30T00:00:00.000Z',
      activeState: {
        schemaVersion: 1,
        kind: 'hii.active-state',
        model: 'white-box operational state',
        observedAt: '2026-08-30T00:00:00.000Z',
        claim: 'Only observable state is claimed.',
        transition: 'input -> receipt',
        coverage: {
          registeredDomains: 1,
          observed: 1,
          partial: 0,
          unavailable: 0,
          exclusions: ['private activity']
        },
        activeInstanceProjection: { total: 2, returned: 1, truncated: true, inspectCommand: 'hii instances list' },
        domains: [{
          id: 'systems',
          state: 'active',
          visibility: 'observed',
          source: '/runtime/instances.json',
          updatedAt: '2026-08-30T00:00:00.000Z',
          basis: 'Two processes are live.',
          counts: { active: 2 }
        }],
        activeInstances: [{
          id: 'daemon:hiid', type: 'agent', status: 'running', owned: true, live: true,
          title: 'hiid', coordinate: '/runtime', heartbeatAt: '2026-08-30T00:00:00.000Z'
        }]
      }
    } satisfies AgentHomeV2;

    const output = formatActiveState(home);
    expect(output).toContain('SYSTEMS · active');
    expect(output).toContain('source: /runtime/instances.json');
    expect(output).toContain('coverage: 1/1 observed');
    expect(output).toContain('instances: 2 active · 1 shown · inspect all with hii instances list');
    expect(output).toContain('owned · agent · running · hiid');
    expect(output).toContain('Not visible: private activity.');
  });
});
