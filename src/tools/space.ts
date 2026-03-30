import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type SpaceHealth = {
  backend: 'aerospace' | 'none';
  installed: boolean;
  running: boolean;
  binary?: string;
  configPath?: string;
  error?: string;
};

export type SpaceSnapshot = {
  backend: 'aerospace';
  monitors: unknown[];
  workspaces: unknown[];
  windows: unknown[];
};

export type SpaceApps = {
  backend: 'aerospace';
  apps: string[];
};

function parseCliError(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const maybe = error as { stderr?: string; stdout?: string; message?: string };
  return maybe.stderr?.trim() || maybe.stdout?.trim() || maybe.message || String(error);
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command]);
    return true;
  } catch {
    return false;
  }
}

async function runAerospace(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('aerospace', args);
  return stdout.trim();
}

async function aerospaceConfigPath(): Promise<string | undefined> {
  try {
    return await runAerospace(['config', '--config-path']);
  } catch {
    return undefined;
  }
}

export async function getSpaceHealth(): Promise<SpaceHealth> {
  const installed = await commandExists('aerospace');
  if (!installed) {
    return { backend: 'none', installed: false, running: false, error: 'AeroSpace is not installed' };
  }

  try {
    await runAerospace(['list-workspaces', '--focused']);
    return {
      backend: 'aerospace',
      installed: true,
      running: true,
      binary: 'aerospace',
      configPath: await aerospaceConfigPath(),
    };
  } catch (error) {
    return {
      backend: 'aerospace',
      installed: true,
      running: false,
      binary: 'aerospace',
      configPath: await aerospaceConfigPath(),
      error: parseCliError(error),
    };
  }
}

async function readAerospaceJson(args: string[]): Promise<unknown[]> {
  const raw = await runAerospace([...args, '--json']);
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function getSpaceSnapshot(): Promise<SpaceSnapshot> {
  const health = await getSpaceHealth();
  if (!health.installed) throw new Error('AeroSpace is not installed');
  if (!health.running) throw new Error(health.error || 'AeroSpace is not running');

  const [monitors, workspaces, windows] = await Promise.all([
    readAerospaceJson(['list-monitors']),
    readAerospaceJson(['list-workspaces', '--all']),
    readAerospaceJson(['list-windows', '--all']),
  ]);

  return {
    backend: 'aerospace',
    monitors,
    workspaces,
    windows,
  };
}

export async function focusSpaceWindow(windowId: string): Promise<{ ok: true; windowId: string }> {
  await runAerospace(['focus', '--window-id', windowId]);
  return { ok: true, windowId };
}

export async function switchSpaceWorkspace(workspace: string): Promise<{ ok: true; workspace: string }> {
  await runAerospace(['workspace', workspace]);
  return { ok: true, workspace };
}

export async function listSpaceApps(): Promise<SpaceApps> {
  const health = await getSpaceHealth();
  if (!health.installed) throw new Error('AeroSpace is not installed');
  if (!health.running) throw new Error(health.error || 'AeroSpace is not running');
  const raw = await runAerospace(['list-apps']);
  const apps = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return { backend: 'aerospace', apps };
}

export async function focusSpaceMonitor(target: string): Promise<{ ok: true; target: string }> {
  await runAerospace(['focus-monitor', target]);
  return { ok: true, target };
}

export async function moveSpaceWindowToWorkspace(workspace: string): Promise<{ ok: true; workspace: string }> {
  await runAerospace(['move-node-to-workspace', workspace]);
  return { ok: true, workspace };
}

export async function moveSpaceWorkspaceToMonitor(target: string): Promise<{ ok: true; target: string }> {
  await runAerospace(['move-workspace-to-monitor', target]);
  return { ok: true, target };
}

export async function reloadSpaceConfig(): Promise<{ ok: true }> {
  await runAerospace(['reload-config']);
  return { ok: true };
}

export async function balanceSpaceSizes(): Promise<{ ok: true }> {
  await runAerospace(['balance-sizes']);
  return { ok: true };
}
