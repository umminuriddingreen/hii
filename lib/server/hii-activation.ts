import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { contextProjectState } from './hii-context-dock.ts';

const execFileAsync = promisify(execFile);

export type ActivationAgent = 'codex' | 'claude';

export type DetectedAgent = {
  id: 'codex' | 'claude' | 'ollama';
  installed: boolean;
  authenticated: boolean | null;
  version: string | null;
  detail: string | null;
};

type ProjectState = NonNullable<ReturnType<typeof contextProjectState>>;
type ProjectSource = {
  sourcePath: string;
  kind: string;
  format: string;
  approvedRoot: boolean;
  pinned: boolean;
  excluded: boolean;
};

type ActivationRecord = {
  id: string;
  projectId: string;
  agent: ActivationAgent;
  task: string;
  startedAt: string;
  status: 'running' | 'completed' | 'failed';
  receiptPath?: string;
};

const REPORTING_INSTRUCTIONS = [
  'After meaningful work, record a structured after-work receipt with `hii skill report`.',
  'Record exactly one receipt, only after verification — the activation status reads the newest receipt, so trial or duplicate receipts corrupt what the human reviews.',
  'Pass the project root as --coordinate so the receipt is attributed to the right project.',
  'Mark repeatable verified work with `--repeatable` to create a draft skill candidate; do not register, publish, sell, or license it yourself.'
];

function runtimeRoot() {
  return process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
}

function firstLine(value: string) {
  return value.trim().split(/\r?\n/, 1)[0]?.trim() || null;
}

async function detectBinary(
  id: DetectedAgent['id'],
  command: string,
  versionArgs: string[]
): Promise<DetectedAgent> {
  try {
    const result = await execFileAsync(command, versionArgs, {
      timeout: 5_000,
      maxBuffer: 512 * 1024
    });
    return {
      id,
      installed: true,
      authenticated: null,
      version: firstLine(`${result.stdout || ''}${result.stderr || ''}`),
      detail: null
    };
  } catch {
    return { id, installed: false, authenticated: null, version: null, detail: null };
  }
}

export async function detectAgents(): Promise<DetectedAgent[]> {
  const home = os.homedir();
  const pinnedCodex = path.join(home, '.local', 'bin', 'codex');
  const codexCommand = process.env.HII_CODEX_BIN || (existsSync(pinnedCodex) ? pinnedCodex : 'codex');
  const claudeCommand = process.env.HII_CLAUDE_BIN || '/opt/homebrew/bin/claude';
  const ollamaCommand = process.env.HII_OLLAMA_BIN || '/opt/homebrew/bin/ollama';
  const [codex, claude, ollama] = await Promise.all([
    detectBinary('codex', codexCommand, ['--version']),
    detectBinary('claude', claudeCommand, ['--version']),
    detectBinary('ollama', ollamaCommand, ['--version'])
  ]);

  if (ollama.installed) {
    try {
      const result = await execFileAsync(ollamaCommand, ['list'], {
        timeout: 5_000,
        maxBuffer: 2 * 1024 * 1024
      });
      const models = result.stdout
        .split(/\r?\n/)
        .slice(1)
        .map((line) => line.trim().split(/\s+/, 1)[0])
        .filter(Boolean);
      ollama.detail = models.length ? models.join(', ') : 'No local models';
    } catch {
      ollama.detail = 'Local models unavailable';
    }
  }

  return [codex, claude, ollama];
}

