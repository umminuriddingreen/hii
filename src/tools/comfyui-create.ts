import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { appendConversationTurn } from '../conversations.js';

const COMFYUI_URL = process.env.COMFYUI_URL ?? 'http://127.0.0.1:8000';
const HII_DIR = path.join(os.homedir(), '.hii');
const COMFYUI_DIR = path.join(HII_DIR, 'comfyui');
const REQUESTS_LOG = path.join(COMFYUI_DIR, 'requests.jsonl');

type ImageShape = 'square' | 'landscape' | 'portrait';
type CreationMode = 'image' | 'wallpaper' | 'logo' | 'icon' | 'poster';

export type ComfyCreatePlan = {
  prompt: string;
  negativePrompt: string;
  model?: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  samplerName: string;
  scheduler: string;
  seed: number;
  batchSize: number;
  mode: CreationMode;
  shape: ImageShape;
  outputPrefix: string;
  source: 'heuristic';
};

export type ComfyCreateOptions = {
  model?: string;
  negative?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  batchSize?: number;
  outputPrefix?: string;
  wait?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

export type ComfyCreateResult = {
  ok: boolean;
  clientId: string;
  promptId?: string;
  plan: ComfyCreatePlan;
  outputs?: Array<{ filename: string; subfolder: string; type: string; url: string }>;
  queuedAt: string;
  completedAt?: string;
};

type PromptResponse = { prompt_id?: string; node_errors?: unknown };
type HistoryOutputFile = { filename?: string; subfolder?: string; type?: string };

function ensureDir(): void {
  fs.mkdirSync(COMFYUI_DIR, { recursive: true });
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'comfy-job';
}

function randomSeed(): number {
  return Math.floor(Math.random() * 2147483647);
}

async function httpGetJson(url: string, ms = 10000): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) {
    throw new Error(`GET ${url} failed with ${res.status}`);
  }
  return res.json();
}

async function httpPostJson(url: string, body: unknown, ms = 15000): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) {
    throw new Error(`POST ${url} failed with ${res.status}`);
  }
  return res.json();
}

function pickMode(request: string): CreationMode {
  const text = request.toLowerCase();
  if (/\b(wallpaper|desktop|background)\b/.test(text)) return 'wallpaper';
  if (/\b(logo|wordmark|brand mark|brandmark)\b/.test(text)) return 'logo';
  if (/\b(icon|app icon|favicon)\b/.test(text)) return 'icon';
  if (/\b(poster|flyer|cover)\b/.test(text)) return 'poster';
  return 'image';
}

function pickShape(request: string, mode: CreationMode): ImageShape {
  const text = request.toLowerCase();
  if (mode === 'wallpaper') return 'landscape';
  if (/\b(portrait|vertical|phone|poster)\b/.test(text)) return 'portrait';
  if (/\b(landscape|wide|desktop|banner|wallpaper)\b/.test(text)) return 'landscape';
  return 'square';
}

function defaultSize(mode: CreationMode, shape: ImageShape): { width: number; height: number } {
  if (mode === 'wallpaper') return { width: 1344, height: 768 };
  if (mode === 'poster' || shape === 'portrait') return { width: 832, height: 1216 };
  if (shape === 'landscape') return { width: 1344, height: 768 };
  return { width: 1024, height: 1024 };
}

function buildNegativePrompt(request: string, mode: CreationMode): string {
  const base = ['blurry', 'low quality', 'artifacts', 'deformed', 'duplicate'];
  if (mode === 'logo' || mode === 'icon') {
    base.push('photorealistic', 'busy background', 'text paragraphs', 'watermark');
  }
  if (/\b(anime|manga)\b/i.test(request) === false) {
    base.push('anime');
  }
  return base.join(', ');
}

function inferSteps(mode: CreationMode): number {
  if (mode === 'logo' || mode === 'icon') return 24;
  return 30;
}

function inferCfg(mode: CreationMode): number {
  if (mode === 'logo' || mode === 'icon') return 6.5;
  return 7;
}

function sanitizeDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const snapped = Math.round(value / 64) * 64;
  return Math.min(2048, Math.max(512, snapped));
}

