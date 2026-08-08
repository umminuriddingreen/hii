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

export type ModelProvider = 'ollama' | 'lm-studio' | 'hii-native' | 'codex' | 'claude';

export type ModelModality = 'text' | 'image' | 'audio' | 'embedding';

export type ModelPrivacy = 'local' | 'external';

export type ModelRuntimeState = 'ready' | 'loadable' | 'unreachable';

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
  /** Measured, not estimated. Null until something has actually timed it. */
  latencyMs: number | null;
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

async function fetchJson(url: string, timeoutMs = 2500): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
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
  return entries.map((entry) => ({
    provider: entry.provider,
    id: entry.id,
    key: `${entry.provider}:${entry.id}`,
    label: entry.label,
    runtimeState: 'loadable',
    privacy: entry.privacy,
    inputModalities: ['text'],
    outputModalities: ['text'],
    acceptsImages: null,
    streaming: null,
    contextTokens: null,
    sizeBytes: null,
    latencyMs: null,
    quality: null,
    costPerMTokens: null,
    load: null
  }));
}

/** Runtimes HII does not support, stated so nobody infers otherwise. */
const unsupportedProviders = [
  { provider: 'mlx', reason: 'HII has no MLX runtime adapter. Models served through Ollama or LM Studio are discovered normally.' },
  { provider: 'llama.cpp', reason: 'HII has no direct llama.cpp adapter. Use LM Studio or Ollama in front of it.' }
];

export async function readModelCatalog(): Promise<ModelCatalog> {
  const [ollama, lmStudio] = await Promise.all([discoverOllama(), discoverLmStudio()]);
  return {
    generatedAt: new Date().toISOString(),
    models: [...ollama.models, ...lmStudio.models, ...agentRuntimes()],
    providers: [
      { provider: 'ollama', reachable: ollama.reachable, message: ollama.message },
      { provider: 'lm-studio', reachable: lmStudio.reachable, message: lmStudio.message },
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

  const ready = eligible.filter((model) => model.runtimeState === 'ready');
  const chosen = ready[0] ?? eligible[0] ?? null;
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
