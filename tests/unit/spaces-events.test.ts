// @vitest-environment node
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceNode } from '../../lib/workspace/types';
import { decodeSpaceServerMessage, MAX_SPACE_EVENT_FRAME_BYTES } from '../../lib/spaces/protocol';

const require = createRequire(import.meta.url);
const Ws = require('ws') as typeof import('ws');
type Client = InstanceType<typeof Ws>;

let runtimeDir = '';
const hosts: Array<{ stop(): Promise<void> }> = [];
const clients: Client[] = [];
const guestCookies = new Map<number, string>();

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-space-events-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  vi.resetModules();
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    if (client.readyState !== Ws.CLOSED) client.terminate();
  }
  for (const host of hosts.splice(0)) await host.stop().catch(() => undefined);
  const store = await import('../../lib/server/operational-object-store');
  store.resetOperationalObjectStoreForTests();
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

function photo(): WorkspaceNode {
  return {
    id: 'photo-1',
    spaceId: '14th-street',
    creatorId: 'guest:pending',
    type: 'image',
    x: 10,
    y: 20,
    w: 320,
    h: 240,
    z: 1,
    rotation: 0,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    permissions: { inheritance: 'space-policy' },
    payload: { src: '/api/spaces/14th-street/blobs/photo-1' }
  };
}

async function host(events?: { maxFrameBytes?: number; heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number }) {
  const { createSpace } = await import('../../lib/server/space-store');
  await createSpace({ id: '14th-street', ownerId: 'user:host', name: '14th Street' });
  const { startSpacesHost } = await import('../../lib/spaces/host/server');
  const running = await startSpacesHost({ mode: 'local', port: 0, events });
  const origin = running.origins[0];
  const session = await fetch(`${origin}/api/spaces/14th-street/guest-session`, { method: 'POST', headers: { Origin: origin } });
  guestCookies.set(running.port, session.headers.get('set-cookie')?.split(';')[0] ?? '');
  hosts.push(running);
  return running;
}

function openClient(port: number, pathname = '/api/spaces/14th-street/events', origin = `http://127.0.0.1:${port}`) {
  const client = new Ws(`ws://127.0.0.1:${port}${pathname}`, { origin, headers: { Cookie: guestCookies.get(port) ?? '' } });
  client.on('error', () => undefined);
  clients.push(client);
  return client;
}

