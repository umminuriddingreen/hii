#!/usr/bin/env node

/**
 * Actual crash/restart proof for graph-authoritative Space state.
 *
 * The first host accepts a create and move over its real WebSocket route. Once
 * its ACK proves both graph and workspace projection are durable, this script
 * sends SIGKILL, starts a brand-new process on the same port/runtime, compares
 * the full snapshot, then proves the server-issued Lamport cursor advances.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-spaces-restart-'));
process.env.HII_RUNTIME_DIR = runtimeDir;
const hostScript = path.join(repo, 'scripts', 'hii-spaces-host.mjs');
const hostBootstrap = `
  import { createServer } from 'vite';
  process.argv = [process.execPath, ${JSON.stringify(hostScript)}, '--port', process.env.HII_SPACES_SMOKE_PORT];
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', clearScreen: false, logLevel: 'silent' });
  await vite.ssrLoadModule(${JSON.stringify(hostScript)});
`;
const store = path.join(repo, 'lib', 'server', 'space-store.ts');
const children = new Set();
const sockets = new Set();

function waitForLine(stream, pattern) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk) => {
      buffered += chunk.toString();
      for (const line of buffered.split('\n')) {
        const match = pattern.exec(line);
        if (match) {
          stream.off('data', onData);
          resolve(match);
          return;
        }
      }
    };
    stream.on('data', onData);
    stream.once('error', reject);
  });
}

async function startHost(port = 0) {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', hostBootstrap],
    {
      cwd: repo,
      env: { ...process.env, HII_RUNTIME_DIR: runtimeDir, HII_SPACES_SMOKE_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  children.add(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const match = await Promise.race([
    waitForLine(child.stdout, /HII Spaces host listening on 127\.0\.0\.1:(\d+)/),
    exited.then(({ code, signal }) => { throw new Error(`host exited before ready (${code ?? signal}): ${stderr}`); })
  ]);
  return { child, port: Number(match[1]), exited };
}

async function connect(port) {
  const origin = `http://127.0.0.1:${port}`;
  const sessionResponse = await fetch(`${origin}/api/spaces/restart-proof/guest-session`, {
    method: 'POST',
    headers: { Origin: origin }
  });
  assert.equal(sessionResponse.status, 201, 'guest session was not issued');
  const cookie = sessionResponse.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'guest session did not return Set-Cookie');
  const session = await sessionResponse.json();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/spaces/restart-proof/events`, {
    origin,
    headers: { Cookie: cookie }
  });
  sockets.add(socket);
  const queued = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    queued.push(message);
    const index = waiters.findIndex(({ predicate }) => predicate(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const waitFor = (predicate) => {
    const existing = queued.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => waiters.push({ predicate, resolve }));
  };
  const snapshot = await waitFor((message) => message.type === 'space.snapshot');
  assert.equal(snapshot.participantId, session.participantId, 'guest session identity changed during upgrade');
  return {
    socket,
    snapshot,
    send(message) { socket.send(JSON.stringify(message)); },
    ack(requestId) {
      return waitFor((message) => message.type === 'space.ack' && message.requestId === requestId);
    }
  };
}

function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once('close', resolve);
    socket.close();
  });
}

try {
  const { createSpace } = await import(store);
  await createSpace({ id: 'restart-proof', ownerId: 'user:smoke', name: 'Restart Proof' });

  const firstHost = await startHost();
  const first = await connect(firstHost.port);
  const createdAt = '2026-08-20T12:00:00.000Z';
  first.send({
    type: 'object.create',
    requestId: 'create',
    idempotencyKey: 'restart-smoke-create',
    node: {
      id: 'camera-photo',
      type: 'image',
      spaceId: 'restart-proof',
      x: 20,
      y: 30,
      w: 300,
      h: 225,
      z: 1,
      rotation: 0,
      createdAt,
      updatedAt: createdAt,
      payload: {
        src: '/api/spaces/restart-proof/blobs/blob_restart_proof',
        blobRef: 'blob_restart_proof',
        alt: 'Crash durable photo'
      }
    }
  });
  await first.ack('create');
  first.send({
    type: 'object.move',
    requestId: 'move',
    idempotencyKey: 'restart-smoke-move',
    objectId: 'camera-photo',
    patch: { x: 640, y: 360, rotation: 9 }
  });
  const moved = await first.ack('move');
  const observer = await connect(firstHost.port);
  const durableBeforeCrash = observer.snapshot;
  assert.equal(durableBeforeCrash.cursor, moved.cursor);
  assert.deepEqual(
    durableBeforeCrash.workspace.nodes.map(({ id, x, y, rotation, payload }) => ({ id, x, y, rotation, payload })),
    [{
      id: 'camera-photo',
      x: 640,
      y: 360,
      rotation: 9,
      payload: {
        src: '/api/spaces/restart-proof/blobs/blob_restart_proof',
        blobRef: 'blob_restart_proof',
        alt: 'Crash durable photo'
      }
    }]
  );
  await Promise.all([closeSocket(first.socket), closeSocket(observer.socket)]);

  firstHost.child.kill('SIGKILL');
  const killed = await firstHost.exited;
  children.delete(firstHost.child);
  assert.equal(killed.signal, 'SIGKILL');

  const restartedHost = await startHost(firstHost.port);
  const after = await connect(restartedHost.port);
  assert.equal(after.snapshot.cursor, durableBeforeCrash.cursor, 'Lamport cursor changed during restart');
  assert.deepEqual(after.snapshot.workspace, durableBeforeCrash.workspace, 'Space snapshot changed during restart');

  after.send({
    type: 'object.create',
    requestId: 'after-restart',
    idempotencyKey: 'restart-smoke-update',
    node: {
      id: 'post-restart-note',
      type: 'canvas-text',
      spaceId: 'restart-proof',
      x: 800,
      y: 450,
      w: 240,
      h: 120,
      z: 2,
      rotation: 0,
      createdAt,
      updatedAt: createdAt,
      payload: {
        text: 'Created by the new post-restart guest'
      }
    }
  });
  const advanced = await after.ack('after-restart');
  assert.ok(advanced.cursor > durableBeforeCrash.cursor, 'Lamport cursor did not resume after restart');
  await closeSocket(after.socket);
  restartedHost.child.kill('SIGTERM');
  const stopped = await restartedHost.exited;
  children.delete(restartedHost.child);
  assert.equal(stopped.code, 0);

  console.log('hii spaces restart smoke: SIGKILL recovery preserved objects, positions, blob refs, and Lamport order.');
} finally {
  for (const socket of sockets) socket.terminate();
  for (const child of children) child.kill('SIGKILL');
  await rm(runtimeDir, { recursive: true, force: true });
  delete process.env.HII_RUNTIME_DIR;
}
