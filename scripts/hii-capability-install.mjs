#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_SKILL_BYTES = 64 * 1024;
const packagePattern = /^[A-Za-z0-9][A-Za-z0-9@+._-]*$/;
const hfRepoPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) { throw new Error(message); }

function run(command, args, options = {}, runCommand = spawnSync) {
  const result = runCommand(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`${command} failed${result.status == null ? '' : ` (exit ${result.status})`}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function validateRoots(runtime, workspace, requestedSkills) {
  if (!path.isAbsolute(runtime) || !path.isAbsolute(workspace)) fail('--runtime and --workspace must be absolute paths');
  const requestedRuntime = path.resolve(runtime);
  const requestedWorkspace = path.resolve(workspace);
  if (requestedRuntime === path.parse(requestedRuntime).root || requestedWorkspace === path.parse(requestedWorkspace).root) fail('refusing filesystem root as runtime or workspace');
  if (!fs.existsSync(requestedWorkspace) || !fs.statSync(requestedWorkspace).isDirectory()) fail(`workspace is not a directory: ${requestedWorkspace}`);
  fs.mkdirSync(requestedRuntime, { recursive: true, mode: 0o700 });
  const requestedSkillsRoot = path.resolve(requestedSkills || path.join(requestedRuntime, 'skills'));
  if (requestedSkills && !path.isAbsolute(requestedSkills)) fail('--skills must be an absolute path');
  if (requestedSkills && (!fs.existsSync(requestedSkillsRoot) || !fs.statSync(requestedSkillsRoot).isDirectory())) fail(`configured HII skills folder is unavailable: ${requestedSkillsRoot}`);
  if (!requestedSkills) fs.mkdirSync(requestedSkillsRoot, { recursive: true, mode: 0o700 });
  return {
    runtime: fs.realpathSync(requestedRuntime),
    workspace: fs.realpathSync(requestedWorkspace),
    skills: fs.realpathSync(requestedSkillsRoot),
  };
}

function assertNoSymlinkComponents(target, boundary) {
  const base = path.resolve(boundary);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) fail(`path escapes trusted directory: ${resolved}`);
  let current = base;
  for (const component of path.relative(base, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail(`refusing symlink path component: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function validateRepo(value) {
  const repo = String(value || '').trim();
  if (!hfRepoPattern.test(repo) || repo.includes('..')) fail('model source must be a Hugging Face owner/repository ID');
  return repo;
}

function validateRelativeFile(value) {
  const file = String(value || '').trim();
  if (!file || path.posix.isAbsolute(file) || file.includes('\\') || file.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('file or subdirectory must be a safe relative path');
  }
  return file;
}

function sha256File(file) {
  const descriptor = fs.openSync(file, 'r');
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, bytes));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function installModel({ runtime, workspace, source, file }, runCommand) {
  const repo = validateRepo(source);
  if (!file) {
    const daemon = path.join(SCRIPT_ROOT, 'runtime', 'daemon', 'hiid.mjs');
    if (!fs.existsSync(daemon) || !fs.lstatSync(daemon).isFile()) fail(`HII model installer is unavailable: ${daemon}`);
    run('node', [daemon, 'model-runtime', 'install', repo], {
      cwd: SCRIPT_ROOT,
      stdio: 'inherit',
      env: { ...process.env, HII_RUNTIME_DIR: runtime },
    }, runCommand);
    return { kind: 'model', source: repo, verifiedBy: 'hii-model-runtime' };
  }
  const relative = validateRelativeFile(file);
  if (!relative.toLowerCase().endsWith('.gguf')) fail('local model-file import currently accepts GGUF files only');
  const targetRoot = path.join(runtime, 'models', 'gguf');
  const destination = path.resolve(targetRoot, relative);
  if (!destination.startsWith(`${path.resolve(targetRoot)}${path.sep}`)) fail('model file destination escapes runtime model directory');
  if (fs.existsSync(destination)) fail(`model file already exists: ${destination}`);
  const cacheRoot = path.join(runtime, 'models', 'huggingface', 'hub');
  assertNoSymlinkComponents(cacheRoot, runtime);
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(cacheRoot, runtime);
  run('hf', ['download', repo, relative, '--cache-dir', cacheRoot], { cwd: workspace, stdio: 'inherit' }, runCommand);
  run('hf', ['cache', 'verify', repo, '--cache-dir', cacheRoot], { cwd: workspace, stdio: 'inherit' }, runCommand);
  const repoCache = path.join(cacheRoot, `models--${repo.replaceAll('/', '--')}`);
  assertNoSymlinkComponents(repoCache, cacheRoot);
  const revision = fs.readFileSync(path.join(repoCache, 'refs', 'main'), 'utf8').trim();
  if (!/^[a-f0-9]{7,64}$/i.test(revision)) fail(`Hugging Face cache has an invalid main revision for ${repo}`);
  const cachedFile = path.resolve(repoCache, 'snapshots', revision, relative);
  const canonicalFile = fs.realpathSync(cachedFile);
  const canonicalCacheRoot = fs.realpathSync(cacheRoot);
  if (!canonicalFile.startsWith(`${canonicalCacheRoot}${path.sep}`)) fail('verified model file resolves outside the Hugging Face cache');
  const stat = fs.statSync(canonicalFile);
  if (!stat.isFile() || stat.size < 4) fail(`Hugging Face download did not produce a valid GGUF file: ${canonicalFile}`);
  const descriptor = fs.openSync(canonicalFile, 'r');
  const magic = Buffer.alloc(4);
  try { fs.readSync(descriptor, magic, 0, 4, 0); } finally { fs.closeSync(descriptor); }
  if (magic.toString('ascii') !== 'GGUF') fail(`downloaded file does not have a GGUF header: ${relative}`);
  const digest = sha256File(canonicalFile);
  assertNoSymlinkComponents(path.dirname(destination), runtime);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(path.dirname(destination), runtime);
  const staged = path.join(path.dirname(destination), `.hii-${path.basename(destination)}-${crypto.randomBytes(8).toString('hex')}`);
  try {
    fs.copyFileSync(canonicalFile, staged, fs.constants.COPYFILE_EXCL);
    fs.linkSync(staged, destination);
    fs.unlinkSync(staged);
  } finally {
    fs.rmSync(staged, { force: true });
  }
  return { kind: 'model', source: repo, file: relative, path: destination, sha256: digest, verifiedBy: 'hf-cache-verify+gguf-header+sha256' };
}

function skillName(source, subdir) {
  const last = (subdir || source).split('/').filter(Boolean).at(-1) || '';
  const normalized = last.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized || normalized === '.' || normalized === '..') fail('could not derive a safe skill name from source');
  return normalized;
}

