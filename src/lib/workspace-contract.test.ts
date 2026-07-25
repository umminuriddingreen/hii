import { describe, expect, it, vi } from 'vitest';
import { seedFor, seedFromFile, seedFromString, seedFromUrl } from '../../lib/workspace/ingest';
import { emptyWorkspace, normalizeSpatialObject, workspaceNodeTypes } from '../../lib/workspace/types';

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

  it('creates governed spatial intent and managed run seeds', () => {
    const intent = seedFor('intent', { text: 'Inspect this workspace', parentId: 'run-parent' });
    const run = seedFor('run', { prompt: 'Inspect this workspace', parentId: 'intent-1', autoStart: true });

    expect(workspaceNodeTypes).toEqual(expect.arrayContaining(['intent', 'run']));
    expect(intent).toMatchObject({
      type: 'intent',
      object: {
        kind: 'intent',
        owner: 'human',
        status: 'approved',
        parentId: 'run-parent'
      }
    });
    expect(run).toMatchObject({
      type: 'run',
      object: {
        kind: 'run',
        owner: 'aii',
        status: 'queued',
        parentId: 'intent-1'
      },
      payload: {
        autoStart: true,
        status: 'queued'
      }
    });
  });

  it('routes self-contained models and PDFs into governed viewer nodes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: 'cube.obj',
            mime: 'model/obj',
            size: 32,
            path: '/Users/ummi/.hii/workspace/assets/cube.obj',
            url: '/api/workspace/assets/cube.obj',
            sha256: 'abc123'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: 'brief.pdf',
            mime: 'application/pdf',
            size: 128,
            path: '/Users/ummi/.hii/workspace/assets/brief.pdf',
            url: '/api/workspace/assets/brief.pdf',
            sha256: 'def456'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const model = await seedFromFile(new File(['o cube'], 'cube.obj', { type: 'model/obj' }));
    const document = await seedFromFile(new File(['%PDF'], 'brief.pdf', { type: 'application/pdf' }));

    expect(workspaceNodeTypes).toEqual(expect.arrayContaining(['model', 'document']));
    expect(model).toMatchObject({
      type: 'model',
      object: {
        kind: 'model',
        owner: 'human',
        status: 'ready',
        source: '/Users/ummi/.hii/workspace/assets/cube.obj'
      },
      payload: {
        viewer: 'three',
        extension: 'obj',
        sha256: 'abc123'
      }
    });
    expect(document).toMatchObject({
      type: 'document',
      object: {
        kind: 'asset',
        owner: 'human',
        status: 'ready'
      },
      payload: {
        viewer: 'native-pdf',
        kind: 'pdf',
        sha256: 'def456'
      }
    });
  });
});
