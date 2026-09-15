// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  lastMeasuredTTFTMs: null,
  lastMeasuredAt: null,
  switchPenaltyMs: null,
  latencyClass: 'unknown',
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

  it('prefers the faster ready model for first-answer routing', () => {
    const decision = routeModel(
      catalog([
        model({ id: 'slow-ready', provider: 'llama-serve', latencyMs: 5500, latencyClass: 'slow' }),
        model({ id: 'fast-ready', provider: 'llama-serve', latencyMs: 250, latencyClass: 'fast' })
      ])
    );
    expect(decision.chosen?.id).toBe('fast-ready');
  });

  it('does not choose an unloaded model over a warm model just because its estimate is low', () => {
    const decision = routeModel(
      catalog([
        model({ id: 'cold-fast', provider: 'llama-serve', runtimeState: 'loadable', latencyMs: 250, switchPenaltyMs: 25_000, latencyClass: 'slow' }),
        model({ id: 'warm-ok', provider: 'llama-serve', runtimeState: 'ready', latencyMs: 900, switchPenaltyMs: 0, latencyClass: 'fast' })
      ])
    );
    expect(decision.chosen?.id).toBe('warm-ok');
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
    vi.unstubAllEnvs();
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
      if (url.includes('127.0.0.1:8080/v1/models')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'qwen3.6-35b-a3b-agent',
                status: { value: 'loaded' },
                architecture: { input_modalities: ['text'], output_modalities: ['text'] },
                meta: { n_ctx: 65536, size: 13_676_723_168 }
              }
            ]
          }),
          { status: 200 }
        );
      }
      throw new Error('unreachable');
    }) as typeof fetch;

    const { readModelCatalog } = await import('../../lib/server/model-catalog');
    const result = await readModelCatalog();
    expect(result.models.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['ollama:qwen3:8b', 'ollama:llava:13b', 'llama-serve:qwen3.6-35b-a3b-agent', 'hii-native:hii-cli'])
    );
    expect(result.models.find((entry) => entry.key === 'llama-serve:qwen3.6-35b-a3b-agent')).toMatchObject({
      runtimeState: 'ready',
      contextTokens: 65536,
      sizeBytes: 13_676_723_168,
      latencyClass: 'fast',
      switchPenaltyMs: 0
    });
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
    expect(result.unsupported.find((entry) => entry.provider === 'llama.cpp')?.reason).toContain('llama-serve');
    expect(result.providers.every((entry) => entry.provider === 'hii-native' || !entry.reachable)).toBe(true);
  });

  it('discovers an authenticated HII llama rail through HII_MODEL_URL and bearer-file auth', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hii-model-catalog-'));
    const keyFile = path.join(directory, 'api-key');
    await writeFile(keyFile, 'test-token\n');
    vi.stubEnv('HII_MODEL_URL', 'http://100.81.69.126:8080');
    vi.stubEnv('HII_MODEL_API_KEY_FILE', keyFile);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/tags') || url.includes('127.0.0.1:1234')) throw new Error('unreachable');
      expect(url).toBe('http://100.81.69.126:8080/v1/models');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.5-9b-balanced', status: { value: 'loaded' } }] }), { status: 200 });
    }) as typeof fetch;

    try {
      const { readModelCatalog } = await import('../../lib/server/model-catalog');
      const result = await readModelCatalog();
      expect(result.models.find((entry) => entry.key === 'llama-serve:qwen3.5-9b-balanced')).toMatchObject({
        runtimeState: 'ready',
        latencyClass: 'fast'
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
