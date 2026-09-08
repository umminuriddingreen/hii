// SPDX-License-Identifier: LicenseRef-BSL-1.1
// Per-user source checkout maintenance, not a desktop binary updater.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const xml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const ps = (value) => `'${String(value).replaceAll("'", "''")}'`;
const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64');

export function parseArgs(args) {
  const [action, ...rest] = args;
  if (!['install', 'status', 'run'].includes(action)) throw new Error('Use install|status [--repo <path>] [--dry-run].');
  const options = { action, repo: path.resolve(path.dirname(self), '..'), dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dry-run') options.dryRun = true;
    else if (rest[i] === '--repo' && rest[i + 1] && !rest[i + 1].startsWith('--')) options.repo = path.resolve(rest[++i]);
    else throw new Error('Unknown option or missing --repo value.');
  }
  return options;
}

export function makePlan({ repo, platform = process.platform, node = process.execPath, home = homedir(), uid = process.getuid?.() }) {
  if (!['win32', 'darwin'].includes(platform)) throw new Error('Only Windows and macOS schedules are supported.');
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (![repo, node, home].every((value) => paths.isAbsolute(value) && !/[\x00-\x1f]/.test(value))) throw new Error('Absolute, control-character-free paths are required.');
  const id = createHash('sha256').update(`${home}\n${repo}`).digest('hex').slice(0, 16);
  const scheduler = paths.join(repo, 'scripts', 'hii-source-update-schedule.mjs');
  const updater = paths.join(repo, 'scripts', 'hii-source-update.mjs');
  const log = paths.join(home, '.hii', 'logs', 'source-update.jsonl');
  const common = { kind: 'source-checkout-only', platform, repo, node, intervalSeconds: 900, log, updater, updaterArgs: [updater, 'update', '--repo', repo], programArguments: [node, scheduler, 'run', '--repo', repo] };
  if (platform === 'darwin') {
    if (!Number.isInteger(uid) || uid < 0) throw new Error('A valid macOS user ID is required.');
    const label = `com.hii.source-update.${id}`;
    const plistPath = paths.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array>${common.programArguments.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${xml(repo)}</string>\n<key>StartInterval</key><integer>900</integer>\n<key>RunAtLoad</key><false/>\n<key>ProcessType</key><string>Background</string>\n</dict></plist>\n`;
    return { ...common, label, plistPath, plist, domain: `gui/${uid}` };
  }
  const taskName = `HII Source Update ${id}`;
  // Literal PowerShell arguments survive spaces, apostrophes and metacharacters.
  const runner = `$ErrorActionPreference='Stop'; & ${common.programArguments.map(ps).join(' ')}; exit $LASTEXITCODE`;
  const taskArguments = `-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded(runner)}`;
  const installScript = `$ErrorActionPreference='Stop'
$name=${ps(taskName)}
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'The source-update task already exists; it was not replaced.' }
$shell=(Get-Command powershell.exe -ErrorAction Stop).Source
$action=New-ScheduledTaskAction -Execute $shell -Argument ${ps(taskArguments)} -WorkingDirectory ${ps(repo)}
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(15) -RepetitionInterval (New-TimeSpan -Minutes 15)
$principal=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -Hidden -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 14) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Updates only a clean fast-forward HII source checkout; does not update installed app binaries.' -ErrorAction Stop | Out-Null
`;
  const statusScript = `$ErrorActionPreference='Stop'
