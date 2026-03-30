/**
 * Rhino viewport capture → ComfyUI img2img pipeline with real-time progress.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stdout } from 'node:process';
import { runShell } from './shell.js';
import { appendConversationTurn } from '../conversations.js';

const COMFYUI_URL = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8000';

type ProgressCallback = (step: number, total: number, phase: string) => void;

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'rhino-gen';
}

async function uploadImage(imagePath: string): Promise<{ name: string; subfolder: string }> {
  const fileData = fs.readFileSync(imagePath);
  const filename = path.basename(imagePath);

  const boundary = `----HII${Date.now()}`;
  const parts: Buffer[] = [];
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`));
  parts.push(fileData);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const res = await fetch(`${COMFYUI_URL}/upload/image`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const data: any = await res.json();
  return { name: data.name ?? filename, subfolder: data.subfolder ?? '' };
}

async function pickModel(explicit?: string): Promise<string> {
  const res = await fetch(`${COMFYUI_URL}/object_info`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('ComfyUI unreachable');
  const info: any = await res.json();
  const models: string[] = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
  if (!models.length) throw new Error('No checkpoint models in ComfyUI');
  if (!explicit) return models[0];
  return models.find((m) => m.toLowerCase().includes(explicit.toLowerCase())) ?? models[0];
}

function buildImg2ImgGraph(opts: {
  model: string;
  imageName: string;
  imageSubfolder: string;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  denoise: number;
  seed: number;
  outputPrefix: string;
}) {
  return {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: opts.model },
    },
    '2': {
      class_type: 'LoadImage',
      inputs: { image: opts.imageName },
    },
    '3': {
      class_type: 'ImageScale',
      inputs: {
        upscale_method: 'lanczos',
        width: opts.width,
        height: opts.height,
        crop: 'center',
        image: ['2', 0],
      },
    },
    '4': {
      class_type: 'VAEEncode',
      inputs: { pixels: ['3', 0], vae: ['1', 2] },
    },
    '5': {
      class_type: 'CLIPTextEncode',
      inputs: { text: opts.prompt, clip: ['1', 1] },
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { text: opts.negative, clip: ['1', 1] },
    },
    '7': {
      class_type: 'KSampler',
      inputs: {
        seed: opts.seed,
        steps: opts.steps,
        cfg: opts.cfg,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: opts.denoise,
        model: ['1', 0],
        positive: ['5', 0],
        negative: ['6', 0],
        latent_image: ['4', 0],
      },
    },
    '8': {
      class_type: 'VAEDecode',
      inputs: { samples: ['7', 0], vae: ['1', 2] },
    },
    '9': {
      class_type: 'SaveImage',
      inputs: { filename_prefix: opts.outputPrefix, images: ['8', 0] },
    },
  };
}

async function waitWithProgress(
  clientId: string,
  promptId: string,
  onProgress: ProgressCallback,
  timeoutMs = 300000,
): Promise<Array<{ filename: string; url: string }>> {
  const wsUrl = `${COMFYUI_URL.replace(/^http/, 'ws')}/ws?clientId=${clientId}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Generation timed out'));
    }, timeoutMs);

    const ws = new WebSocket(wsUrl);
    let resolved = false;

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
        const { type, data } = msg;

        if (type === 'progress' && data?.prompt_id === promptId) {
          onProgress(data.value, data.max, 'sampling');
        }

        if (type === 'executing' && data?.prompt_id === promptId && data.node === null) {
          // Execution complete — fetch outputs
          clearTimeout(timer);
          ws.close();
          if (resolved) return;
          resolved = true;

          onProgress(1, 1, 'saving');
          const histRes = await fetch(`${COMFYUI_URL}/history/${promptId}`, { signal: AbortSignal.timeout(10000) });
          const history: any = await histRes.json();
          const outputs = history?.[promptId]?.outputs ?? {};
          const files: Array<{ filename: string; url: string }> = [];
          for (const val of Object.values(outputs) as any[]) {
            for (const img of val?.images ?? []) {
              if (!img.filename) continue;
              const params = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' });
              files.push({ filename: img.filename, url: `${COMFYUI_URL}/view?${params}` });
            }
          }
          resolve(files);
        }
      } catch {}
    };

    ws.onerror = () => {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        reject(new Error('WebSocket connection to ComfyUI failed'));
      }
    };
  });
}

export type RhinoToComfyOptions = {
  prompt?: string;
  model?: string;
  denoise?: number;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  capturePath?: string;
};

export type RhinoToComfyResult = {
  capturePath: string;
  outputs: Array<{ filename: string; url: string }>;
  prompt: string;
  model: string;
};

/**
 * Full pipeline: capture Rhino viewport → upload → img2img → return outputs.
 * Renders a live progress bar to stdout.
 */
