import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { handleSpacesRequest } from '../src/index.ts';
import productionWorker from '../src/production.ts';
import { createFixtureResolver, safePublicProjection } from '../src/resolver.ts';
import { routeSpacesRequest } from '../src/router.ts';
import type { PublicSpaceProjection } from '../src/types.ts';

test('route table owns only the three Spaces surfaces', () => {
  assert.deepEqual(routeSpacesRequest('GET', '/spaces'), { kind: 'spaces-index' });
  assert.deepEqual(routeSpacesRequest('HEAD', '/new'), { kind: 'new-space' });
  assert.deepEqual(routeSpacesRequest('GET', '/new/'), { kind: 'new-space' });
  assert.deepEqual(routeSpacesRequest('GET', '/spaces/'), { kind: 'spaces-index' });
  assert.deepEqual(routeSpacesRequest('GET', '/spaces/unknown'), { kind: 'owned-not-found' });
  assert.deepEqual(routeSpacesRequest('GET', '/s/14th-street'), { kind: 'space', spaceId: '14th-street' });
  assert.deepEqual(routeSpacesRequest('GET', '/s/Uppercase'), { kind: 'invalid-space', candidate: 'Uppercase' });
  assert.deepEqual(routeSpacesRequest('POST', '/s/14th-street'), { kind: 'method-not-allowed', allow: 'GET, HEAD' });
  for (const path of ['/', '/spaceship', '/api/spaces/14th-street', '/workspace', '/terminal']) {
    assert.deepEqual(routeSpacesRequest('GET', path), { kind: 'fallback' });
  }
});

test('production ownership matrix preserves the existing site and strictly owns Spaces paths', () => {
  const cases = [
    ['/', { kind: 'fallback' }],
    ['/about', { kind: 'fallback' }],
    ['/existing-valid-path', { kind: 'fallback' }],
    ['/spaces', { kind: 'spaces-index' }],
    ['/spaces/', { kind: 'spaces-index' }],
    ['/spaces/example', { kind: 'owned-not-found' }],
    ['/new', { kind: 'new-space' }],
    ['/new/', { kind: 'new-space' }],
    ['/s/abc123', { kind: 'space', spaceId: 'abc123' }],
    ['/s/abc123/anything-needed', { kind: 'invalid-space', candidate: 'abc123/anything-needed' }],
    ['/random-existing-path', { kind: 'fallback' }]
  ] as const;

  for (const [path, expected] of cases) {
    assert.deepEqual(routeSpacesRequest('GET', path), expected, path);
  }
});

test('public pages and stable preview Space resolve without a write surface', async () => {
  for (const path of ['/spaces', '/new', '/s/14th-street']) {
    const response = await handleSpacesRequest(new Request(`https://preview.example${path}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-hii-route-owner'), 'spaces-public');
    const body = await response.text();
    assert.match(body, /HII|14th Street/);
    assert.doesNotMatch(body, /terminal|operator|upload endpoint|agent authority/i);
  }
  const source = await (await handleSpacesRequest(new Request('https://preview.example/s/14th-street'))).text();
  assert.match(source, /Public read \/ local write/);
  assert.doesNotMatch(source, /ownerId|provider|guest_|publication/);
  assert.match(source, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.doesNotMatch(source, /href="\/favicon\.ico"/);
  assert.match(source, /@media\(max-width:640px\)[\s\S]*overflow-x:hidden/);
  assert.match(source, /\.object\{position:relative;left:auto!important;top:auto!important/);
  assert.match(source, /\.object:not\(\.sticker\)\{width:100%!important/);
});

test('invalid, missing, mutation, and fallback behavior is strict', async () => {
  const invalid = await handleSpacesRequest(new Request('https://preview.example/s/Uppercase'));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: { code: 'INVALID_SPACE_ID', message: 'The Space id is invalid.' } });
  const missing = await handleSpacesRequest(new Request('https://preview.example/s/missing'));
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: { code: 'SPACE_NOT_FOUND', message: 'Space not found.' } });
  const write = await handleSpacesRequest(new Request('https://preview.example/s/14th-street', { method: 'POST' }));
  assert.equal(write.status, 405);
  assert.equal(write.headers.get('allow'), 'GET, HEAD');
  const ownedMissing = await handleSpacesRequest(new Request('https://preview.example/spaces/unknown'));
  assert.equal(ownedMissing.status, 404);
  assert.equal(ownedMissing.headers.get('x-hii-route-owner'), 'spaces-public');
  const fallback = await handleSpacesRequest(new Request('https://preview.example/workspace'));
  assert.equal(fallback.status, 404);
  assert.equal(fallback.headers.get('x-hii-route-owner'), 'none');
  assert.equal(fallback.headers.get('x-hii-fallback'), 'route-scoped-upstream');
});

test('HEAD preserves status and headers without a body', async () => {
  const response = await handleSpacesRequest(new Request('https://preview.example/spaces', { method: 'HEAD' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await response.text(), '');
});

test('preview favicon probe returns an empty secured response', async () => {
  for (const method of ['GET', 'HEAD']) {
    const response = await handleSpacesRequest(new Request('https://preview.example/favicon.ico', { method }));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('x-hii-route-owner'), 'spaces-public-preview');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await response.text(), '');
  }
});

test('resolver projection rejects private and malformed provider data', async () => {
  assert.equal(safePublicProjection({ schemaVersion: 1, id: '../private', name: 'Private' }), null);
  assert.equal(safePublicProjection({
    schemaVersion: 1,
    id: 'private-shape',
    name: 'Private shape',
    ownerId: 'owner',
    policy: { read: 'local', write: 'local' },
    objects: [],
    updatedAt: 'now'
  }), null);
  assert.throws(() => createFixtureResolver([{ id: 'unsafe' }]), /unsafe public Space projection/);

  const base = {
    schemaVersion: 1 as const,
    id: 'bounded',
    name: 'Bounded',
    policy: { read: 'public' as const, write: 'none' as const },
    updatedAt: '2026-08-20T00:00:00.000Z'
  };
  const object = (id: string, content: Record<string, string | number[]>) => ({
    id,
    type: 'text',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    content,
    updatedAt: base.updatedAt
  });
  assert.equal(safePublicProjection({
    ...base,
    objects: [object('large-array', { points: Array.from({ length: 1_025 }, (_, index) => index) })]
  }), null);
  assert.equal(safePublicProjection({
    ...base,
    objects: [object('large-content', Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field${index}`, 'x'.repeat(1_000)])))]
  }), null);
  assert.equal(safePublicProjection({
    ...base,
    objects: Array.from({ length: 200 }, (_, index) => object(`large-${index}`, { text: 'x'.repeat(4_000) }))
  }), null);
});

