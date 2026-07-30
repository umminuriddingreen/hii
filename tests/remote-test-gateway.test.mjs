import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_HTTPS_PORT,
  MODEL,
  TERMINAL_HTTPS_PORT,
  ensureSessionLayout,
  funnelStartArgs,
  funnelStopArgs,
  inspectPreflight,
  resolvePublicArtifact,
  routeOwnedBy
} from '../server/remote-test-core.mjs';
import { verifyArtifact } from '../server/remote-test-artifacts.mjs';
import { createSandbox, sanitizedHostEnv } from '../server/remote-test-sandbox.mjs';
import { startRemoteTestGateway } from '../server/remote-test-gateway.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function temporary() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'hii-remote-test-'));
}

test('artifact boundary rejects traversal, dotfiles, and symlinks', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = await ensureSessionLayout(root, '20260730120000-1234567890abcdef12345678');
  await fs.writeFile(path.join(layout.publicDir, 'ok.txt'), 'ok');
  await fs.writeFile(path.join(layout.publicDir, '.secret'), 'no');
  await fs.symlink(path.join(layout.publicDir, 'ok.txt'), path.join(layout.publicDir, 'link.txt'));
  assert.equal(await resolvePublicArtifact(layout.publicDir, 'ok.txt'), await fs.realpath(path.join(layout.publicDir, 'ok.txt')));
  await assert.rejects(() => resolvePublicArtifact(layout.publicDir, '../runtime/secret'));
  await assert.rejects(() => resolvePublicArtifact(layout.publicDir, '%2e%2e/runtime/secret'));
  await assert.rejects(() => resolvePublicArtifact(layout.publicDir, '.secret'));
  await assert.rejects(() => resolvePublicArtifact(layout.publicDir, 'link.txt'));
});

test('preflight refuses occupied Funnel routes and never mutates them', async () => {
  const calls = [];
  const status = {
    BackendState: 'Running',
    Self: { DNSName: 'mac.example.ts.net.' },
    Web: {
      'mac.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } }
    }
  };
  const run = async (_binary, args) => {
    calls.push(args);
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify(status), stderr: '' };
    return { code: 0, stdout: JSON.stringify(status), stderr: '' };
  };
  const report = await inspectPreflight({
    run,
    canBind: async () => true,
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: MODEL }] }) }),
    hiiBinary: process.execPath,
    requireChrome: false
  });
  assert.equal(report.ok, false);
  assert.equal(report.tailscaleDnsName, 'mac.example.ts.net.');
  assert.equal(report.checks.find((item) => item.name === 'funnel-443-unused').ok, false);
  assert.equal(calls.some((args) => args.includes('reset') || args.includes('off') || args.includes('--bg')), false);
});

test('Funnel commands use exact routes and exact teardown, never reset', () => {
  assert.deepEqual(funnelStartArgs(TERMINAL_HTTPS_PORT, 17171), [
    'funnel', '--bg', '--yes', '--https=443', 'http://127.0.0.1:17171'
  ]);
  assert.deepEqual(funnelStopArgs(ARTIFACT_HTTPS_PORT), ['funnel', '--https=8443', 'off']);
  const status = {
    Web: {
      'mac.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:17171' } } }
    }
  };
  assert.equal(routeOwnedBy(status, 443, 17171), true);
  assert.equal(routeOwnedBy(status, 443, 9999), false);
});

test('public-test sandbox retains host PATH but removes secrets and denies deletion', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = await ensureSessionLayout(root, '20260730120000-abcdefabcdefabcdefabcdef');
  const hostEnv = {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    OPENAI_API_KEY: 'do-not-copy',
    RANDOM_TOKEN: 'do-not-copy'
  };
  const env = sanitizedHostEnv({ layout, hostEnv });
  assert.equal(env.PATH, hostEnv.PATH);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.RANDOM_TOKEN, undefined);
  assert.equal(env.HOME.startsWith(layout.sessionDir), true);
  assert.equal(env.HII_RUNTIME_DIR, layout.runtime);
  const sandbox = await createSandbox({ layout, hiiBinary: '/bin/sh', hostEnv });
  const profile = await fs.readFile(sandbox.profilePath, 'utf8');
  assert.match(profile, /\(allow network\*\)/);
  assert.match(profile, /\(allow pseudo-tty\)/);
  assert.match(profile, /\(allow file-ioctl\)/);
  assert.match(profile, /\(deny file-write-unlink/);
  const escapedHome = os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(profile, new RegExp(`\\(deny file-read\\* \\(subpath "${escapedHome}"\\)\\)`));
  assert.doesNotMatch(profile, new RegExp(`\\(allow file-read\\* \\(subpath "${escapedHome}"\\)\\)`));
  assert.deepEqual(sandbox.args.slice(-1), ['/bin/sh']);
  if (process.platform === 'darwin') {
    const target = path.join(layout.workspace, 'sandbox-write.txt');
    const probe = spawnSync(sandbox.launcher, [
      ...sandbox.args,
      '-c',
      `if IFS= read -r line < "$2/.zshrc"; then host_read=true; else host_read=false; fi
printf ok > "$1"
if /bin/rm "$1" 2>/dev/null; then delete_denied=false; else delete_denied=true; fi
printf '{"hostRead":%s,"deleteDenied":%s,"wrote":"%s"}' "$host_read" "$delete_denied" "$(/bin/cat "$1")"`,
      'hii-sandbox-probe',
      target,
      os.homedir()
    ], { encoding: 'utf8', env });
    assert.equal(probe.status, 0, JSON.stringify({ error: probe.error?.message, signal: probe.signal, stderr: probe.stderr }));
    assert.deepEqual(JSON.parse(probe.stdout), { hostRead: false, deleteDenied: true, wrote: 'ok' }, profile);
  }
});