export async function rhinoToComfy(opts: RhinoToComfyOptions = {}): Promise<RhinoToComfyResult> {
  const isTTY = stdout.isTTY;
  const capturePath = opts.capturePath ?? '/tmp/hii-rhino-capture.png';
  const prompt = opts.prompt ?? 'high quality 3D render, professional lighting, photorealistic';
  const negative = 'blurry, low quality, artifacts, deformed, watermark';
  const denoise = opts.denoise ?? 0.55;
  const width = opts.width ?? 1024;
  const height = opts.height ?? 1024;
  const steps = opts.steps ?? 30;
  const cfg = opts.cfg ?? 7;
  const seed = opts.seed ?? Math.floor(Math.random() * 2147483647);
  const outputPrefix = `hii-rhino-${slugify(prompt)}`;

  const renderProgress = (step: number, total: number, phase: string) => {
    if (!isTTY) return;
    const pct = total > 0 ? Math.round((step / total) * 100) : 0;
    const barWidth = 24;
    const filled = Math.round((step / Math.max(total, 1)) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    stdout.write(`\r  ${bar} ${pct}% ${phase} (${step}/${total})`);
  };

  // Phase 1: Capture
  if (isTTY) stdout.write('  ◆ capturing viewport…');
  const { code, stderr } = await runShell(
    `python3 ~/hii/scripts/rhino_capture_viewport.py --width ${width} --height ${height} --output "${capturePath}"`,
  );
  if (code !== 0 && !fs.existsSync(capturePath)) {
    throw new Error(`Viewport capture failed: ${stderr}`);
  }
  if (isTTY) stdout.write('\r  ✓ viewport captured   \n');

  // Phase 2: Upload
  if (isTTY) stdout.write('  ◆ uploading to ComfyUI…');
  const uploaded = await uploadImage(capturePath);
  if (isTTY) stdout.write('\r  ✓ image uploaded       \n');

  // Phase 3: Generate
  const model = await pickModel(opts.model);
  const clientId = crypto.randomUUID();
  const graph = buildImg2ImgGraph({
    model,
    imageName: uploaded.name,
    imageSubfolder: uploaded.subfolder,
    prompt,
    negative,
    width,
    height,
    steps,
    cfg,
    denoise,
    seed,
    outputPrefix,
  });

  const queued: any = await fetch(`${COMFYUI_URL}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, prompt: graph }),
    signal: AbortSignal.timeout(15000),
  }).then((r) => r.json());

  if (!queued?.prompt_id) {
    throw new Error(`ComfyUI prompt submission failed`);
  }

  if (isTTY) stdout.write('  ');
  const outputs = await waitWithProgress(clientId, queued.prompt_id, renderProgress);
  if (isTTY) stdout.write('\r  ✓ generation complete                    \n');

  const result: RhinoToComfyResult = { capturePath, outputs, prompt, model };

  appendConversationTurn({
    source: 'hii.rhino-to-comfy',
    prompt,
    answer: JSON.stringify({ model, outputs: outputs.map((o) => o.url) }),
    tools: ['rhino_capture', 'comfyui'],
  });

  return result;
}
