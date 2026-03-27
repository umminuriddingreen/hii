import path from 'node:path';
import fs from 'node:fs';

export type Config = {
  baseModel: string;
  coderModel: string;
  embedModel: string;
  dbPath: string;
  workspacePath: string;
  sessionsPath: string;
  obsidianVaultPath?: string;
  memoryEnabled?: boolean;
  memoryMaxEntries?: number;
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
  baseModel: process.env.AGENT_BASE_MODEL || 'qwen2.5:32b',
  coderModel: process.env.AGENT_CODER_MODEL || 'deepseek-coder-v2:16b',
  embedModel: process.env.AGENT_EMBED_MODEL || 'nomic-embed-text',
  dbPath: path.resolve(process.cwd(), 'data'),
  workspacePath: path.resolve(process.cwd(), 'workspace'),
  sessionsPath: path.resolve(process.cwd(), 'sessions'),
  obsidianVaultPath: process.env.HII_OBSIDIAN_VAULT || '/Users/ummi/Library/Mobile Documents/iCloud~md~obsidian/Documents/hii/hii',
  memoryEnabled: true,
  memoryMaxEntries: 20,
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
    return { ...defaultConfig, ...parsed } as Config;
  }
  return defaultConfig;
}

export function saveConfig(cfg: Partial<Config>): void {
  const merged = { ...defaultConfig, ...cfg };
  const configPath = path.resolve(process.cwd(), 'agent.config.json');
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
}
