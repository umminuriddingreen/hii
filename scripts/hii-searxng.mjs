#!/usr/bin/env node
// Local, non-Docker search service used by the HII CLI.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const base = path.join(homedir(), '.hii');
const source = path.join(homedir(), 'searxng');
const runtime = path.join(base, 'searxng');
const python = path.join(base, 'searxng-venv', 'bin', 'python');
const settings = path.join(runtime, 'settings.yml');
const pidFile = path.join(runtime, 'searxng.pid');
const logFile = path.join(runtime, 'searxng.log');
const endpoint = 'http://127.0.0.1:8888';
const action = process.argv[2] || 'status';

function fail(message) { console.error(message); process.exit(1); }
function run(bin, args) {
  const result = spawnSync(bin, args, { stdio: 'inherit' });
  if (result.status !== 0) fail(`${bin} exited ${result.status}`);
}
function pid() {
  if (!existsSync(pidFile)) return null;
  const value = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(value) || value <= 0) return null;
  try { process.kill(value, 0); return value; } catch { return null; }
}
function ensureSettings() {
  if (existsSync(settings)) return;
  mkdirSync(runtime, { recursive: true });
  writeFileSync(settings, `use_default_settings: true
server:
  port: 8888
  bind_address: "127.0.0.1"
  secret_key: "${randomBytes(32).toString('hex')}"
  limiter: false
  public_instance: false
search:
  formats: [html, json]
`, { mode: 0o600 });
}

if (action === 'install') {
  if (!existsSync(source)) fail(`SearXNG source missing at ${source}`);
  if (!existsSync(python)) run('python3', ['-m', 'venv', path.dirname(path.dirname(python))]);
  run(python, ['-m', 'pip', 'install', '-r', path.join(source, 'requirements.txt')]);
  run(python, ['-m', 'pip', 'install', '--no-build-isolation', '-e', source]);
  ensureSettings();
  console.log('Installed local SearXNG without Docker.');
} else if (action === 'start') {
  if (pid()) { console.log(`already running at ${endpoint}`); process.exit(0); }
  if (!existsSync(python)) fail('Not installed; run node scripts/hii-searxng.mjs install');
  ensureSettings();
  const log = openSync(logFile, 'a');
  const child = spawn(python, ['-m', 'searx.webapp'], {
    detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, SEARXNG_SETTINGS_PATH: settings, SEARXNG_PORT: '8888', SEARXNG_BIND_ADDRESS: '127.0.0.1' },
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  console.log(`started local search at ${endpoint}`);
} else if (action === 'status') {
  const response = await fetch(`${endpoint}/search?q=hii&format=json&engines=google+cse`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  console.log(JSON.stringify({ running: Boolean(pid()), json: response?.ok ?? false, endpoint }));
} else if (action === 'stop') {
  const current = pid();
  if (current) process.kill(current, 'SIGTERM');
  console.log(current ? 'stopped local search' : 'not running');
} else {
  fail('usage: node scripts/hii-searxng.mjs install|start|status|stop');
}
