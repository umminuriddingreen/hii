import 'server-only';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Thin read client per docs/aii-hii-boundary.md: AII (hiid) owns
// ~/.hii/config.json and mutates it via `hiid config set`; HII surfaces only
// read it and render accordingly. Defaults here mirror hiid's DEFAULT_CONFIG
// so surfaces behave sanely before the daemon has ever run.
export type HiiSurfaceConfig = {
  enabled: boolean;
  [key: string]: unknown;
};

export type HiiConfig = {
  version: number;
  updatedAt: string | null;
  updatedBy: string;
  defaults: { homepage: string; [key: string]: unknown };
  surfaces: Record<string, HiiSurfaceConfig>;
  agentNotes: unknown[];
};

const configPath = path.join(
  process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii'),
  'config.json'
);

const fallbackConfig: HiiConfig = {
  version: 1,
  updatedAt: null,
  updatedBy: 'aii.hiid',
  defaults: { homepage: 'canvas' },
  surfaces: {
    canvas: { enabled: true },
    terminal: { enabled: true, defaultCwd: '~' },
    boards: { enabled: true },
    feed: { enabled: true }
  },
  agentNotes: []
};

export function readHiiConfig(): HiiConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.surfaces) {
      return { ...fallbackConfig, ...parsed };
    }
  } catch {
    /* fall through to defaults */
  }
  return fallbackConfig;
}

export function surfaceEnabled(name: string) {
  return readHiiConfig().surfaces[name]?.enabled !== false;
}
