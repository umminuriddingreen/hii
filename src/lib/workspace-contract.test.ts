import { describe, expect, it } from 'vitest';
import { seedFor, seedFromString, seedFromUrl } from '../../lib/workspace/ingest';
import { emptyWorkspace, normalizeSpatialObject } from '../../lib/workspace/types';

describe('workspace contract', () => {
  it('starts from a durable empty workspace shape', () => {
    const workspace = emptyWorkspace();

    expect(workspace).toMatchObject({
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nextZ: 1,
      nodes: []
    });
    expect(new Date(workspace.updatedAt).toISOString()).toBe(workspace.updatedAt);
  });

  it('normalizes governed spatial metadata and strips terminal control codes', () => {
    expect(
      normalizeSpatialObject({
        kind: 'receipt',
        owner: '\u001b[31moperator\u001b[0m',
        status: 'completed',
        proofRefs: [' build log ', null],
        audit: [{ ts: '2026-07-16T12:00:00.000Z', actor: 'agent', action: ' verified ' }]
      })
    ).toEqual({
      kind: 'receipt',
      owner: 'operator',
      status: 'completed',
      source: undefined,
      capabilityId: undefined,
      runId: undefined,
      proofRefs: ['build log'],
      memoryRefs: undefined,
      parentId: undefined,
      audit: [{ ts: '2026-07-16T12:00:00.000Z', actor: 'agent', action: 'verified' }]
    });
  });

  it('routes pasted input into deterministic workspace object types', () => {
    expect(seedFromString('https://hii.local/proof').type).toBe('link');
    expect(seedFromUrl('https://hii.local/reference.svg').type).toBe('image');
    expect(seedFromString('<section>proof</section>').type).toBe('html');
    expect(seedFromString('plain project context').type).toBe('text');
  });

  it('attaches truth labels to the modeled sound-field object', () => {
    const seed = seedFor('sound-field');

    expect(seed.object).toMatchObject({
      kind: 'scene',
      owner: 'hii',
      status: 'ready',
      capabilityId: 'hii.scene.sound-field'
    });
    expect(seed.payload).toMatchObject({ dataMode: 'modeled', scenario: 'weekday' });
  });

  it('creates a governed live exploration window with browser and terminal state', () => {
    const seed = seedFor('explorer');

    expect(seed).toMatchObject({
      type: 'explorer',
      w: 1040,
      h: 640,
      object: {
        kind: 'interface',
        owner: 'hii',
        status: 'ready'
      },
      payload: {
        title: 'live exploration',
        url: 'https://duckduckgo.com'
      }
    });
    expect(seed.payload.sessionId).toEqual(expect.any(String));
  });
});
