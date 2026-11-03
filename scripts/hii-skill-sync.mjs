#!/usr/bin/env node
// Additive, content-addressed skill transfer. Never executes imported skill code.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installCapability } from './hii-capability-install.mjs';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const excluded = /^(?:HII_INSTALL\.json|HII_SETUP\.json|\.DS_Store|node_modules|\.git|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|auth\.json|mcp\.json|settings\.(?:json|ya?ml|toml)|config\.(?:json|ya?ml|toml)|\.npmrc|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/i;
const safeName = /^[a-z0-9][a-z0-9-]{0,127}$/;
const MAX_SKILL_BYTES = 64 * 1024;
const NAMESPACE_SUFFIX_LENGTH = '--sync-'.length + 12;
export const defaultRoots = (home = os.homedir()) => ['.agents/skills', '.codex/skills', '.claude/skills', '.pi/agent/skills', '.hermes/skills', '.hii/skills/installed', '.hii/skills/registered'].map(p => path.join(home, p));
function realDir(p) { try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } }
function directories(root, out = [], depth = 0) {
  if (!realDir(root) || depth > 8) return out;
  const skill = path.join(root, 'SKILL.md');
  if (fs.existsSync(skill) && fs.lstatSync(skill).isFile() && !fs.lstatSync(skill).isSymbolicLink()) { out.push(root); return out; }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink() && !excluded.test(entry.name)) directories(path.join(root, entry.name), out, depth + 1);
  return out;
}
function files(root, relative = '', out = [], skipped = []) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || excluded.test(entry.name)) { skipped.push(rel); continue; }
    if (entry.isDirectory()) files(root, rel, out, skipped);
    else if (entry.isFile()) {
      const absolute = path.join(root, rel); const stat = fs.statSync(absolute);
      if (stat.size > 16 * 1024 * 1024) {
        if (rel !== 'SKILL.md') throw new Error(`skill file exceeds 16 MiB: ${rel}`);
        const descriptor = fs.openSync(absolute, 'r');
        const hash = crypto.createHash('sha256');
        const chunk = Buffer.allocUnsafe(1024 * 1024);
        try { let bytes; while ((bytes = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, bytes)); }
        finally { fs.closeSync(descriptor); }
        out.push({ path: rel, sha256: hash.digest('hex'), bytes: stat.size, executable: !!(stat.mode & 0o111) });
        continue;
      }
      const bytes = fs.readFileSync(absolute);
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(bytes.toString('utf8'))) { skipped.push(rel); continue; }
      out.push({ path: rel, sha256: sha(bytes), bytes: bytes.length, executable: !!(stat.mode & 0o111) });
    } else skipped.push(rel);
  }
  return out.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
