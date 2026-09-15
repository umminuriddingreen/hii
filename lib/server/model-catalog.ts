import { readFile } from 'node:fs/promises';

/**
 * One provider-neutral view of the models HII can actually use.
 *
 * Discovery was scattered: the workspace asked Ollama directly, the installer
 * had its own client, the CLI had a third. Each knew a different subset, so the
 * answer to "what can this run on" depended on which surface you asked. This is
 * the one catalog those surfaces read.
 *
 * What it deliberately does *not* do: claim capabilities it has not observed.
 * Modalities, context limits and hardware requirements are recorded only where a
 * provider reports them or a local rule can derive them from the model's own
 * metadata. Cost is reported only where it is genuinely known, which for local
 * runtimes means not at all. An unknown is `null`, never a plausible guess —
 * a routing decision made on an invented number is worse than one that admits it
 * cannot decide.
 */

export type ModelProvider = 'ollama' | 'lm-studio' | 'llama-serve' | 'hii-native' | 'codex' | 'claude';

export type ModelModality = 'text' | 'image' | 'audio' | 'embedding';

export type ModelPrivacy = 'local' | 'external';

export type ModelRuntimeState = 'ready' | 'loadable' | 'unreachable';
export type ModelLatencyClass = 'fast' | 'interactive' | 'slow' | 'unknown';

export type CatalogModel = {
  provider: ModelProvider;
  /** Provider-scoped id, as the provider names it. */
  id: string;
  /** `provider:id`, unique across the catalog. */
  key: string;
  label: string;
  runtimeState: ModelRuntimeState;
  privacy: ModelPrivacy;
  inputModalities: ModelModality[];
  outputModalities: ModelModality[];
  /** Whether the model accepts image references as input, when known. */
  acceptsImages: boolean | null;
  streaming: boolean | null;
  /** Context window, only where the provider reports it. */
  contextTokens: number | null;
  /** Parameter count or on-disk size, where reported. Not a hardware promise. */
  sizeBytes: number | null;
  /** Routing latency hint in milliseconds; measured values should also populate lastMeasuredTTFTMs. */
  latencyMs: number | null;
  /** Last measured time to first streamed data, when known. */
  lastMeasuredTTFTMs: number | null;
  /** ISO timestamp for the measurement, when known. */
  lastMeasuredAt: string | null;
  /** Expected cold-switch/load penalty before first answer, when known. */
  switchPenaltyMs: number | null;
  /** Coarse fast-first routing hint. */
  latencyClass: ModelLatencyClass;
  /** Quality metadata HII has actually recorded. Null when nothing has. */
  quality: Record<string, unknown> | null;
  /** Cost per million tokens, only where reliably known. Local models: null. */
  costPerMTokens: number | null;
  /** Provider-reported load, where available. */
  load: number | null;
};

export type ModelCatalog = {
  generatedAt: string;
  models: CatalogModel[];
  providers: { provider: ModelProvider; reachable: boolean; message: string }[];
  /** Providers HII knows of but has not implemented. Named so nobody assumes. */
  unsupported: { provider: string; reason: string }[];
};

