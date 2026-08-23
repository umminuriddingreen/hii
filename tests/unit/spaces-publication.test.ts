// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSpace, readSpace, updateSpace } from '../../lib/server/space-store.ts';
import {
  SpacePublicationError,
  SpacePublisher,
  funnelStartArgs,
  funnelStopArgs,
  routeOwnedBy,
  type PublicationCommandResult
} from '../../lib/spaces/publication.ts';
import { startSpacesHost } from '../../lib/spaces/host/server.ts';

const roots: string[] = [];
const ok = (stdout = ''): PublicationCommandResult => ({ code: 0, signal: null, stdout, stderr: '' });
const require = createRequire(import.meta.url);
const Ws = require('ws') as typeof import('ws');

function nextWsMessage(socket: InstanceType<typeof Ws>, type: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      if (message.type !== type) return;
      socket.off('error', onError);
      resolve(message);
    };
    const onError = (error: Error) => {
      socket.off('message', onMessage);
      reject(error);
    };
    socket.on('message', onMessage);
    socket.once('error', onError);
  });
}

function rawPost(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function fixture(policy?: Parameters<typeof createSpace>[0]['policy']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hii-spaces-publication-'));
  roots.push(root);
  process.env.HII_RUNTIME_DIR = root;
  await createSpace({ id: '14th-street', ownerId: 'owner', name: '14th Street', policy });
  return root;
}

afterEach(async () => {
  delete process.env.HII_RUNTIME_DIR;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Space publication lifecycle', () => {
  it('uses exact Funnel routes and ownership checks', () => {
    expect(funnelStartArgs(443, 43123)).toEqual([
      'funnel', '--bg', '--yes', '--https=443', 'http://127.0.0.1:43123'
    ]);
    expect(funnelStopArgs(443)).toEqual(['funnel', '--https=443', 'off']);
    const status = { Web: { 'mac.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:43123' } } } } };
    expect(routeOwnedBy(status, 443, 43123)).toBe(true);
    expect(routeOwnedBy(status, 443, 9999)).toBe(false);
  });

  it('publishes and unpublishes without changing Space identity', async () => {
    await fixture({ read: 'public', write: 'local' });
    const calls: readonly string[][] = [];
    let exposed = false;
    let listenerStopped = false;
    const publisher = new SpacePublisher({
      binary: '/mock/tailscale',
      localPort: 43123,
      startPublicListener: async ({ allowedHostname }) => {
        expect(allowedHostname).toBe('mac.example.ts.net');
        return { port: 43123, stop: async () => { listenerStopped = true; } };
      },
      run: async (_binary, args) => {
        (calls as string[][]).push([...args]);
        if (args[0] === 'status') return ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.example.ts.net.' } }));
        if (args.includes('--bg')) { exposed = true; return ok(); }
        if (args.at(-1) === 'off') { exposed = false; return ok(); }
        return ok(JSON.stringify(exposed ? {
          Web: { 'mac.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:43123' } } } }
        } : {}));
      }
    });

    const published = await publisher.publish('14th-street');
    expect(published.endpoint).toBe('https://mac.example.ts.net/s/14th-street');
    expect(published.space.id).toBe('14th-street');
    expect((await readSpace('14th-street')).publication).toMatchObject({
      state: 'published', provider: 'tailscale-funnel', endpoint: published.endpoint
    });
    expect((await readSpace('14th-street')).hosting).toBe('published');

    const unpublished = await publisher.unpublish('14th-street');
    expect(unpublished.id).toBe('14th-street');
    expect(unpublished.hosting).toBe('local-only');
    expect(unpublished.publication).toMatchObject({ state: 'unpublished' });
    expect(unpublished.publication.endpoint).toBeUndefined();
    expect(listenerStopped).toBe(true);
    expect(calls).toContainEqual(['funnel', '--https=443', 'off']);
  });

  it('fails preflight without starting a listener or mutating an occupied route', async () => {
    await fixture();
    const calls: readonly string[][] = [];
    let listenerStarts = 0;
    const publisher = new SpacePublisher({
      localPort: 43123,
      startPublicListener: async () => { listenerStarts += 1; return { port: 43123, stop: async () => undefined }; },
      run: async (_binary, args) => {
        (calls as string[][]).push([...args]);
        if (args[0] === 'status') return ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.example.ts.net.' } }));
        return ok(JSON.stringify({ Web: { 'mac.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } }));
      }
    });
    await expect(publisher.publish('14th-street')).rejects.toMatchObject({ code: 'PUBLICATION_ROUTE_OCCUPIED' });
    expect(listenerStarts).toBe(0);
    expect(calls.some((args) => args.includes('--bg') || args.includes('off'))).toBe(false);
    expect((await readSpace('14th-street')).publication.state).toBe('failed');
  });

  it('rolls back only its owned route when durable transition fails', async () => {
    await fixture();
    let exposed = false;
    let listenerStopped = false;
    const publisher = new SpacePublisher({
      localPort: 43123,
      startPublicListener: async () => {
        return { port: 43123, stop: async () => { listenerStopped = true; } };
      },
      run: async (_binary, args) => {
        if (args[0] === 'status') return ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.example.ts.net.' } }));
        if (args.includes('--bg')) {
          exposed = true;
          const current = await readSpace('14th-street');
          await updateSpace('14th-street', { name: current.name });
          return ok();
        }
        if (args.at(-1) === 'off') { exposed = false; return ok(); }
        return ok(JSON.stringify(exposed ? { Web: { 'mac.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:43123' } } } } } : {}));
      }
    });
    await expect(publisher.publish('14th-street')).rejects.toThrow(/revision changed/);
    expect(exposed).toBe(false);
    expect(listenerStopped).toBe(true);
    expect((await readSpace('14th-street')).publication.state).toBe('failed');
  });

  it('refuses to unpublish a route the current process does not own', async () => {
    await fixture();
    const publisher = new SpacePublisher({
      localPort: 43123,
      startPublicListener: async () => { throw new Error('not used'); },
      run: async () => ok(JSON.stringify({ Web: { 'mac.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } }))
    });
    await expect(publisher.unpublish('14th-street')).rejects.toEqual(
      expect.objectContaining<Partial<SpacePublicationError>>({ code: 'PUBLICATION_ROUTE_NOT_OWNED' })
    );
  });

  it('recovers a durable exact route in a fresh process and can unpublish it', async () => {
    await fixture({ read: 'public', write: 'local' });
    await updateSpace('14th-street', {
      hosting: 'published',
      publication: { state: 'published', provider: 'tailscale-funnel', endpoint: 'https://mac.example.ts.net/s/14th-street' }
    });
    let exposed = true;
    let starts = 0;
    const publisher = new SpacePublisher({
      localPort: 43123,
      startPublicListener: async ({ port, spaceId }) => {
        starts += 1;
        expect({ port, spaceId }).toEqual({ port: 43123, spaceId: '14th-street' });
        return { port, stop: async () => undefined };
      },
      run: async (_binary, args) => {
        if (args[0] === 'status') return ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.example.ts.net.' } }));
        if (args.includes('--bg')) throw new Error('recovery must not replace the existing route');
        if (args.at(-1) === 'off') { exposed = false; return ok(); }
        return ok(JSON.stringify(exposed ? {
          Web: { 'mac.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:43123' } } } }
        } : {}));
      }
    });
    expect((await publisher.publish('14th-street')).space.publication.state).toBe('published');
    expect(starts).toBe(1);
    expect((await publisher.unpublish('14th-street')).publication.state).toBe('unpublished');
    expect(exposed).toBe(false);
  });

  it('publishes and unpublishes only through the loopback operator control route', async () => {
    const root = await fixture({ read: 'public', write: 'local' });
    const appRoot = path.join(root, 'app');
    await mkdir(appRoot, { recursive: true });
    await writeFile(path.join(appRoot, 'index.html'), '<!doctype html><title>Space</title>');
    let exposedPort: number | undefined;
    const host = await startSpacesHost({
      mode: 'local',
      port: 0,
      appRoot,
      publication: {
        binary: '/mock/tailscale',
        localPort: 43123,
        run: async (_binary, args) => {
          if (args[0] === 'status') return ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.example.ts.net.' } }));
          if (args.includes('--bg')) {
            exposedPort = Number(new URL(args.at(-1) as string).port);
            return ok();
          }
          if (args.at(-1) === 'off') { exposedPort = undefined; return ok(); }
          return ok(JSON.stringify(exposedPort ? {
            Web: { 'mac.example.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${exposedPort}` } } } }
          } : {}));
        }
      }
    });
    const operatorOrigin = host.operatorOrigins[0];
    const control = (action: string) => fetch(`${operatorOrigin}/api/host/spaces/14th-street/controls`, {
      method: 'POST',
      headers: { Origin: operatorOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    try {
      expect((await control('publish-space')).status).toBe(200);
      expect(exposedPort).toBeTypeOf('number');
      expect((await readSpace('14th-street')).publication.state).toBe('published');
      expect((await control('unpublish-space')).status).toBe(200);
      expect(exposedPort).toBeUndefined();
      expect((await readSpace('14th-street')).publication.state).toBe('unpublished');
    } finally {
      await host.stop();
    }
  });

  it('automatically rebinds a durable published Space when the actual host restarts', async () => {
    const root = await fixture({ read: 'public', write: 'local' });
    const appRoot = path.join(root, 'app');
    await mkdir(appRoot, { recursive: true });
    await writeFile(path.join(appRoot, 'index.html'), '<!doctype html><title>Space</title>');
    await updateSpace('14th-street', {
      hosting: 'published',
      publication: { state: 'published', provider: 'tailscale-funnel', endpoint: 'https://mac.example.ts.net/s/14th-street' }
    });
    let exposed = true;
    const host = await startSpacesHost({
      mode: 'local',
      port: 0,
      appRoot,
      publication: {
        localPort: 43124,
        run: async (_binary, args) => {
          if (args[0] === 'status') return ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.example.ts.net.' } }));
          if (args.includes('--bg')) throw new Error('restart must reattach, not replace');
          if (args.at(-1) === 'off') { exposed = false; return ok(); }
          return ok(JSON.stringify(exposed ? {
            Web: { 'mac.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:43124' } } } }
          } : {}));
        }
      }
    });
    try {
      await host.publicationReady;
      expect((await fetch('http://127.0.0.1:43124/api/spaces/14th-street')).status).toBe(200);
      expect((await readSpace('14th-street')).publication.state).toBe('published');
    } finally {
      await host.stop();
    }
    expect(exposed).toBe(false);
  });
});

describe('public Space-safe listener', () => {
  it('allows public reads, denies public writes/uploads, and has no operator routes', async () => {
    const root = await fixture({ read: 'public', write: 'local' });
    await updateSpace('14th-street', {
      hosting: 'published',
      publication: { state: 'published', provider: 'tailscale-funnel', endpoint: 'https://mac.example.ts.net/s/14th-street' }
    });
    await createSpace({ id: 'not-published', ownerId: 'owner', policy: { read: 'public', write: 'local' } });
    const appRoot = path.join(root, 'app');
    await mkdir(appRoot, { recursive: true });
    await writeFile(path.join(appRoot, 'index.html'), '<!doctype html><title>Space</title>');
    const host = await startSpacesHost({
      mode: 'local', port: 0, appRoot, audience: 'public', operator: false, publication: false,
      allowedHostnames: ['mac.example.ts.net']
      , publicSpaceId: '14th-street'
    });
    try {
      const origin = host.origins[0];
      const spaceResponse = await fetch(`${origin}/api/spaces/14th-street`);
      expect(spaceResponse.status, await spaceResponse.text()).toBe(200);
      expect((await fetch(`${origin}/s/14th-street`)).status).toBe(200);
      expect((await fetch(`${origin}/api/operator/spaces`)).status).toBe(404);
      expect((await fetch(`${origin}/api/spaces/not-published`)).status).toBe(404);
      const session = await rawPost(`${origin}/api/spaces/14th-street/guest-session`, {
        Host: 'mac.example.ts.net', Origin: 'https://mac.example.ts.net'
      });
      expect(session.status, session.body).toBe(201);
      const setCookie = Array.isArray(session.headers['set-cookie']) ? session.headers['set-cookie'][0] : '';
      expect(setCookie).toContain('; Secure');
      const cookie = setCookie.split(';', 1)[0];
      const upload = await rawPost(`${origin}/api/spaces/14th-street/blobs`, {
        Host: 'mac.example.ts.net', Origin: 'https://mac.example.ts.net', Cookie: cookie
      });
      expect(upload.status).toBe(403);

      const socket = new Ws(`${origin.replace('http:', 'ws:')}/api/spaces/14th-street/events`, {
        origin: 'https://mac.example.ts.net',
        headers: { Host: 'mac.example.ts.net', Cookie: cookie }
      });
      try {
        expect(await nextWsMessage(socket, 'space.snapshot')).toMatchObject({ type: 'space.snapshot' });
        const denied = nextWsMessage(socket, 'space.error');
        socket.send(JSON.stringify({
          type: 'object.create',
          requestId: 'public-create',
          idempotencyKey: 'public-create',
          node: {
            id: 'public-photo', spaceId: '14th-street', creatorId: 'guest:pending', type: 'image',
            x: 10, y: 20, w: 320, h: 240, z: 1, rotation: 0,
            createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
            permissions: { inheritance: 'space-policy' }, payload: { src: '/photo.jpg' }
          }
        }));
        expect(await denied).toMatchObject({
          type: 'space.error', requestId: 'public-create', code: 'POLICY_LOCAL_AUDIENCE_REQUIRED'
        });
      } finally {
        socket.close();
      }
    } finally {
      await host.stop();
    }
  });

  it('keeps PUBLIC_READ_ONLY readable while refusing every participant write', async () => {
    const root = await fixture({ read: 'public', write: 'none' });
    await updateSpace('14th-street', {
      hosting: 'published',
      publication: { state: 'published', provider: 'tailscale-funnel', endpoint: 'https://mac.example.ts.net/s/14th-street' }
    });
    const appRoot = path.join(root, 'app');
    await mkdir(appRoot, { recursive: true });
    await writeFile(path.join(appRoot, 'index.html'), '<!doctype html><title>Space</title>');
    const host = await startSpacesHost({
      mode: 'local', port: 0, appRoot, audience: 'public', operator: false, publication: false,
      allowedHostnames: ['mac.example.ts.net']
      , publicSpaceId: '14th-street'
    });
    try {
      const spaceResponse = await fetch(`${host.origins[0]}/api/spaces/14th-street`);
      expect(spaceResponse.status, await spaceResponse.text()).toBe(200);
      const session = await rawPost(`${host.origins[0]}/api/spaces/14th-street/guest-session`, {
        Host: 'mac.example.ts.net', Origin: 'https://mac.example.ts.net'
      });
      expect(session.status, session.body).toBe(201);
      const setCookie = Array.isArray(session.headers['set-cookie']) ? session.headers['set-cookie'][0] : '';
      const cookie = setCookie.split(';', 1)[0];
      const upload = await rawPost(`${host.origins[0]}/api/spaces/14th-street/blobs`, {
        Host: 'mac.example.ts.net', Origin: 'https://mac.example.ts.net', Cookie: cookie
      });
      expect(upload.status).toBe(403);
    } finally {
      await host.stop();
    }
  });
});
