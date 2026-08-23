import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSpace } from '../../lib/server/space-store.ts';
import {
  isAllowedSpacesPeer,
  resolveSpacesHostBinding,
  SpacesLanUnavailableError
} from '../../lib/spaces/host/network.ts';
import {
  SPACES_HOST_LIMITS,
  startSpacesHost,
  type RunningSpacesHost
} from '../../lib/spaces/host/server.ts';

let runtimeDir: string;
let appRoot: string;
const hosts: RunningSpacesHost[] = [];

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-spaces-host-runtime-'));
  appRoot = await mkdtemp(path.join(os.tmpdir(), 'hii-spaces-host-app-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  await mkdir(path.join(appRoot, '_next', 'static', 'chunks'), { recursive: true });
  await writeFile(path.join(appRoot, 'index.html'), '<!doctype html><title>HII Space</title>');
  await writeFile(path.join(appRoot, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(appRoot, '_next', 'static', 'chunks', 'app.js'), 'globalThis.HII=true;');
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
  await rm(appRoot, { recursive: true, force: true });
});

async function host(options: Parameters<typeof startSpacesHost>[0] = {}) {
  const running = await startSpacesHost({ port: 0, appRoot, ...options });
  hosts.push(running);
  return running;
}

function rawRequest(url: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(url, { method: 'GET', headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      );
    });
    request.once('error', reject);
    request.end(body);
  });
}

describe('Spaces host network boundary', () => {
  it('binds only to loopback by default', () => {
    expect(resolveSpacesHostBinding()).toEqual({
      mode: 'local',
      bindAddress: '127.0.0.1',
      advertisedAddresses: ['127.0.0.1']
    });
  });

  it('binds all interfaces only after explicit LAN selection and advertises a usable address', () => {
    const binding = resolveSpacesHostBinding('lan', {
      lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: '127.0.0.1/8' }],
      en1: [{ address: '192.168.4.30', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: '192.168.4.30/24' }],
      en0: [{ address: '10.0.0.12', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: '10.0.0.12/24' }],
      utun3: [{ address: '100.64.0.4', netmask: '255.192.0.0', family: 'IPv4', mac: '', internal: false, cidr: '100.64.0.4/10' }],
      bridge0: [{ address: '8.8.8.8', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: '8.8.8.8/24' }]
    });
    expect(binding.bindAddress).toBe('10.0.0.12');
    expect(binding.advertisedAddresses).toEqual(['10.0.0.12']);
    expect(binding.lanCidr).toBe('10.0.0.12/24');
  });

  it('uses bounded HTTP parser, timeout, keepalive, and socket reuse settings', () => {
    expect(SPACES_HOST_LIMITS).toEqual({
      maxHeaderSize: 16 * 1024,
      headersTimeout: 5_000,
      requestTimeout: 10_000,
      keepAliveTimeout: 2_000,
      maxRequestsPerSocket: 100
    });
  });

  it('classifies the actual socket peer instead of trusting forwarding headers', () => {
    const local = resolveSpacesHostBinding('local');
    const lan = resolveSpacesHostBinding('lan', {
      en0: [{ address: '192.168.4.30', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: '192.168.4.30/24' }]
    });
    expect(isAllowedSpacesPeer('127.0.0.1', local)).toBe(true);
    expect(isAllowedSpacesPeer('::1', local)).toBe(true);
    expect(isAllowedSpacesPeer('192.168.4.20', local)).toBe(false);
    expect(isAllowedSpacesPeer('192.168.4.20', lan)).toBe(true);
    expect(isAllowedSpacesPeer('::ffff:192.168.4.8', lan)).toBe(true);
    expect(isAllowedSpacesPeer('192.168.5.20', lan)).toBe(false);
    expect(isAllowedSpacesPeer('100.64.0.8', lan)).toBe(false);
    expect(isAllowedSpacesPeer(undefined, lan)).toBe(false);
  });

  it('accepts peers in a physical CGNAT Wi-Fi CIDR while excluding utun and adjacent routes', () => {
    const binding = resolveSpacesHostBinding('lan', {
      en0: [{ address: '100.100.86.2', netmask: '255.255.255.128', family: 'IPv4', mac: '', internal: false, cidr: '100.100.86.2/25' }],
      utun4: [{ address: '100.125.20.9', netmask: '255.192.0.0', family: 'IPv4', mac: '', internal: false, cidr: '100.125.20.9/10' }]
    });
    expect(binding.bindAddress).toBe('100.100.86.2');
    expect(binding.lanCidr).toBe('100.100.86.2/25');
    expect(isAllowedSpacesPeer('100.100.86.20', binding)).toBe(true);
    expect(isAllowedSpacesPeer('100.100.87.20', binding)).toBe(false);
    expect(isAllowedSpacesPeer('100.125.20.10', binding)).toBe(false);
  });

  it('does not claim LAN reachability when no usable interface exists', () => {
    expect(() =>
      resolveSpacesHostBinding('lan', {
        lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: '127.0.0.1/8' }]
      })
    ).toThrow(SpacesLanUnavailableError);
  });
});

