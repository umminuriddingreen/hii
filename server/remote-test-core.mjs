import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MODEL = 'qwen3.6:35b-mlx';
export const DEFAULT_SESSION_MODEL = 'gpt-5.5';
export const SESSION_PROFILE = 'public-test';
export const TERMINAL_PORT = 17171;
export const ARTIFACT_PORT = 17172;
export const TERMINAL_HTTPS_PORT = 443;
export const ARTIFACT_HTTPS_PORT = 8443;
export const DISCONNECT_GRACE_MS = 90_000;
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_MESSAGES_PER_MINUTE = 120;

export function remoteTestsRoot(home = os.homedir()) {
  return path.join(home, '.hii', 'remote-tests');
}

export function newSessionId() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(12).toString('hex')}`;
}

export function newSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export async function ensureSessionLayout(root, id) {
  if (!/^[a-zA-Z0-9-]{20,80}$/.test(id)) throw new Error('invalid session id');
  const sessionDir = path.join(root, id);
  const layout = {
    id,
    sessionDir,
    workspace: path.join(sessionDir, 'workspace'),
    publicDir: path.join(sessionDir, 'workspace', 'public'),
    runtime: path.join(sessionDir, 'runtime'),
    artifacts: path.join(sessionDir, 'artifacts'),
    transcript: path.join(sessionDir, 'transcript.log'),
    events: path.join(sessionDir, 'events.jsonl'),
    manifest: path.join(sessionDir, 'manifest.json')
  };
  await Promise.all([
    fsp.mkdir(layout.publicDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(layout.runtime, { recursive: true, mode: 0o700 }),
    fsp.mkdir(layout.artifacts, { recursive: true, mode: 0o700 })
  ]);
  await fsp.chmod(sessionDir, 0o700);
  return layout;
}

export async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, file);
}

export async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function archiveSessionForReset(sessionDir) {
  const resolvedSession = path.resolve(sessionDir);
  const historyRoot = path.join(
    resolvedSession,
    'history',
    `reset-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${crypto.randomBytes(4).toString('hex')}`
  );
  await fsp.mkdir(historyRoot, { recursive: true, mode: 0o700 });
  const moved = [];
  for (const name of ['workspace', 'runtime', 'home', 'tmp', 'transcript.log']) {
    const source = path.join(resolvedSession, name);
    try {
      await fsp.lstat(source);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    await fsp.rename(source, path.join(historyRoot, name));
    moved.push(name);
  }
  return { historyRoot, moved };
}

export function appendEvent(layout, event) {
  fs.appendFileSync(
    layout.events,
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    { mode: 0o600 }
  );
}

export function contentType(file) {
  const extension = path.extname(file).toLowerCase();
  return {
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp',
    '.wasm': 'application/wasm'
  }[extension] ?? 'application/octet-stream';
}

export async function resolvePublicArtifact(publicDir, requestPath) {
  if (typeof requestPath !== 'string' || requestPath.includes('\0')) throw new Error('invalid artifact path');
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    throw new Error('invalid artifact path encoding');
  }
  const pieces = decoded.replace(/^\/+/, '').split('/');
  if (
    pieces.length === 0 ||
    pieces.some((piece) => !piece || piece === '.' || piece === '..' || piece.startsWith('.'))
  ) {
    throw new Error('artifact path is not allowed');
  }
  const root = await fsp.realpath(publicDir);
  let cursor = root;
  for (const piece of pieces) {
    cursor = path.join(cursor, piece);
    const stat = await fsp.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error('artifact symlinks are not allowed');
  }
  const resolved = await fsp.realpath(cursor);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('artifact escapes workspace/public');
  }
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) throw new Error('artifact is not a file');
  return resolved;
}

export async function canBind(port, host = '127.0.0.1') {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

export async function runCommand(binary, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (code === 0 || options.allowFailure) resolve(result);
      else reject(new Error(`${binary} exited ${code}: ${result.stderr.trim()}`));
    });
  });
}

export function funnelRoute(status, port) {
  const web = status?.Web ?? {};
  for (const [hostPort, entry] of Object.entries(web)) {
    if (hostPort.endsWith(`:${port}`)) return { hostPort, entry };
  }
  return null;
}

export function expectedProxy(localPort) {
  return `http://127.0.0.1:${localPort}`;
}

