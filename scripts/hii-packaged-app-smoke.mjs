#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceApp = path.resolve(
  process.env.HII_APP_BUNDLE ||
    path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'HII.app')
);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'hii-packaged-app-'));
const installedApp = path.join(temporaryRoot, 'Applications', 'HII.app');
const runtimeDir = path.join(temporaryRoot, 'clean-user', '.hii');
const keepTemporaryRoot = process.env.HII_KEEP_PACKAGED_SMOKE === '1';

function installedPaths() {
  const resources = path.join(installedApp, 'Contents', 'Resources', 'hii-app');
  return {
    executable: path.join(installedApp, 'Contents', 'MacOS', 'hii'),
    node: path.join(resources, 'bin', 'node'),
    server: path.join(resources, 'server'),
    entrypoint: path.join(resources, 'server', 'server.mjs')
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function installFreshCopy() {
  await rm(installedApp, { recursive: true, force: true });
  await mkdir(path.dirname(installedApp), { recursive: true });
  await cp(sourceApp, installedApp, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true
  });
  const paths = installedPaths();
  await Promise.all(Object.values(paths).map((item) => access(item)));
  if (process.platform === 'darwin') {
    const verification = spawnSync(
      'codesign',
      ['--verify', '--deep', '--strict', '--verbose=2', installedApp],
      { encoding: 'utf8' }
    );
    assert.equal(
      verification.status,
      0,
      `Copied HII.app failed strict code-sign verification.\n${verification.stderr || verification.stdout}`
    );
  }
}

async function startPackagedServer() {
  const paths = installedPaths();
  const port = await freePort();
  const output = [];
  const child = spawn(paths.node, ['server.mjs'], {
    cwd: paths.server,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: path.dirname(runtimeDir),
      HII_RUNTIME_DIR: runtimeDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      HII_TAURI: '1',
      NODE_ENV: 'production'
    }
  });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged HII server exited before readiness.\n${output.join('')}`);
    }
    let response;
    try {
      response = await fetch(`${baseUrl}/api/workspace?workspaceId=default`);
    } catch {
      // The packaged server is still starting.
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (response.ok) return { child, baseUrl, output };
    if (response.status >= 500) {
      const body = await response.text();
      child.kill('SIGKILL');
      throw new Error(
        `Packaged HII returned ${response.status} during readiness.\n${body}\n${output.join('')}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`Packaged HII server did not become ready within 15 seconds.\n${output.join('')}`);
}

async function stopPackagedServer(instance) {
  const { child } = instance;
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000))
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function requestJson(baseUrl, pathname, init) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      origin: baseUrl,
      ...(init?.headers || {})
    }
  });
  const body = await response.json();
  return { response, body };
}

function receiptNode(now) {
  return {
    id: 'packaged-receipt',
    type: 'note',
    x: 120,
    y: 120,
    w: 360,
    h: 220,
    z: 2,
    createdAt: now,
    updatedAt: now,
    object: {
      kind: 'receipt',
      owner: 'hii',
      status: 'completed',
      proofRefs: ['packaged-app-smoke'],
      audit: [{ ts: now, actor: 'system', action: 'packaged_app_smoke' }]
    },
    payload: {
      title: 'Packaged app receipt',
      summary: 'Created before reinstall and verified after restart.'
    }
  };
}

let server;
try {
  if (process.platform !== 'darwin') {
    throw new Error('The packaged HII.app smoke test requires macOS.');
  }
  await access(sourceApp);
  await installFreshCopy();

  server = await startPackagedServer();
  const firstLoad = await requestJson(server.baseUrl, '/api/workspace?workspaceId=default');
  assert.equal(firstLoad.response.status, 200);
  assert.equal(firstLoad.body.status, 'missing');
  assert.equal(firstLoad.body.workspace.version, 1);

  const created = await requestJson(server.baseUrl, '/api/workspace', {
    method: 'POST',
    body: JSON.stringify({ action: 'create', workspaceId: 'packaged-proof', select: true })
  });
  assert.equal(created.response.status, 201);
  const now = new Date().toISOString();
  const workspace = created.body.workspace;
  workspace.nodes = [receiptNode(now)];
  workspace.nextZ = 2;
  const saved = await requestJson(server.baseUrl, '/api/workspace', {
    method: 'PUT',
    body: JSON.stringify({
      workspaceId: 'packaged-proof',
      expectedRevision: workspace.revision,
      workspace
    })
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.workspace.revision, 1);
  assert.equal(saved.body.workspace.nodes[0].object.kind, 'receipt');
  await stopPackagedServer(server);
  server = null;

  const persistedPath = path.join(runtimeDir, 'workspace', 'workspaces', 'packaged-proof.json');
  const persistedBeforeReinstall = JSON.parse(await readFile(persistedPath, 'utf8'));
  assert.equal(persistedBeforeReinstall.nodes[0].id, 'packaged-receipt');

  // Replacing the isolated app copy models a packaged upgrade while leaving user data untouched.
  await installFreshCopy();
  server = await startPackagedServer();
  const afterReinstall = await requestJson(
    server.baseUrl,
    '/api/workspace?workspaceId=packaged-proof'
  );
  assert.equal(afterReinstall.response.status, 200);
  assert.equal(afterReinstall.body.status, 'ready');
  assert.equal(afterReinstall.body.workspace.version, 1);
  assert.equal(afterReinstall.body.workspace.nodes[0].id, 'packaged-receipt');
  assert.equal(afterReinstall.body.workspace.nodes[0].object.kind, 'receipt');

  const brokenPath = path.join(runtimeDir, 'workspace', 'workspaces', 'broken.json');
  await writeFile(brokenPath, '{"version":1,"nodes":', 'utf8');
  const recovery = await requestJson(server.baseUrl, '/api/workspace?workspaceId=broken');
  assert.equal(recovery.response.status, 500);
  assert.equal(recovery.body.status, 'recovery');
  assert.equal(typeof recovery.body.recoveryPath, 'string');
  assert(recovery.body.recoveryPath.startsWith(runtimeDir));
  await stat(recovery.body.recoveryPath);

  const listing = await requestJson(server.baseUrl, '/api/workspace?list=1');
  assert.equal(listing.response.status, 200);
  assert(
    listing.body.workspaces.some(
      (item) => item.id === 'packaged-proof' && item.status === 'ready' && item.revision === 1
    )
  );
  assert(listing.body.workspaces.some((item) => item.id === 'broken' && item.status === 'recovery'));

  console.log('HII packaged app smoke');
  console.log('status:       ok');
  console.log('isolation:    copied HII.app ran outside the source repository');
  console.log('clean user:   empty isolated runtime initialized');
  console.log('persistence:  receipt workspace survived packaged reinstall + restart');
  console.log('recovery:     corrupt workspace preserved with an inspectable recovery path');
  console.log('signature:    copied app passed strict deep code-sign verification');
} finally {
  if (server) await stopPackagedServer(server);
  if (keepTemporaryRoot) {
    console.log(`kept:         ${temporaryRoot}`);
  } else {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
