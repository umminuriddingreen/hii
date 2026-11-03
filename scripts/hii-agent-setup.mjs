#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCapability } from './hii-capability-install.mjs';

const TOOL_ROOTS = [
  ['pi', '.pi/agent/skills'],
  ['hermes', '.hermes/skills'],
  ['codex', '.codex/skills'],
  ['agents', '.agents/skills'],
  ['claude', '.claude/skills'],
];
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeSkillName(value) {
  if (!SAFE_NAME.test(value)) return null;
  const name = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return name || null;
}

function isDirectoryWithoutSymlink(target) {
  try { return fs.lstatSync(target).isDirectory(); } catch { return false; }
}

function hasOnlySafeTree(root) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) return false;
      // These names commonly hold credentials or tool configuration. Never import them.
      if (/^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|auth\.json|mcp\.json|settings\.json|config\.json)$/i.test(entry.name)) return false;
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
  return true;
}

/** Discover immediate personal skill directories. No skill contents are read. */
export function discoverSkills({ home = os.homedir(), runtime = path.join(home, '.hii') } = {}) {
  const roots = TOOL_ROOTS.map(([tool, relative]) => ({ tool, path: path.join(home, relative) }));
  roots.push({ tool: 'hii', path: path.join(runtime, 'skills') });
  roots.push({ tool: 'hii', path: path.join(runtime, 'skills', 'installed') });
  const seen = new Set();
  const found = [];
  for (const root of roots) {
    if (!isDirectoryWithoutSymlink(root.path)) continue;
    let canonicalRoot;
    try { canonicalRoot = fs.realpathSync(root.path); } catch { continue; }
    let entries;
    try { entries = fs.readdirSync(root.path, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_NAME.test(entry.name)) continue;
      const candidate = path.join(root.path, entry.name);
      if (!isDirectoryWithoutSymlink(candidate)) continue;
      const skillFile = path.join(candidate, 'SKILL.md');
      try {
        if (!fs.lstatSync(skillFile).isFile() || fs.lstatSync(skillFile).size === 0) continue;
      } catch { continue; }
      let canonical;
      try { canonical = fs.realpathSync(candidate); } catch { continue; }
      if (!canonical.startsWith(`${canonicalRoot}${path.sep}`) || seen.has(canonical)) continue;
      seen.add(canonical);
      const name = safeSkillName(entry.name);
      if (!name) continue;
      found.push({ tool: root.tool, name, path: canonical, status: root.tool === 'hii' ? 'existing' : 'available' });
    }
  }
  const byName = new Map();
  for (const source of found) byName.set(source.name, [...(byName.get(source.name) || []), source]);
  for (const sources of byName.values()) {
    if (sources.length > 1) for (const source of sources) source.status = 'conflict';
  }
  const installed = path.join(path.resolve(runtime), 'skills', 'installed');
  for (const source of found) {
    if (source.status !== 'available') continue;
    if (fs.existsSync(path.join(installed, source.name))) source.status = 'conflict';
  }
  return found;
}

function assertImportable(source) {
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('--source must be an absolute real skill directory');
  if (!hasOnlySafeTree(source)) throw new Error('skill contains a symlink, unsupported entry, credential, or tool configuration file; refusing import');
}

export function importSkill({ source, runtime, workspace, home = os.homedir() }) {
  if (!path.isAbsolute(source || '') || !path.isAbsolute(runtime || '') || !path.isAbsolute(workspace || '')) {
    throw new Error('--source, --runtime, and --workspace must be absolute paths');
  }
  if (!isDirectoryWithoutSymlink(workspace)) throw new Error('--workspace must be an existing real directory');
  if (fs.lstatSync(source).isSymbolicLink()) throw new Error('refusing a symlink skill source');
  const canonicalSource = fs.realpathSync(source);
  const available = discoverSkills({ home, runtime }).find((item) => item.path === canonicalSource);
  if (!available) throw new Error('source is not a discovered personal skill directory');
  if (available.status !== 'available') throw new Error(`skill import is blocked by a name conflict: ${available.name}`);
  assertImportable(canonicalSource);
  // The installer intentionally confines local sources to its workspace. For a
  // personal skill, use its parent as that boundary while retaining the user's
  // requested workspace in the setup result.
  const receipt = installCapability({
    runtime,
    workspace: path.dirname(canonicalSource),
    kind: 'skill',
    source: path.basename(canonicalSource),
  });
  const result = { ...receipt, sourcePath: canonicalSource, requestedWorkspace: path.resolve(workspace), sourceTool: available.tool };
  const receiptPath = path.join(receipt.path, 'HII_SETUP.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { ...result, receiptPath };
}

function parseArgs(argv) {
  let command = 'plan';
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'import' || arg === 'plan') command = arg;
    else if (arg === '--json') options.json = true;
    else if (['--runtime', '--workspace', '--source'].includes(arg)) options[arg.slice(2)] = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return { command, ...options };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const home = os.homedir();
    const runtime = args.runtime || path.join(home, '.hii');
    if (args.help) console.log('Usage: hii-agent-setup.mjs [--json] [--runtime PATH] [--workspace PATH] | import --source ABSOLUTE_SKILL_DIR --runtime PATH --workspace PATH');
    else if (args.command === 'import') {
      if (!args.source || !args.workspace) throw new Error('usage: hii-agent-setup.mjs import --source ABSOLUTE_SKILL_DIR --runtime PATH --workspace PATH');
      const result = importSkill({ source: args.source, runtime, workspace: args.workspace });
      console.log(JSON.stringify({ ok: true, ...result }));
    } else {
      const result = { ok: true, schemaVersion: 1, sources: discoverSkills({ home, runtime }) };
      if (args.json) console.log(JSON.stringify(result));
      else {
        console.log('Returning-user skill setup plan (read-only):');
        for (const source of result.sources) console.log(`${source.status.padEnd(9)} ${source.tool.padEnd(7)} ${source.name}  ${source.path}`);
        if (!result.sources.length) console.log('No personal skills found.');
        console.log('Import a selected skill with: hii setup import --source PATH');
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