export function planComfyCreate(request: string, opts: Omit<ComfyCreateOptions, 'wait' | 'dryRun' | 'json'> = {}): ComfyCreatePlan {
  const mode = pickMode(request);
  const shape = pickShape(request, mode);
  const size = defaultSize(mode, shape);
  const width = sanitizeDimension(opts.width ?? size.width, size.width);
  const height = sanitizeDimension(opts.height ?? size.height, size.height);
  const batchSize = Math.min(8, Math.max(1, opts.batchSize ?? 1));
  return {
    prompt: request.trim(),
    negativePrompt: opts.negative?.trim() || buildNegativePrompt(request, mode),
    model: opts.model,
    width,
    height,
    steps: Math.min(80, Math.max(8, Math.round(opts.steps ?? inferSteps(mode)))),
    cfg: Math.min(16, Math.max(1, Number((opts.cfg ?? inferCfg(mode)).toFixed(1)))),
    samplerName: 'euler',
    scheduler: 'normal',
    seed: Number.isFinite(opts.seed) ? Number(opts.seed) : randomSeed(),
    batchSize,
    mode,
    shape,
    outputPrefix: opts.outputPrefix?.trim() || `hii-${slugify(request)}`,
    source: 'heuristic',
  };
}

async function pickModel(explicitModel?: string): Promise<string> {
  const info = await httpGetJson(`${COMFYUI_URL}/object_info`, 10000);
  const models: string[] = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
  if (!models.length) {
    throw new Error('No checkpoint models available in ComfyUI.');
  }
  if (!explicitModel) return models[0];
  const found = models.find((name) => name === explicitModel);
  if (found) return found;
  const partial = models.find((name) => name.toLowerCase().includes(explicitModel.toLowerCase()));
  if (partial) return partial;
  throw new Error(`Model not found in ComfyUI: ${explicitModel}`);
}

function buildPromptGraph(plan: ComfyCreatePlan, model: string) {
  return {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: plan.seed,
        steps: plan.steps,
        cfg: plan.cfg,
        sampler_name: plan.samplerName,
        scheduler: plan.scheduler,
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '4': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: model },
    },
    '5': {
      class_type: 'EmptyLatentImage',
      inputs: {
        width: plan.width,
        height: plan.height,
        batch_size: plan.batchSize,
      },
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: plan.prompt,
        clip: ['4', 1],
      },
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: plan.negativePrompt,
        clip: ['4', 1],
      },
    },
    '8': {
      class_type: 'VAEDecode',
      inputs: {
        samples: ['3', 0],
        vae: ['4', 2],
      },
    },
    '9': {
      class_type: 'SaveImage',
      inputs: {
        filename_prefix: plan.outputPrefix,
        images: ['8', 0],
      },
    },
  };
}

function viewUrl(file: Required<HistoryOutputFile>): string {
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder,
    type: file.type,
  });
  return `${COMFYUI_URL}/view?${params.toString()}`;
}

