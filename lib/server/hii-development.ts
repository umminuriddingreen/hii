import { createConnection } from 'node:net';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const DEVELOPMENT_PORT = 5173;
const DEVELOPMENT_HOST = '127.0.0.1';

function runtimeDirectory() {
  return path.join(process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii'), 'development');
}

function repositoryRoot() {
  return path.join(os.homedir(), 'hii');
}

async function portReady(timeoutMs = 250) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: DEVELOPMENT_HOST, port: DEVELOPMENT_PORT });
    const done = (ready: boolean) => { socket.destroy(); resolve(ready); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function recordedPid() {
  try {
    const value = JSON.parse(await readFile(path.join(runtimeDirectory(), 'web.json'), 'utf8'));
    return Number.isInteger(value.pid) ? value.pid as number : null;
  } catch {
    return null;
  }
}

export async function developmentSessionSnapshot() {
  const ready = await portReady();
  return {
    ok: true,
    state: ready ? 'ready' : 'offline',
    web: {
      ready,
      previewUrl: `http://${DEVELOPMENT_HOST}:${DEVELOPMENT_PORT}/workspace`,
      mode: 'Svelte HMR',
      pid: await recordedPid()
    },
    native: {
      mode: 'rebuild and relaunch',
      installedApp: '/Applications/HII.app',
      previewApp: '/Applications/HII Preview.app',
      boundary: 'Rust and Tauri changes do not hot-load. Build and relaunch HII Preview.app; never replace the running HII.app from a development session.'
    },
    workspaceRoot: repositoryRoot()
  };
}

export async function ensureDevelopmentSession() {
  const current = await developmentSessionSnapshot();
  if (current.web.ready) return current;
  const runtime = runtimeDirectory();
  await mkdir(runtime, { recursive: true });
  const log = await open(path.join(runtime, 'web.log'), 'a');
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(DEVELOPMENT_PORT)], {
    cwd: repositoryRoot(),
    env: { ...process.env, HII_TARGET: 'web' },
    detached: true,
    stdio: ['ignore', log.fd, log.fd]
  });
  child.unref();
  await writeFile(path.join(runtime, 'web.json'), `${JSON.stringify({
    pid: child.pid,
    startedAt: new Date().toISOString(),
    port: DEVELOPMENT_PORT,
    root: repositoryRoot()
  }, null, 2)}\n`, { mode: 0o600 });
  await log.close();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await portReady()) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return developmentSessionSnapshot();
}
