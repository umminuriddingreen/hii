// SPDX-License-Identifier: LicenseRef-BSL-1.1
// Per-user schedule for reconciling local Codex knowledge through installed HII.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const xml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

export function parseArgs(args) {
  const [action, ...rest] = args;
  if (!['install', 'status', 'run'].includes(action)) throw new Error('Use install|status|run [--launcher <path>].');
  const options = { action, launcher: undefined, dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dry-run') options.dryRun = true;
    else if (rest[i] === '--launcher' && rest[i + 1] && !rest[i + 1].startsWith('--')) options.launcher = path.resolve(rest[++i]);
    else throw new Error('Unknown option or missing --launcher value.');
  }
  return options;
}

export function makePlan({ platform = process.platform, home = homedir(), uid = process.getuid?.(), launcher = process.env.HII_LAUNCHER_PATH || path.join(home, 'bin', 'hii'), launchctlPath = '/bin/launchctl' } = {}) {
  if (platform !== 'darwin') throw new Error('The Codex sync schedule is supported on macOS only.');
  for (const value of [home, launcher, launchctlPath]) {
    if (!path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw new Error('Absolute, control-character-free paths are required.');
  }
  if (!Number.isInteger(uid) || uid < 0) throw new Error('A valid macOS user ID is required.');
  const id = createHash('sha256').update(home).digest('hex').slice(0, 16);
  const label = `com.hii.codex-sync.${id}`;
  const plistPath = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  const log = path.join(home, '.hii', 'logs', 'codex-sync-schedule.log');
  const programArguments = [launcher, 'update', 'sync'];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array>${programArguments.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>\n<key>StartInterval</key><integer>900</integer>\n<key>RunAtLoad</key><false/>\n<key>ProcessType</key><string>Background</string>\n<key>StandardOutPath</key><string>${xml(log)}</string>\n<key>StandardErrorPath</key><string>${xml(log)}</string>\n</dict></plist>\n`;
  return { kind: 'hii-codex-sync', platform, home, uid, launcher, launchctlPath, label, plistPath, plist, log, intervalSeconds: 900, programArguments, domain: `gui/${uid}` };
}

function execute(plan, args) {
  return spawnSync(plan.launchctlPath, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 1024 * 1024 });
}

function ensureLauncher(plan) {
  try { accessSync(plan.launcher, constants.X_OK); }
  catch { throw new Error(`Installed HII launcher is missing or not executable: ${plan.launcher}`); }
}

export function install(plan, dryRun = false) {
  if (dryRun) return { dryRun: true, action: 'install', plan };
  ensureLauncher(plan);
  if (existsSync(plan.plistPath)) throw new Error('The Codex sync plist already exists; it was not replaced.');
  const loaded = execute(plan, ['print', `${plan.domain}/${plan.label}`]);
  if (loaded.status === 0) throw new Error('The Codex sync job already exists; it was not replaced.');
  if (loaded.error) throw new Error('Could not inspect launchd; nothing was installed.');
  mkdirSync(path.dirname(plan.plistPath), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(plan.log), { recursive: true, mode: 0o700 });
  writeFileSync(plan.plistPath, plan.plist, { flag: 'wx', mode: 0o600 });
  const result = execute(plan, ['bootstrap', plan.domain, plan.plistPath]);
  if (result.status !== 0) throw new Error('launchd registration failed; the newly created plist remains for inspection.');
  return scheduleStatus(plan);
}

export function scheduleStatus(plan, dryRun = false) {
  if (dryRun) return { dryRun: true, action: 'status', plan };
  const result = execute(plan, ['print', `${plan.domain}/${plan.label}`]);
  if (result.error) throw new Error('Could not inspect launchd.');
  const plistExists = existsSync(plan.plistPath);
  const loaded = result.status === 0;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const runs = output.match(/\bruns\s*=\s*(\d+)/i);
  const lastExitCode = output.match(/\blast exit code\s*=\s*(-?\d+)/i);
  return { kind: plan.kind, name: plan.label, installed: plistExists && loaded, plistExists, loaded, launcher: plan.launcher, intervalSeconds: plan.intervalSeconds, lastRunCount: runs ? Number(runs[1]) : null, lastExitCode: lastExitCode ? Number(lastExitCode[1]) : null };
}

export function runSync(plan, dryRun = false) {
  if (dryRun) return { dryRun: true, action: 'run', executable: plan.launcher, args: ['update', 'sync'] };
  ensureLauncher(plan);
  const result = spawnSync(plan.launcher, ['update', 'sync'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 12 * 60_000, maxBuffer: 4 * 1024 * 1024 });
  return { kind: plan.kind, executable: plan.launcher, args: ['update', 'sync'], exitCode: result.status, signal: result.signal ?? null, failedToRun: Boolean(result.error) };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = makePlan({ launcher: options.launcher });
  const result = options.action === 'install' ? install(plan, options.dryRun)
    : options.action === 'status' ? scheduleStatus(plan, options.dryRun) : runSync(plan, options.dryRun);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (options.action === 'run' && !options.dryRun && (result.failedToRun || result.exitCode !== 0)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
