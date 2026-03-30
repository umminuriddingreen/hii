import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type GenerationKind = 'snapshot' | 'vision' | 'release';

export interface GenerationRecord {
  id: string;
  name: string;
  slug: string;
  kind: GenerationKind;
  summary: string;
  tags: string[];
  createdAt: string;
  version: string;
  git?: {
    branch: string | null;
    head: string | null;
    dirty: boolean;
    statusLines: string[];
    changedFiles: string[];
    untrackedFiles: string[];
    deletedFiles: string[];
  };
  snapshotDir: string;
  manifestPath: string;
}

interface GenerationLedger {
  currentId: string | null;
  generations: GenerationRecord[];
}

interface SnapshotOptions {
  id?: string;
  name?: string;
  summary?: string;
  tags?: string[];
  kind?: GenerationKind;
  markCurrent?: boolean;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function safeGit(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function readPackageVersion(repoRoot: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function generationRoot(repoRoot: string): string {
  return path.join(repoRoot, 'docs', 'generations');
}

function ledgerPath(repoRoot: string): string {
  return path.join(generationRoot(repoRoot), 'ledger.json');
}

function snapshotRoot(repoRoot: string): string {
  return path.join(generationRoot(repoRoot), 'snapshots');
}

function loadLedger(repoRoot: string): GenerationLedger {
  const file = ledgerPath(repoRoot);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as GenerationLedger;
  } catch {
    return { currentId: null, generations: [] };
  }
}

function saveLedger(repoRoot: string, ledger: GenerationLedger): void {
  ensureDir(generationRoot(repoRoot));
  fs.writeFileSync(ledgerPath(repoRoot), JSON.stringify(ledger, null, 2));
}

function nextGenerationId(ledger: GenerationLedger): string {
  const max = ledger.generations.reduce((highest, item) => {
    const match = /^g0*(\d+)$/.exec(item.id);
    const num = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(num) ? Math.max(highest, num) : highest;
  }, 0);
  return `g${max + 1}`;
}

function copyFileIntoSnapshot(repoRoot: string, snapshotFilesDir: string, relativePath: string): void {
  const source = path.join(repoRoot, relativePath);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return;
  const target = path.join(snapshotFilesDir, relativePath);
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
}

function collectGitState(repoRoot: string) {
  const branch = safeGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = safeGit(repoRoot, ['rev-parse', '--short', 'HEAD']);
  const statusOutput = safeGit(repoRoot, ['status', '--short']) || '';
  const changedOutput = safeGit(repoRoot, ['diff', '--name-only', 'HEAD', '--']) || '';
  const untrackedOutput = safeGit(repoRoot, ['ls-files', '--others', '--exclude-standard']) || '';
  const diffOutput = safeGit(repoRoot, ['diff', '--binary', 'HEAD', '--']) || '';
  const statusLines = statusOutput.split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const changedFiles = changedOutput.split('\n').map((line) => line.trim()).filter(Boolean);
  const untrackedFiles = untrackedOutput.split('\n').map((line) => line.trim()).filter(Boolean);
  const deletedFiles = statusLines
    .filter((line) => line.startsWith('D ') || line.startsWith(' D') || line.includes(' D '))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  return {
    branch,
    head,
    statusLines,
    changedFiles,
    untrackedFiles,
    deletedFiles,
    diffOutput,
    dirty: statusLines.length > 0,
  };
}

export function generationPaths(repoRoot: string = process.cwd()) {
  const root = generationRoot(repoRoot);
  const snapshots = snapshotRoot(repoRoot);
  return {
    root,
    ledger: ledgerPath(repoRoot),
    snapshots,
  };
}

export function createGenerationSnapshot(repoRoot: string, opts: SnapshotOptions = {}): GenerationRecord {
  const ledger = loadLedger(repoRoot);
  const git = collectGitState(repoRoot);
  const id = opts.id?.trim() || nextGenerationId(ledger);
  if (ledger.generations.some((item) => item.id === id)) {
    throw new Error(`Generation already exists: ${id}`);
  }
  const createdAt = new Date().toISOString();
  const defaultName = opts.name?.trim() || id;
  const slug = slugify(defaultName) || id;
  const dirName = `${id}-${slug}`;
  const snapshotDir = path.join(snapshotRoot(repoRoot), dirName);
  const filesDir = path.join(snapshotDir, 'files');
  ensureDir(filesDir);

  const trackedFiles = new Set<string>([...git.changedFiles, ...git.untrackedFiles]);
  for (const relativePath of trackedFiles) {
    copyFileIntoSnapshot(repoRoot, filesDir, relativePath);
  }

  if (git.diffOutput) {
    fs.writeFileSync(path.join(snapshotDir, 'worktree.diff'), git.diffOutput);
  }
  if (git.statusLines.length) {
    fs.writeFileSync(path.join(snapshotDir, 'status.txt'), git.statusLines.join('\n') + '\n');
  }

  const record: GenerationRecord = {
    id,
    name: defaultName,
    slug,
    kind: opts.kind || 'snapshot',
    summary: opts.summary?.trim() || 'Working-tree snapshot',
    tags: opts.tags || [],
    createdAt,
    version: readPackageVersion(repoRoot),
    git: {
      branch: git.branch,
      head: git.head,
      dirty: git.dirty,
      statusLines: git.statusLines,
      changedFiles: git.changedFiles,
      untrackedFiles: git.untrackedFiles,
      deletedFiles: git.deletedFiles,
    },
    snapshotDir,
    manifestPath: path.join(snapshotDir, 'manifest.json'),
  };

  fs.writeFileSync(record.manifestPath, JSON.stringify(record, null, 2));

  const nextLedger: GenerationLedger = {
    currentId: opts.markCurrent === false ? ledger.currentId : record.id,
    generations: [record, ...ledger.generations],
  };
  saveLedger(repoRoot, nextLedger);
  return record;
}

export function listGenerations(repoRoot: string): GenerationRecord[] {
  return loadLedger(repoRoot).generations
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function currentGeneration(repoRoot: string): GenerationRecord | null {
  const ledger = loadLedger(repoRoot);
  if (!ledger.currentId) return null;
  return ledger.generations.find((item) => item.id === ledger.currentId) || null;
}

export function getGeneration(repoRoot: string, idOrName: string): GenerationRecord | null {
  const normalized = slugify(idOrName);
  return listGenerations(repoRoot).find((item) =>
    item.id === idOrName ||
    item.slug === normalized ||
    slugify(item.name) === normalized,
  ) || null;
}

export function formatGenerationSummary(records: GenerationRecord[], currentId?: string | null): string {
  if (!records.length) return 'No generations recorded.';
  return records.map((record) => {
    const currentMark = record.id === currentId ? '*' : ' ';
    const dirty = record.git?.dirty ? 'dirty' : 'clean';
    const changes = (record.git?.changedFiles.length || 0) + (record.git?.untrackedFiles.length || 0);
    return `${currentMark} ${record.id}  ${record.createdAt}  ${record.name}  v${record.version}  ${dirty}  ${changes} files`;
  }).join('\n');
}

export function formatGenerationDetail(record: GenerationRecord | null): string {
  if (!record) return 'Generation not found.';
  const lines = [
    `id: ${record.id}`,
    `name: ${record.name}`,
    `kind: ${record.kind}`,
    `createdAt: ${record.createdAt}`,
    `version: ${record.version}`,
    `summary: ${record.summary}`,
    `snapshotDir: ${record.snapshotDir}`,
    `manifestPath: ${record.manifestPath}`,
  ];
  if (record.tags.length) lines.push(`tags: ${record.tags.join(', ')}`);
  if (record.git) {
    lines.push(`git: ${record.git.branch || 'unknown'}@${record.git.head || 'unknown'}`);
    lines.push(`dirty: ${record.git.dirty}`);
    lines.push(`changedFiles: ${record.git.changedFiles.length}`);
    lines.push(`untrackedFiles: ${record.git.untrackedFiles.length}`);
    lines.push(`deletedFiles: ${record.git.deletedFiles.length}`);
    if (record.git.statusLines.length) {
      lines.push('');
      lines.push('status:');
      lines.push(...record.git.statusLines.map((line) => `  ${line}`));
    }
  }
  return lines.join('\n');
}
