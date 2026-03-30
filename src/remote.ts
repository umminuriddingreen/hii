import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HII_DIR = path.join(process.env.HOME || '/tmp', '.hii');
const REMOTES_FILE = path.join(HII_DIR, 'remotes.json');
const SSH_REMOTES_FILE = path.join(HII_DIR, 'ssh-remotes.json');

export type RemoteProvider = 'novnc' | 'guacamole' | 'custom';
export type SshAuthType = 'agent' | 'password' | 'key';

export type RemoteRecord = {
  id: string;
  name: string;
  slug: string;
  kind: 'windows';
  provider: RemoteProvider;
  host?: string;
  port?: number;
  scheme?: 'http' | 'https';
  path?: string;
  url?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type SshRemoteRecord = {
  id: string;
  name: string;
  slug: string;
  kind: 'ssh';
  host: string;
  port?: number;
  user?: string;
  auth?: SshAuthType;
  keyPath?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

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

export function loadRemotes(): RemoteRecord[] {
  try {
    return JSON.parse(fs.readFileSync(REMOTES_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveRemotes(remotes: RemoteRecord[]): void {
  ensureDir();
  fs.writeFileSync(REMOTES_FILE, JSON.stringify(remotes, null, 2));
}

export function loadSshRemotes(): SshRemoteRecord[] {
  try {
    return JSON.parse(fs.readFileSync(SSH_REMOTES_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveSshRemotes(remotes: SshRemoteRecord[]): void {
  ensureDir();
  fs.writeFileSync(SSH_REMOTES_FILE, JSON.stringify(remotes, null, 2));
}

function resolveNoVncPath(input?: string): string {
  if (input?.trim()) return input.trim();
  return '/vnc.html?autoconnect=1&resize=remote&reconnect=1&view_only=0';
}

function resolveGuacamolePath(input?: string): string {
  if (input?.trim()) return input.trim();
  return '/';
}

export function buildRemoteUrl(remote: RemoteRecord): string {
  if (remote.provider === 'custom') {
    if (!remote.url) throw new Error(`Remote ${remote.name} is missing a custom URL.`);
    return remote.url;
  }
  if (!remote.host) throw new Error(`Remote ${remote.name} is missing a host.`);
  const scheme = remote.scheme || 'http';
  const port = remote.port ? `:${remote.port}` : '';
  const suffix = remote.provider === 'guacamole'
    ? resolveGuacamolePath(remote.path)
    : resolveNoVncPath(remote.path);
  return `${scheme}://${remote.host}${port}${suffix}`;
}

export function addRemote(input: {
  name: string;
  provider?: RemoteProvider;
  host?: string;
  port?: number;
  scheme?: 'http' | 'https';
  path?: string;
  url?: string;
  notes?: string;
}): RemoteRecord {
  const remotes = loadRemotes();
  const slug = slugify(input.name);
  if (remotes.some((item) => item.slug === slug)) {
    throw new Error(`remote already exists: ${input.name}`);
  }
  const provider = input.provider || (input.url ? 'custom' : 'novnc');
  const now = new Date().toISOString();
  const remote: RemoteRecord = {
    id: Math.random().toString(36).slice(2, 10),
    name: input.name,
    slug,
    kind: 'windows',
    provider,
    host: input.host,
    port: input.port,
    scheme: input.scheme,
    path: input.path,
    url: input.url,
    notes: input.notes,
    createdAt: now,
    updatedAt: now,
  };
  buildRemoteUrl(remote);
  remotes.push(remote);
  saveRemotes(remotes);
  return remote;
}

export function listRemotes(): RemoteRecord[] {
  return loadRemotes().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getRemote(nameOrSlug: string): RemoteRecord | null {
  const query = slugify(nameOrSlug);
  return loadRemotes().find((item) => item.slug === query || slugify(item.name) === query) || null;
}

export function getRemoteById(id: string): RemoteRecord | null {
  return loadRemotes().find((item) => item.id === id) || null;
}

export async function openRemote(nameOrSlug: string): Promise<{ ok: true; url: string; remote: RemoteRecord }> {
  const remote = getRemote(nameOrSlug);
  if (!remote) throw new Error(`remote not found: ${nameOrSlug}`);
  const url = buildRemoteUrl(remote);
  await execFileAsync('open', [url]);
  return { ok: true, url, remote };
}

export function remoteSummary(): string {
  const remotes = listRemotes();
  if (!remotes.length) return 'No remotes registered.';
  return remotes.map((remote) => {
    const target = remote.provider === 'custom' ? remote.url : `${remote.scheme || 'http'}://${remote.host}${remote.port ? `:${remote.port}` : ''}`;
    return `${remote.slug} | ${remote.provider} | ${target}`;
  }).join('\n');
}

export function addSshRemote(input: {
  name: string;
  host: string;
  port?: number;
  user?: string;
  auth?: SshAuthType;
  keyPath?: string;
  notes?: string;
}): SshRemoteRecord {
  const remotes = loadSshRemotes();
  const slug = slugify(input.name);
  if (remotes.some((item) => item.slug === slug)) {
    throw new Error(`ssh remote already exists: ${input.name}`);
  }
  const now = new Date().toISOString();
  const remote: SshRemoteRecord = {
    id: Math.random().toString(36).slice(2, 10),
    name: input.name,
    slug,
    kind: 'ssh',
    host: input.host,
    port: input.port,
    user: input.user,
    auth: input.auth || 'agent',
    keyPath: input.keyPath,
    notes: input.notes,
    createdAt: now,
    updatedAt: now,
  };
  remotes.push(remote);
  saveSshRemotes(remotes);
  return remote;
}

export function listSshRemotes(): SshRemoteRecord[] {
  return loadSshRemotes().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getSshRemote(nameOrSlug: string): SshRemoteRecord | null {
  const query = slugify(nameOrSlug);
  return loadSshRemotes().find((item) => item.slug === query || slugify(item.name) === query) || null;
}

function sshTarget(remote: SshRemoteRecord): string {
  return remote.user ? `${remote.user}@${remote.host}` : remote.host;
}

function sshArgs(remote: SshRemoteRecord, remoteCommand?: string, batchMode: boolean = false): string[] {
  const args = ['-o', 'StrictHostKeyChecking=accept-new'];
  if (batchMode) args.push('-o', 'BatchMode=yes');
  if (remote.port) args.push('-p', String(remote.port));
  if (remote.keyPath) args.push('-i', remote.keyPath);
  args.push(sshTarget(remote));
  if (remoteCommand?.trim()) args.push(remoteCommand);
  return args;
}

export async function testSshRemote(nameOrSlug: string): Promise<{ ok: boolean; remote: SshRemoteRecord; stdout: string; stderr: string }> {
  const remote = getSshRemote(nameOrSlug);
  if (!remote) throw new Error(`ssh remote not found: ${nameOrSlug}`);
  try {
    const { stdout, stderr } = await execFileAsync('ssh', sshArgs(remote, 'echo hii-ssh-ok', true));
    return { ok: stdout.trim() === 'hii-ssh-ok', remote, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: any) {
    return {
      ok: false,
      remote,
      stdout: String(error?.stdout || '').trim(),
      stderr: String(error?.stderr || error?.message || error).trim(),
    };
  }
}

export async function execSshRemote(nameOrSlug: string, command: string): Promise<{ ok: boolean; remote: SshRemoteRecord; code: number; stdout: string; stderr: string }> {
  const remote = getSshRemote(nameOrSlug);
  if (!remote) throw new Error(`ssh remote not found: ${nameOrSlug}`);
  try {
    const { stdout, stderr } = await execFileAsync('ssh', sshArgs(remote, command, false));
    return { ok: true, remote, code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: any) {
    return {
      ok: false,
      remote,
      code: Number(error?.code) || 1,
      stdout: String(error?.stdout || '').trim(),
      stderr: String(error?.stderr || error?.message || error).trim(),
    };
  }
}

export function sshRemoteSummary(): string {
  const remotes = listSshRemotes();
  if (!remotes.length) return 'No SSH remotes registered.';
  return remotes.map((remote) => {
    const target = `${remote.user ? `${remote.user}@` : ''}${remote.host}${remote.port ? `:${remote.port}` : ''}`;
    return `${remote.slug} | ${target} | ${remote.auth || 'agent'}`;
  }).join('\n');
}
