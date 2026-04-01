import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export type Config = {
  chatBackend: 'codex' | 'mlx';
  baseModel: string;
  coderModel: string;
  embedModel: string;
  mlxModel: string;
  dbPath: string;
  workspacePath: string;
  sessionsPath: string;
  memoryPath: string;
  memoryEnabled?: boolean;
  memoryMaxEntries?: number;
  obsidianVaultPath?: string;
  allowShell: boolean;
  allowSearch: boolean;
  offline: boolean;
  lmStudioUrl: string;
  lmStudioApiKey?: string;
  lmStudioChatModel: string;
  lmStudioTranscribeModel: string;
  notesPath: string;
};

const defaultConfig: Config = {
  chatBackend: 'codex',
  baseModel: process.env.AGENT_BASE_MODEL || 'codex',
  coderModel: process.env.AGENT_CODER_MODEL || 'deepseek-coder-v2:16b',
  embedModel: process.env.AGENT_EMBED_MODEL || 'nomic-embed-text',
  mlxModel: process.env.HII_MLX_MODEL || 'mlx-community/AceReason-Nemotron-1.1-7B-4bit',
  dbPath: path.resolve(process.cwd(), 'data'),
  workspacePath: path.resolve(process.cwd(), 'workspace'),
  sessionsPath: path.resolve(process.cwd(), 'sessions'),
  memoryPath: process.env.HII_MEMORY_PATH || path.join(os.homedir(), '.hii', 'memory'),
  memoryEnabled: true,
  memoryMaxEntries: 30,
  obsidianVaultPath: process.env.HII_OBSIDIAN_VAULT,
  allowShell: false,
  allowSearch: false,
  offline: true,
  lmStudioUrl: process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234/v1',
  lmStudioApiKey: process.env.LM_STUDIO_API_KEY,
  lmStudioChatModel: process.env.LM_STUDIO_CHAT_MODEL || 'lmstudio-community/Meta-Llama-3-8B-Instruct',
  lmStudioTranscribeModel: process.env.LM_STUDIO_TRANSCRIBE_MODEL || 'whisper-large-v3',
  notesPath: process.env.HII_NOTES_PATH || path.resolve(process.cwd(), 'notes')
};

export function loadConfig(): Config {
  const configPath = path.resolve(process.cwd(), 'agent.config.json');
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const chatBackend = parsed.chatBackend === 'mlx' ? 'mlx' : 'codex';
    const baseModel = parsed.baseModel && parsed.baseModel !== 'nemotron-cascade-2:latest'
      ? parsed.baseModel
      : defaultConfig.baseModel;
    return {
      ...defaultConfig,
      ...parsed,
      chatBackend,
      baseModel,
    } as Config;
  }
  return defaultConfig;
}

export function saveConfig(cfg: Partial<Config>): void {
  const merged = {
    ...defaultConfig,
    ...cfg,
    chatBackend: cfg.chatBackend === 'mlx' ? 'mlx' : 'codex',
  };
  const configPath = path.resolve(process.cwd(), 'agent.config.json');
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
}
