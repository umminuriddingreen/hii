// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeModel, type CatalogModel, type ModelCatalog } from '../../lib/server/model-catalog';

const base: Omit<CatalogModel, 'provider' | 'id' | 'key' | 'label' | 'privacy'> = {
  runtimeState: 'ready',
  inputModalities: ['text'],
  outputModalities: ['text'],
  acceptsImages: null,
  streaming: true,
  contextTokens: null,
  sizeBytes: null,
  latencyMs: null,
  quality: null,
  costPerMTokens: null,
  load: null
};

function model(overrides: Partial<CatalogModel> & Pick<CatalogModel, 'id'>): CatalogModel {
  const provider = overrides.provider ?? 'ollama';
  return {
    ...base,
    provider,
    key: `${provider}:${overrides.id}`,
    label: overrides.id,
    privacy: 'local',
    ...overrides
  } as CatalogModel;
}

function catalog(models: CatalogModel[]): ModelCatalog {
  return {
    generatedAt: '2026-08-08T00:00:00.000Z',
    models,
    providers: [],
    unsupported: []
  };
}

describe('model routing', () => {
  it('prefers a ready model over a merely loadable one', () => {
    const decision = routeModel(
      catalog([
        model({ id: 'cold', runtimeState: 'loadable' }),
        model({ id: 'warm', runtimeState: 'ready', provider: 'lm-studio' })
      ])
    );
    expect(decision.chosen?.id).toBe('warm');
    expect(decision.eligible).toHaveLength(2);
  });

  it('excludes external models when the context is local-only', () => {
    const decision = routeModel(
      catalog([
        model({ id: 'claude-code', provider: 'claude', privacy: 'external' }),
        model({ id: 'qwen3:8b' })
      ]),
      { privacy: 'local' }
    );
    expect(decision.chosen?.id).toBe('qwen3:8b');
    expect(decision.excluded).toContainEqual({
      key: 'claude:claude-code',
      reason: 'context is local-only and this model is external'
    });
  });

  it('treats unknown image support as not qualifying for a hard requirement', () => {
    const decision = routeModel(
      catalog([
        model({ id: 'qwen3:8b', acceptsImages: null }),
        model({ id: 'text-only', acceptsImages: false })
      ]),
      { needsImages: true }
    );
    // `null` is unknown, and unknown is not a yes.
    expect(decision.chosen).toBeNull();
    expect(decision.excluded.map((entry) => entry.reason)).toEqual([
      'image support unknown',
      'cannot read images'
    ]);
  });

  it('accepts a model that genuinely reports image input', () => {
    const decision = routeModel(
      catalog([model({ id: 'llava:13b', acceptsImages: true, inputModalities: ['text', 'image'] })]),
      { needsImages: true, inputModalities: ['image'] }
    );
    expect(decision.chosen?.id).toBe('llava:13b');
  });

  it('lets a human override win outright', () => {
    const decision = routeModel(
      catalog([model({ id: 'fast' }), model({ id: 'slow', runtimeState: 'loadable' })]),
      { override: 'slow' }
    );
    expect(decision.chosen?.id).toBe('slow');
    expect(decision.overridden).toBe(true);
  });

  it('reports a missing override rather than quietly substituting', () => {
    const decision = routeModel(catalog([model({ id: 'present' })]), { override: 'absent' });
    expect(decision.chosen).toBeNull();
    expect(decision.overridden).toBe(false);
    expect(decision.notice).toContain('"absent" is not available');
  });

  it('says plainly when nothing qualifies', () => {
    const decision = routeModel(catalog([]), { privacy: 'local' });
    expect(decision.chosen).toBeNull();
    expect(decision.notice).toContain('No available model meets these requirements');
  });

  it('records the reason for every exclusion so the choice is inspectable', () => {
    const decision = routeModel(
      catalog([
        model({ id: 'embedder', outputModalities: ['embedding'] }),
        model({ id: 'chat' })
      ]),
      { outputModalities: ['text'] }
    );
    expect(decision.chosen?.id).toBe('chat');
    expect(decision.excluded).toContainEqual({
      key: 'ollama:embedder',
      reason: 'does not produce text output'
    });
  });
});

describe('model discovery', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reads both local providers and reports each one honestly', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/tags')) {
        return new Response(
          JSON.stringify({ models: [{ name: 'qwen3:8b', size: 5_000_000 }, { name: 'llava:13b' }] }),
          { status: 200 }
        );
      }
      throw new Error('unreachable');
    }) as typeof fetch;

    const { readModelCatalog } = await import('../../lib/server/model-catalog');
    const result = await readModelCatalog();
    expect(result.models.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['ollama:qwen3:8b', 'ollama:llava:13b', 'hii-native:hii-cli'])
    );
    // A vision family is recognised; a text model stays unknown rather than false.
    expect(result.models.find((entry) => entry.id === 'llava:13b')?.acceptsImages).toBe(true);
    expect(result.models.find((entry) => entry.id === 'qwen3:8b')?.acceptsImages).toBeNull();
    // Nothing invents a context window or a cost the provider never reported.
    expect(result.models.find((entry) => entry.id === 'qwen3:8b')?.contextTokens).toBeNull();
    expect(result.models.find((entry) => entry.id === 'qwen3:8b')?.costPerMTokens).toBeNull();
    expect(result.providers.find((entry) => entry.provider === 'lm-studio')?.reachable).toBe(false);
  });

  it('names the runtimes HII does not support instead of implying it does', async () => {
    globalThis.fetch = (async () => {
      throw new Error('unreachable');
    }) as typeof fetch;
    const { readModelCatalog } = await import('../../lib/server/model-catalog');
    const result = await readModelCatalog();
    expect(result.unsupported.map((entry) => entry.provider)).toEqual(['mlx', 'llama.cpp']);
    expect(result.providers.every((entry) => entry.provider === 'hii-native' || !entry.reachable)).toBe(true);
  });
});
