// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceClientMessage, SpaceServerMessage } from '../../lib/spaces/protocol';

let runtimeDir = '';
const hosts: Array<{ stop(): Promise<void> }> = [];
const sockets: WebSocket[] = [];

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-spaces-persistence-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  vi.resetModules();
});

afterEach(async () => {
  await Promise.allSettled(sockets.splice(0).map((socket) => closeSocket(socket)));
  await Promise.allSettled(hosts.splice(0).map((host) => host.stop()));
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

function closeSocket(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
}

async function guestSession(origin: string, spaceId: string, existingCookie?: string) {
  const response = await fetch(`${origin}/api/spaces/${spaceId}/guest-session`, {
    method: 'POST',
    headers: {
      Origin: origin,
      ...(existingCookie ? { Cookie: existingCookie } : {})
    }
  });
  if (response.status !== 201) throw new Error(`guest session failed with HTTP ${response.status}`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('guest session did not issue a cookie');
  const body = await response.json() as { participantId: string; expiresAt: number };
  return { cookie, ...body };
}

async function connect(origin: string, spaceId: string, existingCookie?: string) {
  const session = await guestSession(origin, spaceId, existingCookie);
  const socket = new WebSocket(
    `${origin.replace(/^http/, 'ws')}/api/spaces/${spaceId}/events`,
    { origin, headers: { Cookie: session.cookie } }
  );
  sockets.push(socket);
  const messages: SpaceServerMessage[] = [];
  const waiters: Array<{
    predicate: (message: SpaceServerMessage) => boolean;
    resolve: (message: SpaceServerMessage) => void;
  }> = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as SpaceServerMessage;
    messages.push(message);
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const waitFor = (predicate: (message: SpaceServerMessage) => boolean) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<SpaceServerMessage>((resolve) => waiters.push({ predicate, resolve }));
  };
  const snapshot = await waitFor((message) => message.type === 'space.snapshot');
  if (snapshot.type !== 'space.snapshot' || snapshot.participantId !== session.participantId) {
    throw new Error('guest session identity did not match the Space snapshot');
  }
  return {
    socket,
    cookie: session.cookie,
    snapshot: snapshot as Extract<SpaceServerMessage, { type: 'space.snapshot' }>,
    send(message: SpaceClientMessage) {
      socket.send(JSON.stringify(message));
    },
    waitFor,
    ack(requestId: string) {
      return waitFor(
        (message) => message.type === 'space.ack' && message.requestId === requestId
      ) as Promise<Extract<SpaceServerMessage, { type: 'space.ack' }>>;
    }
  };
}

function imageNode(spaceId: string) {
  const now = '2026-08-20T12:00:00.000Z';
  return {
    id: 'photo-1',
    type: 'image' as const,
    spaceId,
    x: 40,
    y: 60,
    w: 320,
    h: 240,
    z: 1,
    rotation: 0,
    createdAt: now,
    updatedAt: now,
    payload: {
      src: `/api/spaces/${spaceId}/blobs/blob_stable`,
      blobRef: 'blob_stable',
      alt: 'Durable camera upload'
    }
  };
}

async function runningHost(spaceId: string) {
  const [{ createSpace }, { startSpacesHost }] = await Promise.all([
    import('../../lib/server/space-store'),
    import('../../lib/spaces/host/server')
  ]);
  await createSpace({ id: spaceId, ownerId: 'user:test', name: 'Persistence Proof' });
  const host = await startSpacesHost({ port: 0 });
  hosts.push(host);
  return host;
}

describe('Space realtime durability', () => {
  it('acknowledges only state that is already in the durable workspace projection', async () => {
    const spaceId = 'durable-ack';
    const host = await runningHost(spaceId);
    const client = await connect(host.origins[0], spaceId);
    const requestId = 'create-photo';
    client.send({
      type: 'object.create',
      requestId,
      idempotencyKey: 'persist-create-photo',
      node: imageNode(spaceId)
    });
    const ack = await client.ack(requestId);

    const { readWorkspace } = await import('../../lib/server/workspace-store');
    const durable = await readWorkspace(spaceId);
    expect(ack.cursor).toBeGreaterThan(0);
    expect(durable.nodes).toHaveLength(1);
    expect(durable.nodes[0]).toMatchObject({
      id: 'photo-1',
      spaceId,
      x: 40,
      y: 60,
      payload: { blobRef: 'blob_stable' }
    });
  });

  it('rehydrates an identical snapshot and advances Lamport after host restart', async () => {
    const spaceId = 'restart-space';
    const host = await runningHost(spaceId);
    const first = await connect(host.origins[0], spaceId);
    first.send({
      type: 'object.create',
      requestId: 'create',
      idempotencyKey: 'restart-create',
      node: imageNode(spaceId)
    });
    await first.ack('create');
    first.send({
      type: 'object.move',
      requestId: 'move',
      idempotencyKey: 'restart-move',
      objectId: 'photo-1',
      patch: { x: 444, y: 555, rotation: 12 }
    });
    const moved = await first.ack('move');
    const before = await connect(host.origins[0], spaceId);
    const expected = before.snapshot.workspace;
    expect(before.snapshot.cursor).toBe(moved.cursor);

    await closeSocket(first.socket);
    await closeSocket(before.socket);
    await host.stop();
    hosts.splice(hosts.indexOf(host), 1);

    const { startSpacesHost } = await import('../../lib/spaces/host/server');
    const restarted = await startSpacesHost({ port: host.port });
    hosts.push(restarted);
    const after = await connect(restarted.origins[0], spaceId);
    expect(after.snapshot.workspace).toEqual(expected);
    expect(after.snapshot.cursor).toBe(moved.cursor);

    after.send({
      type: 'object.create',
      requestId: 'update-after-restart',
      idempotencyKey: 'restart-update',
      node: {
        ...imageNode(spaceId),
        id: 'photo-after-restart',
        x: 700,
        y: 800,
        payload: { ...imageNode(spaceId).payload, alt: 'Created after restart' }
      }
    });
    expect((await after.ack('update-after-restart')).cursor).toBeGreaterThan(moved.cursor);
  });

  it('serializes concurrent moves and materializes the highest-cursor event', async () => {
    const spaceId = 'concurrent-space';
    const host = await runningHost(spaceId);
    const left = await connect(host.origins[0], spaceId);
    const right = await connect(host.origins[0], spaceId, left.cookie);
    left.send({
      type: 'object.create',
      requestId: 'create',
      idempotencyKey: 'concurrent-create',
      node: imageNode(spaceId)
    });
    await left.ack('create');

    left.send({
      type: 'object.move',
      requestId: 'move-left',
      idempotencyKey: 'concurrent-left',
      objectId: 'photo-1',
      patch: { x: 101, y: 102 }
    });
    right.send({
      type: 'object.move',
      requestId: 'move-right',
      idempotencyKey: 'concurrent-right',
      objectId: 'photo-1',
      patch: { x: 901, y: 902 }
    });
    const [leftAck, rightAck] = await Promise.all([left.ack('move-left'), right.ack('move-right')]);
    expect(leftAck.cursor).not.toBe(rightAck.cursor);
    const winner = leftAck.cursor > rightAck.cursor ? { x: 101, y: 102 } : { x: 901, y: 902 };

    const reconnected = await connect(host.origins[0], spaceId);
    expect(reconnected.snapshot.cursor).toBe(Math.max(leftAck.cursor, rightAck.cursor));
    expect(reconnected.snapshot.workspace.nodes).toHaveLength(1);
    expect(reconnected.snapshot.workspace.nodes[0]).toMatchObject(winner);

    const { readWorkspace } = await import('../../lib/server/workspace-store');
    expect((await readWorkspace(spaceId)).nodes[0]).toMatchObject(winner);
  });

  it('preserves a corrupt Space canvas document instead of replacing it', async () => {
    const spaceId = 'corrupt-canvas';
    const file = path.join(runtimeDir, 'workspace', 'workspaces', `${spaceId}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{not-json', 'utf8');

    const { readWorkspace, WorkspaceLoadError } = await import('../../lib/server/workspace-store');
    await expect(readWorkspace(spaceId)).rejects.toBeInstanceOf(WorkspaceLoadError);
    expect(await readFile(file, 'utf8')).toBe('{not-json');
    const recoveries = (await readdir(path.join(runtimeDir, 'workspace'))).filter((entry) =>
      entry.startsWith(`${spaceId}.unreadable.`)
    );
    expect(recoveries).toHaveLength(1);
    expect(await readFile(path.join(runtimeDir, 'workspace', recoveries[0]), 'utf8')).toBe('{not-json');
  });
});
