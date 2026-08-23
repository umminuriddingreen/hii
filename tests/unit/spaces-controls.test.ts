// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createSpace, readSpace } from '../../lib/server/space-store.ts';
import { readWorkspace } from '../../lib/server/workspace-store.ts';
import { startSpacesHost, type RunningSpacesHost } from '../../lib/spaces/host/server.ts';

let runtimeDir: string;
const hosts: RunningSpacesHost[] = [];
beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-space-controls-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});
async function setup() {
  await createSpace({ id: 'moderated', ownerId: 'user:host' });
  const running = await startSpacesHost({ port: 0 });
  hosts.push(running);
  const origin = running.origins[0];
  const response = await fetch(`${origin}/api/spaces/moderated/guest-session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  const client = new WebSocket(`ws://127.0.0.1:${running.port}/api/spaces/moderated/events`, { headers: { Origin: origin, Cookie: cookie } });
  const snapshot = await new Promise<any>((resolve) => client.once('message', (raw) => resolve(JSON.parse(raw.toString()))));
  return { running, client, snapshot, cookie, origin };
}
function next(client: WebSocket, type: string): Promise<any> {
  return new Promise((resolve) => {
    const listener = (raw: Buffer) => {
      const value = JSON.parse(raw.toString());
      if (value.type === type) { client.off('message', listener); resolve(value); }
    };
    client.on('message', listener);
  });
}
function node(id: string) {
  const now = new Date().toISOString();
  return { id, type: 'image', spaceId: 'moderated', x: 0, y: 0, w: 80, h: 80, z: 1, createdAt: now, updatedAt: now, payload: {} };
}

describe('process-local Space host controls', () => {
  it('freezes live writes, changes canonical policy and exposes no visitor route', async () => {
    const { running, client } = await setup();
    await running.controls.freezeWrites('moderated');
    client.send(JSON.stringify({ type: 'object.create', requestId: 'frozen', idempotencyKey: 'frozen', node: node('x') }));
    expect(await next(client, 'space.error')).toMatchObject({ requestId: 'frozen', code: 'POLICY_WRITES_FROZEN' });
    await running.controls.setPolicyMode('moderated', 'PUBLIC_READ_ONLY');
    expect((await readSpace('moderated')).policy.write).toBe('none');
    expect((await fetch(`${running.origins[0]}/api/spaces/moderated/controls`)).status).toBe(404);
  });

  it('revokes a participant and closes its socket', async () => {
    const { running, client, snapshot, cookie, origin } = await setup();
    const closed = new Promise<number>((resolve) => client.once('close', (code) => resolve(code)));
    expect(await running.controls.removeParticipant('moderated', snapshot.participantId)).toBe(true);
    expect(await closed).toBe(1008);
    expect((await fetch(`${origin}/api/spaces/moderated/guest-session`, {
      method: 'POST', headers: { Origin: origin, Cookie: cookie }
    })).status).toBe(401);
  });

  it('evicts guests on invite-only policy and admits a host-invited replacement', async () => {
    const { running, client, origin } = await setup();
    const invite = await running.controls.createInvite('moderated');
    const closed = new Promise<number>((resolve) => client.once('close', (code) => resolve(code)));
    await running.controls.setPolicyMode('moderated', 'INVITE_ONLY');
    expect(await closed).toBe(1008);
    const admitted = await fetch(`${origin}/api/spaces/moderated/guest-session`, {
      method: 'POST', headers: { Origin: origin, 'X-HII-Space-Invite': invite }
    });
    expect(admitted.status).toBe(201);
    const invited = new WebSocket(`ws://127.0.0.1:${running.port}/api/spaces/moderated/events`, {
      headers: { Origin: origin, Cookie: admitted.headers.get('set-cookie')?.split(';')[0] ?? '' }
    });
    expect(await next(invited, 'space.snapshot')).toMatchObject({ spaceId: 'moderated' });
  });

  it('removes and clears objects durably even while frozen', async () => {
    const { running, client } = await setup();
    for (const id of ['one', 'two']) {
      client.send(JSON.stringify({ type: 'object.create', requestId: id, idempotencyKey: id, node: node(id) }));
      await next(client, 'space.ack');
    }
    await running.controls.freezeWrites('moderated');
    await running.controls.removeObject('moderated', 'one');
    expect((await readWorkspace('moderated')).nodes.map((item) => item.id)).toEqual(['two']);
    expect(await running.controls.clearSpace('moderated')).toBe(1);
    expect((await readWorkspace('moderated')).nodes).toEqual([]);
  });
});
