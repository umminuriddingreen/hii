#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalLauncher = path.join(root, 'scripts', process.platform === 'win32' ? 'hii-launcher.ps1' : 'hii-launcher.sh');

function destinationState(destination) {
  try { return lstatSync(destination); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function installLauncher(options = {}) {
  const source = options.source || canonicalLauncher;
  const destination = options.destination
    || process.env.HII_LAUNCHER_PATH
    || (process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'npm', 'hii.ps1')
      : path.join(homedir(), 'bin', 'hii'));
  const destinationDirectory = path.dirname(destination);
  const staging = path.join(destinationDirectory, `.hii-launcher-${randomUUID()}.tmp`);

  if (!existsSync(source)) {
    throw new Error(`canonical HII launcher is missing: ${source}`);
  }

  const previous = destinationState(destination);
  if (previous) {
    if (!previous.isFile() || previous.isSymbolicLink()) {
      throw new Error('HII launcher destination must be a regular file, not a link or directory');
    }
    if (readFileSync(source).equals(readFileSync(destination))) {
      return { source, destination, backup: null, unchanged: true };
    }
    if (!options.replaceExisting) {
      throw new Error('Existing HII launcher differs from this version and may hold model configuration. It was preserved. Use --replace-launcher only after migrating its settings; replacement creates a backup.');
    }
  }

  mkdirSync(destinationDirectory, { recursive: true });
  const backup = previous ? `${destination}.previous-${randomUUID()}` : null;
  if (backup) copyFileSync(destination, backup);
  try {
    copyFileSync(source, staging);
    chmodSync(staging, 0o755);
    renameSync(staging, destination);
  } finally {
    rmSync(staging, { force: true });
  }

  return { source, destination, backup };
}

export function setInstallRoot(repo, options = {}) {
  if (!path.isAbsolute(repo) || /[\r\n\0]/.test(repo)) throw new Error('HII install root must be one absolute directory path');
  if (!existsSync(path.join(repo, 'Cargo.toml')) || !existsSync(path.join(repo, 'cli', 'Cargo.toml'))) {
    throw new Error('HII install root must contain the HII Cargo workspace and cli/Cargo.toml');
  }
  const destination = options.destination || path.join(homedir(), '.hii', 'install-root');
  mkdirSync(path.dirname(destination), { recursive: true });
  const previous = destinationState(destination);
  if (previous && (!previous.isFile() || previous.isSymbolicLink())) {
    throw new Error('HII install-root destination must be a regular file');
  }
  const backup = previous ? `${destination}.previous-${randomUUID()}` : null;
  if (backup) copyFileSync(destination, backup);
  const staging = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, `${repo}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(staging, destination);
  } finally {
    rmSync(staging, { force: true });
  }
  return { destination, backup, root: repo };
}

function buildBrowserAdapter() {
  const browser = path.join(root, 'browser');
  const npmCli = process.env.npm_execpath
    || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) throw new Error(`Unable to locate npm CLI at ${npmCli}`);
  const playwrightPackage = path.join(browser, 'node_modules', 'playwright', 'package.json');
  if (!existsSync(playwrightPackage)) {
    const install = spawnSync(process.execPath, [npmCli, 'ci', '--ignore-scripts'], {
      cwd: browser,
      stdio: 'inherit'
    });
    if (install.error) throw new Error(`Unable to install the HII browser build dependencies: ${install.error.message}`);
    if (install.status !== 0) throw new Error(`HII browser dependency install exited with ${install.status}`);
  }
  const build = spawnSync(process.execPath, [npmCli, 'run', 'build'], {
    cwd: browser,
    stdio: 'inherit'
  });
  if (build.error) throw new Error(`Unable to start the HII browser build: ${build.error.message}`);
  if (build.status !== 0) throw new Error(`HII browser build exited with ${build.status}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const allowed = new Set(['--launcher-only', '--set-root', '--replace-launcher']);
    const unexpected = process.argv.slice(2).find(arg => !allowed.has(arg));
    if (unexpected) throw new Error(`Unknown installation argument: ${unexpected}`);
    if (!process.argv.includes('--launcher-only')) buildBrowserAdapter();
    const installed = installLauncher({ replaceExisting: process.argv.includes('--replace-launcher') });
    if (process.argv.includes('--set-root')) {
      setInstallRoot(root);
    }
    console.log(`hii CLI launcher installed: ${installed.destination}`);
    console.log('The launcher executes the release binary directly and builds only when that binary is missing.');
  } catch (error) {
    console.error(`hii CLI launcher install failed: ${error.message}`);
    process.exit(1);
  }
}