export function buildOrientationContract(input: {
  projectState: ProjectState;
  task: string;
  agent: ActivationAgent;
}) {
  const task = String(input.task || '').trim();
  if (!task) throw new Error('A bounded task is required.');
  const { project, lastScan } = input.projectState;
  const sources = input.projectState.sources as unknown as ProjectSource[];
  const topSources = sources
    .filter((source) => !source.excluded && source.approvedRoot)
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || String(left.sourcePath).localeCompare(String(right.sourcePath), 'en'))
    .slice(0, 12);
  const sourceLines = topSources.length
    ? topSources.map((source) => `- ${source.sourcePath} (${source.kind}, ${source.format}${source.pinned ? ', pinned' : ''})`)
    : ['- No indexed project sources are currently available.'];

  return [
    '# HII activation orientation',
    '',
    `Agent: ${input.agent}`,
    '',
    '## Project summary',
    '',
    `Project: ${project.name}`,
    `Approved project folder: ${project.rootPath}`,
    `Indexed sources: ${sources.filter((source) => !source.excluded).length}`,
    `Last scan: ${String(lastScan?.completedAt || lastScan?.startedAt || project.lastScannedAt || 'not scanned')}`,
    '',
    'Top sources:',
    ...sourceLines,
    '',
    '## Bounded task',
    '',
    task,
    '',
    '## Permission boundary',
    '',
    `Work only inside the approved project folder: ${project.rootPath}`,
    'Do not read, create, edit, move, or delete files outside that folder. Do not publish, push, upload, message, spend, or expose secrets.',
    '',
    '## Receipt instructions',
    '',
    ...REPORTING_INSTRUCTIONS
  ].join('\n');
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readActivation(activationId: string): Promise<ActivationRecord | null> {
  if (!/^[a-zA-Z0-9-]+$/.test(activationId)) return null;
  try {
    return JSON.parse(await readFile(path.join(runtimeRoot(), 'activations', `${activationId}.json`), 'utf8')) as ActivationRecord;
  } catch {
    return null;
  }
}

export async function startActivationRun(input: {
  projectId: string;
  agent: ActivationAgent;
  task: string;
}) {
  if (input.agent !== 'codex' && input.agent !== 'claude') throw new Error('Activation agent must be codex or claude.');
  const projectState = contextProjectState(String(input.projectId || '').trim());
  if (!projectState) throw new Error(`Context project not found: ${input.projectId}`);
  const task = String(input.task || '').trim();
  const prompt = buildOrientationContract({ projectState, task, agent: input.agent });
  const activationId = `activation-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const record: ActivationRecord = {
    id: activationId,
    projectId: projectState.project.id,
    agent: input.agent,
    task,
    startedAt,
    status: 'running'
  };
  await writeJson(path.join(runtimeRoot(), 'activations', `${activationId}.json`), record);

  try {
    if (input.agent === 'codex') {
      const runId = `codex-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const runsDir = path.join(runtimeRoot(), 'daemon', 'runs');
      await writeJson(path.join(runsDir, `${runId}.json`), {
        id: runId,
        kind: 'codex-run',
        status: 'queued',
        prompt,
        title: `Activation · ${projectState.project.name}`,
        coordinate: projectState.project.rootPath,
        cwd: projectState.project.rootPath,
        activationId,
        createdAt: startedAt,
        updatedAt: startedAt,
        autonomy: 'reversible-local',
        loop: ['observed request', 'queued managed Codex run'],
        log: path.join(runsDir, `${runId}.log`)
      });
    } else {
      const intent = {
        kind: 'agent.spawn',
        id: randomUUID(),
        preset: 'partner-onboard',
        prompt,
        name: `hii-activation-${activationId.slice(-8)}`,
        cwd: projectState.project.rootPath,
        activationId,
        requestedAt: startedAt,
        source: 'hii.activation'
      };
      const intentsPath = path.join(runtimeRoot(), 'daemon', 'intents.jsonl');
      await mkdir(path.dirname(intentsPath), { recursive: true });
      // Prime the daemon's cursor before appending (same as enqueueClaude in
      // hiid.mjs) — without it, hiid's first poll treats a fresh intents file
      // as history and silently drops the spawn.
      const cursorPath = path.join(runtimeRoot(), 'daemon', 'intents.cursor.json');
      if (!existsSync(cursorPath)) {
        let existingLines = 0;
        try {
          existingLines = (await readFile(intentsPath, 'utf8')).split('\n').filter(Boolean).length;
        } catch {
          existingLines = 0;
        }
        await writeFile(cursorPath, `${JSON.stringify({ processed: existingLines }, null, 2)}\n`, 'utf8');
      }
      await appendFile(intentsPath, `${JSON.stringify(intent)}\n`, 'utf8');
    }
  } catch (error) {
    record.status = 'failed';
    await writeJson(path.join(runtimeRoot(), 'activations', `${activationId}.json`), record);
    throw error;
  }

  return {
    activationId,
    startedAt,
    runKind: input.agent === 'codex' ? 'codex-exec' as const : 'claude-spawn' as const
  };
}