async function waitForOutputs(promptId: string, timeoutMs = 180000): Promise<Array<{ filename: string; subfolder: string; type: string; url: string }>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const history = await httpGetJson(`${COMFYUI_URL}/history/${promptId}`, 10000);
    const run = history?.[promptId];
    const outputs = run?.outputs ?? {};
    const files: Array<{ filename: string; subfolder: string; type: string; url: string }> = [];
    for (const value of Object.values(outputs) as Array<{ images?: HistoryOutputFile[] }>) {
      for (const image of value?.images ?? []) {
        if (!image.filename || image.subfolder === undefined || !image.type) continue;
        files.push({
          filename: image.filename,
          subfolder: image.subfolder,
          type: image.type,
          url: viewUrl({
            filename: image.filename,
            subfolder: image.subfolder,
            type: image.type,
          }),
        });
      }
    }
    if (files.length) return files;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out waiting for ComfyUI outputs for prompt ${promptId}`);
}

function appendRequestLog(entry: ComfyCreateResult): void {
  ensureDir();
  fs.appendFileSync(REQUESTS_LOG, `${JSON.stringify(entry)}\n`);
}

export function recentComfyRequests(limit = 20): ComfyCreateResult[] {
  ensureDir();
  if (!fs.existsSync(REQUESTS_LOG)) return [];
  const lines = fs.readFileSync(REQUESTS_LOG, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  const parsed: ComfyCreateResult[] = [];
  for (const line of lines.slice(-Math.max(1, limit))) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return parsed.reverse();
}

function printResult(result: ComfyCreateResult, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`prompt id: ${result.promptId ?? 'dry-run'}`);
  console.log(`model: ${result.plan.model ?? 'auto'}`);
  console.log(`size: ${result.plan.width}x${result.plan.height}`);
  console.log(`steps/cfg: ${result.plan.steps}/${result.plan.cfg}`);
  console.log(`mode: ${result.plan.mode}`);
  console.log(`prefix: ${result.plan.outputPrefix}`);
  if (result.outputs?.length) {
    console.log('\noutputs:');
    for (const output of result.outputs) {
      console.log(`- ${output.url}`);
    }
  }
}

export async function comfyuiPlan(request: string, opts: Omit<ComfyCreateOptions, 'wait' | 'dryRun' | 'json'> = {}): Promise<ComfyCreatePlan> {
  return planComfyCreate(request, opts);
}

export async function comfyuiCreate(request: string, opts: ComfyCreateOptions = {}): Promise<ComfyCreateResult> {
  ensureDir();
  const basePlan = await comfyuiPlan(request, opts);
  const clientId = crypto.randomUUID();
  const queuedAt = new Date().toISOString();

  if (opts.dryRun) {
    const dryRun: ComfyCreateResult = {
      ok: true,
      clientId,
      plan: basePlan,
      queuedAt,
    };
    appendRequestLog(dryRun);
    printResult(dryRun, !!opts.json);
    return dryRun;
  }

  const model = await pickModel(basePlan.model);
  const plan = { ...basePlan, model };
  const prompt = buildPromptGraph(plan, model);
  const queued = await httpPostJson(`${COMFYUI_URL}/prompt`, {
    client_id: clientId,
    prompt,
  }) as PromptResponse;

  if (!queued?.prompt_id) {
    throw new Error(`ComfyUI prompt submission failed${queued?.node_errors ? `: ${JSON.stringify(queued.node_errors)}` : ''}`);
  }

  const result: ComfyCreateResult = {
    ok: true,
    clientId,
    promptId: queued.prompt_id,
    plan,
    queuedAt,
  };

  if (opts.wait) {
    result.outputs = await waitForOutputs(queued.prompt_id);
    result.completedAt = new Date().toISOString();
  }

  appendRequestLog(result);
  appendConversationTurn({
    source: 'hii.comfyui.create',
    prompt: request,
    answer: JSON.stringify({
      promptId: result.promptId,
      model: result.plan.model,
      size: `${result.plan.width}x${result.plan.height}`,
      outputs: result.outputs?.map((item) => item.url) ?? [],
    }),
    tools: ['comfyui'],
  });
  printResult(result, !!opts.json);
  return result;
}

export async function comfyuiPlanCommand(request: string, opts: Omit<ComfyCreateOptions, 'wait' | 'dryRun'> = {}): Promise<void> {
  const plan = await comfyuiPlan(request, opts);
  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`model: ${plan.model}`);
  console.log(`size: ${plan.width}x${plan.height}`);
  console.log(`steps/cfg: ${plan.steps}/${plan.cfg}`);
  console.log(`mode: ${plan.mode}`);
  console.log(`prefix: ${plan.outputPrefix}`);
  console.log(`prompt: ${plan.prompt}`);
  console.log(`negative: ${plan.negativePrompt}`);
}

export function comfyuiRequests(limit = 20, asJson = false): void {
  const items = recentComfyRequests(limit);
  if (asJson) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (!items.length) {
    console.log('No ComfyUI requests logged yet.');
    return;
  }
  for (const item of items) {
    console.log(`${item.queuedAt} ${item.promptId ?? 'dry-run'} ${item.plan.mode} ${item.plan.width}x${item.plan.height}`);
    console.log(`  ${item.plan.prompt}`);
    if (item.outputs?.length) {
      for (const output of item.outputs) {
        console.log(`  -> ${output.url}`);
      }
    }
  }
}
