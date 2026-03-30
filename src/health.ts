import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from './config.js';
import { currentGeneration, listGenerations } from './generations.js';
import { listRemotes } from './remote.js';
import { getSpaceHealth } from './tools/space.js';

const execFileAsync = promisify(execFile);

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command]);
    return true;
  } catch {
    return false;
  }
}

function pathState(target: string) {
  return {
    path: target,
    exists: fs.existsSync(target),
  };
}

export async function getHiiHealth() {
  const repoRoot = process.cwd();
  const cfg = loadConfig();
  const [space, ollamaInstalled] = await Promise.all([
    getSpaceHealth().catch((error) => ({
      backend: 'none' as const,
      installed: false,
      running: false,
      error: error instanceof Error ? error.message : String(error),
    })),
    commandExists('ollama'),
  ]);

  const generation = currentGeneration(repoRoot);
  const remotes = listRemotes();

  return {
    ok: true,
    timestamp: new Date().toISOString(),
    runtime: {
      ollamaInstalled,
      memoryEnabled: cfg.memoryEnabled !== false,
      allowSearch: cfg.allowSearch,
      allowShell: cfg.allowShell,
      offline: cfg.offline,
    },
    paths: {
      db: pathState(cfg.dbPath),
      workspace: pathState(cfg.workspacePath),
      sessions: pathState(cfg.sessionsPath),
      notes: pathState(cfg.notesPath),
      obsidianVault: cfg.obsidianVaultPath ? pathState(cfg.obsidianVaultPath) : null,
    },
    generation: generation
      ? {
          id: generation.id,
          name: generation.name,
          capturedAt: generation.createdAt,
          total: listGenerations(repoRoot).length,
        }
      : {
          id: null,
          name: null,
          total: listGenerations(repoRoot).length,
        },
    remotes: {
      total: remotes.length,
      names: remotes.map((remote) => remote.slug),
    },
    desktop: {
      space,
    },
  };
}