export async function readActivationReceipt(activationId: string) {
  const record = await readActivation(activationId);
  if (!record) return { status: 'unknown' as const, receipt: null };
  if (record.status === 'failed') return { status: 'failed' as const, receipt: null };
  if (record.status === 'completed' && record.receiptPath) {
    try {
      return {
        status: 'completed' as const,
        receipt: JSON.parse(await readFile(record.receiptPath, 'utf8')) as Record<string, unknown>
      };
    } catch {
      return { status: 'running' as const, receipt: null };
    }
  }

  // A failed daemon run would otherwise leave the wizard polling forever:
  // the receipt never appears, so cross-check the run linked to this activation.
  if (record.agent === 'codex') {
    try {
      const runsDir = path.join(runtimeRoot(), 'daemon', 'runs');
      for (const name of await readdir(runsDir)) {
        if (!name.endsWith('.json')) continue;
        const run = JSON.parse(await readFile(path.join(runsDir, name), 'utf8')) as Record<string, unknown>;
        if (run.activationId !== activationId) continue;
        if (run.status === 'failed') {
          await writeJson(path.join(runtimeRoot(), 'activations', `${activationId}.json`), {
            ...record,
            status: 'failed'
          });
          return { status: 'failed' as const, receipt: null };
        }
        break;
      }
    } catch {
      // runs dir unreadable — fall through to receipt polling
    }
  }

  try {
    const latestPath = path.join(runtimeRoot(), 'runs', 'cli', 'latest');
    const latest = (await readFile(latestPath, 'utf8')).trim();
    if (latest && !latest.includes('/') && latest !== '.' && latest !== '..') {
      const receiptPath = path.join(path.dirname(latestPath), latest, 'receipt.json');
      const receiptStat = await stat(receiptPath);
      if (receiptStat.mtimeMs > new Date(record.startedAt).getTime()) {
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
        await writeJson(path.join(runtimeRoot(), 'activations', `${activationId}.json`), {
          ...record,
          status: 'completed',
          receiptPath
        });
        return { status: 'completed' as const, receipt };
      }
    }
  } catch {
    // no CLI receipt — fall through to skill-report receipts
  }

  // `hii skill report` (the receipt path the orientation contract instructs)
  // appends to skills/actions.jsonl rather than runs/cli — accept the newest
  // matching entry recorded after this activation started.
  const actionReceipt = await readSkillActionReceipt(record);
  if (actionReceipt) {
    const receiptPath = path.join(runtimeRoot(), 'activations', `${activationId}.receipt.json`);
    await writeJson(receiptPath, actionReceipt);
    await writeJson(path.join(runtimeRoot(), 'activations', `${activationId}.json`), {
      ...record,
      status: 'completed',
      receiptPath
    });
    return { status: 'completed' as const, receipt: actionReceipt };
  }
  return { status: 'running' as const, receipt: null };
}

async function readSkillActionReceipt(record: ActivationRecord): Promise<Record<string, unknown> | null> {
  try {
    const actionsPath = path.join(runtimeRoot(), 'skills', 'actions.jsonl');
    const lines = (await readFile(actionsPath, 'utf8')).trim().split('\n');
    const startedMs = new Date(record.startedAt).getTime();
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(lines[i]) as Record<string, unknown>;
      } catch {
        continue;
      }
      const createdMs = new Date(String(entry.createdAt ?? '')).getTime();
      // entries append chronologically — anything at or before start ends the scan
      if (!Number.isFinite(createdMs) || createdMs <= startedMs) break;
      const agent = entry.agent as { id?: string } | undefined;
      if (agent?.id && agent.id !== record.agent) continue;
      return entry;
    }
    return null;
  } catch {
    return null;
  }
}
