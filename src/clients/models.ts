/**
 * Query available models across all backends.
 */
import fetch from 'node-fetch';
import type { MenuItem } from '../tui/menu.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

export type ModelInfo = {
  name: string;
  backend: string;
  size?: string;
  modified?: string;
  description?: string;
};

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)}MB`;
  return `${bytes}B`;
}

export async function listOllamaModels(): Promise<ModelInfo[]> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return [];
    const data: any = await res.json();
    return (data.models ?? []).map((m: any) => ({
      name: m.name,
      backend: 'ollama',
      size: m.size ? formatSize(m.size) : undefined,
      modified: m.modified_at ? new Date(m.modified_at).toLocaleDateString() : undefined,
    }));
  } catch {
    return [];
  }
}

export async function listMlxModels(): Promise<ModelInfo[]> {
  // MLX models are typically stored in ~/.cache/huggingface/hub/models--mlx-community*
  try {
    const { readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const cacheDir = join(homedir(), '.cache', 'huggingface', 'hub');
    const entries = readdirSync(cacheDir).filter((d) => d.startsWith('models--'));
    return entries
      .filter((d) => {
        try { return statSync(join(cacheDir, d)).isDirectory(); } catch { return false; }
      })
      .map((d) => {
        // models--mlx-community--Foo-Bar -> mlx-community/Foo-Bar
        const name = d.replace('models--', '').replace(/--/g, '/');
        return { name, backend: 'mlx' };
      });
  } catch {
    return [];
  }
}

export async function listClaudeModels(): Promise<ModelInfo[]> {
  // Static list of available Claude models
  return [
    { name: 'claude-opus-4-6', backend: 'claude', description: 'Most capable, deep reasoning' },
    { name: 'claude-sonnet-4-6', backend: 'claude', description: 'Fast + capable balance' },
    { name: 'claude-haiku-4-5-20251001', backend: 'claude', description: 'Fastest, lightweight' },
  ];
}

export async function listCodexModels(): Promise<ModelInfo[]> {
  // Check if codex CLI is available
  try {
    const { execSync } = await import('node:child_process');
    execSync('which codex', { stdio: 'ignore' });
    return [
      { name: 'codex', backend: 'codex', description: 'OpenAI Codex agent' },
    ];
  } catch {
    return [];
  }
}

export async function listAllModels(): Promise<ModelInfo[]> {
  const [ollama, mlx, claude, codex] = await Promise.all([
    listOllamaModels(),
    listMlxModels(),
    listClaudeModels(),
    listCodexModels(),
  ]);
  return [...ollama, ...mlx, ...claude, ...codex];
}

export function modelsToMenuItems(models: ModelInfo[]): MenuItem[] {
  return models.map((m) => ({
    label: m.name,
    value: `${m.backend}:${m.name}`,
    description: [m.backend, m.size, m.description].filter(Boolean).join(' · '),
    group: m.backend,
  }));
}
