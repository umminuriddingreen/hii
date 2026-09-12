import { describe, expect, it } from 'vitest';
import { formatActiveState, type AgentHomeV2, type HiiPresenceV1 } from '@/lib/client/hii-bridge';

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

describe('packaged native presence', () => {
  it('shows observed activity and its limits without claiming full home coverage', () => {
    const presence = {
      schemaVersion: 1,
      kind: 'hii.presence',
      state: 'available',
      claim: 'operational presence, not a claim of consciousness or sentience',
      runtime: { component: 'hii-cli', version: '0.1.0', invocation: 'operator-invoked', persistentProcess: false },
      supervisor: { state: 'stopped', liveExecutors: 0 },
      model: { provider: 'native', state: 'reachable', configuredModel: 'local-model', loadedState: 'not-exposed-by-provider', loadedModels: [] },
      traceCoverage: { records: 0, hiiControlledRecords: 0, scope: 'HII-instrumented calls only; host activity is not observed' },
      context: { workspace: '/tmp/hii-workspace' },
      attention: [{ id: 'task-1', title: 'Research facade', lane: 'next', coordinate: 'board' }],
      recentProof: null,
      authority: { act: 'only within explicit granted authority', represent: 'never attribute HII inference to the user without adoption' },
      next: 'Return to Research facade'
    } satisfies HiiPresenceV1;

    const output = formatActiveState(presence);
    expect(output).toContain('HII PRESENCE · available');
    expect(output).toContain('0 live executor(s)');
    expect(output).toContain('loaded not-exposed-by-provider');
    expect(output).toContain('host activity is not observed');
    expect(output).toContain('CLI workspace: /tmp/hii-workspace');
    expect(output).toContain('next · Research facade · board');
    expect(output).toContain('latest CLI workspace proof: no receipt observed');
    expect(output).not.toContain('coverage:');
  });
});