export async function inspectPreflight(options = {}) {
  const run = options.run ?? runCommand;
  const bind = options.canBind ?? canBind;
  const fetchImpl = options.fetchImpl ?? fetch;
  const tailscale = options.tailscale ?? '/usr/local/bin/tailscale';
  const hiiBinary = path.resolve(options.hiiBinary);
  const terminalPort = options.terminalPort ?? TERMINAL_PORT;
  const artifactPort = options.artifactPort ?? ARTIFACT_PORT;
  const requireChrome = options.requireChrome ?? true;
  const checks = [];

  let binaryReal = null;
  try {
    binaryReal = await fsp.realpath(hiiBinary);
    const stat = await fsp.stat(binaryReal);
    checks.push({ name: 'hii-binary', ok: stat.isFile() && (stat.mode & 0o111) !== 0, detail: binaryReal });
  } catch (error) {
    checks.push({ name: 'hii-binary', ok: false, detail: error.message });
  }

  const statusResult = await run(tailscale, ['status', '--json'], { allowFailure: true });
  let tailscaleStatus = null;
  try {
    tailscaleStatus = JSON.parse(statusResult.stdout);
  } catch {}
  checks.push({
    name: 'tailscale-connected',
    ok: statusResult.code === 0 && tailscaleStatus?.BackendState === 'Running',
    detail: tailscaleStatus?.BackendState ?? (statusResult.stderr.trim() || 'unavailable')
  });

  const funnelResult = await run(tailscale, ['funnel', 'status', '--json'], { allowFailure: true });
  let funnelStatus = {};
  try {
    funnelStatus = JSON.parse(funnelResult.stdout || '{}');
  } catch {}
  for (const externalPort of [TERMINAL_HTTPS_PORT, ARTIFACT_HTTPS_PORT]) {
    const occupied = funnelRoute(funnelStatus, externalPort);
    checks.push({
      name: `funnel-${externalPort}-unused`,
      ok: !occupied,
      detail: occupied ? `${occupied.hostPort} already configured` : 'available'
    });
  }

  for (const [name, port] of [['terminal-loopback', terminalPort], ['artifact-loopback', artifactPort]]) {
    const available = await bind(port);
    checks.push({ name, ok: available, detail: available ? `127.0.0.1:${port} available` : `127.0.0.1:${port} occupied` });
  }

  let chromePath = null;
  if (requireChrome) {
    const chromeCandidates = options.chromeCandidates ?? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    ];
    for (const candidate of chromeCandidates) {
      try {
        await fsp.access(candidate, fs.constants.X_OK);
        chromePath = candidate;
        break;
      } catch {}
    }
    checks.push({
      name: 'chrome-verifier',
      ok: Boolean(chromePath),
      detail: chromePath ?? 'Google Chrome, Chromium, or Brave is required'
    });
  }

  try {
    const response = await fetchImpl('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) });
    const body = response.ok ? await response.json() : {};
    const models = (body.models ?? []).flatMap((item) => [item.name, item.model]).filter(Boolean);
    checks.push({
      name: 'ollama-model',
      ok: response.ok && models.includes(MODEL),
      detail: response.ok ? (models.includes(MODEL) ? MODEL : `${MODEL} not installed`) : `HTTP ${response.status}`
    });
  } catch (error) {
    checks.push({ name: 'ollama-model', ok: false, detail: error.message });
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
    hiiBinary: binaryReal,
    tailscaleDnsName: tailscaleStatus?.Self?.DNSName ?? null,
    funnelStatus,
    chromePath
  };
}

export function funnelStartArgs(externalPort, localPort) {
  return ['funnel', '--bg', '--yes', `--https=${externalPort}`, expectedProxy(localPort)];
}

export function funnelStopArgs(externalPort) {
  return ['funnel', `--https=${externalPort}`, 'off'];
}

export function routeOwnedBy(status, externalPort, localPort) {
  const route = funnelRoute(status, externalPort);
  if (!route) return false;
  return Object.values(route.entry?.Handlers ?? {}).some((handler) => handler?.Proxy === expectedProxy(localPort));
}

export class SlidingWindowLimiter {
  constructor(limit, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  allow(key, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const values = (this.hits.get(key) ?? []).filter((time) => time > cutoff);
    if (values.length >= this.limit) {
      this.hits.set(key, values);
      return false;
    }
    values.push(now);
    this.hits.set(key, values);
    return true;
  }
}
