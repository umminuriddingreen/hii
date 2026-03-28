import fs from 'node:fs';
import path from 'node:path';

const HII_DIR = path.join(process.env.HOME || '/tmp', '.hii');
const APPS_FILE = path.join(HII_DIR, 'apps.json');

export type AppStatus = 'idea' | 'building' | 'mvp' | 'paused' | 'archived';

export interface AppRecord {
  id: string;
  name: string;
  slug: string;
  path?: string;
  stack: string[];
  summary: string;
  status: AppStatus;
  mvpReady: boolean;
  entry?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

function ensureDir(): void {
  fs.mkdirSync(HII_DIR, { recursive: true });
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function loadApps(): AppRecord[] {
  try {
    return JSON.parse(fs.readFileSync(APPS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveApps(apps: AppRecord[]): void {
  ensureDir();
  fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
}

export function addApp(input: {
  name: string;
  path?: string;
  stack?: string[];
  summary?: string;
  status?: AppStatus;
  mvpReady?: boolean;
  entry?: string;
  tags?: string[];
}): AppRecord {
  const apps = loadApps();
  const now = new Date().toISOString();
  const slug = slugify(input.name);
  const existing = apps.find((app) => app.slug === slug);
  if (existing) {
    throw new Error(`app already exists: ${existing.name}`);
  }
  const app: AppRecord = {
    id: Math.random().toString(36).slice(2, 10),
    name: input.name,
    slug,
    path: input.path,
    stack: input.stack || [],
    summary: input.summary || '',
    status: input.status || 'idea',
    mvpReady: input.mvpReady ?? false,
    entry: input.entry,
    tags: input.tags || [],
    createdAt: now,
    updatedAt: now,
  };
  apps.push(app);
  saveApps(apps);
  return app;
}

export function listApps(): AppRecord[] {
  return loadApps().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getApp(slugOrName: string): AppRecord | null {
  const query = slugify(slugOrName);
  return loadApps().find((app) => app.slug === query || slugify(app.name) === query) || null;
}

export function updateApp(slugOrName: string, patch: Partial<Omit<AppRecord, 'id' | 'slug' | 'createdAt'>>): AppRecord {
  const apps = loadApps();
  const query = slugify(slugOrName);
  const app = apps.find((item) => item.slug === query || slugify(item.name) === query);
  if (!app) throw new Error(`app not found: ${slugOrName}`);
  if (patch.name) app.name = patch.name;
  if (patch.path !== undefined) app.path = patch.path;
  if (patch.stack) app.stack = patch.stack;
  if (patch.summary !== undefined) app.summary = patch.summary;
  if (patch.status) app.status = patch.status;
  if (patch.mvpReady !== undefined) app.mvpReady = patch.mvpReady;
  if (patch.entry !== undefined) app.entry = patch.entry;
  if (patch.tags) app.tags = patch.tags;
  app.updatedAt = new Date().toISOString();
  saveApps(apps);
  return app;
}

export function appsSummary(): string {
  const apps = listApps();
  if (!apps.length) return 'No apps registered.';
  return apps.map((app) => {
    const stack = app.stack.length ? ` [${app.stack.join(', ')}]` : '';
    const ready = app.mvpReady ? 'MVP-ready' : 'not MVP-ready';
    return `${app.slug} | ${app.status} | ${ready}${stack}${app.path ? ` | ${app.path}` : ''}`;
  }).join('\n');
}
