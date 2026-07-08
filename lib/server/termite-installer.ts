import 'server-only';
import { access, appendFile, mkdir, stat } from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const termiteRoot = '/Users/ummi/Termite';
const hiiRoot = '/Users/ummi/hii';
const runLogPath = path.join(hiiRoot, '.hii', 'termite-installer-runs.jsonl');

export type InstallerState = {
  checkedAt: string;
  termiteRoot: string;
  alphaZip: boolean;
  stagedRelease: boolean;
  rhinoApp: boolean;
  rhinoPlugin: boolean;
};

export type InstallerAction = {
  id: string;
  label: string;
  description: string;
};

export type InstallerRun = {
  actionId: string;
  command: string;
  exitCode: number;
  output: string;
  startedAt: string;
  finishedAt: string;
};

type CommandSpec = InstallerAction & {
  cwd: string;
  command: string;
  args: string[];
  timeoutMs: number;
};

const actions: CommandSpec[] = [
  {
    id: 'hii-health',
    label: 'Check HII capabilities',
    description: 'Confirm local HII and Ollama capability state.',
    cwd: hiiRoot,
    command: '/Users/ummi/bin/hii',
    args: ['health', '--text'],
    timeoutMs: 15000
  },
  {
    id: 'termite-typecheck',
    label: 'Typecheck Termite',
    description: 'Run the MCP server TypeScript typecheck.',
    cwd: termiteRoot,
    command: 'npm',
    args: ['run', 'typecheck'],
    timeoutMs: 30000
  },
  {
    id: 'termite-build',
    label: 'Build Termite',
    description: 'Build the Termite MCP server.',
    cwd: termiteRoot,
    command: 'npm',
    args: ['run', 'build'],
    timeoutMs: 30000
  },
  {
    id: 'termite-stage',
    label: 'Stage alpha release',
    description: 'Build release artifacts for the Rhino bridge and MCP server.',
    cwd: termiteRoot,
    command: 'npm',
    args: ['run', 'release:stage'],
    timeoutMs: 60000
  },
  {
    id: 'termite-install-mac',
    label: 'Install Rhino bridge',
    description: 'Install the local macOS Rhino 8 bridge bundle.',
    cwd: termiteRoot,
    command: 'npm',
    args: ['run', 'install:rhino-mac'],
    timeoutMs: 60000
  },
  {
    id: 'open-rhino',
    label: 'Open Rhino 8',
    description: 'Open Rhino 8 so the user can run StartTermiteBridge.',
    cwd: termiteRoot,
    command: 'open',
    args: ['-a', 'Rhino 8'],
    timeoutMs: 15000
  },
  {
    id: 'termite-doctor',
    label: 'Run doctor',
    description: 'Verify the bridge with the default READ_ONLY permission.',
    cwd: termiteRoot,
    command: 'node',
    args: ['apps/mcp-server/dist/index.js', 'doctor'],
    timeoutMs: 30000
  },
  {
    id: 'termite-doctor-edit-safe',
    label: 'Run EDIT_SAFE doctor',
    description: 'Verify the bridge for safe geometry testing.',
    cwd: termiteRoot,
    command: '/bin/zsh',
    args: ['-lc', 'RHINO_MCP_PERMISSION=EDIT_SAFE node apps/mcp-server/dist/index.js doctor'],
    timeoutMs: 30000
  }
];

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function listInstallerActions(): InstallerAction[] {
  return actions.map(({ id, label, description }) => ({ id, label, description }));
}

export async function getInstallerState(): Promise<InstallerState> {
  const alphaZipPath = path.join(hiiRoot, 'public/downloads/termite-alpha-macos.zip');
  const releasePath = path.join(termiteRoot, 'outputs/release');
  const rhinoAppPath = '/Applications/Rhino 8.app';
  const rhinoPluginPath =
    '/Users/ummi/Library/Application Support/McNeel/Rhinoceros/8.0/MacPlugIns/termite.rhp';

  return {
    checkedAt: new Date().toISOString(),
    termiteRoot,
    alphaZip: await exists(alphaZipPath),
    stagedRelease: await exists(releasePath),
    rhinoApp: await exists(rhinoAppPath),
    rhinoPlugin: await exists(rhinoPluginPath)
  };
}

export async function runInstallerAction(actionId: string): Promise<InstallerRun> {
  const spec = actions.find((action) => action.id === actionId);
  if (!spec) throw new Error('Unknown installer action.');

  const startedAt = new Date().toISOString();
  let exitCode = 0;
  let output = '';

  try {
    const result = await execFileAsync(spec.command, spec.args, {
      cwd: spec.cwd,
      timeout: spec.timeoutMs,
      maxBuffer: 1024 * 1024
    });
    output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  } catch (error) {
    exitCode = (error as { code?: number }).code ?? 1;
    const err = error as { stdout?: string; stderr?: string; message?: string };
    output = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ? `\n${err.message}` : ''}`.trim();
  }

  const finishedAt = new Date().toISOString();
  const run: InstallerRun = {
    actionId,
    command: [spec.command, ...spec.args].join(' '),
    exitCode,
    output: output.slice(0, 12000),
    startedAt,
    finishedAt
  };

  await mkdir(path.dirname(runLogPath), { recursive: true });
  await appendFile(runLogPath, `${JSON.stringify(run)}\n`, 'utf8');
  return run;
}

export async function getAlphaZipSize() {
  try {
    const info = await stat(path.join(hiiRoot, 'public/downloads/termite-alpha-macos.zip'));
    return info.size;
  } catch {
    return 0;
  }
}