test('passcode gate locks after five failures without starting HII or Funnel', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'active.json');
  const gateway = await startRemoteTestGateway({
    root,
    stateFile,
    sessionId: '20260730120000-fedcbafedcbafedcbafedcba',
    sessionPath: 'unguessable-session-path-123456789',
    hiiBinary: process.execPath,
    terminalPort: 0,
    artifactPort: 0,
    expose: false,
    disconnectGraceMs: 50,
    chromePath: false
  }, 'correct horse battery staple', { expose: false });
  context.after(() => gateway.shutdown('test'));
  const address = gateway.servers.terminal.address();
  const endpoint = `http://127.0.0.1:${address.port}${gateway.basePath}/auth`;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode: 'wrong' })
    });
    assert.equal(response.status, attempt === 5 ? 423 : 401);
  }
  const locked = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode: 'correct horse battery staple' })
  });
  assert.equal(locked.status, 423);
  assert.equal(gateway.manifest.artifacts.length, 0);
});

test('only the first correct passcode can claim the tester session', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const gateway = await startRemoteTestGateway({
    root,
    stateFile: path.join(root, 'active.json'),
    sessionId: '20260730120000-010101010101010101010101',
    sessionPath: 'single-tester-session-path-123456789',
    hiiBinary: process.execPath,
    terminalPort: 0,
    artifactPort: 0,
    expose: false,
    disconnectGraceMs: 50,
    chromePath: false
  }, 'correct horse battery staple', { expose: false });
  context.after(() => gateway.shutdown('test'));
  const endpoint = `http://127.0.0.1:${gateway.servers.terminal.address().port}${gateway.basePath}/auth`;
  const authenticate = () => fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode: 'correct horse battery staple' })
  });
  assert.equal((await authenticate()).status, 200);
  assert.equal((await authenticate()).status, 409);
});

test('HTML publication requires Chrome instead of accepting a static false positive', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = await ensureSessionLayout(root, '20260730120000-020202020202020202020202');
  await fs.writeFile(path.join(layout.publicDir, 'index.html'), '<!doctype html><html><body><main>Looks present</main></body></html>');
  const result = await verifyArtifact({
    publicDir: layout.publicDir,
    relativePath: 'index.html',
    artifactsDir: layout.artifacts,
    chromePath: false
  });
  assert.equal(result.ok, false);
  assert.equal(result.engine, 'chrome-required');
});

test('Three.js addon imports without an import map are rejected', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = await ensureSessionLayout(root, '20260730120000-030303030303030303030303');
  await fs.writeFile(
    path.join(layout.publicDir, 'index.html'),
    `<!doctype html><html><body><main>Broken Three.js page</main><script type="module">
      import { FontLoader } from 'three/addons/loaders/FontLoader.js';
      document.body.dataset.loaded = String(Boolean(FontLoader));
    </script></body></html>`
  );
  const result = await verifyArtifact({
    publicDir: layout.publicDir,
    relativePath: 'index.html',
    artifactsDir: layout.artifacts
  });
  assert.equal(result.engine, 'chrome-cdp');
  assert.equal(result.ok, false);
  assert.ok(result.failures.length > 0);
});

test('Three.js import-map fixture renders a canvas and captures a screenshot in Chrome', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = await ensureSessionLayout(root, '20260730120000-aabbccddeeff001122334455');
  const fixture = path.join(repository, 'tests', 'fixtures', 'remote-test-three', 'public');
  await fs.cp(fixture, layout.publicDir, { recursive: true });
  const vendor = path.join(layout.publicDir, 'vendor');
  await fs.mkdir(vendor, { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(repository, 'public', 'vendor', 'three.module.js'), path.join(vendor, 'three.module.js')),
    fs.copyFile(path.join(repository, 'public', 'vendor', 'three.core.js'), path.join(vendor, 'three.core.js'))
  ]);
  const result = await verifyArtifact({
    publicDir: layout.publicDir,
    relativePath: 'index.html',
    artifactsDir: layout.artifacts
  });
  assert.equal(result.engine, 'chrome-cdp');
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.dom.canvases.length, 1);
  assert.ok((await fs.stat(result.screenshot)).size > 1000);
});

test('authenticated screen is exactly two equal panes in both orientations', async () => {
  const html = await fs.readFile(path.join(repository, 'server', 'remote-test-static', 'index.html'), 'utf8');
  const css = await fs.readFile(path.join(repository, 'server', 'remote-test-static', 'style.css'), 'utf8');
  const main = html.match(/<main id="session" hidden>([\s\S]*?)<\/main>/)?.[1] ?? '';
  assert.equal((main.match(/<(?:section|iframe)\b/g) ?? []).length, 2);
  assert.match(main, /id="terminal"/);
  assert.match(main, /id="artifact"/);
  assert.doesNotMatch(main, /<(?:header|nav|button|aside|footer)\b/);
  assert.match(css, /grid-template-columns:\s*1fr 1fr/);
  assert.match(css, /grid-template-rows:\s*1fr 1fr/);
  assert.match(css, /@media \(orientation: portrait\), \(max-aspect-ratio: 1\/1\)/);
});
