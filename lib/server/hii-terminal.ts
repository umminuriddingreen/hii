import 'server-only';
import { appendFile, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { appendCapabilityJob } from '@/lib/capabilities/local-store';

const execFileAsync = promisify(execFile);

const runtimeRoot = process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
const hiiRoot = process.env.HII_ROOT || process.cwd();
const spawnLogPath = path.join(runtimeRoot, 'terminal-spawns.jsonl');
const claudeBin = process.env.HII_CLAUDE_BIN || (process.platform === 'win32' ? 'claude' : '/opt/homebrew/bin/claude');

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
  if (process.env.HII_LOCAL_TERMINAL_ENABLED === '1' || process.env.HII_TAURI === '1') return true;
  const host = request.headers.get('host') ?? '';
  let requestHostname = '';
  try {
    requestHostname = new URL(request.url).hostname;
  } catch {
    // A malformed URL must not expand local authority.
  }
  const hostOk =
    host === 'localhost' ||
    host.startsWith('localhost:') ||
    host === '127.0.0.1' ||
    host.startsWith('127.0.0.1:') ||
    host === '[::1]' ||
    host.startsWith('[::1]:') ||
    (!host && ['localhost', '127.0.0.1', '[::1]'].includes(requestHostname));
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
      agent: /claude|codex|hii|aii|ollama|rhino/i.test(trimmed)
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
    agent: /claude|codex|hii|aii|ollama|rhino|node.*next|python.*hii/i.test(trimmed)
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
  if (process.platform === 'win32') {
    const result = await execFileAsync('tasklist.exe', ['/FO', 'CSV', '/NH'], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024
    });
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const fields = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
        const command = redactProcessLine(fields[0] || line);
        return {
          pid: fields[1] || '', user: '', cpu: '', mem: fields[4] || '', command,
          raw: redactProcessLine(line),
          agent: /claude|codex|hii|aii|ollama|rhino|node/i.test(command)
        } satisfies ProcessLine;
      });
  }
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

// Per docs/aii-hii-boundary.md, HII no longer executes agent spawns. The
// surface validates and appends an intent to ~/.hii/daemon/intents.jsonl;
// hiid (HII) picks it up within its 3s tick, runs the claude CLI, and updates
// the capability job record (same id, last-write-wins in the jobs ledger).
export async function spawnClaudeAgent(request: SpawnRequest) {
  const preset = ['observer', 'shipper', 'rhino-demo', 'custom'].includes(request.preset)
    ? request.preset
    : 'observer';
  if (request.prompt.trim().length < 8) throw new Error('Prompt must be at least 8 characters.');

  const name = cleanSessionName(request.name || `hii-${preset}-${Date.now().toString(36)}`);
  const requestedAt = new Date().toISOString();
  const intent = {
    kind: 'agent.spawn',
    id: randomUUID(),
    preset,
    prompt: request.prompt.trim().slice(0, 12000),
    name,
    requestedAt,
    source: 'hii.terminal'
  };

  const intentsPath = path.join(
    runtimeRoot,
    'daemon',
    'intents.jsonl'
  );
  await mkdir(path.dirname(intentsPath), { recursive: true });
  await appendFile(intentsPath, `${JSON.stringify(intent)}\n`, 'utf8');

  const run = {
    id: intent.id,
    name,
    preset,
    command: 'intent → runtime/daemon/hiid.mjs',
    output: 'spawn intent queued — hiid executes within a few seconds',
    startedAt: requestedAt
  };
  await mkdir(path.dirname(spawnLogPath), { recursive: true });
  await appendFile(spawnLogPath, `${JSON.stringify(run)}\n`, 'utf8');

  await appendCapabilityJob({
    id: intent.id,
    capabilityId: 'hii.agent.spawn',
    inputSummary: `${preset}: ${intent.prompt.slice(0, 240)}`,
    userId: 'local',
    userEmail: null,
    status: 'queued',
    budget: 'local-operator',
    logs: [`[${requestedAt}] spawn intent ${intent.id} queued for hiid`],
    ledger: [
      {
        id: randomUUID(),
        jobId: intent.id,
        capabilityId: 'hii.agent.spawn',
        actor: 'hii',
        type: 'approval',
        summary: `Local operator queued spawn intent (preset ${preset}).`,
        createdAt: requestedAt
      }
    ],
    proofArtifacts: [],
    createdAt: requestedAt,
    updatedAt: requestedAt,
    metadata: { preset, name }
  });
  return run;
}
