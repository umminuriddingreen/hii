import 'server-only';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listCapabilities } from '@/lib/capabilities';

const root = path.join(os.homedir(), 'hii');
const runtime = path.join(os.homedir(), '.hii');
const bridgeLog = path.join(runtime, 'bridge', 'codex.jsonl');
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

function latestById<T extends { id?: unknown }>(entries: T[]) {
  const byId = new Map<unknown, T>();
  for (const entry of entries) {
    if (!entry?.id) continue;
    byId.set(entry.id, entry);
  }
  return Array.from(byId.values());
}

function recentLocalJobs(limit: number) {
  return latestById(readJsonl(localJobs))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .slice(0, limit);
}

function fileSummary(file: string) {
  try {
    const stat = fs.statSync(file);
    return { path: file, exists: true, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
  } catch {
    return { path: file, exists: false };
  }
}

function classifyGitStatus(lines: string[]) {
  const counts = {
    total: lines.length,
    staged: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    untracked: 0,
    conflicted: 0
  };
  const files = lines.map((line) => {
    const index = line[0] ?? ' ';
    const worktree = line[1] ?? ' ';
    const rawPath = line.slice(3).trim();
    const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() ?? rawPath : rawPath;
    if (index !== ' ' && index !== '?') counts.staged += 1;
    if (index === '?' && worktree === '?') counts.untracked += 1;
    if (index === 'R' || worktree === 'R') counts.renamed += 1;
    if (index === 'D' || worktree === 'D') counts.deleted += 1;
    if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D')) counts.conflicted += 1;
    if (worktree !== ' ' && worktree !== '?' && worktree !== 'D' && worktree !== 'U') counts.modified += 1;
    return { path: filePath, index, worktree, raw: line };
  });
  return {
    clean: lines.length === 0,
    counts,
    files,
    sample: files.slice(0, 60)
  };
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
    return { branch, status, worktree: classifyGitStatus(status), recent };
  } catch {
    return { branch: 'unknown', status: [], worktree: classifyGitStatus([]), recent: [] };
  }
}

function staleLegacyRuntimeProbe() {
  const legacyPath = path.join(os.homedir(), 'hii-old');
  const capabilityCache = path.join(runtime, 'capabilities.json');
  const findings = [];
  if (fs.existsSync(legacyPath)) {
    findings.push({
      path: legacyPath,
      state: 'present',
      action: `remove or mine then discard; current HII is ${root}`
    });
  }
  if (fs.existsSync(capabilityCache)) {
    const text = fs.readFileSync(capabilityCache, 'utf8');
    if (text.includes(legacyPath) || text.includes('hii-old')) {
      findings.push({
        path: capabilityCache,
        state: 'stale-reference',
        action: 'ignore as runtime truth until refreshed by current registry scan'
      });
    }
  }
  return {
    legacyPath,
    currentRepo: root,
    clean: findings.length === 0,
    findings
  };
}

function inferNextActions(input: string) {
  const text = input.toLowerCase();
  const actions = [];
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
      score: 76,
      track: 'Context Dock truthful bootstrap',
      next: 'align product truth, storage, permissions, provenance, and bounded MCP around the Context Dock vertical slice'
    }
  );
  return actions.sort((a, b) => b.score - a.score).slice(0, 4);
}

export function getHiiAgentContext() {
  const git = gitSnapshot();
  const jobs = recentLocalJobs(10);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    identity: {
      name: 'hii',
      repo: root,
      runtime,
      role: 'local-first human interface for source-linked context and verified agent work'
    },
    git,
    commands: ['/og', '/context', '/console', '/boards', '/credits', '/termite', '/upload'],
    capabilities: listCapabilities().map((capability) => ({
      id: capability.id,
      name: capability.name,
      status: capability.status,
      summary: capability.summary
    })),
    localState: {
      bridge: fileSummary(bridgeLog),
      worktreeProbe: git.worktree,
      legacyRuntimeProbe: staleLegacyRuntimeProbe(),
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
    capabilities: context.capabilities.length,
    nextActions: inferNextActions('og status')
  };
}
