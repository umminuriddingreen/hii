import 'server-only';
import { randomUUID } from 'node:crypto';

function comfyBase() {
  const raw = String(process.env.HII_COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || url.protocol !== 'http:') {
    throw new Error('HII ComfyUI must use a local http endpoint.');
  }
  return url.toString().replace(/\/$/, '');
}

async function comfyFetch(path: string, init?: RequestInit, timeoutMs = 3000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${comfyBase()}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function comfyStatus() {
  try {
    const response = await comfyFetch('/system_stats');
    if (!response.ok) throw new Error(`ComfyUI returned ${response.status}.`);
    const system = await response.json() as Record<string, unknown>;
    return { available: true, baseUrl: comfyBase(), system, message: 'Local ComfyUI is ready.' };
  } catch (error) {
    return {
      available: false,
      baseUrl: comfyBase(),
      system: null,
      message: error instanceof Error && error.name !== 'AbortError' && !/fetch failed/i.test(error.message)
        ? error.message
        : 'Local ComfyUI is not reachable.'
    };
  }
}

export async function queueComfyPrompt(prompt: Record<string, unknown>) {
  if (!Object.keys(prompt).length) throw new Error('The ComfyUI prompt graph is empty.');
  const clientId = randomUUID();
  const response = await comfyFetch('/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: clientId })
  }, 10_000);
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.error || `ComfyUI returned ${response.status}.`));
  const promptId = String(result.prompt_id || '');
  if (!promptId) throw new Error('ComfyUI accepted the request without returning a prompt id.');
  return { promptId, clientId, queueNumber: result.number ?? null, nodeErrors: result.node_errors ?? {} };
}

export async function comfyPromptHistory(promptId: unknown) {
  const id = String(promptId ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) throw new Error('A ComfyUI prompt id is required.');
  const response = await comfyFetch(`/history/${encodeURIComponent(id)}`, undefined, 5000);
  if (!response.ok) throw new Error(`ComfyUI history returned ${response.status}.`);
  return response.json() as Promise<Record<string, unknown>>;
}
