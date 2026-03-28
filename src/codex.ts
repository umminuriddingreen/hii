import fs from 'node:fs';
import path from 'node:path';

const HII_DIR = path.join(process.env.HOME || '/tmp', '.hii');
const CODEX_DIR = path.join(HII_DIR, 'codex');
const DOCS_DIR = path.join(CODEX_DIR, 'docs');
const INDEX_FILE = path.join(CODEX_DIR, 'index.json');

export interface CodexDoc {
  id: string;
  slug: string;
  title: string;
  kind: string;
  summary: string;
  tags: string[];
  path: string;
  createdAt: string;
  updatedAt: string;
}

function ensureDirs(): void {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function loadIndex(): CodexDoc[] {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveIndex(index: CodexDoc[]): void {
  ensureDirs();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

export function codexPaths() {
  ensureDirs();
  return { codexDir: CODEX_DIR, docsDir: DOCS_DIR, indexFile: INDEX_FILE };
}

export function createCodexDoc(input: {
  title: string;
  kind?: string;
  summary?: string;
  tags?: string[];
  body?: string;
}): CodexDoc {
  ensureDirs();
  const now = new Date().toISOString();
  const slug = slugify(input.title);
  if (!slug) throw new Error('invalid title');
  const filePath = path.join(DOCS_DIR, `${slug}.md`);
  const index = loadIndex();
  const existing = index.find((doc) => doc.slug === slug);
  const content = [
    '---',
    `title: ${input.title}`,
    `kind: ${input.kind || 'note'}`,
    `created: ${existing?.createdAt || now}`,
    `updated: ${now}`,
    `tags: ${(input.tags || []).join(', ')}`,
    '---',
    '',
    `# ${input.title}`,
    '',
    input.summary || '',
    '',
    input.body || '',
    '',
  ].join('\n');
  fs.writeFileSync(filePath, content);
  const doc: CodexDoc = {
    id: existing?.id || Math.random().toString(36).slice(2, 10),
    slug,
    title: input.title,
    kind: input.kind || 'note',
    summary: input.summary || '',
    tags: input.tags || [],
    path: filePath,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const next = index.filter((item) => item.slug !== slug);
  next.push(doc);
  next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  saveIndex(next);
  return doc;
}

export function listCodexDocs(): CodexDoc[] {
  return loadIndex().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getCodexDoc(slugOrTitle: string): { meta: CodexDoc; body: string } | null {
  const slug = slugify(slugOrTitle);
  const doc = loadIndex().find((item) => item.slug === slug || slugify(item.title) === slug);
  if (!doc) return null;
  const body = fs.existsSync(doc.path) ? fs.readFileSync(doc.path, 'utf-8') : '';
  return { meta: doc, body };
}

export function searchCodexDocs(query: string): CodexDoc[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return listCodexDocs().filter((doc) => {
    const haystack = `${doc.title} ${doc.kind} ${doc.summary} ${doc.tags.join(' ')}`.toLowerCase();
    return haystack.includes(q);
  });
}

type WorkspaceSummary = {
  root: string;
  totalFiles: number;
  totalDirs: number;
  topLevel: { name: string; type: 'dir' | 'file' }[];
  topExtensions: { ext: string; count: number }[];
};

function summarizeWorkspace(root: string): WorkspaceSummary {
  const extCounts = new Map<string, number>();
  let totalFiles = 0;
  let totalDirs = 0;
  const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__']);

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        totalDirs += 1;
        walk(full);
      } else if (entry.isFile()) {
        totalFiles += 1;
        const ext = path.extname(entry.name).toLowerCase() || '[none]';
        extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
      }
    }
  }

  walk(root);
  const topLevel = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => !ignored.has(entry.name))
    .slice(0, 40)
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir' as const : 'file' as const }));
  const topExtensions = [...extCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([ext, count]) => ({ ext, count }));

  return { root, totalFiles, totalDirs, topLevel, topExtensions };
}

export function createWorkspaceCodex(rootPath: string, title?: string): CodexDoc {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root)) throw new Error(`path not found: ${root}`);
  const summary = summarizeWorkspace(root);
  const body = [
    `Workspace root: \`${summary.root}\``,
    '',
    `Total files: ${summary.totalFiles}`,
    `Total directories: ${summary.totalDirs}`,
    '',
    '## Top Level',
    '',
    ...summary.topLevel.map((item) => `- [${item.type}] ${item.name}`),
    '',
    '## Dominant File Types',
    '',
    ...summary.topExtensions.map((item) => `- ${item.ext}: ${item.count}`),
    '',
    '## Purpose',
    '',
    'This codex entry acts as a bird\'s-eye index of the workspace so HII can treat the project as a navigable knowledge surface rather than a loose directory tree.',
  ].join('\n');

  return createCodexDoc({
    title: title || `Workspace Codex — ${path.basename(root)}`,
    kind: 'workspace-atlas',
    summary: `Bird's-eye view of ${path.basename(root)} with structure and file-type distribution.`,
    tags: ['workspace', 'atlas', 'codex', 'knowledge'],
    body,
  });
}