const digest = records => sha(JSON.stringify(records.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))));
function describe(root) { const skipped = []; const entries = files(root, '', [], skipped); return { entries, skipped, hash: digest(entries) }; }
function skillMdIsCompatible(entries) {
  const entry = entries.find(file => file.path === 'SKILL.md');
  return Boolean(entry && entry.bytes > 0 && entry.bytes <= MAX_SKILL_BYTES);
}
function namespacedName(name, hash) {
  const base = name.slice(0, 128 - NAMESPACE_SUFFIX_LENGTH);
  return `${base}--sync-${hash.slice(0, 12)}`;
}
export function exportSkills({ roots = defaultRoots(), output }) {
  if (fs.existsSync(output)) throw new Error('export output already exists; choose a fresh directory');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const manifest = { schemaVersion: 1, kind: 'hii.skills.bundle', skills: [], skipped: [] };
  const seen = new Set();
  for (const root of roots) for (const directory of directories(root)) {
    const name = path.basename(directory).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!safeName.test(name)) { manifest.skipped.push({ name, reason: 'unsupported name' }); continue; }
    const skillMd = fs.lstatSync(path.join(directory, 'SKILL.md'));
    if (!skillMd.isFile() || skillMd.size === 0 || skillMd.size > MAX_SKILL_BYTES) {
      manifest.skipped.push({ name, reason: 'SKILL.md must be a non-empty regular file no larger than 64 KiB' });
      continue;
    }
    const info = describe(directory);
    if (!info.entries.some(entry => entry.path === 'SKILL.md')) continue;
    if (!skillMdIsCompatible(info.entries)) {
      manifest.skipped.push({ name, reason: 'SKILL.md must be a non-empty regular file no larger than 64 KiB' });
      continue;
    }
    const id = `${name}--${info.hash}`;
    if (seen.has(id)) continue; seen.add(id);
    for (const entry of info.entries) {
      const dest = path.join(output, 'skills', id, entry.path); fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(directory, entry.path), dest, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(dest, entry.executable ? 0o700 : 0o600);
    }
    manifest.skills.push({ name, directory: `skills/${id}`, hash: info.hash, files: info.entries, omitted: info.skipped });
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return manifest;
}
function safeRelative(p) { return typeof p === 'string' && p.length > 0 && !p.includes('\\') && !p.includes(':') && !p.startsWith('/') && p.split('/').every(part => part && part !== '.' && part !== '..'); }
function assertTreePath(root, rel) {
  if (!safeRelative(rel)) throw new Error('unsafe bundle path');
  let current = root;
  for (const part of rel.split('/')) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink bundle path refused'); }
  return current;
}
export function importSkills({ bundle, runtime, roots = defaultRoots(), conflicts = 'preserve' }) {
  if (!realDir(bundle) || !realDir(runtime)) throw new Error('bundle and runtime must be existing real directories');
  if (!['preserve', 'namespace'].includes(conflicts)) throw new Error('conflicts must be preserve or namespace');
  const manifestPath = assertTreePath(bundle, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'hii.skills.bundle' || !Array.isArray(manifest.skills) || manifest.skills.length > 4096) throw new Error('invalid bundle manifest');
  const known = new Map();
  for (const root of [...roots, path.join(runtime, 'skills/installed'), path.join(runtime, 'skills/registered')]) for (const directory of directories(root)) {
    const name = path.basename(directory).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    known.set(name, [...(known.get(name) || []), describe(directory).hash]);
  }
  // Validate the whole bundle before creating any installed skill. Skills the
  // normal installer cannot accept are recorded and skipped after validation.
  const incompatible = new Map();
  for (const skill of manifest.skills) {
    if (!safeName.test(skill.name) || !/^[a-f0-9]{64}$/.test(skill.hash) || skill.directory !== `skills/${skill.name}--${skill.hash}`) throw new Error('invalid skill manifest identity');
    const source = assertTreePath(bundle, skill.directory);
    for (const entry of skill.files || []) assertTreePath(source, entry.path);
    const actual = describe(source);
    if (actual.skipped.length || !actual.entries.some(entry => entry.path === 'SKILL.md') || actual.hash !== skill.hash || digest(skill.files) !== actual.hash) throw new Error(`bundle content mismatch: ${skill.name}`);
    if (!skillMdIsCompatible(actual.entries)) incompatible.set(skill.name + '\0' + skill.hash, 'SKILL.md must be a non-empty regular file no larger than 64 KiB');
  }
  const results = [];
  for (const skill of manifest.skills) {
    const incompatibleReason = incompatible.get(skill.name + '\0' + skill.hash);
    if (incompatibleReason) {
      results.push({ name: skill.name, hash: skill.hash, status: 'unsupported', reason: incompatibleReason });
      continue;
    }
    const existing = known.get(skill.name) || [];
    let installName = skill.name;
    if (existing.length) {
      if (existing.includes(skill.hash)) { results.push({ name: skill.name, hash: skill.hash, status: 'identical' }); continue; }
      if (conflicts !== 'namespace') { results.push({ name: skill.name, hash: skill.hash, status: 'conflict-preserved' }); continue; }
      installName = namespacedName(skill.name, skill.hash);
      const aliasHashes = known.get(installName) || [];
      if (aliasHashes.includes(skill.hash)) {
        results.push({ name: skill.name, installedName: installName, hash: skill.hash, status: 'identical-namespaced' });
        continue;
      }
      if (aliasHashes.length) {
        results.push({ name: skill.name, installedName: installName, hash: skill.hash, status: 'namespace-conflict-preserved' });
        continue;
      }
    }
    let staging;
    try {
      staging = fs.mkdtempSync(path.join(runtime, '.skill-sync-'));
      const staged = path.join(staging, installName);
      fs.cpSync(path.join(bundle, skill.directory), staged, { recursive: true, dereference: false });
      // Restore executable bits on POSIX after cross-platform transfer.
      if (process.platform !== 'win32') for (const entry of skill.files) fs.chmodSync(path.join(staged, entry.path), entry.executable ? 0o700 : 0o600);
      const installed = installCapability({ runtime, workspace: staging, kind: 'skill', source: installName });
      results.push({ name: skill.name, ...(installName !== skill.name ? { installedName: installName } : {}), hash: skill.hash, status: 'installed', path: installed.path }); known.set(installName, [skill.hash]);
    } catch (error) {
      results.push({ name: skill.name, ...(installName !== skill.name ? { installedName: installName } : {}), hash: skill.hash, status: 'install-failed', error: error.message });
    } finally { if (staging) fs.rmSync(staging, { recursive: true, force: true }); }
  }
  const receipt = { schemaVersion: 1, kind: 'hii.skills.sync', at: new Date().toISOString(), results, hooksExecuted: false, overwrite: false };
  const receiptDir = path.join(runtime, 'skills/sync-receipts'); fs.mkdirSync(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, `${crypto.randomUUID()}.json`); fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...receipt, receiptPath };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2); const options = {}; const roots = [];
    for (let i = 0; i < args.length; i += 2) { const key = args[i]; const value = args[i + 1]; if (!value || !['--root', '--output', '--bundle', '--runtime', '--conflicts'].includes(key)) throw new Error('invalid option'); if (key === '--root') roots.push(path.resolve(value)); else if (key === '--conflicts') options.conflicts = value; else options[key.slice(2)] = path.resolve(value); }
    if (roots.length) options.roots = roots;
    if (command === 'export' && options.output) console.log(JSON.stringify(exportSkills(options), null, 2));
    else if (command === 'import' && options.bundle && options.runtime) console.log(JSON.stringify(importSkills(options), null, 2));
    else throw new Error('usage: hii-skill-sync.mjs export --output DIR [--root DIR] | import --bundle DIR --runtime DIR [--root DIR] [--conflicts namespace]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