const OLLAMA_URL = () => String(process.env.HII_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const LM_STUDIO_URL = () => String(process.env.HII_LM_STUDIO_URL || 'http://127.0.0.1:1234').replace(/\/+$/, '');
const LLAMA_SERVE_URL = () => openAiBaseUrl(process.env.HII_LLAMA_SERVE_URL || process.env.HII_MODEL_URL || 'http://127.0.0.1:8080/v1');

function openAiBaseUrl(value: string) {
  const trimmed = String(value).replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

async function modelApiHeaders(): Promise<HeadersInit> {
  const keyFile = process.env.HII_MODEL_API_KEY_FILE;
  if (keyFile) {
    const key = (await readFile(keyFile, 'utf8')).trim();
    return key ? { Authorization: `Bearer ${key}` } : {};
  }
  const key = process.env.HII_MODEL_API_KEY?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function latencyClass(latencyMs: number | null, runtimeState: ModelRuntimeState): ModelLatencyClass {
  if (runtimeState !== 'ready') return 'slow';
  if (latencyMs == null) return 'unknown';
  if (latencyMs <= 1500) return 'fast';
  if (latencyMs <= 5000) return 'interactive';
  return 'slow';
}

function localTimingHints(provider: ModelProvider, id: string, runtimeState: ModelRuntimeState) {
  const lower = id.toLowerCase();
  let latencyMs: number | null = null;
  let switchPenaltyMs: number | null = runtimeState === 'ready' ? 0 : null;

  if (provider === 'llama-serve') {
    if (lower.includes('qwen3.6-35b-a3b-agent')) {
      latencyMs = runtimeState === 'ready' ? 250 : 900;
      switchPenaltyMs = runtimeState === 'ready' ? 0 : 25_000;
    } else if (lower.includes('qwen3.5-9b-balanced')) {
      latencyMs = runtimeState === 'ready' ? 400 : 1500;
      switchPenaltyMs = runtimeState === 'ready' ? 0 : 25_000;
    }
  }

  if (provider === 'hii-native') {
    if (lower.includes('4b')) latencyMs = 900;
    if (lower.includes('9b')) latencyMs = 4000;
    if (lower.includes('27b') || lower.includes('35b')) latencyMs = 5500;
  }

  return {
    latencyMs,
    lastMeasuredTTFTMs: null,
    lastMeasuredAt: null,
    switchPenaltyMs,
    latencyClass: latencyClass(latencyMs, runtimeState)
  };
}

/**
 * Model families that genuinely accept image input.
 *
 * A name-based rule, and marked as such: it is the only signal Ollama and LM
 * Studio expose without loading the model. A model not on this list reports
 * `null` — unknown — rather than `false`, because "we did not recognise the
 * name" is not the same as "it cannot see".
 */
const visionFamilies = ['llava', 'bakllava', 'moondream', 'llama3.2-vision', 'qwen2-vl', 'qwen2.5-vl', 'minicpm-v', 'gemma3'];

function acceptsImages(id: string): boolean | null {
  const lower = id.toLowerCase();
  if (visionFamilies.some((family) => lower.includes(family))) return true;
  if (/embed/.test(lower)) return false;
  return null;
}

function modalities(id: string): { input: ModelModality[]; output: ModelModality[] } {
  const lower = id.toLowerCase();
  if (/embed/.test(lower)) return { input: ['text'], output: ['embedding'] };
  const input: ModelModality[] = acceptsImages(id) === true ? ['text', 'image'] : ['text'];
  return { input, output: ['text'] };
}

async function fetchJson(url: string, timeoutMs = 2500, headers?: HeadersInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(`${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function discoverOllama(): Promise<{ models: CatalogModel[]; reachable: boolean; message: string }> {
  try {
    const payload = (await fetchJson(`${OLLAMA_URL()}/api/tags`)) as {
      models?: { name?: string; size?: number; details?: Record<string, unknown> }[];
    };
    const models = (payload.models ?? [])
      .map((entry) => String(entry.name ?? '').trim())
      .filter(Boolean)
      .map((id, index): CatalogModel => {
        const shape = modalities(id);
        return {
          provider: 'ollama',
          id,
          key: `ollama:${id}`,
          label: id,
          runtimeState: 'loadable',
          privacy: 'local',
          inputModalities: shape.input,
          outputModalities: shape.output,
          acceptsImages: acceptsImages(id),
          streaming: true,
          // Ollama's tag listing does not report the context window.
          contextTokens: null,
          sizeBytes: Number(payload.models?.[index]?.size) || null,
          latencyMs: null,
          lastMeasuredTTFTMs: null,
          lastMeasuredAt: null,
          switchPenaltyMs: null,
          latencyClass: latencyClass(null, 'loadable'),
          quality: null,
          costPerMTokens: null,
          load: null
        };
      });
    return {
      models,
      reachable: true,
      message: models.length
        ? `${models.length} installed model${models.length === 1 ? '' : 's'}.`
        : 'Ollama is reachable but no models are installed.'
    };
  } catch {
    return { models: [], reachable: false, message: 'Ollama is not reachable.' };
  }
}

async function discoverLmStudio(): Promise<{ models: CatalogModel[]; reachable: boolean; message: string }> {
  try {
    const payload = (await fetchJson(`${LM_STUDIO_URL()}/v1/models`)) as { data?: { id?: string }[] };
    const models = (payload.data ?? [])
      .map((entry) => String(entry.id ?? '').trim())
      .filter(Boolean)
      .map((id): CatalogModel => {
        const shape = modalities(id);
        return {
          provider: 'lm-studio',
          id,
          key: `lm-studio:${id}`,
          label: id,
          // LM Studio only lists what it has loaded or can serve immediately.
          runtimeState: 'ready',
          privacy: 'local',
          inputModalities: shape.input,
          outputModalities: shape.output,
          acceptsImages: acceptsImages(id),
          streaming: true,
          contextTokens: null,
          sizeBytes: null,
          latencyMs: null,
          lastMeasuredTTFTMs: null,
          lastMeasuredAt: null,
          switchPenaltyMs: 0,
          latencyClass: latencyClass(null, 'ready'),
          quality: null,
          costPerMTokens: null,
          load: null
        };
      });
    return {
      models,
      reachable: true,
      message: models.length ? `${models.length} served model${models.length === 1 ? '' : 's'}.` : 'LM Studio is reachable but serving nothing.'
    };
  } catch {
    return { models: [], reachable: false, message: 'LM Studio is not reachable.' };
  }
}

async function discoverLlamaServe(): Promise<{ models: CatalogModel[]; reachable: boolean; message: string }> {
  try {
    const payload = (await fetchJson(`${LLAMA_SERVE_URL()}/models`, 2500, await modelApiHeaders())) as {
      data?: {
        id?: string;
        architecture?: { input_modalities?: string[]; output_modalities?: string[] };
        meta?: { n_ctx?: number; size?: number };
        status?: { value?: string };
      }[];
    };
    const models = (payload.data ?? [])
      .map((entry) => ({ entry, id: String(entry.id ?? '').trim() }))
      .filter(({ id }) => Boolean(id))
      .map(({ entry, id }): CatalogModel => {
        const shape = modalities(id);
        const runtimeState = entry.status?.value === 'loaded' ? 'ready' : 'loadable';
        const timing = localTimingHints('llama-serve', id, runtimeState);
        const input = entry.architecture?.input_modalities?.filter((value): value is ModelModality =>
          ['text', 'image', 'audio', 'embedding'].includes(value)
        ) ?? shape.input;
        const output = entry.architecture?.output_modalities?.filter((value): value is ModelModality =>
          ['text', 'image', 'audio', 'embedding'].includes(value)
        ) ?? shape.output;
        return {
          provider: 'llama-serve',
          id,
          key: `llama-serve:${id}`,
          label: id,
          runtimeState,
          privacy: 'local',
          inputModalities: input.length ? input : shape.input,
          outputModalities: output.length ? output : shape.output,
          acceptsImages: input.includes('image') ? true : acceptsImages(id),
          streaming: true,
          contextTokens: Number(entry.meta?.n_ctx) || null,
          sizeBytes: Number(entry.meta?.size) || null,
          latencyMs: timing.latencyMs,
          lastMeasuredTTFTMs: timing.lastMeasuredTTFTMs,
          lastMeasuredAt: timing.lastMeasuredAt,
          switchPenaltyMs: timing.switchPenaltyMs,
          latencyClass: timing.latencyClass,
          quality: null,
          costPerMTokens: null,
          load: null
        };
      });
    return {
      models,
      reachable: true,
      message: models.length ? `${models.length} served model${models.length === 1 ? '' : 's'}.` : 'llama-server is reachable but serving nothing.'
    };
  } catch {
    return { models: [], reachable: false, message: 'llama-server is not reachable.' };
  }
}

/**
 * Agent runtimes HII drives rather than models it calls.
 *
 * Listed because a routing decision has to know they exist, but described
 * honestly: HII does not enumerate their internal model choices, so their
 * capabilities are recorded as unknown rather than assumed from a model name in
 * a config file.
 */
function agentRuntimes(): CatalogModel[] {
  const entries: { provider: ModelProvider; id: string; label: string; privacy: ModelPrivacy }[] = [
    { provider: 'hii-native', id: 'hii-cli', label: 'HII CLI (local agent loop)', privacy: 'local' },
    { provider: 'codex', id: 'codex', label: 'Codex CLI', privacy: 'external' },
    { provider: 'claude', id: 'claude-code', label: 'Claude Code', privacy: 'external' }
  ];
  return entries.map((entry) => {
    const runtimeState: ModelRuntimeState = 'loadable';
    const timing = localTimingHints(entry.provider, entry.id, runtimeState);
    return {
      provider: entry.provider,
      id: entry.id,
      key: `${entry.provider}:${entry.id}`,
      label: entry.label,
      runtimeState,
      privacy: entry.privacy,
      inputModalities: ['text'],
      outputModalities: ['text'],
      acceptsImages: null,
      streaming: null,
      contextTokens: null,
      sizeBytes: null,
      latencyMs: timing.latencyMs,
      lastMeasuredTTFTMs: timing.lastMeasuredTTFTMs,
      lastMeasuredAt: timing.lastMeasuredAt,
      switchPenaltyMs: timing.switchPenaltyMs,
      latencyClass: timing.latencyClass,
      quality: null,
      costPerMTokens: null,
      load: null
    };
  });
}

/** Runtimes HII does not support, stated so nobody infers otherwise. */
const unsupportedProviders = [
  { provider: 'mlx', reason: 'Use HII Native or an OpenAI-compatible local server in front of MLX models.' },
  { provider: 'llama.cpp', reason: 'Use the HII llama-server rail discovered as provider llama-serve.' }
];

export async function readModelCatalog(): Promise<ModelCatalog> {
  const [ollama, lmStudio, llamaServe] = await Promise.all([discoverOllama(), discoverLmStudio(), discoverLlamaServe()]);
  return {
    generatedAt: new Date().toISOString(),
    models: [...ollama.models, ...lmStudio.models, ...llamaServe.models, ...agentRuntimes()],
    providers: [
      { provider: 'ollama', reachable: ollama.reachable, message: ollama.message },
      { provider: 'lm-studio', reachable: lmStudio.reachable, message: lmStudio.message },
      { provider: 'llama-serve', reachable: llamaServe.reachable, message: llamaServe.message },
      { provider: 'hii-native', reachable: true, message: 'The local HII agent loop is always available.' }
    ],
    unsupported: unsupportedProviders
  };
}

export type RoutingRequirements = {
  /** Modalities the work needs as input. */
  inputModalities?: ModelModality[];
  outputModalities?: ModelModality[];
  needsImages?: boolean;
  /** Whether resolved context may leave the machine. */
  privacy?: ModelPrivacy;
  /** A model the human chose. Always wins if it exists. */
  override?: string | null;
};

export type RoutingDecision = {
  eligible: CatalogModel[];
  /** The first eligible model, or the override. Null when nothing qualifies. */
  chosen: CatalogModel | null;
  /** Why each excluded model was excluded, so the choice is inspectable. */
  excluded: { key: string; reason: string }[];
  /** Whether a human override was applied. */
  overridden: boolean;
  notice: string;
};

/**
 * The first routing policy, over evidence HII actually has.
 *
 * Requirements, modality, privacy and availability — nothing about measured
 * quality or cost, because neither is populated yet and routing on an empty
 * field is routing on nothing. A manual override always wins: the point of
 * routing is to make a good default, not to take the choice away.
 */
export function routeModel(catalog: ModelCatalog, requirements: RoutingRequirements = {}): RoutingDecision {
  const excluded: { key: string; reason: string }[] = [];

  if (requirements.override) {
    const chosen = catalog.models.find(
      (model) => model.key === requirements.override || model.id === requirements.override
    );
    if (chosen) {
      return {
        eligible: [chosen],
        chosen,
        excluded: [],
        overridden: true,
        notice: `Using ${chosen.label} because it was chosen explicitly.`
      };
    }
    // A named-but-absent override is reported, never silently replaced: quietly
    // running on a different model than the human asked for is worse than
    // stopping.
    return {
      eligible: [],
      chosen: null,
      excluded: [{ key: String(requirements.override), reason: 'not present in the catalog' }],
      overridden: false,
      notice: `"${requirements.override}" is not available. Refresh the model list and choose an available model.`
    };
  }

  const eligible = catalog.models.filter((model) => {
    if (model.runtimeState === 'unreachable') {
      excluded.push({ key: model.key, reason: 'runtime unreachable' });
      return false;
    }
    if (requirements.privacy === 'local' && model.privacy !== 'local') {
      excluded.push({ key: model.key, reason: 'context is local-only and this model is external' });
      return false;
    }
    for (const modality of requirements.inputModalities ?? []) {
      if (!model.inputModalities.includes(modality)) {
        excluded.push({ key: model.key, reason: `does not accept ${modality} input` });
        return false;
      }
    }
    for (const modality of requirements.outputModalities ?? []) {
      if (!model.outputModalities.includes(modality)) {
        excluded.push({ key: model.key, reason: `does not produce ${modality} output` });
        return false;
      }
    }
    if (requirements.needsImages && model.acceptsImages !== true) {
      // `null` is unknown, and unknown does not qualify for a hard requirement.
      excluded.push({
        key: model.key,
        reason: model.acceptsImages === false ? 'cannot read images' : 'image support unknown'
      });
      return false;
    }
    return true;
  });

  const chosen = [...eligible].sort(compareFastFirstModels)[0] ?? null;
  return {
    eligible,
    chosen,
    excluded,
    overridden: false,
    notice: chosen
      ? `${eligible.length} eligible model${eligible.length === 1 ? '' : 's'}; using ${chosen.label}.`
      : 'No available model meets these requirements. Start a local runtime or relax the requirements.'
  };
}

function compareFastFirstModels(a: CatalogModel, b: CatalogModel) {
  const stateRank = (model: CatalogModel) => model.runtimeState === 'ready' ? 0 : model.runtimeState === 'loadable' ? 1 : 2;
  const latencyRank = (model: CatalogModel) => model.latencyMs ?? Number.MAX_SAFE_INTEGER;
  const switchRank = (model: CatalogModel) => model.switchPenaltyMs ?? (model.runtimeState === 'ready' ? 0 : 60_000);
  return stateRank(a) - stateRank(b)
    || latencyRank(a) - latencyRank(b)
    || switchRank(a) - switchRank(b);
}
