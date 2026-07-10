import 'server-only';
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { appendCapabilityJob } from '@/lib/capabilities/local-store';

const execFileAsync = promisify(execFile);

const hiiRoot = '/Users/ummi/hii';
const spawnLogPath = path.join(hiiRoot, '.hii', 'terminal-spawns.jsonl');
const claudeBin = '/opt/homebrew/bin/claude';

export type ProcessLine = {
  pid: string;
  user: string;
  cpu: string;
  mem: string;
  command: string;
  raw: string;
  agent: boolean;
};

export type AgentSession = {
  id?: string;
  pid?: number;
  name?: string;
  cwd?: string;
  kind?: string;
  state?: string;
  status?: string;
  waitingFor?: string;
  sessionId?: string;
};

export type TerminalSnapshot = {
  capturedAt: string;
  host: string;
  processCount: number;
  agentCount: number;
  agents: AgentSession[];
  processes: ProcessLine[];
};

export type SpawnRequest = {
  preset: string;
  prompt: string;
  name?: string;
};

const tokenPatterns = [
  /((?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)=)([^\s]+)/gi,
  /((?:OPENAI|ANTHROPIC|SUPABASE|STRIPE|GITHUB|VERCEL|CLOUDFLARE|AWS)[A-Z0-9_]*=)([^\s]+)/g,
  /(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi,
  /(--(?:api-key|token|secret|password|auth|key)\s+)([^\s]+)/gi,
  /(sk-[A-Za-z0-9_-]{12,})/g,
  /(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/g
];

function truncateProcessText(value: string, maxLength = 720) {
  return value.length > maxLength ? `${value.slice(0, maxLength)} ...[truncated]` : value;
}

export function localTerminalAllowed(request: Request) {
  if (process.env.HII_LOCAL_TERMINAL_ENABLED === '1') return true;
  const host = request.headers.get('host') ?? '';
  const hostOk =
    host.startsWith('localhost:') || host.startsWith('127.0.0.1:') || host.startsWith('[::1]:');
  // Host alone is forgeable-by-default in a browser (any site can fetch
  // http://localhost:3000 and the browser sets Host for it). Origin is what
  // distinguishes our own pages from a cross-site request.
  const origin = request.headers.get('origin');
  const originOk =
    !origin ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:') ||
    origin.startsWith('http://[::1]:');
  return hostOk && originOk;
}

export function redactProcessLine(value: string) {
  const redacted = tokenPatterns.reduce(
    (current, pattern) =>
      current.replace(pattern, (_match, prefix) => (prefix ? `${prefix}[redacted]` : '[redacted]')),
    value
  );
  return truncateProcessText(redacted);
}

function parsePsLine(line: string): ProcessLine | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('USER ')) return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length < 11) {
    return {
      pid: '',
      user: '',
      cpu: '',
      mem: '',
      command: redactProcessLine(trimmed),
      raw: redactProcessLine(trimmed),
      agent: /claude|codex|hii|aii|termite|ollama|rhino/i.test(trimmed)
    };
  }

  const command = parts.slice(10).join(' ');
  const raw = redactProcessLine(trimmed);
  return {
    user: parts[0],
    pid: parts[1],
    cpu: parts[2],
    mem: parts[3],
    command: redactProcessLine(command),
    raw,
    agent: /claude|codex|hii|aii|termite|ollama|rhino|node.*next|python.*hii/i.test(trimmed)
  };
}

async function getHostName() {
  try {
    const result = await execFileAsync('hostname', [], { timeout: 2000, maxBuffer: 64 * 1024 });
    return result.stdout.trim() || 'localhost';
  } catch {
    return 'localhost';
  }
}

async function listProcesses() {
  const result = await execFileAsync('ps', ['auxww'], {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024
  });
  return result.stdout
    .split('\n')
    .map(parsePsLine)
    .filter((line): line is ProcessLine => Boolean(line));
}