function assertNoSymlinks(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) fail(`skill source contains a symlink: ${full}`);
      if (entry.isDirectory()) stack.push(full);
      else if (!entry.isFile()) fail(`skill source contains an unsupported filesystem entry: ${full}`);
    }
  }
}

function locateLocalSkill(source, workspace, subdir) {
  const base = path.resolve(workspace, source);
  if (base !== workspace && !base.startsWith(`${workspace}${path.sep}`)) fail('local skill source must stay inside the workspace');
  assertNoSymlinkComponents(base, workspace);
  if (!fs.existsSync(base) || !fs.lstatSync(base).isDirectory()) fail(`local skill source must be a real directory: ${base}`);
  const relative = subdir ? validateRelativeFile(subdir) : '';
  const candidate = path.resolve(base, relative || '.');
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) fail('skill subdirectory escapes the local source directory');
  assertNoSymlinkComponents(candidate, base);
  if (!fs.existsSync(candidate) || !fs.lstatSync(candidate).isDirectory()) fail(`local skill subdirectory is not a real directory: ${candidate}`);
  return { directory: candidate, origin: path.relative(workspace, candidate) || '.' };
}

function installSkill({ workspace, skills, source, file: subdir }, runCommand) {
  let sourceDir;
  let origin;
  let temporaryClone;
  if (fs.existsSync(path.resolve(workspace, source))) {
    ({ directory: sourceDir, origin } = locateLocalSkill(source, workspace, subdir));
  } else {
    const match = String(source).match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (!match || match[1] === '.' || match[2] === '.' || source.includes('..')) fail('skill source must be a workspace-local directory or GitHub owner/repository');
    const repo = `${match[1]}/${match[2]}`;
    const relative = subdir ? validateRelativeFile(subdir) : '';
    temporaryClone = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-skill-import-'));
    try {
      run('git', ['clone', '--depth', '1', `https://github.com/${repo}.git`, temporaryClone], { stdio: 'inherit' }, runCommand);
      sourceDir = path.resolve(temporaryClone, relative || '.');
      if (!sourceDir.startsWith(`${temporaryClone}${path.sep}`) && sourceDir !== temporaryClone) fail('skill subdirectory escapes repository');
      assertNoSymlinkComponents(sourceDir, temporaryClone);
      origin = `https://github.com/${repo}${relative ? `/${relative}` : ''}`;
    } catch (error) {
      fs.rmSync(temporaryClone, { recursive: true, force: true });
      throw error;
    }
  }
  try {
    if (!fs.statSync(sourceDir).isDirectory()) fail('skill source must resolve to a directory');
    assertNoSymlinks(sourceDir);
    const skillFile = path.join(sourceDir, 'SKILL.md');
    const skillStat = fs.lstatSync(skillFile);
    if (!skillStat.isFile() || skillStat.size === 0 || skillStat.size > MAX_SKILL_BYTES) fail('SKILL.md must be a non-empty regular file no larger than 64 KiB');
    const name = skillName(source, subdir);
    const destination = path.join(skills, 'installed', name);
    assertNoSymlinkComponents(destination, skills);
    if (fs.existsSync(destination)) fail(`skill already exists; refusing overwrite: ${destination}`);
    const parent = path.dirname(destination);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(parent, skills);
    const temp = fs.mkdtempSync(path.join(parent, `.${name}-`));
    try {
      fs.cpSync(sourceDir, path.join(temp, name), { recursive: true, errorOnExist: true, dereference: false });
      const stagedSkill = path.join(temp, name, 'SKILL.md');
      const provenance = { source: origin, importedAt: new Date().toISOString(), installHooksExecuted: false };
      fs.writeFileSync(path.join(temp, name, 'HII_INSTALL.json'), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      if (fs.readFileSync(stagedSkill).length === 0) fail('staged SKILL.md is empty');
      fs.renameSync(path.join(temp, name), destination);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    return { kind: 'skill', source: origin, name, path: destination, installed: true, installHooksExecuted: false };
  } finally {
    if (temporaryClone) fs.rmSync(temporaryClone, { recursive: true, force: true });
  }
}

function installTool({ source }, runCommand) {
  const formula = String(source || '').trim();
  if (process.platform !== 'darwin') fail('Homebrew formula installation is currently supported only on macOS');
  if (!packagePattern.test(formula) || formula.includes('..')) fail('tool source must be a Homebrew formula name, not a URL or path');
  run('brew', ['install', '--formula', formula], { stdio: 'inherit' }, runCommand);
  const versions = run('brew', ['list', '--formula', '--versions', formula], {}, runCommand).stdout.trim();
  if (!versions || !versions.split(/\s+/).includes(formula)) fail(`Homebrew did not verify installed formula ${formula}`);
  return { kind: 'tool', source: formula, manager: 'homebrew', verified: versions };
}

export function installCapability({ runtime, workspace, skills, kind, source, file }, options = {}) {
  const roots = validateRoots(runtime, workspace, skills);
  if (!['model', 'skill', 'tool'].includes(kind)) fail(`unsupported capability kind: ${kind}`);
  if (!source || typeof source !== 'string') fail('source is required');
  const request = { ...roots, kind, source, file };
  let receipt;
  if (kind === 'model') receipt = installModel(request, options.runCommand || spawnSync);
  else if (kind === 'skill') receipt = installSkill(request, options.runCommand || spawnSync);
  else receipt = installTool(request, options.runCommand || spawnSync);
  return { ok: true, schemaVersion: 1, ...receipt };
}

function saveReceipt(runtime, receipt) {
  const directory = path.join(runtime, 'installations');
  assertNoSymlinkComponents(directory, runtime);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(directory, runtime);
  const destination = path.join(directory, `install-${crypto.randomUUID()}.json`);
  const temporary = `${destination}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return destination;
}

function cliSummary(receipt, receiptPath) {
  if (receipt.kind === 'model' && receipt.file) {
    return `Installed GGUF ${receipt.source}/${receipt.file} at ${receipt.path}. Verified with Hugging Face cache verification, GGUF header, and SHA-256. Receipt: ${receiptPath}`;
  }
  if (receipt.kind === 'model') {
    return `Model install completed for ${receipt.source} using HII's model installer. Detailed receipt: ${receiptPath}`;
  }
  if (receipt.kind === 'skill') {
    return `Imported skill ${receipt.name} to ${receipt.path}; no install hooks were executed. Receipt: ${receiptPath}`;
  }
  return `Installed Homebrew formula ${receipt.source} (${receipt.verified}). Receipt: ${receiptPath}`;
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--runtime' || argv[i] === '--workspace' || argv[i] === '--skills') {
      const key = argv[i].slice(2);
      values[key] = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      return { help: true };
    } else if (values.kind === undefined) values.kind = argv[i];
    else if (values.source === undefined) values.source = argv[i];
    else if (values.file === undefined) values.file = argv[i];
    else fail(`unexpected argument: ${argv[i]}`);
  }
  if (!values.runtime || !values.workspace || !values.kind || !values.source) fail('usage: hii-capability-install.mjs --runtime PATH --workspace PATH [--skills PATH] <model|skill|tool> SOURCE [FILE]');
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) console.log('Usage: hii-capability-install.mjs --runtime PATH --workspace PATH [--skills PATH] <model|skill|tool> SOURCE [FILE]');
    else {
      const receipt = installCapability(args);
      const receiptPath = saveReceipt(fs.realpathSync(path.resolve(args.runtime)), receipt);
      console.log(cliSummary(receipt, receiptPath));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
