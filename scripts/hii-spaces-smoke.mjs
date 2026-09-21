/**
 * Space record smoke test.
 *
 * The unit suite proves the store's behaviour with a fresh module registry
 * standing in for a restart. This proves the same thing the way the product
 * claims it: a separate Node process writes a Space, exits, and a second
 * process started from nothing reads the identical record off disk.
 *
 *   npm run hii:spaces:check
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { removeTestTree } from './lib/test-temp.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-spaces-smoke-'));

/** Run a snippet in a brand-new Node process against the temporary runtime. */
function inFreshProcess(source) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', source],
    { cwd: repo, env: { ...process.env, HII_RUNTIME_DIR: runtimeDir }, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`space smoke step failed:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

const store = pathToFileURL(path.join(repo, 'lib', 'server', 'space-store.ts')).href;

try {
  const created = inFreshProcess(`
    const { createSpace } = await import(${JSON.stringify(store)});
    const space = await createSpace({ id: '14th-street', ownerId: 'user:ummi', name: '14th Street' });
    console.log(JSON.stringify(space));
  `);

  assert.equal(created.id, '14th-street');
  assert.equal(created.name, '14th Street');
  assert.equal(created.ownerId, 'user:ummi');
  assert.equal(created.hosting, 'local-only');
  assert.equal(created.publication.state, 'unpublished');
  assert.equal(created.policy.read, 'local', 'a new space must not be publicly readable');
  assert.equal(created.policy.write, 'local', 'a new space must not be publicly writable');
  assert.equal(created.revision, 1);

  // The identity record must not have grown a copy of anything the workspace
  // document or the asset directory already owns.
  for (const forbidden of ['nodes', 'objects', 'links', 'assets', 'blobs', 'viewport']) {
    assert.equal(forbidden in created, false, `space record must not own "${forbidden}"`);
  }

  const afterRestart = inFreshProcess(`
    const { readSpace, listSpaces } = await import(${JSON.stringify(store)});
    console.log(JSON.stringify({ space: await readSpace('14th-street'), listed: await listSpaces() }));
  `);

  assert.deepEqual(afterRestart.space, created, 'space record changed across a process restart');
  assert.deepEqual(afterRestart.listed.map((entry) => entry.id), ['14th-street']);
  assert.equal(afterRestart.listed[0].status, 'ready');

  const published = inFreshProcess(`
    const { updateSpace } = await import(${JSON.stringify(store)});
    console.log(JSON.stringify(await updateSpace('14th-street', {
      hosting: 'published',
      policy: { read: 'public' },
      publication: { state: 'published', endpoint: 'https://example.ts.net/s/14th-street', provider: 'tailscale-funnel' }
    })));
  `);

  assert.equal(published.policy.read, 'public');
  assert.equal(published.policy.write, 'local', 'publishing must not grant write');
  assert.equal(published.revision, created.revision + 1);
  // Publishing changes where a space is reachable, never what it is.
  assert.equal(published.id, created.id);
  assert.equal(published.createdAt, created.createdAt);

  console.log('hii spaces smoke: space identity survives a process restart.');
} finally {
  await removeTestTree(runtimeDir);
}
