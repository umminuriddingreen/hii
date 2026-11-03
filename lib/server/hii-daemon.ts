import 'server-only';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { redactProcessLine } from '@/lib/server/hii-terminal';
import { visibleRunOutput } from '@/lib/workspace/run-output';
import { listCapabilityJobs } from '@/lib/capabilities/local-store';
import { summarizeHiiDaemonHealth } from '@/lib/workspace/daemon-health';
import { homeDirectory, runtimeRoot } from './runtime-root.ts';

const execFileAsync = promisify(execFile);

const home = homeDirectory();
const hiiRootCandidates = [process.env.HII_ROOT, process.cwd(), path.join(home, 'hii')].filter(
  (candidate): candidate is string => Boolean(candidate)
);
const hiiRoot = hiiRootCandidates.find((candidate) => existsSync(path.join(candidate, 'runtime', 'daemon', 'hiid.mjs'))) ?? hiiRootCandidates[0] ?? process.cwd();
const runtime = runtimeRoot();
const daemonDir = path.join(runtime, 'daemon');
const runsDir = path.join(daemonDir, 'runs');
const statusPath = path.join(daemonDir, 'status.json');
const instancesPath = path.join(daemonDir, 'instances.json');
const eventsPath = path.join(daemonDir, 'events.jsonl');
const daemonLogPath = path.join(daemonDir, 'daemon.log');
const hiidScript = path.join(hiiRoot, 'runtime', 'daemon', 'hiid.mjs');

function nodeRuntime() {
  const candidates = [
    process.env.HII_NODE_RUNTIME,
    // The packaged app runs under its own Node; the absolute paths below are
    // a macOS/Linux courtesy for a stripped environment, not a Windows path.
    process.execPath,
    '/opt/homebrew/opt/node/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node'
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('HII could not find a working Node runtime. Reinstall the HII app and try again.');
  return found;
}

export type HiiDaemonEvent = {
  id: string;
  ts: string;
  source: string;
  type: string;
  actor?: string;
  target?: string;
  status?: string;
  text?: string;
  loop?: string;
  pid?: number;
  exitCode?: number;
};

export type HiiDaemonInstance = {
  id: string;
  type: string;
  title?: string;
  pid?: number | null;
  status: string;
  owned?: boolean;
  autonomy?: string;
  coordinate?: string;
  heartbeatAt?: string | null;
  runId?: string;
  command?: string;
};

export type HiiDaemonRun = {
  id: string;
  kind: string;
  status: string;
  prompt: string;
  title?: string;
  coordinate?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  log?: string;
  pid?: number | null;
  autonomy?: string;
  loop?: string[];
  output?: string;
  visibleOutput?: string;
  outputBytes?: number;
};

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as T;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is T => entry !== null);
  } catch {
    return [];
  }
}

async function readRuns(): Promise<HiiDaemonRun[]> {
  try {
    const names = await readdir(runsDir);
    const runs = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map((name) => readJson<HiiDaemonRun | null>(path.join(runsDir, name), null))
    );
    return runs
      .filter((run): run is HiiDaemonRun => Boolean(run))
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  } catch {
    return [];
  }
}

async function readDaemonOutput() {
  try {
    return (await readFile(daemonLogPath, 'utf8'))
      .split('\n')
      .slice(-320)
      .map((line) => redactProcessLine(line))
      .join('\n')
      .trim();
  } catch {
    return '';
  }
}

async function pidAlive(pid: number | null | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

export async function getHiiDaemonSnapshot() {
  const status = await readJson<Record<string, unknown>>(statusPath, {});
  const instancesDoc = await readJson<{ instances?: HiiDaemonInstance[] }>(instancesPath, { instances: [] });
  const events = (await readJsonl<HiiDaemonEvent>(eventsPath)).slice(-120).reverse();
  const runs = (await readRuns()).slice(0, 40);
  const workspaceJobs = (await listCapabilityJobs({ limit: 500 }))
    .filter((job) => job.capabilityId === 'hii.agent.workspace_run');
  const alive = await pidAlive(typeof status.pid === 'number' ? status.pid : null);
  const rawOutput = await readDaemonOutput();
  const instances = instancesDoc.instances ?? [];
  const health = summarizeHiiDaemonHealth({
    alive,
    status,
    instances,
    runs,
    workspaceJobs,
    events
  });

  return {
    alive,
    health,
    status: {
      state: alive ? status.state || 'running' : 'stopped',
      pid: alive ? status.pid ?? null : null,
      updatedAt: status.updatedAt ?? null,
      autonomy: status.autonomy ?? 'reversible-local',
      policy: status.policy ?? null,
      counts: status.counts ?? {
        instances: instancesDoc.instances?.length ?? 0,
        active: instancesDoc.instances?.filter((item) => item.status === 'running').length ?? 0,
        blocked: instancesDoc.instances?.filter((item) => ['blocked', 'failed'].includes(item.status)).length ?? 0,
        queued: runs.filter((run) => run.status === 'queued').length,
        events: events.length
      },
      runtime: daemonDir
    },
    instances,
    events,
    runs,
    rawOutput,
    rawOutputPath: daemonLogPath
  };
}

export async function controlHiiDaemon(action: string, body: Record<string, unknown> = {}) {
  const args: string[] = [];
  if (['start', 'stop', 'restart', 'status', 'feed', 'instances', 'runs'].includes(action)) {
    args.push(action);
  } else if (action === 'codex.run') {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) throw new Error('Prompt required.');
    args.push('codex', 'run', prompt);
  } else if (action === 'codex.stop') {
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) throw new Error('Run id required.');
    args.push('codex', 'stop', id);
  } else if (action === 'config.set') {
    const configPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!/^(?:surfaces\.[a-z0-9_-]+\.enabled|defaults\.homepage)$/.test(configPath)) {
      throw new Error('Unsupported HII config path.');
    }
    args.push('config', 'set', configPath, JSON.stringify(body.value));
  } else {
    throw new Error(`Unsupported daemon action: ${action}`);
  }

  await mkdir(daemonDir, { recursive: true });
  if (!existsSync(hiidScript)) {
    throw new Error('HII local runtime is incomplete. Reinstall HII.app, then try again.');
  }
  const result = await execFileAsync(nodeRuntime(), [hiidScript, ...args], {
    cwd: hiiRoot,
    env: { ...process.env, HII_ROOT: hiiRoot },
    timeout: action === 'restart' ? 5000 : 8000,
    maxBuffer: 1024 * 1024
  });
  return {
    action,
    runId: action === 'codex.run' ? result.stdout.match(/codex-[a-z0-9-]+/i)?.[0] ?? null : null,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

export async function getHiiDaemonRun(id: string) {
  if (!/^codex-[a-z0-9-]+$/i.test(id)) return null;
  const run = await readJson<HiiDaemonRun | null>(path.join(runsDir, `${id}.json`), null);
  if (!run) return null;
  let output = '';
  if (run.log) {
    try {
      output = (await readFile(run.log, 'utf8')).slice(-120_000);
    } catch {
      /* the queued run may not have opened its log yet */
    }
  }
  return {
    ...run,
    output,
    visibleOutput: visibleRunOutput(output),
    outputBytes: Buffer.byteLength(output)
  };
}

export async function createDaemonFeedPin(event: HiiDaemonEvent) {
  await mkdir(daemonDir, { recursive: true });
  const pinPath = path.join(daemonDir, 'pinned-events.jsonl');
  await writeFile(pinPath, `${JSON.stringify({ ...event, pinnedAt: new Date().toISOString() })}\n`, {
    flag: 'a'
  });
}
