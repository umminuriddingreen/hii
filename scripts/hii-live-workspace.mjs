#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const INVENTORY_MS = 5000;
const STAT_SCAN_MS = 1800;
const SKIP_DIRS = new Set(['.git', '.hii', '.next', '.turbo', 'build', 'dist', 'node_modules', 'target']);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function isText(sample) {
  if (sample.includes(0)) return false;
  try { utf8Decoder.decode(sample); return true; }
  catch { return false; }
}

function displayPath(value) { return value.replace(/[\x00-\x1f\x7f]/g, '?'); }

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function parseArgs(argv) {
  const options = { detached: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--detached') options.detached = true;
    else if (arg === '--json') options.json = true;
    else if (['--directory', '--binary', '--session'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = argv[++i];
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.help && (!options.directory || !options.binary)) {
    throw new Error('usage: hii-live-workspace.mjs --directory PATH --binary PATH [--detached] [--session NAME] [--json]');
  }
  return options;
}

function command(name, args, options = {}) {
  const result = spawnSync(name, args, { encoding: 'utf8', ...options });
  if (result.error) throw new Error(`${name} is unavailable: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${name} ${args.join(' ')} failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  return (result.stdout || '').trim();
}

export async function listTextFiles(root, gitOutput) {
  root = await fs.realpath(root);
  const files = [];
  for (const relative of gitOutput.split('\0').filter(Boolean)) {
    if (relative.split(path.sep).some(part => SKIP_DIRS.has(part))) continue;
    const candidate = path.resolve(root, relative);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) continue;
    try {
      const linkInfo = await fs.lstat(candidate);
      const real = linkInfo.isSymbolicLink() ? await fs.realpath(candidate) : candidate;
      if (real !== root && !real.startsWith(`${root}${path.sep}`)) continue;
      const info = linkInfo.isSymbolicLink() ? await fs.stat(real) : linkInfo;
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      const handle = await fs.open(real, 'r');
      const sample = Buffer.alloc(Math.min(info.size, 65536));
      let bytesRead;
      try { ({ bytesRead } = await handle.read(sample, 0, sample.length, 0)); }
      finally { await handle.close(); }
      if (!isText(sample.subarray(0, bytesRead))) continue;
      files.push({ path: real, relative: path.relative(root, real), mtimeMs: info.mtimeMs, size: info.size, ino: info.ino, ctimeMs: info.ctimeMs });
    } catch { /* stale, unreadable, or unsafe worktree entries are skipped */ }
  }
  return files;
}

async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function watch(root, stateFile) {
  const events = [];
  let previous = new Map();
  let metadata = new Map();
  let classifications = new Map();
  let selected = null;
  let gitOutput = '';
  let lastInventory = 0;
  let lastStat = 0;
  await fs.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  console.log(`Watching git files under ${root}`);
  for (;;) {
    try {
      const now = Date.now();
      if (!gitOutput || now - lastInventory >= INVENTORY_MS) {
        gitOutput = command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root });
        lastInventory = now;
      }
      if (now - lastStat >= STAT_SCAN_MS) {
        const nextMetadata = new Map();
        for (const relative of gitOutput.split('\0').filter(Boolean)) {
          if (relative.split(path.sep).some(part => SKIP_DIRS.has(part))) continue;
          const candidate = path.resolve(root, relative);
          if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) continue;
          try {
            const linkInfo = await fs.lstat(candidate);
            const real = linkInfo.isSymbolicLink() ? await fs.realpath(candidate) : candidate;
            if ((real !== root && !real.startsWith(`${root}${path.sep}`)) || !linkInfo.isFile() && !linkInfo.isSymbolicLink()) continue;
            const info = linkInfo.isSymbolicLink() ? await fs.stat(real) : linkInfo;
            if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
            const record = { path: real, relative: path.relative(root, real), mtimeMs: info.mtimeMs, size: info.size, ino: info.ino, ctimeMs: info.ctimeMs };
            const signature = `${record.mtimeMs}:${record.ctimeMs}:${record.size}:${record.ino}`;
            nextMetadata.set(real, record);
            let classification = classifications.get(real);
            if (classification?.signature !== signature) {
              const handle = await fs.open(real, 'r');
              const sample = Buffer.alloc(Math.min(info.size, 65536));
              let bytesRead;
              try { ({ bytesRead } = await handle.read(sample, 0, sample.length, 0)); }
              finally { await handle.close(); }
              classification = { signature, isText: isText(sample.subarray(0, bytesRead)) };
              classifications.set(real, classification);
            }
          } catch { /* stale, unreadable, or unsafe worktree entries are skipped */ }
        }
        for (const file of classifications.keys()) if (!nextMetadata.has(file)) classifications.delete(file);
        metadata = nextMetadata;
        lastStat = now;
      }
      const files = [...metadata.values()].filter(file => classifications.get(file.path)?.isText);
      const next = new Map(files.map(file => [file.path, file]));
      const changed = files.filter(file => {
        const old = previous.get(file.path);
        return !old || old.mtimeMs !== file.mtimeMs || old.ctimeMs !== file.ctimeMs || old.size !== file.size || old.ino !== file.ino;
      }).sort((a, b) => b.mtimeMs - a.mtimeMs);
      const removed = [...previous.keys()].filter(file => !next.has(file));
      if (changed.length || removed.length) {
        const event = { at: new Date().toISOString(), changedCount: changed.length, changed: changed.slice(0, 6).map(x => x.relative), removedCount: removed.length, removed: removed.slice(0, 6).map(x => path.relative(root, x)) };
        events.push(event);
        if (events.length > 24) events.shift();
        if (changed.length && (!selected || changed[0].mtimeMs >= (next.get(selected)?.mtimeMs ?? -Infinity))) selected = changed[0].path;
        if (selected && !next.has(selected)) selected = changed[0]?.path ?? files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? null;
        console.log(`${event.at} changed ${changed.length}, removed ${removed.length}: ${[...event.changed, ...event.removed].map(displayPath).join(', ') || '(metadata)'}`);
        await writeJson(stateFile, { version: 1, root, file: selected, fileMeta: selected ? next.get(selected) : null, updatedAt: event.at, activity: events });
      }
      if (selected && !next.has(selected)) selected = files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? null;
      previous = next;
    } catch (error) {
      console.error(`watch error: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function tmux(args) { return command('tmux', args); }

async function launch(options) {
  const root = await fs.realpath(options.directory);
  if (root === path.parse(root).root || root === os.homedir()) throw new Error('choose a project directory below the filesystem or home root');
  const binary = path.resolve(options.binary);
  const binaryInfo = await fs.stat(binary).catch(() => null);
  if (!binaryInfo?.isFile()) throw new Error(`HII binary not found: ${binary}`);
  command('git', ['rev-parse', '--show-toplevel'], { cwd: root });
  for (const dependency of ['tmux', '/bin/bash', 'vim', 'git']) {
    if (dependency.startsWith('/')) {
      await fs.access(dependency).catch(() => { throw new Error(`required dependency unavailable: ${dependency}`); });
    } else command('which', [dependency]);
  }
  const session = options.session || `hii-live-${path.basename(root).replace(/[^A-Za-z0-9_.-]/g, '-')}-${Date.now().toString(36)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(session)) throw new Error('--session must start with a letter or digit and contain only letters, digits, dot, underscore, and dash');
  const stateDir = path.join(os.homedir(), '.hii', 'live-workspaces', session);
  await fs.mkdir(path.dirname(stateDir), { recursive: true, mode: 0o700 });
  await fs.mkdir(stateDir, { mode: 0o700 }).catch(error => {
    if (error.code === 'EEXIST') throw new Error(`live workspace state already exists for session ${session}`);
    throw error;
  });
  const stateFile = path.join(stateDir, 'state.json');
  await writeJson(stateFile, { version: 1, root, file: null, updatedAt: new Date().toISOString(), activity: [] });
  const script = fileURLToPath(import.meta.url);
  const helper = path.join(SCRIPT_DIR, 'hii-live-workspace.vim');
  const hiiPane = `env HII_SHELL=/bin/bash ${shellQuote(binary)} -C ${shellQuote(root)}`;
  const bashPane = '/bin/bash -i';
  const vimPane = `env HII_LIVE_ROOT=${shellQuote(root)} HII_LIVE_STATE=${shellQuote(stateFile)} vim -Nu NONE -n -R -S ${shellQuote(helper)}`;
  const watcherPane = `${shellQuote(process.execPath)} ${shellQuote(script)} --watch ${shellQuote(root)} ${shellQuote(stateFile)}`;
  let created = false;
  try {
    tmux(['new-session', '-d', '-s', session, '-c', root, hiiPane]);
    created = true;
    tmux(['split-window', '-h', '-t', `${session}:0`, '-c', root, bashPane]);
    tmux(['split-window', '-v', '-t', `${session}:0.1`, '-c', root, vimPane]);
    tmux(['select-layout', '-t', `${session}:0`, 'main-vertical']);
    tmux(['new-window', '-d', '-t', session, '-n', 'watcher', '-c', root, watcherPane]);
  } catch (error) {
    if (created) {
      try { tmux(['kill-session', '-t', session]); } catch { /* session may have already exited */ }
    }
    await fs.rm(stateDir, { recursive: true, force: true });
    throw error;
  }
  const attach = process.env.TMUX ? `tmux switch-client -t ${shellQuote(session)}` : `tmux attach-session -t ${shellQuote(session)}`;
  if (options.json) console.log(JSON.stringify({ ok: true, session, root, state: stateFile, attach }));
  else console.log(`Live workspace ${session}\n  root: ${root}\n  state: ${stateFile}\n  attach: ${attach}`);
  if (!options.detached) {
    const result = process.env.TMUX
      ? spawnSync('tmux', ['switch-client', '-t', session], { stdio: 'inherit' })
      : spawnSync('tmux', ['attach-session', '-t', session], { stdio: 'inherit' });
    if (result.error) throw new Error(`could not attach tmux: ${result.error.message}`);
  }
}

async function main() {
  if (process.argv[2] === '--watch') return watch(await fs.realpath(process.argv[3]), process.argv[4]);
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: hii-live-workspace.mjs --directory PATH --binary PATH [--detached] [--session NAME] [--json]');
    return;
  }
  await launch(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`hii-live-workspace: ${error.message}`); process.exitCode = 1; });
}