$task=Get-ScheduledTask -TaskName ${ps(taskName)} -ErrorAction SilentlyContinue
if ($null -eq $task) { Write-Output '{"installed":false}'; exit 0 }
$info=$task | Get-ScheduledTaskInfo
@{installed=$true;state=[string]$task.State;lastResult=$info.LastTaskResult;lastRun=$info.LastRunTime.ToString('o');nextRun=$info.NextRunTime.ToString('o')} | ConvertTo-Json -Compress
`;
  return { ...common, taskName, taskArguments, installScript, statusScript };
}

function execute(file, args, options = {}) {
  return spawnSync(file, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 1024 * 1024, ...options });
}

function powershell(script, options) {
  return execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded(script)], options);
}

function ensureInputs(plan) {
  if (realpathSync(plan.repo) !== plan.repo) throw new Error('Use the canonical repository path for installation and execution.');
  for (const file of [plan.node, plan.updater, plan.programArguments[1]]) {
    if (!lstatSync(file).isFile()) throw new Error('Required Node or source-update script is missing.');
  }
}

export function install(plan, dryRun = false) {
  if (dryRun) return { dryRun: true, action: 'install', plan };
  ensureInputs(plan);
  if (plan.platform === 'darwin') {
    if (existsSync(plan.plistPath)) throw new Error('The source-update plist already exists; it was not replaced.');
    const loaded = execute('/bin/launchctl', ['print', `${plan.domain}/${plan.label}`]);
    if (loaded.status === 0) throw new Error('The source-update job already exists; it was not replaced.');
    if (loaded.error) throw new Error('Could not inspect launchd; nothing was installed.');
    mkdirSync(path.dirname(plan.plistPath), { recursive: true, mode: 0o700 });
    writeFileSync(plan.plistPath, plan.plist, { flag: 'wx', mode: 0o600 });
    const result = execute('/bin/launchctl', ['bootstrap', plan.domain, plan.plistPath]);
    if (result.status !== 0) throw new Error('launchd registration failed; the newly created plist remains for inspection.');
  } else {
    const result = powershell(plan.installScript);
    if (result.status !== 0) throw new Error('Task registration failed or the task already exists; no existing task was replaced.');
  }
  return { installed: true, kind: plan.kind, name: plan.label ?? plan.taskName, intervalSeconds: plan.intervalSeconds, log: plan.log };
}

export function scheduleStatus(plan, dryRun = false) {
  if (dryRun) return { dryRun: true, action: 'status', plan };
  if (plan.platform === 'darwin') {
    const result = execute('/bin/launchctl', ['print', `${plan.domain}/${plan.label}`]);
    if (result.error) throw new Error('Could not inspect launchd.');
    return { kind: plan.kind, plistExists: existsSync(plan.plistPath), loaded: result.status === 0, name: plan.label };
  }
  const result = powershell(plan.statusScript);
  if (result.status !== 0) throw new Error('Could not inspect the source-update task.');
  return { kind: plan.kind, name: plan.taskName, ...JSON.parse(result.stdout.trim()) };
}

export function runUpdate(plan, dryRun = false) {
  if (dryRun) return { dryRun: true, action: 'run', executable: plan.node, args: plan.updaterArgs, log: plan.log };
  ensureInputs(plan);
  const logDirectory = path.dirname(plan.log);
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  if (lstatSync(logDirectory).isSymbolicLink() || (existsSync(plan.log) && (!lstatSync(plan.log).isFile() || lstatSync(plan.log).isSymbolicLink()))) throw new Error('Source-update log path must not be a link.');
  if (plan.platform !== 'win32' && existsSync(plan.log)) chmodSync(plan.log, 0o600);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const result = execute(plan.node, plan.updaterArgs, { cwd: plan.repo, timeout: 12 * 60_000 });
  // Deliberately discard child stdout/stderr: they may contain private Git URLs.
  const receipt = { kind: plan.kind, startedAt, durationMs: Date.now() - started, exitCode: result.status, signal: result.signal ?? null, failedToRun: Boolean(result.error) };
  appendFileSync(plan.log, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  return receipt;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = makePlan({ repo: options.repo });
  const result = options.action === 'install' ? install(plan, options.dryRun)
    : options.action === 'status' ? scheduleStatus(plan, options.dryRun) : runUpdate(plan, options.dryRun);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (options.action === 'run' && !options.dryRun && (result.failedToRun || result.exitCode !== 0)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
