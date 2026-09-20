import 'server-only';

type LocalLlmResult = {
  text: string;
  model: string;
  available: boolean;
};

const ollamaBaseUrl = process.env.HII_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const requestedModel = process.env.HII_LOCAL_INSTALLER_MODEL ?? 'qwen-work';
const modelFallbacks = (
  process.env.HII_LOCAL_MODEL_FALLBACKS ?? 'qwen-work,qwen-deep,gemma-write,fast-local,fast-local:latest'
)
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);

function modelPreferenceChain() {
  return Array.from(new Set([requestedModel, ...modelFallbacks]));
}

async function listOllamaModels(signal: AbortSignal): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${ollamaBaseUrl.replace(/\/$/, '')}/api/tags`, { signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: Array<{ name?: unknown }> };
    return new Set(
      (data.models ?? [])
        .map((model) => (typeof model.name === 'string' ? model.name : ''))
        .filter(Boolean)
    );
  } catch {
    return null;
  }
}

function resolveModel(available: Set<string> | null) {
  const chain = modelPreferenceChain();
  if (!available || available.size === 0) return chain[0];

  for (const candidate of chain) {
    if (available.has(candidate)) return candidate;
    if (!candidate.includes(':') && available.has(`${candidate}:latest`)) return `${candidate}:latest`;
  }
  return null;
}

export async function askLocalInstallerModel(prompt: string): Promise<LocalLlmResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const availableModels = await listOllamaModels(controller.signal);
    const model = resolveModel(availableModels);
    if (!model) throw new Error(`No preferred local model available: ${modelPreferenceChain().join(', ')}`);

    const res = await fetch(`${ollamaBaseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: 'system',
            content:
              'You are the local HII installer assistant. Give one concise next step. Never suggest arbitrary shell commands. Only refer to the whitelisted installer actions shown in the UI.'
          },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = await res.json();
    const text = String(data?.message?.content ?? '').trim();
    return {
      text: text || 'Use the next whitelisted installer action shown in the HII console.',
      model,
      available: true
    };
  } catch {
    return {
      text:
        'Local model unavailable. Open Rhino, confirm RhinoCode is enabled, then run npm run hii:rhino -- status.',
      model: modelPreferenceChain()[0],
      available: false
    };
  } finally {
    clearTimeout(timeout);
  }
}
