import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import { chat as ollamaChat } from './ollama.js';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: any[];
};

export type ChatBackend = 'ollama' | 'mlx';

export type ChatOptions = {
  stream?: boolean;
  temperature?: number;
  tools?: any[];
  maxTokens?: number;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const MLX_RUNNER = path.resolve(__dirname, '../../scripts/mlx_chat.py');
const LOCAL_MLX_PYTHON = path.join(REPO_ROOT, '.venv-mlx', 'bin', 'python3');

export function resolveChatBackend(cfg: Config): ChatBackend {
  return cfg.chatBackend || 'ollama';
}

export function resolveChatModel(cfg: Config): string {
  return resolveChatBackend(cfg) === 'mlx'
    ? (cfg.mlxModel || cfg.baseModel)
    : cfg.baseModel;
}

export async function chatWithConfig(
  cfg: Config,
  messages: ChatMessage[],
  options?: ChatOptions,
): Promise<{ text: string }> {
  const backend = resolveChatBackend(cfg);
  const model = resolveChatModel(cfg);
  if (backend === 'mlx') return mlxChat(model, messages, options);
  return ollamaChat(model, messages, options);
}

export async function mlxChat(
  model: string,
  messages: ChatMessage[],
  options?: ChatOptions,
): Promise<{ text: string }> {
  const pythonBin = process.env.MLX_PYTHON_BIN
    || (fs.existsSync(LOCAL_MLX_PYTHON) ? LOCAL_MLX_PYTHON : 'python3');
  const payload = JSON.stringify({
    model,
    messages,
    temperature: options?.temperature ?? 0.2,
    max_tokens: options?.maxTokens ?? Number(process.env.HII_MLX_MAX_TOKENS || 800),
  });

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, [MLX_RUNNER], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (error) => reject(error));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`MLX chat error: ${stderr.trim() || `runner exited with code ${code}`}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve({ text: String(parsed?.text || '') });
      } catch (error: any) {
        reject(new Error(`MLX chat parse error: ${error?.message || String(error)}`));
      }
    });

    proc.stdin.write(payload);
    proc.stdin.end();
  });
}