test('query tokens never reach the resolver or logs', async () => {
  let resolverCalls = 0;
  const response = await handleSpacesRequest(
    new Request('https://preview.example/s/14th-street?token=secret-value'),
    { async resolve() { resolverCalls += 1; return null; } }
  );
  assert.equal(response.status, 404);
  assert.equal(resolverCalls, 0);
  assert.doesNotMatch(await response.text(), /secret-value|token=/);
});

test('resolver failures emit only a controlled generic log', async () => {
  const original = console.error;
  const logs: string[] = [];
  console.error = (...values: unknown[]) => { logs.push(values.join(' ')); };
  try {
    const response = await handleSpacesRequest(
      new Request('https://preview.example/s/14th-street'),
      { async resolve() { throw new Error('token=secret-value /private/operator/path'); } }
    );
    assert.equal(response.status, 503);
  } finally {
    console.error = original;
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /SPACE_RESOLUTION_UNAVAILABLE/);
  assert.doesNotMatch(logs[0], /secret-value|private\/operator/);
});

test('handler rejects malformed and cross-ID resolver projections without leakage', async () => {
  const projection = (id: string, width = 100): PublicSpaceProjection => ({
    schemaVersion: 1,
    id,
    name: 'Resolver secret name',
    policy: { read: 'public', write: 'none' },
    objects: [{
      id: 'object',
      type: 'text',
      x: 0,
      y: 0,
      width,
      height: 100,
      rotation: 0,
      content: { text: 'private resolver payload' },
      updatedAt: '2026-08-20T00:00:00.000Z'
    }],
    updatedAt: '2026-08-20T00:00:00.000Z'
  });
  for (const value of [projection('different-space'), projection('requested-space', Number.NaN)]) {
    const response = await handleSpacesRequest(
      new Request('https://preview.example/s/requested-space'),
      { async resolve() { return value; } }
    );
    assert.equal(response.status, 404);
    const body = await response.text();
    assert.match(body, /SPACE_NOT_FOUND/);
    assert.doesNotMatch(body, /Resolver secret|private resolver|different-space/);
  }
});

test('default module handler uses only the preview resolver', async () => {
  const response = await worker.fetch(new Request('https://preview.example/s/14th-street'));
  assert.equal(response.status, 200);
});

test('production entry never resolves the preview fixture', async () => {
  const index = await productionWorker.fetch(new Request('https://humaninformationinterface.com/spaces'));
  assert.equal(index.status, 200);
  const indexBody = await index.text();
  for (const previewMarker of ['14th-street', '14th Street', 'Open preview']) {
    assert.doesNotMatch(indexBody, new RegExp(previewMarker));
  }
  const create = await productionWorker.fetch(new Request('https://humaninformationinterface.com/new'));
  assert.equal(create.status, 200);
  const fixture = await productionWorker.fetch(new Request('https://humaninformationinterface.com/s/14th-street'));
  assert.equal(fixture.status, 404);
  assert.deepEqual(await fixture.json(), { error: { code: 'SPACE_NOT_FOUND', message: 'Space not found.' } });
});
