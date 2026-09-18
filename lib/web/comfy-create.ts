import type { WorkspaceNode } from '@/lib/workspace/types';

export const HII_COMFY_LOCAL_URL = 'http://127.0.0.1:8189';

export type ComfyOutput = { filename: string; subfolder?: string; type?: string };

function nodeText(node: WorkspaceNode) {
  const payload = node.payload as Record<string, unknown>;
  const fields = ['title', 'name', 'text', 'content', 'excerpt', 'description', 'url', 'path'];
  const values = fields.map((field) => String(payload[field] ?? '').trim()).filter(Boolean);
  return `${node.type}: ${values.join(' | ') || node.id}`;
}

export function compileCanvasContext(nodes: WorkspaceNode[]) {
  return nodes.slice(0, 24).map(nodeText).join('\n').slice(0, 12_000);
}

export function buildZImagePrompt(prompt: string, seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { clip: ['3', 0], text: prompt } },
    '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
    '6': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '7': { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1 } },
    '8': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['8', 0] } },
    '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'hii-canvas/create' } }
  };
}

async function localFetch(path: string, init?: RequestInit) {
  const response = await fetch(`${HII_COMFY_LOCAL_URL}${path}`, init);
  if (!response.ok) throw new Error(`Local ComfyUI returned ${response.status}.`);
  return response;
}

export async function localComfyStatus() {
  await localFetch('/system_stats');
}

export async function queueCanvasPrompt(prompt: string) {
  const response = await localFetch('/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: buildZImagePrompt(prompt), client_id: crypto.randomUUID() })
  });
  const body = await response.json() as { prompt_id?: string; error?: string };
  if (!body.prompt_id) throw new Error(body.error || 'ComfyUI did not return a prompt id.');
  return body.prompt_id;
}

export async function waitForCanvasOutput(promptId: string, attempts = 240): Promise<ComfyOutput> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await localFetch(`/history/${encodeURIComponent(promptId)}`);
    const history = await response.json() as Record<string, { outputs?: Record<string, { images?: ComfyOutput[] }> }>;
    const output = history[promptId]?.outputs?.['10']?.images?.[0];
    if (output) return output;
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  throw new Error('ComfyUI did not finish before the local timeout.');
}

export function comfyOutputUrl(output: ComfyOutput) {
  const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || '', type: output.type || 'output' });
  return `${HII_COMFY_LOCAL_URL}/view?${query}`;
}