async function listClaudeAgents(): Promise<AgentSession[]> {
  try {
    const result = await execFileAsync(claudeBin, ['agents', '--json'], {
      cwd: hiiRoot,
      timeout: 5000,
      maxBuffer: 512 * 1024
    });
    const parsed = JSON.parse(result.stdout) as AgentSession[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function getTerminalSnapshot(): Promise<TerminalSnapshot> {
  const [host, processes, agents] = await Promise.all([
    getHostName(),
    listProcesses(),
    listClaudeAgents()
  ]);

  return {
    capturedAt: new Date().toISOString(),
    host,
    processCount: processes.length,
    agentCount: agents.length,
    agents,
    processes
  };
}

function cleanSessionName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function presetPrompt(preset: string, prompt: string) {
  const base = prompt.trim();
  if (preset === 'observer') {
    return [
      'You are a read-only HII observer agent.',
      'Watch the local HII/AII/Termite workstation state and report actionable status.',
      'Do not edit files, do not touch secrets, do not push or commit.',
      base
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  if (preset === 'shipper') {
    return [
      'You are a bounded HII shipping agent.',
      'Improve the HII product surface only when the requested scope is clear.',
      'Do not delete or revert user work. Do not touch secrets. Verify with npm run build when editing HII.',
      base
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  if (preset === 'termite-demo') {
    return [
      'You are a Termite demo operator for HII.',
      'Prepare or monitor a Rhino/Termite alpha demo and report exact blockers and proof artifacts.',
      'Do not edit files unless explicitly asked. Do not touch secrets.',
      base
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  return base;
}

export async function spawnClaudeAgent(request: SpawnRequest) {
  const preset = ['observer', 'shipper', 'termite-demo', 'custom'].includes(request.preset)
    ? request.preset
    : 'observer';
  if (request.prompt.trim().length < 8) throw new Error('Prompt must be at least 8 characters.');
  const prompt = presetPrompt(preset, request.prompt).slice(0, 12000);

  const name = cleanSessionName(request.name || `hii-${preset}-${Date.now().toString(36)}`);
  const startedAt = new Date().toISOString();
  const args = [
    prompt,
    '--bg',
    '--safe-mode',
    '--model',
    'claude-fable-5',
    '--name',
    name,
    '--permission-mode',
    preset === 'observer' ? 'default' : 'auto'
  ];

  const result = await execFileAsync(claudeBin, args, {
    cwd: hiiRoot,
    timeout: 10000,
    maxBuffer: 512 * 1024
  });

  const output = redactProcessLine(`${result.stdout ?? ''}${result.stderr ?? ''}`.trim());
  const match = output.match(/backgrounded\s+·\s+([a-z0-9]+)/i);
  const run = {
    id: match?.[1] ?? null,
    name,
    preset,
    command: `${claudeBin} <prompt> --bg --safe-mode --model claude-fable-5 --name ${name}`,
    output,
    startedAt
  };

  await mkdir(path.dirname(spawnLogPath), { recursive: true });
  await appendFile(spawnLogPath, `${JSON.stringify(run)}\n`, 'utf8');
  const capabilityJobId = run.id ?? randomUUID();
  await appendCapabilityJob({
    id: capabilityJobId,
    capabilityId: 'hii.agent.spawn',
    inputSummary: `${preset}: ${prompt.slice(0, 240)}`,
    userId: 'local',
    userEmail: null,
    status: 'running',
    budget: 'local-operator',
    logs: [
      `[${startedAt}] spawned ${name}`,
      output || 'spawn request accepted'
    ],
    ledger: [
      {
        id: randomUUID(),
        jobId: capabilityJobId,
        capabilityId: 'hii.agent.spawn',
        actor: 'hii',
        type: 'approval',
        summary: `Local operator spawned preset ${preset}.`,
        createdAt: startedAt
      }
    ],
    proofArtifacts: [
      {
        id: randomUUID(),
        kind: 'log',
        label: 'Spawn receipt',
        summary: output || 'Claude session spawn request accepted.',
        createdAt: startedAt
      }
    ],
    createdAt: startedAt,
    updatedAt: startedAt,
    metadata: {
      preset,
      name
    }
  });
  return run;
}
