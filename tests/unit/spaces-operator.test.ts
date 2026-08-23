// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSpace } from '../../lib/server/space-store.ts';
import { startSpacesHost, type RunningSpacesHost } from '../../lib/spaces/host/server.ts';

let runtimeDir: string;
let appRoot: string;
const hosts: RunningSpacesHost[] = [];

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-spaces-operator-'));
  appRoot = await mkdtemp(path.join(os.tmpdir(), 'hii-spaces-operator-app-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  await mkdir(path.join(appRoot, '_next', 'static', 'chunks'), { recursive: true });
  await writeFile(path.join(appRoot, 'index.html'), '<!doctype html><title>HII Operator</title>');
  await writeFile(path.join(appRoot, '_next', 'static', 'chunks', 'operator.js'), 'globalThis.HII_OPERATOR=true;');
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
  await rm(appRoot, { recursive: true, force: true });
});

async function host(options: Parameters<typeof startSpacesHost>[0] = {}) {
  const running = await startSpacesHost({ port: 0, operatorPort: 0, appRoot, ...options });
  hosts.push(running);
  return running;
}

async function post(running: RunningSpacesHost, pathname: string, body: unknown, origin = running.operatorOrigins[0]) {
  return fetch(`${running.operatorOrigins[0]}${pathname}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function rawPost(url: string, headers: Record<string, string>, body: string) {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end(body);
  });
}

describe('loopback-only Spaces operator', () => {
  it('creates a canonical Space and returns a visitor-host access URL', async () => {
    const running = await host();
    expect(running.operatorOrigins[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(running.operatorOrigins[0]).not.toBe(running.origins[0]);
    const response = await post(running, '/api/host/spaces', { name: '14th Street' });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      space: { id: '14th-street', name: '14th Street', ownerId: 'user:local-host' },
      accessUrl: `${running.origins[0]}/s/14th-street`
    });
    expect((await fetch(`${running.operatorOrigins[0]}/api/host/spaces/14th-street/share`).then((value) => value.json()))).toMatchObject({
      space: { id: '14th-street' }, accessUrl: `${running.origins[0]}/s/14th-street`
    });
    expect((await fetch(`${running.operatorOrigins[0]}/api/host/spaces/14th-street`).then((value) => value.json()))).toMatchObject({
      space: { id: '14th-street' }, accessUrl: `${running.origins[0]}/s/14th-street`
    });
  });

  it('serves operator shells and never exposes host APIs on the visitor listener', async () => {
    const running = await host();
    for (const pathname of ['/spaces', '/new', '/host/s/valid']) {
      const response = await fetch(`${running.operatorOrigins[0]}${pathname}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('HII Operator');
    }
    expect(await fetch(`${running.operatorOrigins[0]}/_next/static/chunks/operator.js`).then((response) => response.text())).toContain('HII_OPERATOR');
    expect((await fetch(`${running.origins[0]}/api/host/spaces`)).status).toBe(404);
    expect((await fetch(`${running.origins[0]}/new`)).status).toBe(404);
  });

  it('applies bounded live controls and issues an invite only through the operator', async () => {
    const running = await host();
    await post(running, '/api/host/spaces', { name: 'Controlled' });
    const freeze = await post(running, '/api/host/spaces/controlled/controls', { action: 'set-writes-frozen', value: true });
    expect(await freeze.json()).toMatchObject({ ok: true, space: { policy: { writesFrozen: true } } });
    const limits = await post(running, '/api/host/spaces/controlled/controls', { action: 'set-upload-limits', maxUploadBytes: 4096, maxObjects: 12 });
    expect(await limits.json()).toMatchObject({ ok: true, space: { policy: { maxUploadBytes: 4096, maxObjects: 12 } } });
    const invite = await post(running, '/api/host/spaces/controlled/controls', { action: 'create-invite' });
    expect(await invite.json()).toMatchObject({ ok: true, invite: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect((await readSpace('controlled')).policy.writesFrozen).toBe(true);
  });

  it('enforces loopback Host, exact Origin, JSON type, body cap, and closed action schema', async () => {
    const running = await host();
    expect((await post(running, '/api/host/spaces', { name: 'CSRF' }, 'http://evil.invalid')).status).toBe(403);
    expect((await fetch(`${running.operatorOrigins[0]}/api/host/spaces`, { method: 'POST', headers: { Origin: running.operatorOrigins[0] }, body: '{}' })).status).toBe(415);
    expect((await post(running, '/api/host/spaces', { name: 'x'.repeat(17_000) })).status).toBe(413);
    expect(await rawPost(`${running.operatorOrigins[0]}/api/host/spaces`, {
      Host: 'attacker.invalid', Origin: running.operatorOrigins[0], 'Content-Type': 'application/json', 'Content-Length': '12'
    }, '{"name":"x"}')).toBe(421);
    await post(running, '/api/host/spaces', { name: 'Closed' });
    expect((await post(running, '/api/host/spaces/closed/controls', { action: 'clear', extra: true })).status).toBe(400);
  });

  it('lists durable Spaces after both listeners restart', async () => {
    const first = await host();
    await post(first, '/api/host/spaces', { name: 'Durable Operator' });
    await first.stop();
    hosts.splice(hosts.indexOf(first), 1);
    const restarted = await host();
    const listed = await fetch(`${restarted.operatorOrigins[0]}/api/host/spaces`).then((response) => response.json());
    expect(listed).toMatchObject({ spaces: [{ id: 'durable-operator', ownerId: 'user:local-host' }] });
  });
});