describe('Spaces-only HTTP routes', () => {
  it('loads a canonical Space and its app shell with safe response headers', async () => {
    const created = await createSpace({ id: '14th-street', ownerId: 'user:ummi', name: '14th Street' });
    const running = await host();
    const api = await fetch(`${running.origins[0]}/api/spaces/14th-street`);
    expect(api.status).toBe(200);
    expect(await api.json()).toMatchObject({
      id: created.id,
      name: created.name,
      policy: { read: 'local', write: 'local' },
      revision: created.revision
    });
    expect(api.headers.get('access-control-allow-origin')).toBeNull();
    expect(api.headers.get('x-content-type-options')).toBe('nosniff');

    const shell = await fetch(`${running.origins[0]}/s/14th-street`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('HII Space');
    expect(shell.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

    const asset = await fetch(`${running.origins[0]}/_next/static/chunks/app.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('globalThis.HII');
  });

  it('distinguishes invalid and nonexistent Space ids without filesystem details', async () => {
    const running = await host();
    const invalid = await fetch(`${running.origins[0]}/api/spaces/UPPERCASE`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: { code: 'INVALID_SPACE_ID', message: 'The Space id is invalid.' }
    });

    const missing = await fetch(`${running.origins[0]}/api/spaces/not-here`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: 'SPACE_NOT_FOUND', message: 'Space not found.' }
    });
  });

  it('never exposes traversal, privileged APIs, terminal routes, or arbitrary files', async () => {
    const running = await host();
    const origin = running.origins[0];
    for (const requestPath of [
      '/api/workspace',
      '/api/agent/start',
      '/terminal',
      '/etc/passwd',
      '/s/valid?admin=true',
      '/_next/static/%2e%2e/%2e%2e/etc/passwd'
    ]) {
      const response = await fetch(`${origin}${requestPath}`);
      expect(response.status, requestPath).toBe(404);
      expect(JSON.stringify(await response.json())).not.toContain(runtimeDir);
    }
  });

  it('rejects writes and ignores untrusted Host headers when forming share URLs', async () => {
    await createSpace({ id: 'safe-space', ownerId: 'user:ummi' });
    const running = await host();
    const write = await fetch(`${running.origins[0]}/api/spaces/safe-space`, { method: 'POST' });
    expect(write.status).toBe(405);

    const rebound = await rawRequest(`${running.origins[0]}/api/spaces/safe-space`, {
      Host: 'attacker.invalid',
      'X-Forwarded-Host': '127.0.0.1'
    });
    expect(rebound.status).toBe(421);
    expect(rebound.body).toContain('MISDIRECTED_REQUEST');
    expect(running.spaceUrls('safe-space')).toEqual([
      `http://127.0.0.1:${running.port}/s/safe-space`
    ]);
  });

  it('rejects request bodies without draining or retaining the connection', async () => {
    await createSpace({ id: 'no-body', ownerId: 'user:ummi' });
    const running = await host();
    const response = await rawRequest(
      `${running.origins[0]}/api/spaces/no-body`,
      { 'Content-Length': '4' },
      'body'
    );
    expect(response.status).toBe(400);
    expect(response.body).toContain('REQUEST_BODY_NOT_ALLOWED');
  });

  it('returns only visitor-safe Space fields and escapes HTML-significant names on the wire', async () => {
    await createSpace({
      id: 'visitor-safe',
      ownerId: 'user:private-owner',
      name: '<img src=x onerror=alert(1)>'
    });
    const running = await host();
    const response = await fetch(`${running.origins[0]}/api/spaces/visitor-safe`);
    const wire = await response.text();
    expect(wire).not.toContain('<img');
    const body = JSON.parse(wire);
    expect(body.name).toBe('<img src=x onerror=alert(1)>');
    expect(body).not.toHaveProperty('ownerId');
    expect(body).not.toHaveProperty('publication');
    expect(body.policy).not.toHaveProperty('storageQuotaBytes');
  });

  it('can stop and restart on the same port without in-memory authority', async () => {
    await createSpace({ id: 'durable-space', ownerId: 'user:ummi' });
    const first = await host();
    const port = first.port;
    await first.stop();
    hosts.splice(hosts.indexOf(first), 1);

    const restarted = await startSpacesHost({ port, appRoot });
    hosts.push(restarted);
    const response = await fetch(`${restarted.origins[0]}/api/spaces/durable-space`);
    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe('durable-space');
  });
});
// @vitest-environment node
