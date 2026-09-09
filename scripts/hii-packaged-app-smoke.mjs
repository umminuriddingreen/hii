#!/usr/bin/env node
// Current package proof: Tauri executable + embedded Rust CLI, never a Node server.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceApp = path.resolve(process.env.HII_APP_BUNDLE || path.join(root, 'src-tauri/target/release/bundle/macos/HII.app'));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hii-packaged-app-'));
const installedApp = path.join(temporaryRoot, 'Applications', 'HII.app');
const runtimeDir = path.join(temporaryRoot, 'runtime');
const workspace = path.join(temporaryRoot, 'work');
const hash = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
}

function command(binary, args, env = process.env) {
  const result = spawnSync(binary, args, { cwd: workspace, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${path.basename(binary)} ${args.join(' ')} failed: ${result.error?.message || result.stderr}`);
  return result.stdout;
}

try {
  assert.equal(process.platform, 'darwin', 'The HII.app package proof requires macOS.');
  await access(sourceApp);
  await mkdir(workspace, { recursive: true });
  await cp(sourceApp, installedApp, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  const executable = path.join(installedApp, 'Contents/MacOS/hii');
  const cli = path.join(installedApp, 'Contents/Resources/resources/hii');
  await Promise.all([access(executable), access(cli)]);
  command('codesign', ['--verify', '--deep', '--strict', '--verbose=2', installedApp]);

  // Tauri embeds assets in its executable. Validate build inputs and chronology;
  // this does not claim native rendering or byte extraction from the binary.
  const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const frontend = path.resolve(root, 'src-tauri', config.build.frontendDist);
  const html = await readFile(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /_next\/static\//, 'Static frontend entrypoint is missing its Next assets.');
  const assets = await files(frontend);
  const executableTime = (await stat(executable)).mtimeMs;
  for (const asset of assets) {
    assert.ok((await stat(asset)).mtimeMs <= executableTime, `Frontend input is newer than package: ${asset}`);
  }
  const cliHash = await hash(cli);
  assert.equal(cliHash, await hash(path.join(root, 'target/release/hii')), 'Packaged CLI differs from the current release build.');
  assert.equal(cliHash, await hash(path.join(root, 'src-tauri/resources/hii')), 'Packaged CLI differs from staged resource.');

  const env = { ...process.env, HII_RUNTIME_DIR: runtimeDir, HII_ROOT: workspace, HII_NO_AUTO_UPDATE: '1', HII_UI_LINE_MODE: '1' };
  delete env.HII_BIN;
  delete env.HII_DB_PATH;
  delete env.HII_ACCOUNT_DIR;
  const terminal = () => JSON.parse(command(cli, ['--cwd', workspace, 'terminal', workspace, '--json'], env));
  const first = terminal();
  assert.equal(first.desktopLaunched, false);
  assert.equal(first.node.type, 'terminal');
  assert.match(first.spaceId, /^[a-z0-9_-]+$/);
  const snapshotPath = path.join(runtimeDir, 'workspace/workspaces', `${first.spaceId}.json`);
  const original = JSON.parse(await readFile(snapshotPath, 'utf8'));
  assert.ok(original.nodes.some(node => node.id === first.node.id));
  // A new CLI process must recover Runtime objects without the disposable export.
  await rename(snapshotPath, `${snapshotPath}.preserved`);
  await cp(sourceApp, installedApp, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  const second = terminal();
  assert.equal(second.spaceId, first.spaceId);
  assert.ok(second.sequence > first.sequence);
  const restored = JSON.parse(await readFile(snapshotPath, 'utf8'));
  assert.ok(restored.nodes.some(node => node.id === first.node.id), 'Reinstall/restart lost the first durable object.');
  assert.ok(restored.nodes.some(node => node.id === second.node.id));
  assert.equal(restored.nodes.length, original.nodes.length + 1);
  console.log(JSON.stringify({
    status: 'passed', sourceApp, executableSha256: await hash(executable), cliSha256: cliHash,
    frontendInputFiles: assets.length, spaceId: first.spaceId, initialSequence: first.sequence,
    finalSequence: second.sequence, durableObjects: restored.nodes.length,
    isolation: 'copied embedded CLI outside repository; fresh temporary Runtime; no model or desktop launch',
    notVerified: ['native WebView rendering', 'PTY interaction', 'embedded asset byte equality', 'notarization', 'updater transport'],
    evidenceDirectory: process.env.HII_KEEP_PACKAGED_SMOKE === '1' ? temporaryRoot : null
  }, null, 2));
} finally {
  if (process.env.HII_KEEP_PACKAGED_SMOKE !== '1') await rm(temporaryRoot, { recursive: true, force: true });
}
