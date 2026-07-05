import 'server-only';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import capabilities from '@/lib/capabilities/registry.json';

const root = path.join(os.homedir(), 'hii');
const runtime = path.join(os.homedir(), '.hii');
const bridgeLog = path.join(runtime, 'bridge', 'yin-codex.jsonl');
const localJobs = path.join(root, '.hii', 'capability-jobs.jsonl');
const ogEvents = path.join(runtime, 'og', 'events.jsonl');

function redactText(value: string) {
  return value
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)=)([^\s]+)/gi, '$1[redacted]')
    .replace(/((?:OPENAI|ANTHROPIC|SUPABASE|STRIPE|GITHUB|VERCEL|CLOUDFLARE|AWS)[A-Z0-9_]*=)([^\s]+)/g, '$1[redacted]')
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, '$1[redacted]')
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[redacted]')
    .slice(0, 2000);
}

function readJsonl(file: string) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  } catch {
    return [];
  }
}

function fileSummary(file: string) {
  try {
    const stat = fs.statSync(file);
    return { path: file, exists: true, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
  } catch {
    return { path: file, exists: false };
  }
}

function gitSnapshot() {
  try {
    const branch = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8'
    }).trim();
    const status = execFileSync('git', ['-C', root, 'status', '--short'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(redactText);
    const recent = execFileSync('git', ['-C', root, 'log', '--oneline', '-5'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    return { branch, status, recent };
  } catch {
    return { branch: 'unknown', status: [], recent: [] };
  }
}

function inferNextActions(input: string) {
  const git = gitSnapshot();
  const text = `${input} ${git.status.join(' ')}`.toLowerCase();
  const actions = [];
  if (git.status.length > 0) {
    actions.push({
      score: 95,
      track: 'repo hygiene',
      next: 'review dirty files, commit product changes, leave local/private files untracked'
    });
  }
  if (text.includes('og') || text.includes('context') || text.includes('agent')) {
    actions.push({
      score: 92,
      track: 'operational graph',
      next: 'capture this turn and use local context to rank the next path'
    });
  }
  actions.push(
    {
      score: 62,
      track: 'Termite capability',
      next: 'keep Termite as the first proof capability with logs and artifacts'
    },
    {
      score: 55,
      track: 'HII exchange spine',
      next: 'preserve upload and exchange links while the new command surface evolves'
    }
  );
  return actions.sort((a, b) => b.score - a.score).slice(0, 4);
}

export function getHiiAgentContext() {
  const git = gitSnapshot();
  const jobs = readJsonl(localJobs).slice(-10);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    identity: {
      name: 'hii',
      repo: root,
      runtime,
      role: 'hyper-basic command surface over backend capabilities'
    },
    git,
    commands: ['/og', '/context', '/terminal', '/credits', '/termite', '/upload'],
    capabilities: capabilities.map((capability) => ({
      id: capability.id,
      name: capability.name,
      status: capability.status,
      summary: capability.summary
    })),
    localState: {
      bridge: fileSummary(bridgeLog),
      jobs: fileSummary(localJobs),
      og: fileSummary(ogEvents),
      recentJobs: jobs.map((job) => ({
        id: job.id,
        capabilityId: job.capabilityId,
        status: job.status,
        inputSummary: typeof job.inputSummary === 'string' ? redactText(job.inputSummary).slice(0, 240) : ''
      }))
    },
    nextActions: inferNextActions('context')
  };
}

export function getHiiOgStatus() {
  const context = getHiiAgentContext();
  return {
    generatedAt: context.generatedAt,
    repo: context.identity.repo,
    branch: context.git.branch,
    dirtyFiles: context.git.status.length,
    capabilities: context.capabilities.length,
    nextActions: inferNextActions('og status')
  };
}
