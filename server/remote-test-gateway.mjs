import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnPty } from 'node-pty';
import { WebSocketServer } from 'ws';
import {
  ARTIFACT_HTTPS_PORT,
  ARTIFACT_PORT,
  DISCONNECT_GRACE_MS,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_MINUTE,
  MODEL,
  SESSION_PROFILE,
  SlidingWindowLimiter,
  TERMINAL_HTTPS_PORT,
  TERMINAL_PORT,
  appendEvent,
  contentType,
  ensureSessionLayout,
  funnelStartArgs,
  funnelStopArgs,
  newSecret,
  readJson,
  resolvePublicArtifact,
  routeOwnedBy,
  runCommand,
  writeJsonAtomic
} from './remote-test-core.mjs';
import { verifyArtifact } from './remote-test-artifacts.mjs';
import { createSandbox } from './remote-test-sandbox.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const staticDirectory = path.join(directory, 'remote-test-static');
const libraryAssets = {
  'xterm.js': path.join(directory, '..', 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'),
  'xterm.css': path.join(directory, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css')
};
const SUPPORTED_ARTIFACT = /\.(?:html|png|jpe?g|gif|webp|svg|txt|md|json)$/i;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function walkArtifacts(root, relative = '') {
  const items = [];
  for (const entry of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) items.push(...await walkArtifacts(root, child));
    else if (entry.isFile() && SUPPORTED_ARTIFACT.test(entry.name)) {
      const stat = await fsp.stat(path.join(root, child));
      items.push({ relativePath: child.split(path.sep).join('/'), mtimeMs: stat.mtimeMs, bytes: stat.size });
    }
  }
  return items;
}

export function replayTranscript(layout, socket) {
  try {
    const transcript = fs.readFileSync(layout.transcript, 'utf8');
    if (transcript) socket.send(JSON.stringify({ type: 'data', data: transcript }));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function startRemoteTestGateway(config, dependencies = {}) {
  const run = dependencies.run ?? runCommand;
  const expose = dependencies.expose ?? config.expose ?? true;
  const terminalPort = config.terminalPort ?? TERMINAL_PORT;
  const artifactPort = config.artifactPort ?? ARTIFACT_PORT;
  const disconnectGraceMs = config.disconnectGraceMs ?? DISCONNECT_GRACE_MS;
  const layout = await ensureSessionLayout(config.root, config.sessionId);
  const sessionPath = config.sessionPath;
  const basePath = `/s/${sessionPath}`;
  const artifactCookie = newSecret();
  const tickets = new Map();
  const messageLimiter = new SlidingWindowLimiter(MAX_MESSAGES_PER_MINUTE);
  let pty = null;
  let ptyStartPromise = null;
  let disconnectTimer = null;
  let artifactTimer = null;
  let shuttingDown = false;
  let latestArtifact = null;
  const verifiedRevisions = new Map();
  const routesStarted = [];
  const subscribers = new Set();

  const manifest = {
    schemaVersion: 1,
    id: config.sessionId,
    createdAt: new Date().toISOString(),
    endedAt: null,
    model: MODEL,
    sessionProfile: SESSION_PROFILE,
    workspace: layout.workspace,
    runtime: layout.runtime,
    binary: config.hiiBinary,
    exposure: expose ? { terminal: TERMINAL_HTTPS_PORT, artifacts: ARTIFACT_HTTPS_PORT } : null,
    artifacts: [],
    outcome: 'starting'
  };
  await writeJsonAtomic(layout.manifest, manifest);
  appendEvent(layout, { type: 'gateway-starting' });

  async function saveManifest() {
    await writeJsonAtomic(layout.manifest, manifest);
  }

  function broadcast(message) {
    const payload = JSON.stringify(message);
    for (const socket of subscribers) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  async function scanArtifacts() {
    let candidates;
    try {
      candidates = await walkArtifacts(layout.publicDir);
    } catch (error) {
      appendEvent(layout, { type: 'artifact-scan-failed', error: error.message });
      return;
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const candidate of candidates) {
      const revision = `${candidate.mtimeMs}:${candidate.bytes}`;
      if (verifiedRevisions.get(candidate.relativePath) === revision) continue;
      verifiedRevisions.set(candidate.relativePath, revision);
      try {
        const verification = await verifyArtifact({
          publicDir: layout.publicDir,
          relativePath: candidate.relativePath,
          artifactsDir: layout.artifacts,
          chromePath: config.chromePath
        });
        const record = {
          id: newSecret(12),
          path: candidate.relativePath,
          bytes: candidate.bytes,
          verifiedAt: new Date().toISOString(),
          verified: verification.ok,
          verification
        };
        manifest.artifacts.push(record);
        if (verification.ok) {
          latestArtifact = record;
          broadcast({ type: 'artifact', id: record.id });
        }
        await saveManifest();
        appendEvent(layout, { type: 'artifact-verified', path: candidate.relativePath, ok: verification.ok, engine: verification.engine });
      } catch (error) {
        appendEvent(layout, { type: 'artifact-rejected', path: candidate.relativePath, error: error.message });
      }
    }
  }

  async function serveStatic(name, res) {
    const file = libraryAssets[name] ?? path.join(staticDirectory, name);
    try {
      const body = await fsp.readFile(file);
      res.writeHead(200, {
        'content-type': contentType(file),
        'content-length': body.length,
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; frame-src http: https:; style-src 'self' 'unsafe-inline'; script-src 'self'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer'
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  }

  const terminalServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://loopback');
    if (url.pathname === basePath) {
      res.writeHead(302, { location: `${basePath}/`, 'cache-control': 'no-store' }).end();
      return;
    }
    if (url.pathname === `${basePath}/`) return await serveStatic('index.html', res);
    if (url.pathname === `${basePath}/style.css`) return await serveStatic('style.css', res);
    if (url.pathname === `${basePath}/app.js`) return await serveStatic('app.js', res);
    if (url.pathname === `${basePath}/xterm.js`) return await serveStatic('xterm.js', res);
    if (url.pathname === `${basePath}/xterm.css`) return await serveStatic('xterm.css', res);
    if (url.pathname === `${basePath}/latest-ticket` && req.method === 'POST') {
      if (!latestArtifact) {
        res.writeHead(204, { 'cache-control': 'no-store' }).end();
        return;
      }
      const ticket = newSecret(24);
      tickets.set(ticket, { artifact: latestArtifact, expiresAt: Date.now() + 60_000 });
      const artifactOrigin = config.artifactOrigin ?? `http://127.0.0.1:${artifactPort}`;
      return json(res, 200, {
        id: latestArtifact.id,
        url: `${artifactOrigin}${basePath}/claim/${ticket}`
      });
    }
    res.writeHead(404, { 'cache-control': 'no-store' }).end();
  });

  const artifactServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://loopback');
    const claimPrefix = `${basePath}/claim/`;
    const filesPrefix = `${basePath}/files/`;
    if (url.pathname.startsWith(claimPrefix)) {
      const ticket = url.pathname.slice(claimPrefix.length);
      const claim = tickets.get(ticket);
      tickets.delete(ticket);
      if (!claim || claim.expiresAt < Date.now() || !claim.artifact.verified) {
        res.writeHead(404).end();
        return;
      }
      const secure = String(config.artifactOrigin ?? '').startsWith('https:') ? '; Secure' : '';
      res.writeHead(302, {
        'set-cookie': `hii_artifact=${artifactCookie}; HttpOnly; SameSite=Strict; Path=${basePath}${secure}`,
        location: `${filesPrefix}${claim.artifact.path.split('/').map(encodeURIComponent).join('/')}`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer'
      }).end();
      return;
    }
    if (!url.pathname.startsWith(filesPrefix) || !String(req.headers.cookie ?? '').split(/;\s*/).includes(`hii_artifact=${artifactCookie}`)) {
      res.writeHead(401, { 'cache-control': 'no-store' }).end();
      return;
    }
    const relative = url.pathname.slice(filesPrefix.length);
    try {
      const file = await resolvePublicArtifact(layout.publicDir, relative);
      const body = await fsp.readFile(file);
      res.writeHead(200, {
        'content-type': contentType(file),
        'content-length': body.length,
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self' data: blob: https:; connect-src 'self' https:; img-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer'
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'cache-control': 'no-store' }).end();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  async function spawnHii() {
    if (pty) return;
    if (ptyStartPromise) return await ptyStartPromise;
    ptyStartPromise = (async () => {
      const sandbox = await createSandbox({ layout, hiiBinary: config.hiiBinary });
      const args = [
        ...sandbox.args,
        '--cwd', layout.workspace,
        '--model', MODEL,
        '--session-profile', SESSION_PROFILE
      ];
      appendEvent(layout, { type: 'hii-spawn', binary: config.hiiBinary, args: args.slice(sandbox.args.length) });
      pty = spawnPty(sandbox.launcher, args, {
        name: 'xterm-256color',
        cwd: layout.workspace,
        cols: 80,
        rows: 24,
        env: sandbox.env
      });
      pty.onData((data) => {
        fs.appendFileSync(layout.transcript, data, { mode: 0o600 });
        broadcast({ type: 'data', data });
      });
      pty.onExit(({ exitCode, signal }) => {
        appendEvent(layout, { type: 'hii-exit', exitCode, signal });
        pty = null;
        void shutdown('hii-exit');
      });
    })().finally(() => {
      ptyStartPromise = null;
    });
    return await ptyStartPromise;
  }

  terminalServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://loopback');
    if (url.pathname !== `${basePath}/ws`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (ws) => {
    const clientId = newSecret(8);
    subscribers.add(ws);
    if (disconnectTimer) clearTimeout(disconnectTimer);
    disconnectTimer = null;
    try {
      replayTranscript(layout, ws);
      await spawnHii();
    } catch (error) {
      appendEvent(layout, { type: 'hii-spawn-failed', error: error.message });
      ws.close(1011, 'HII failed to start');
      return;
    }
    ws.on('message', (raw) => {
      if (raw.length > MAX_MESSAGE_BYTES || !messageLimiter.allow(clientId)) {
        ws.close(1008, 'message limit');
        return;
      }
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 4096) {
          pty?.write(message.data);
          appendEvent(layout, { type: 'terminal-input', bytes: Buffer.byteLength(message.data) });
        } else if (message.type === 'resize') {
          const columns = Math.max(20, Math.min(300, Math.floor(message.columns) || 80));
          const rows = Math.max(5, Math.min(120, Math.floor(message.rows) || 24));
          pty?.resize(columns, rows);
        }
      } catch {
        ws.close(1003, 'invalid message');
      }
    });
    ws.on('close', () => {
      subscribers.delete(ws);
      appendEvent(layout, { type: 'ws-disconnected', clientsRemaining: subscribers.size });
      if (subscribers.size === 0) {
        disconnectTimer = setTimeout(() => void shutdown('disconnect-timeout'), disconnectGraceMs);
        disconnectTimer.unref?.();
      }
    });
  });

  async function stopOwnedRoutes() {
    if (!expose) return;
    const result = await run(config.tailscale, ['funnel', 'status', '--json'], { allowFailure: true });
    let status = {};
    try {
      status = JSON.parse(result.stdout || '{}');
    } catch {}
    for (const route of routesStarted.reverse()) {
      if (!routeOwnedBy(status, route.externalPort, route.localPort)) {
        appendEvent(layout, { type: 'route-preserved', port: route.externalPort, reason: 'route no longer matches this session' });
        continue;
      }
      await run(config.tailscale, funnelStopArgs(route.externalPort), { allowFailure: true });
      appendEvent(layout, { type: 'route-stopped', port: route.externalPort });
    }
  }

  async function shutdown(reason = 'stop') {
    if (shuttingDown) return;
    shuttingDown = true;
    if (disconnectTimer) clearTimeout(disconnectTimer);
    if (artifactTimer) clearInterval(artifactTimer);
    try {
      pty?.kill();
    } catch {}
    pty = null;
    for (const ws of subscribers) ws.close(1001, 'session ended');
    await Promise.allSettled([close(terminalServer), close(artifactServer)]);
    await stopOwnedRoutes();
    manifest.endedAt = new Date().toISOString();
    manifest.outcome = reason;
    await saveManifest();
    appendEvent(layout, { type: 'gateway-stopped', reason });
    const state = await readJson(config.stateFile);
    if (state?.sessionId === config.sessionId) await fsp.rm(config.stateFile, { force: true });
    dependencies.onShutdown?.(reason);
  }

  await listen(terminalServer, terminalPort);
  await listen(artifactServer, artifactPort);
  if (expose) {
    await run(config.tailscale, funnelStartArgs(TERMINAL_HTTPS_PORT, terminalPort));
    routesStarted.push({ externalPort: TERMINAL_HTTPS_PORT, localPort: terminalPort });
    try {
      await run(config.tailscale, funnelStartArgs(ARTIFACT_HTTPS_PORT, artifactPort));
      routesStarted.push({ externalPort: ARTIFACT_HTTPS_PORT, localPort: artifactPort });
    } catch (error) {
      await stopOwnedRoutes();
      throw error;
    }
  }
  artifactTimer = setInterval(() => void scanArtifacts(), 2000);
  artifactTimer.unref?.();
  void scanArtifacts();
  manifest.outcome = 'running';
  await saveManifest();
  await writeJsonAtomic(config.stateFile, {
    schemaVersion: 1,
    sessionId: config.sessionId,
    pid: process.pid,
    startedAt: manifest.createdAt,
    terminalPort,
    artifactPort,
    terminalHttpsPort: expose ? TERMINAL_HTTPS_PORT : null,
    artifactHttpsPort: expose ? ARTIFACT_HTTPS_PORT : null,
    sessionDir: layout.sessionDir,
    sessionPath,
    status: 'running'
  });
  appendEvent(layout, { type: 'gateway-ready', terminalPort, artifactPort, expose });

  return {
    layout,
    basePath,
    terminalPort,
    artifactPort,
    shutdown,
    scanArtifacts,
    manifest,
    servers: { terminal: terminalServer, artifact: artifactServer }
  };
}

async function childMain() {
  const encoded = process.env.HII_REMOTE_TEST_CONFIG;
  if (!encoded) return;
  const config = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  process.once('message', async (message) => {
    if (message?.type !== 'start') process.exit(2);
    try {
      const gateway = await startRemoteTestGateway(config);
      process.send?.({ type: 'ready', pid: process.pid, basePath: gateway.basePath });
      process.disconnect?.();
      process.once('SIGTERM', () => void gateway.shutdown('operator-stop').finally(() => process.exit(0)));
      process.once('SIGINT', () => void gateway.shutdown('operator-stop').finally(() => process.exit(0)));
    } catch (error) {
      process.send?.({ type: 'error', message: error.message });
      process.exit(1);
    }
  });
}

await childMain();
