#!/usr/bin/env node
// Local, non-Docker search service used by the HII CLI.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const base = path.join(homedir(), '.hii');
const source = path.join(homedir(), 'searxng');
const runtime = path.join(base, 'searxng');
const python = path.join(base, 'searxng-venv', 'bin', 'python');
const settings = path.join(runtime, 'settings.yml');
const pidFile = path.join(runtime, 'searxng.pid');
const logFile = path.join(runtime, 'searxng.log');
const launchAgents = path.join(homedir(), 'Library', 'LaunchAgents');
const launchLabel = 'com.hii.searxng';
const launchPlist = path.join(launchAgents, `${launchLabel}.plist`);
const macOS = process.platform === 'darwin';
const launchDomain = macOS ? `gui/${process.getuid()}` : null;
const launchTarget = launchDomain ? `${launchDomain}/${launchLabel}` : null;
const endpoint = 'http://127.0.0.1:8888';
const action = process.argv[2] || 'status';

function fail(message) { console.error(message); process.exit(1); }
function run(bin, args) {
  const result = spawnSync(bin, args, { stdio: 'inherit' });
  if (result.status !== 0) fail(`${bin} exited ${result.status}`);
}
function command(bin, args) {
  return spawnSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function launchLoaded() {
  if (!macOS) return false;
  const result = command('launchctl', ['print', launchTarget]);
  return result.status === 0;
}
function plistText() {
  const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${launchLabel}</string>
  <key>ProgramArguments</key><array><string>${xml(python)}</string><string>-m</string><string>searx.webapp</string></array>
  <key>WorkingDirectory</key><string>${xml(source)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>SEARXNG_SETTINGS_PATH</key><string>${xml(settings)}</string>
    <key>SEARXNG_PORT</key><string>8888</string>
    <key>SEARXNG_BIND_ADDRESS</key><string>127.0.0.1</string>
    <key>PYTHONPATH</key><string>${xml(source)}</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict></plist>\n`;
}
function validatePlist() {
  const result = command('plutil', ['-lint', launchPlist]);
  if (result.status !== 0) fail(`Invalid LaunchAgent plist: ${(result.stderr || result.stdout).trim()}`);
}
function bootstrap() {
  const result = command('launchctl', ['bootstrap', launchDomain, launchPlist]);
  if (result.status !== 0 && !launchLoaded()) fail(`launchctl bootstrap failed: ${(result.stderr || result.stdout).trim()}`);
}
async function probeHealth(timeoutMs = 1500) {
  const response = await fetch(`${endpoint}/config`, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  if (!response) return { running: false, json: false, healthy: false };
  const body = await response.json().catch(() => null);
  const json = body !== null && typeof body === 'object' && Array.isArray(body.engines) && typeof body.instance_name === 'string';
  return { running: true, json: response.ok && json, healthy: response.ok && json };
}
async function waitReady() {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if ((await probeHealth()).healthy) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}
function pid() {
  if (!existsSync(pidFile)) return null;
  const value = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(value) || value <= 0) return null;
  try { process.kill(value, 0); return value; } catch { return null; }
}
function ensureSettings() {
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  chmodSync(runtime, 0o700);
  if (existsSync(settings)) return;
  writeFileSync(settings, `use_default_settings:
  engines:
    keep_only: [google cse, bing, google cse images]
engines:
  - name: google cse
    disabled: false
  - name: bing
    disabled: false
  - name: google cse images
    disabled: false
outgoing:
  request_timeout: 6.0
  max_request_timeout: 10.0
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
} else if (action === 'enable') {
  if (!macOS) fail('LaunchAgent autostart is supported only on macOS');
  if (!existsSync(source)) fail(`SearXNG source missing at ${source}`);
  if (!existsSync(python)) fail('Not installed; run node scripts/hii-searxng.mjs install');
  ensureSettings();
  mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  chmodSync(runtime, 0o700);
  const log = openSync(logFile, 'a', 0o600);
  closeSync(log);
  chmodSync(logFile, 0o600);
  writeFileSync(launchPlist, plistText(), { mode: 0o600 });
  chmodSync(launchPlist, 0o600);
  validatePlist();
  run('launchctl', ['enable', launchTarget]);
  bootstrap();
  if (!await waitReady()) fail(`Local search did not become healthy at ${endpoint} within 20 seconds`);
  console.log('Enabled local search at login.');
} else if (action === 'disable') {
  if (!macOS) fail('LaunchAgent autostart is supported only on macOS');
  if (launchLoaded()) {
    const result = command('launchctl', ['bootout', launchTarget]);
    if (result.status !== 0) fail(`launchctl bootout failed: ${(result.stderr || result.stdout).trim()}`);
  }
  if (existsSync(launchPlist)) unlinkSync(launchPlist);
  console.log('Disabled local search at login.');
} else if (action === 'start') {
  if (!existsSync(source)) fail(`SearXNG source missing at ${source}`);
  if (!existsSync(python)) fail('Not installed; run node scripts/hii-searxng.mjs install');
  ensureSettings();
  if ((await probeHealth()).healthy) {
    console.log(`local search is already healthy at ${endpoint}`);
    process.exit(0);
  }
  if (existsSync(launchPlist)) {
    if (!macOS) fail('A LaunchAgent is configured, but launchd is available only on macOS');
    validatePlist();
    if (!launchLoaded()) bootstrap();
    else {
      const result = command('launchctl', ['kickstart', launchTarget]);
      if (result.status !== 0) fail(`launchctl kickstart failed: ${(result.stderr || result.stdout).trim()}`);
    }
  } else {
    if (pid()) {
      if (!await waitReady()) fail(`Managed local search process did not become healthy at ${endpoint} within 20 seconds`);
      console.log(`local search is healthy at ${endpoint}`);
      process.exit(0);
    }
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    chmodSync(runtime, 0o700);
    const log = openSync(logFile, 'a', 0o600);
    chmodSync(logFile, 0o600);
    const child = spawn(python, ['-m', 'searx.webapp'], {
      detached: true, cwd: source, stdio: ['ignore', log, log],
      env: { ...process.env, SEARXNG_SETTINGS_PATH: settings, SEARXNG_PORT: '8888', SEARXNG_BIND_ADDRESS: '127.0.0.1', PYTHONPATH: source },
    });
    closeSync(log);
    child.unref();
    writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
  }
  if (!await waitReady()) fail(`Local search did not become healthy at ${endpoint} within 20 seconds`);
  console.log(`local search is healthy at ${endpoint}`);
} else if (action === 'status') {
  const health = await probeHealth(8000);
  console.log(JSON.stringify({ ...health, endpoint, autostart: { configured: existsSync(launchPlist), loaded: launchLoaded() } }));
} else if (action === 'stop') {
  if (existsSync(launchPlist) && launchLoaded()) {
    const result = command('launchctl', ['bootout', launchTarget]);
    if (result.status !== 0) fail(`launchctl bootout failed: ${(result.stderr || result.stdout).trim()}`);
    console.log('stopped local search; autostart remains enabled');
    process.exit(0);
  }
  const current = pid();
  if (current) process.kill(current, 'SIGTERM');
  console.log(current ? 'stopped local search' : 'not running');
} else {
  fail('usage: node scripts/hii-searxng.mjs install|enable|disable|start|status|stop');
}
