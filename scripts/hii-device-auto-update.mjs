#!/usr/bin/env node
// Local trusted-source coordinator. Enabling/installing scheduling is an owner action.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const ROOT = path.join(os.homedir(), '.hii/auto-update');
const resources = ['runtime/', 'config/', 'scripts/', 'browser/dist/', 'docs/HII_FEATURE_REGISTRY.yaml', 'AGENTS.md', 'package.json'];
export function inScope(name) {
  return resources.some(p => p.endsWith('/') ? name.startsWith(p) : name === p)
    || name === 'Cargo.toml' || name === 'Cargo.lock' || name === 'build.rs'
    || ['cli/', 'crates/', 'fabric/', 'native-runner/'].some(p => name.startsWith(p));
}
export function fingerprint(tree) {
  return createHash('sha256').update(tree.split('\n').filter(row => inScope(row.split('\t')[1] || '')).sort().join('\n')).digest('hex');
}
export function validateConfig(c) {
  if (!path.isAbsolute(c.repo || '')) throw Error('repo must be an absolute trusted local repository path');
  if (c.branch && c.branch !== 'main') throw Error('only canonical main is supported');
  if (c.windows?.enabled && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(c.windows.host || '')) throw Error('invalid configured SSH host');
  if (c.windows?.enabled && !/^C:\/Users\/[a-zA-Z0-9._-]+\/\.hii\/auto-update$/.test(c.windows.root || '')) throw Error('Windows root must be owned C:/Users/<user>/.hii/auto-update');
  return c;
}
async function read(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
async function write(file, data) { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.${process.pid}.tmp`; await fs.writeFile(temp, JSON.stringify(data, null, 2)+'\n', { mode: 0o600 }); await fs.rename(temp, file); }
export async function run(bin, args, options = {}) {
  // POSIX process groups keep timeout/output overflow from leaving Cargo descendants.
  const { timeout = 60_000, maxBuffer = 1024 * 1024, diagnosticRoot = path.join(ROOT, 'failures'), ...rest } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { ...rest, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', size = 0, failure, tail = Buffer.alloc(0);
    const capture = data => { tail = Buffer.concat([tail, data]).subarray(-65536); };
    let diagnosed = false;
    const diagnose = async error => {
      if (diagnosed) return; diagnosed = true;
      try {
        await fs.mkdir(diagnosticRoot, { recursive: true, mode: 0o700 });
        const diagnosticPath = path.join(diagnosticRoot, `${Date.now()}-${process.pid}-${randomUUID()}.log`);
        await fs.writeFile(diagnosticPath, tail, { mode: 0o600, flag: 'wx' });
        error.diagnosticPath = diagnosticPath;
        error.diagnosticSha256 = createHash('sha256').update(tail).digest('hex');
        error.failedTests = [...new Set([...tail.toString('utf8').matchAll(/^test ([a-zA-Z0-9_:.-]+) \.\.\. FAILED$/gm)].map(match => match[1]))].slice(0, 20);
      } catch { error.diagnosticUnavailable = true; }
      reject(error);
    };
    const kill = () => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
    const timer = setTimeout(() => { failure = Object.assign(Error('subprocess timeout'), { code: 'TIMEOUT' }); kill(); }, timeout);
    child.stdout.on('data', data => { capture(data); size += data.length; if(size > maxBuffer) { failure = Object.assign(Error('output cap'), { code: 'OUTPUT_CAP' }); kill(); } else stdout += data; });
    child.stderr.on('data', data => { capture(data); size += data.length; if(size > maxBuffer) { failure = Object.assign(Error('output cap'), { code: 'OUTPUT_CAP' }); kill(); } });
    child.on('error', error => { clearTimeout(timer); void diagnose(error); });
    child.on('close', code => { clearTimeout(timer); if (failure) void diagnose(failure); else if(code !== 0) void diagnose(Object.assign(Error('subprocess failed'), { exitCode: code })); else resolve(stdout.trim()); });
  });
}
export async function snapshot(file) { try { const stat = await fs.stat(file); return { body: await fs.readFile(file), mode: stat.mode & 0o777 }; } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
export async function restore(file, previous) { if (!previous) return fs.rm(file, { force: true }); const temp = `${file}.${process.pid}.rollback`; await fs.writeFile(temp, previous.body, { mode: previous.mode }); await fs.rename(temp, file); }
export async function lock(root) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'coordinator.lock');
  let handle;
  for (let attempt=0; attempt<2; attempt++) {
    try { handle = await fs.open(file, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt) throw error;
      const pid = Number(await fs.readFile(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw error;
      try { process.kill(pid, 0); throw error; } catch (probe) { if(probe.code !== 'ESRCH') throw error; }
      await fs.unlink(file);
    }
  }
  await handle.writeFile(String(process.pid));
  return async () => { await handle.close(); await fs.unlink(file); };
}
function ps(value) { return `'${value.replaceAll("'", "''")}'`; }
async function updateWindows(c, source, commit, root) {
  const bundle = path.join(root, `${commit}.bundle`);
  await run('git', ['-C', source, 'bundle', 'create', bundle, 'HEAD'], { timeout: 120_000 });
  const remote = `${c.root}/${commit}.bundle`;
  // Remote root must already be provisioned by the foreground; no arbitrary mkdir shell.
  await run('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', bundle, `${c.host}:${remote}`], { timeout: 180_000 });
  const script = `${c.root}/hii-device-update-windows.ps1`;
  const staged = `${c.root}/hii-device-update-windows-${commit}.ps1`;
  await run('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', path.join(source, 'scripts/hii-device-update-windows.ps1'), `${c.host}:${staged}`], { timeout: 180_000 });
  const command = `Move-Item -LiteralPath ${ps(staged)} -Destination ${ps(script)} -Force -ErrorAction Stop; & ${ps(script)} -BundlePath ${ps(remote)} -Commit ${ps(commit)} -BuildRoot ${ps(c.root+'/sources')} -ProofRoot ${ps(c.root+'/proofs')}`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const raw = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', c.host, 'pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 1_200_000 });
  const proof = JSON.parse(raw);
  if (proof.commit !== commit || proof.status !== 'verified') throw Error('Windows proof did not verify requested commit');
  return { status: 'verified', commit, verifiedAt: new Date().toISOString() };
}
async function verifyMac(c, commit) {
  const releaseRoot = c.releaseRoot || path.join(os.homedir(), '.hii/releases/hii-cli');
  const launcher = c.launcherPath || path.join(os.homedir(), 'bin/hii');
  const marker = path.join(releaseRoot, 'current.bin');
    const manifest = await read(path.join(releaseRoot, commit, 'release.json'));
    const binary = (await fs.readFile(marker, 'utf8')).trim();
    if (manifest.commit !== commit || manifest.sourceCommitVerified !== true || binary !== manifest.releaseBinary) throw Error('installed identity mismatch');
    const hash = createHash('sha256').update(await fs.readFile(binary)).digest('hex');
    if (hash !== manifest.binarySha256) throw Error('installed binary hash mismatch');
    await run(launcher, ['--version']);
    await run(launcher, ['home', '--brief'], { env: { ...process.env, HII_YOLO: '0' } });
  return hash;
}
export async function markedMacRelease(c) {
  const releaseRoot = c.releaseRoot || path.join(os.homedir(), '.hii/releases/hii-cli');
  const marker = path.join(releaseRoot, 'current.bin');
  let binary;
  try { binary = (await fs.readFile(marker, 'utf8')).trim(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!binary || !path.isAbsolute(binary)) return null;
  const releaseDir = path.dirname(binary);
  const commit = path.basename(releaseDir);
  if (!/^[a-f0-9]{40}$/.test(commit) || path.resolve(releaseDir) !== path.resolve(releaseRoot, commit)) return null;
  let manifest;
  try { manifest = await read(path.join(releaseDir, 'release.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (manifest.commit !== commit || manifest.sourceCommitVerified !== true || manifest.releaseBinary !== binary) return null;
  const hash = createHash('sha256').update(await fs.readFile(binary)).digest('hex');
  if (hash !== manifest.binarySha256) return null;
  return { commit, binarySha256: hash };
}
export async function isMacReleaseDescendant(repo, targetCommit, installedCommit) {
  if (!/^[a-f0-9]{40}$/.test(targetCommit) || !/^[a-f0-9]{40}$/.test(installedCommit)) return false;
  if (targetCommit === installedCommit) return false;
  try {
    await run('git', ['-C', repo, 'merge-base', '--is-ancestor', targetCommit, installedCommit]);
    return true;
  } catch (error) {
    if (error.exitCode === 1) return false;
    throw error;
  }
}
async function updateMac(c, source, commit) {
  const prechecks = [];
  let phase = 'source-checks';
  try {
  await run('cargo', ['test', '--locked', '--offline', '--manifest-path', path.join(source, 'cli/Cargo.toml')], { cwd: source, timeout: 1_200_000 });
  prechecks.push('cargo-cli-tests');
  const tests = ['scripts/hii-code-check.test.mjs', 'scripts/hii-skill-sync.test.mjs', 'scripts/hii-device-auto-update.test.mjs'];
  const present = [];
  for (const test of tests) { try { await fs.access(path.join(source, test)); present.push(test); } catch { if (!test.includes('device-auto-update')) throw Error('required source check missing'); } }
  await run(process.execPath, ['--test', ...present], { cwd: source, timeout: 1_200_000 });
  prechecks.push(...present);
  phase = 'installation';
  const releaseRoot = c.releaseRoot || path.join(os.homedir(), '.hii/releases/hii-cli');
  const launcher = c.launcherPath || path.join(os.homedir(), 'bin/hii');
  const marker = path.join(releaseRoot, 'current.bin');
  const oldMarker = await snapshot(marker), oldLauncher = await snapshot(launcher);
  try {
    await run(process.execPath, [path.join(source, 'scripts/hii-release-installer.mjs'), '--source-root', source, '--source-commit', commit, '--release-root', releaseRoot, '--launcher-path', launcher], { timeout: 1_200_000, env: { ...process.env, MISTRALRS_METAL_PRECOMPILE: '0' } });
    phase = 'postchecks';
    const hash = await verifyMac(c, commit);
    return { status: 'verified', commit, prechecks, postchecks: ['source-commit', 'marker', 'binary-sha256', 'launcher-version', 'home-brief'], binarySha256: hash, verifiedAt: new Date().toISOString() };
  } catch (error) { await restore(marker, oldMarker); await restore(launcher, oldLauncher); throw error; }
  } catch(error) { error.phase = phase; throw error; }
}
export async function once(c, root = ROOT) {
  validateConfig(c);
  const unlock = await lock(root);
  try {
    const stateFile = path.join(root, 'state.json');
    const state = await read(stateFile, { devices: {} });
    const commit = await run('git', ['-C', c.repo, 'rev-parse', '--verify', 'refs/heads/main^{commit}']);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('invalid local main identity');
    const tree = await run('git', ['-C', c.repo, 'ls-tree', '-r', commit], { maxBuffer: 16 * 1024 * 1024 });
    const scopeHash = fingerprint(tree);
    const now = Date.now();
    if (state.observed !== commit) { state.observed = commit; state.observedAt = now; }
    const receipt = { schema: 'hii-device-auto-update-v1', at: new Date(now).toISOString(), commit, scopeHash, mode: c.enabled === true ? 'enabled' : 'plan', devices: {} };
    const ready = now - state.observedAt >= Math.max(0, c.debounceSeconds ?? 60) * 1000;
    let source;
    for (const device of ['mac', 'windows']) {
      const previous = state.devices[device];
      if (device === 'windows' && !c.windows?.enabled) { receipt.devices[device] = { status: 'disabled' }; continue; }
      if (device === 'mac' && c.enabled === true && ready) {
        try {
          const installed = await markedMacRelease(c);
          if (installed && installed.commit !== commit) {
            await verifyMac(c, installed.commit);
            if (await isMacReleaseDescendant(c.repo, commit, installed.commit)) {
              const held = { status: 'held-local-release', installedCommit: installed.commit, targetCommit: commit, sourceCommitVerified: true, binarySha256: installed.binarySha256, verifiedAt: new Date(now).toISOString() };
              state.devices.mac = held;
              receipt.devices.mac = held;
              continue;
            }
          }
        } catch (error) {
          const pending = { status: 'pending', commit, phase: 'local-release-relation-check', error: 'installed-release-relation-unverified', diagnosticPath: error.diagnosticPath, diagnosticSha256: error.diagnosticSha256 };
          state.devices.mac = pending;
          receipt.devices.mac = pending;
          continue;
        }
      }
      if (previous?.scopeHash === scopeHash && previous.status === 'verified') {
        const due = now - Date.parse(previous.verifiedAt) >= Math.max(0, c.verifyIntervalSeconds ?? 300) * 1000;
        if (c.enabled === true && due) {
          try {
            if(device === 'mac') await verifyMac(c, previous.commit);
            else {
              const cmd = `& ${ps(c.windows.root+'/hii-device-update-windows.ps1')} -VerifyOnly -Commit ${ps(previous.commit)} -BuildRoot ${ps(c.windows.root+'/sources')} -ProofRoot ${ps(c.windows.root+'/proofs')}`;
              const raw = await run('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=10',c.windows.host,'pwsh.exe','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(cmd,'utf16le').toString('base64')], { timeout: 60_000 });
              const proof = JSON.parse(raw); if(proof.status !== 'verified' || proof.commit !== previous.commit) throw Error('installed proof mismatch');
            }
            previous.verifiedAt = new Date(now).toISOString();
          } catch(error) {
            state.devices[device] = { status:'pending', commit:previous.commit, phase:'periodic-installed-verification', error:'installed-verification-failed', diagnosticPath:error.diagnosticPath, diagnosticSha256:error.diagnosticSha256, failedTests:error.failedTests, lastVerified:previous };
            receipt.devices[device] = state.devices[device]; continue;
          }
        }
        receipt.devices[device] = { ...previous, status: 'unchanged', observedCommit: commit }; continue;
      }
      if (c.enabled !== true || !ready) { receipt.devices[device] = { status: c.enabled === true ? 'debouncing' : 'planned' }; continue; }
      if (previous?.retryAt > now) { receipt.devices[device] = { status: 'pending', retryAt: previous.retryAt }; continue; }
      try {
        if (!source) {
          source = c.sourceWorktree || path.join(root, 'sources', 'current');
          if (path.resolve(source) === path.resolve(c.repo)) throw Error('canonical source cannot be update worktree');
          await fs.mkdir(path.dirname(source), { recursive: true });
          try { await fs.access(source); } catch { await run('git', ['-C', c.repo, 'worktree', 'add', '--detach', source, commit]); }
          if (await fs.realpath(source) === await fs.realpath(c.repo)) throw Error('canonical source cannot be update worktree');
          const common = async repo => path.resolve(repo, await run('git', ['-C', repo, 'rev-parse', '--git-common-dir']));
          if (await fs.realpath(await common(source)) !== await fs.realpath(await common(c.repo))) throw Error('isolated source belongs to different repository');
          const dirty = await run('git', ['-C', source, 'status', '--porcelain', '--untracked-files=normal']);
          if (dirty) throw Error('isolated source dirty; preserving work');
          await run('git', ['-C', source, 'switch', '--detach', commit]);
          const actual = await run('git', ['-C', source, 'rev-parse', 'HEAD']);
          if (actual !== commit) throw Error('isolated source identity mismatch');
        }
        if (device === 'windows' && state.devices.mac?.status !== 'verified') throw Error('local source verification required before transfer');
        const proof = device === 'mac' ? await updateMac(c, source, commit) : await updateWindows(c.windows, source, commit, root);
        state.devices[device] = { ...proof, scopeHash };
        receipt.devices[device] = state.devices[device];
      } catch (error) {
        const failures = (previous?.failures || 0) + 1;
        const pending = { status: 'pending', commit, failures, retryAt: now + Math.min(3600, 60 * 2 ** Math.min(failures, 6)) * 1000, error: 'update-or-verification-failed', phase: error.phase || (device === 'windows' ? 'windows-transport-or-proof' : 'source-preparation'), exitCode: Number.isInteger(error.exitCode) ? error.exitCode : undefined, diagnosticPath: error.diagnosticPath, diagnosticSha256: error.diagnosticSha256, failedTests: error.failedTests, lastVerified: previous?.status === 'verified' ? previous : previous?.lastVerified };
        state.devices[device] = pending; receipt.devices[device] = pending;
      }
    }
    state.latest = receipt;
    await write(stateFile, state);
    await write(path.join(root, 'receipts', `${now}-${commit.slice(0,12)}.json`), receipt);
    return receipt;
  } finally { await unlock(); }
}
async function main() {
  const args = process.argv.slice(2); let config = path.join(ROOT, 'config.json'); let status = false;
  for (let i=0; i<args.length; i++) { if(args[i]==='--config') config=args[++i]; else if(args[i]==='--status') status=true; else if(args[i]!=='--once') throw Error('usage: hii-device-auto-update.mjs [--once|--status] [--config PATH]'); }
  if (status) console.log(JSON.stringify((await read(path.join(ROOT,'state.json'), {})).latest || { status: 'not-run' }, null, 2));
  else console.log(JSON.stringify(await once(await read(config, { repo: '/Users/example/hii', enabled: false })), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('HII auto-update coordinator failed; source unchanged. Check configuration or owned lock.'); process.exitCode=1; });
