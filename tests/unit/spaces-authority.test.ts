// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createSpace, updateSpace } from '../../lib/server/space-store.ts';
import { startSpacesHost, type RunningSpacesHost } from '../../lib/spaces/host/server.ts';

let runtimeDir: string;
const hosts: RunningSpacesHost[] = [];
beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-space-authority-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

async function host(options: Parameters<typeof startSpacesHost>[0] = {}) {
  const running = await startSpacesHost({ port: 0, ...options });
  hosts.push(running);
  return running;
}
async function session(running: RunningSpacesHost, spaceId: string) {
  const origin = running.origins[0];
  const response = await fetch(`${origin}/api/spaces/${spaceId}/guest-session`, {
    method: 'POST', headers: { Origin: origin }
  });
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
function publicRequest(running: RunningSpacesHost, spaceId: string, pathname: string, cookie = '', body = '') {
  return new Promise<{ status: number; body: string; cookie: string }>((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${running.port}${pathname}`, {
      method: 'POST',
      headers: {
        Host: 'mac.example.ts.net',
        Origin: 'https://mac.example.ts.net',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': String(Buffer.byteLength(body)) } : {})
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const setCookie = response.headers['set-cookie']?.[0] ?? '';
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), cookie: setCookie.split(';', 1)[0] });
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}
function socket(running: RunningSpacesHost, spaceId: string, cookie: string) {
  return new WebSocket(`ws://127.0.0.1:${running.port}/api/spaces/${spaceId}/events`, {
    headers: { Origin: running.origins[0], Cookie: cookie }
  });
}
function next(client: WebSocket, type: string): Promise<any> {
  return new Promise((resolve) => {
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type === type) { client.off('message', listener); resolve(message); }
    };
    client.on('message', listener);
  });
}
function image(id: string, spaceId: string) {
  const now = new Date().toISOString();
  return { id, type: 'image', spaceId, creatorId: 'attacker', x: 1, y: 2, w: 100, h: 100, z: 1, rotation: 0, createdAt: now, updatedAt: now, permissions: { inheritance: 'space-policy' }, payload: {} };
}

describe('Space guest authority integration', () => {
  it('issues an HttpOnly same-origin credential and rejects missing, tampered, and cross-Space credentials', async () => {
    await createSpace({ id: 'one', ownerId: 'user:host' });
    await createSpace({ id: 'two', ownerId: 'user:host' });
    const running = await host();
    expect((await fetch(`${running.origins[0]}/api/spaces/one/guest-session`, { method: 'POST', headers: { Origin: 'http://evil.invalid' } })).status).toBe(403);
    const issued = await session(running, 'one');
    expect(issued.response.status).toBe(201);
    expect(issued.response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(issued.response.headers.get('set-cookie')).toContain('SameSite=Strict');
    for (const [spaceId, cookie] of [['one', ''], ['one', `${issued.cookie}x`], ['two', issued.cookie]] as const) {
      const client = socket(running, spaceId, cookie);
      const status = await new Promise<number>((resolve) => client.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0)));
      expect(status).toBe(401);
    }
  });

  it('stamps authenticated ownership and refuses cross-object writes', async () => {
    await createSpace({ id: 'owned', ownerId: 'user:host' });
    const running = await host();
    const firstSession = await session(running, 'owned');
    const secondSession = await session(running, 'owned');
    const first = socket(running, 'owned', firstSession.cookie);
    const second = socket(running, 'owned', secondSession.cookie);
    const firstSnapshotPromise = next(first, 'space.snapshot');
    const secondSnapshotPromise = next(second, 'space.snapshot');
    const firstSnapshot = await firstSnapshotPromise;
    await secondSnapshotPromise;
    const createAck = next(first, 'space.ack');
    first.send(JSON.stringify({ type: 'object.create', requestId: 'create', idempotencyKey: 'create', node: image('photo', 'owned') }));
    expect(await createAck).toMatchObject({ requestId: 'create' });
    const refused = next(second, 'space.error');
    second.send(JSON.stringify({ type: 'object.move', requestId: 'steal', idempotencyKey: 'steal', objectId: 'photo', patch: { x: 9, y: 9 } }));
    expect(await refused).toMatchObject({ requestId: 'steal', code: 'MUTATION_REFUSED' });
    expect(firstSnapshot.participantId).toMatch(/^guest_/);
  });

  it('applies listener policy to HTTP and WebSocket admission', async () => {
    await createSpace({ id: 'local-only', ownerId: 'user:host' });
    await updateSpace('local-only', { hosting: 'published', publication: { state: 'published', provider: 'tailscale-funnel', endpoint: 'https://mac.example.ts.net/s/local-only' } });
    const publicHost = await host({ audience: 'public', publicSpaceId: 'local-only', allowedHostnames: ['mac.example.ts.net'] });
    expect((await fetch(`${publicHost.origins[0]}/api/spaces/local-only`)).status).toBe(403);
    expect((await publicRequest(publicHost, 'local-only', '/api/spaces/local-only/guest-session')).status).toBe(403);
  });

  it('rejects a public-listener upload before parsing its body when writes are local-only', async () => {
    await createSpace({ id: 'public-read', ownerId: 'user:host', policy: { read: 'public', write: 'local' } });
    await updateSpace('public-read', { hosting: 'published', publication: { state: 'published', provider: 'tailscale-funnel', endpoint: 'https://mac.example.ts.net/s/public-read' } });
    const running = await host({ audience: 'public', publicSpaceId: 'public-read', allowedHostnames: ['mac.example.ts.net'] });
    const issued = await publicRequest(running, 'public-read', '/api/spaces/public-read/guest-session');
    expect(issued.status).toBe(201);
    const response = await publicRequest(running, 'public-read', '/api/spaces/public-read/blobs', issued.cookie, 'not-an-image');
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'POLICY_LOCAL_AUDIENCE_REQUIRED' } });
  });
});