function nextMessage(client: Client, predicate: (message: any) => boolean = () => true): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for WebSocket message: ${predicate.toString()}`)), 3_000);
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (!predicate(message)) return;
      clearTimeout(timeout);
      client.off('message', listener);
      resolve(message);
    };
    client.on('message', listener);
  });
}

async function snapshot(client: Client) {
  return nextMessage(client, (message) => message.type === 'space.snapshot');
}

async function sendAndAck(client: Client, message: Record<string, unknown>) {
  const ack = nextMessage(client, (entry) => (entry.type === 'space.ack' || entry.type === 'space.error') && entry.requestId === message.requestId);
  client.send(JSON.stringify(message));
  const response = await ack;
  if (response.type === 'space.error') throw new Error(`${response.code}: ${response.message}`);
  return response;
}

describe('Space realtime event host', () => {
  it('converges two real clients across create, move, update, delete, and reconnect', async () => {
    const running = await host();
    const first = openClient(running.port);
    const second = openClient(running.port);
    const [firstSnapshot] = await Promise.all([snapshot(first), snapshot(second)]);
    expect(firstSnapshot).toMatchObject({ cursor: 0, workspace: { nodes: [] } });

    const create = { type: 'object.create', requestId: 'r-create', idempotencyKey: 'k-create', node: photo() };
    const createdForSecond = nextMessage(second, (message) => message.type === 'space.event' && message.event.type === 'object.create');
    const createAck = await sendAndAck(first, create);
    expect(await createdForSecond).toMatchObject({ cursor: createAck.cursor, event: { node: { id: 'photo-1', creatorId: expect.stringMatching(/^guest_/) } } });

    const movedForSecond = nextMessage(second, (message) => message.type === 'space.event' && message.event.type === 'object.move');
    const moveAck = await sendAndAck(first, { type: 'object.move', requestId: 'r-move', idempotencyKey: 'k-move', objectId: 'photo-1', patch: { x: 99, y: 101 } });
    expect((await movedForSecond).event.patch).toMatchObject({ x: 99, y: 101 });

    const updatedForFirst = nextMessage(first, (message) => message.type === 'space.event' && message.event.type === 'object.update');
    const updateAck = await sendAndAck(second, { type: 'object.update', requestId: 'r-update', idempotencyKey: 'k-update', objectId: 'photo-1', patch: { payload: { src: '/changed' } } });
    expect((await updatedForFirst).event.patch.payload).toEqual({ src: '/changed' });
    expect(updateAck.cursor).toBeGreaterThan(moveAck.cursor);

    second.close();
    const reconnected = openClient(running.port);
    expect(await snapshot(reconnected)).toMatchObject({
      cursor: updateAck.cursor,
      workspace: { nodes: [{ id: 'photo-1', x: 99, y: 101, payload: { src: '/changed' } }] }
    });

    const deletedForReconnect = nextMessage(reconnected, (message) => message.type === 'space.event' && message.event.type === 'object.delete');
    await sendAndAck(first, { type: 'object.delete', requestId: 'r-delete', idempotencyKey: 'k-delete', objectId: 'photo-1' });
    expect((await deletedForReconnect).event.objectId).toBe('photo-1');

    let replayWasBroadcast = false;
    const replayListener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type === 'space.event' && message.event.type === 'object.create') replayWasBroadcast = true;
    };
    reconnected.on('message', replayListener);
    expect(await sendAndAck(first, create)).toMatchObject({ replayed: true, cursor: createAck.cursor });
    await new Promise((resolve) => setTimeout(resolve, 30));
    reconnected.off('message', replayListener);
    expect(replayWasBroadcast).toBe(false);

    const finalClient = openClient(running.port);
    expect(await snapshot(finalClient)).toMatchObject({ workspace: { nodes: [] } });
  });

  it('persists before ack, records graph ownership, and replays idempotently', async () => {
    const running = await host();
    const client = openClient(running.port);
    await snapshot(client);
    const message = { type: 'object.create', requestId: 'same-request', idempotencyKey: 'same-key', node: photo() };
    const first = await sendAndAck(client, message);
    const replay = await sendAndAck(client, message);
    expect(replay).toMatchObject({ cursor: first.cursor, replayed: true });

    const { readWorkspace } = await import('../../lib/server/workspace-store');
    expect(await readWorkspace('14th-street')).toMatchObject({ nodes: [{ id: 'photo-1' }] });
    const { readOperationalSpace } = await import('../../lib/server/operational-object-store');
    const graph = readOperationalSpace('14th-street');
    expect(graph.objects).toHaveLength(1);
    expect(graph.objects[0]).toMatchObject({ canonicalSource: 'graph', properties: { spaceNode: { id: 'photo-1' } } });
    expect(graph.operations).toHaveLength(2);
  });

  it('enforces the exact upgrade route and same-origin boundary', async () => {
    const running = await host();
    for (const [pathname, origin, status] of [
      ['/api/spaces/14th-street/events/extra', `http://127.0.0.1:${running.port}`, 404],
      ['/api/spaces/missing/events', `http://127.0.0.1:${running.port}`, 404],
      ['/api/spaces/14th-street/events', 'http://evil.invalid', 403]
    ] as const) {
      const client = openClient(running.port, pathname, origin);
      const response = await new Promise<number>((resolve) => client.once('unexpected-response', (_request, result) => resolve(result.statusCode ?? 0)));
      expect(response).toBe(status);
    }
  });

  it('closes malformed, binary, and oversized frames without taking down the host', async () => {
    const running = await host({ maxFrameBytes: 256 });
    for (const payload of ['{', Buffer.from('binary'), JSON.stringify({ type: 'presence.heartbeat', pad: 'x'.repeat(300) })]) {
      const client = openClient(running.port);
      await snapshot(client);
      const closed = new Promise<number>((resolve) => client.once('close', (code) => resolve(code)));
      client.send(payload);
      expect(await closed).toBeGreaterThanOrEqual(1007);
    }
    const healthy = openClient(running.port);
    expect(await snapshot(healthy)).toMatchObject({ type: 'space.snapshot' });
  });

  it('serializes a joining snapshot with mutations so the joining client converges', async () => {
    const running = await host();
    const writer = openClient(running.port);
    await snapshot(writer);
    await sendAndAck(writer, { type: 'object.create', requestId: 'race-create', idempotencyKey: 'race-create', node: photo() });

    const joining = openClient(running.port);
    const received: any[] = [];
    joining.on('message', (raw) => received.push(JSON.parse(raw.toString('utf8'))));
    await new Promise<void>((resolve) => joining.once('open', () => resolve()));
    const moved = await sendAndAck(writer, { type: 'object.move', requestId: 'race-move', idempotencyKey: 'race-move', objectId: 'photo-1', patch: { x: 700, y: 800 } });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const initial = received.find((message) => message.type === 'space.snapshot');
    expect(initial).toBeTruthy();
    const moveEvent = received.find((message) => message.type === 'space.event' && message.cursor === moved.cursor);
    const convergedX = moveEvent?.event.patch.x ?? initial.workspace.nodes[0].x;
    expect(convergedX).toBe(700);
  });

  it('serves and decodes a canonical snapshot larger than the inbound mutation limit', async () => {
    const running = await host();
    const writer = openClient(running.port);
    await snapshot(writer);
    for (let index = 0; index < 3; index += 1) {
      const large = { ...photo(), id: `large-${index}`, payload: { text: 'x'.repeat(30_000) } };
      await sendAndAck(writer, { type: 'object.create', requestId: `large-${index}`, idempotencyKey: `large-${index}`, node: large });
    }
    const joining = openClient(running.port);
    const raw = await new Promise<string>((resolve) => joining.once('message', (data) => resolve(data.toString('utf8'))));
    expect(Buffer.byteLength(raw)).toBeGreaterThan(MAX_SPACE_EVENT_FRAME_BYTES);
    expect(decodeSpaceServerMessage(raw)).toMatchObject({ type: 'space.snapshot', workspace: { nodes: [{ id: 'large-0' }, { id: 'large-1' }, { id: 'large-2' }] } });
  });

  it('caps concurrent sockets from one peer', async () => {
    const running = await host();
    const accepted = Array.from({ length: 16 }, () => openClient(running.port));
    await Promise.all(accepted.map((client) => snapshot(client)));
    const refused = openClient(running.port);
    const status = await new Promise<number>((resolve) => refused.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0)));
    expect(status).toBe(503);
  });
});
