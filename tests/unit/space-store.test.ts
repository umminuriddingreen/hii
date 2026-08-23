// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_ID_PATTERN, defaultSpacePolicy, slugifySpaceName } from '../../lib/spaces/types';

let runtimeDir = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-space-store-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

function store() {
  return import('../../lib/server/space-store');
}

function spaceFile(id: string) {
  return path.join(runtimeDir, 'spaces', `${id}.json`);
}

describe('space identity', () => {
  it('uses the same id rule as the workspace store, because a space id names its canvas file', async () => {
    // The two patterns are declared in different modules on purpose: space-store
    // must not pull in SQLite just to validate an id. This asserts they agree
    // rather than trusting the comment that says they do.
    const workspaceStore = await readFile(
      path.join(import.meta.dirname, '../../lib/server/workspace-store.ts'),
      'utf8'
    );
    const declared = workspaceStore.match(/const workspaceIdPattern = (\/.*\/);/);
    expect(declared?.[1]).toBe(SPACE_ID_PATTERN.toString());
  });

  it('rejects every id that could escape the spaces directory', async () => {
    const { validateSpaceId } = await store();
    const hostile = [
      '..',
      '../etc/passwd',
      'a/../../b',
      'a/b',
      'a\\b',
      '.hidden',
      'Upper',
      'trailing-',
      '-leading',
      '',
      'a'.repeat(65),
      'sp ace'
    ];
    for (const value of hostile) {
      expect(() => validateSpaceId(value), value).toThrow(TypeError);
    }
  });

  it('accepts the ids the create flow actually produces', async () => {
    const { validateSpaceId } = await store();
    for (const id of ['a', '14th-street', 'default', 'a_b-c9', 'a'.repeat(64)]) {
      expect(validateSpaceId(id)).toBe(id);
    }
  });

  it('slugifies a human name into a candidate id without inventing one', () => {
    expect(slugifySpaceName('14th Street')).toBe('14th-street');
    expect(SPACE_ID_PATTERN.test(slugifySpaceName('14th Street'))).toBe(true);
    // A name with no usable characters yields an empty string so the caller
    // supplies the fallback id. This function never makes one up.
    expect(slugifySpaceName('...')).toBe('');
  });
});

describe('space lifecycle', () => {
  it('creates a space with a permanent id, an owner, and the most restrictive policy', async () => {
    const { createSpace } = await store();
    const space = await createSpace({ id: '14th-street', ownerId: 'user:ummi', name: '14th Street' });
    expect(space).toMatchObject({
      schemaVersion: 1,
      id: '14th-street',
      name: '14th Street',
      ownerId: 'user:ummi',
      hosting: 'local-only',
      publication: { state: 'unpublished' },
      revision: 1
    });
    expect(space.policy).toEqual(defaultSpacePolicy());
    expect(space.policy.admission).toBe('open');
    expect(space.policy.read).toBe('local');
    expect(space.policy.write).toBe('local');
  });

  it('holds no canvas objects and no blobs', async () => {
    const { createSpace } = await store();
    const space = await createSpace({ id: 's1', ownerId: 'user:ummi' });
    // Ownership rule: contents belong to the workspace document and the asset
    // directory. A field named for either here would be a duplicate authority.
    for (const forbidden of ['nodes', 'objects', 'links', 'assets', 'blobs', 'viewport']) {
      expect(space).not.toHaveProperty(forbidden);
    }
  });

  it('survives a process restart unchanged', async () => {
    const { createSpace } = await store();
    const created = await createSpace({ id: 'persisted', ownerId: 'user:ummi', name: 'Persisted' });

    // A fresh module registry is the closest in-process stand-in for a restart:
    // no cached handles, no memoized state, only the bytes on disk.
    vi.resetModules();
    const { readSpace } = await store();
    expect(await readSpace('persisted')).toEqual(created);
  });

  it('refuses to create a space twice', async () => {
    const { createSpace, SpaceExistsError } = await store();
    await createSpace({ id: 'taken', ownerId: 'user:ummi' });
    await expect(createSpace({ id: 'taken', ownerId: 'user:someone-else' })).rejects.toBeInstanceOf(
      SpaceExistsError
    );
  });

  it('requires an owner', async () => {
    const { createSpace } = await store();
    await expect(createSpace({ id: 'ownerless', ownerId: '' })).rejects.toThrow(TypeError);
  });

  it('raises SpaceNotFoundError for an unknown id rather than an ENOENT', async () => {
    const { readSpace, SpaceNotFoundError } = await store();
    const error = await readSpace('absent').catch((thrown) => thrown);
    expect(error).toBeInstanceOf(SpaceNotFoundError);
    expect((error as { code: string }).code).toBe('SPACE_NOT_FOUND');
    // A 404 body built from this must not leak where HII keeps its runtime.
    expect(String(error)).not.toContain(runtimeDir);
  });

  it('validates before touching the filesystem on every path', async () => {
    const { readSpace, spaceExists, deleteSpaceRecord, updateSpace } = await store();
    const calls = [
      () => readSpace('../escape'),
      () => spaceExists('../escape'),
      () => deleteSpaceRecord('../escape'),
      () => updateSpace('../escape', { name: 'x' })
    ];
    for (const call of calls) {
      await expect(call()).rejects.toThrow(TypeError);
    }
  });
});

describe('space updates', () => {
  it('bumps the revision and refuses a caller holding a stale one', async () => {
    const { createSpace, updateSpace, SpaceRevisionConflictError } = await store();
    const created = await createSpace({ id: 's1', ownerId: 'user:ummi' });
    const updated = await updateSpace('s1', { name: 'Renamed' }, created.revision);
    expect(updated.revision).toBe(created.revision + 1);
    expect(updated.name).toBe('Renamed');

    await expect(updateSpace('s1', { name: 'Again' }, created.revision)).rejects.toBeInstanceOf(
      SpaceRevisionConflictError
    );
  });

  it('applies a partial policy change without dropping the rest of the policy', async () => {
    const { createSpace, updateSpace } = await store();
    await createSpace({ id: 's1', ownerId: 'user:ummi' });
    const updated = await updateSpace('s1', { policy: { read: 'public' } });
    expect(updated.policy.read).toBe('public');
    expect(updated.policy.write).toBe('local');
    expect(updated.policy.maxUploadBytes).toBe(defaultSpacePolicy().maxUploadBytes);
  });

  it('stores invite admission and a read-only write audience canonically', async () => {
    const { createSpace, updateSpace } = await store();
    const created = await createSpace({
      id: 'invite-only',
      ownerId: 'user:ummi',
      policy: { admission: 'invite', read: 'public', write: 'public' }
    });
    expect(created.policy).toMatchObject({ admission: 'invite', read: 'public', write: 'public' });

    const readOnly = await updateSpace('invite-only', {
      policy: { admission: 'open', write: 'none' }
    });
    expect(readOnly.policy).toMatchObject({ admission: 'open', read: 'public', write: 'none' });
  });

  it('records a publication endpoint without letting it into the id', async () => {
    const { createSpace, updateSpace } = await store();
    const created = await createSpace({ id: 's1', ownerId: 'user:ummi' });
    const published = await updateSpace('s1', {
      hosting: 'published',
      publication: {
        state: 'published',
        endpoint: 'https://host.example.ts.net/s/s1',
        provider: 'tailscale-funnel'
      }
    });
    expect(published.hosting).toBe('published');
    expect(published.publication).toMatchObject({
      state: 'published',
      endpoint: 'https://host.example.ts.net/s/s1',
      provider: 'tailscale-funnel'
    });
    // Identity is untouched by where the space is currently hosted.
    expect(published.id).toBe(created.id);
    expect(published.createdAt).toBe(created.createdAt);
  });

  it('cannot change identity or provenance', async () => {
    const { createSpace, updateSpace, readSpace } = await store();
    const created = await createSpace({ id: 's1', ownerId: 'user:ummi' });
    await updateSpace(
      's1',
      { id: 'other', ownerId: 'user:attacker', createdAt: '1999-01-01T00:00:00.000Z' } as never
    );
    const after = await readSpace('s1');
    expect(after.id).toBe('s1');
    expect(after.ownerId).toBe(created.ownerId);
    expect(after.createdAt).toBe(created.createdAt);
  });

  it('serializes concurrent updates so no write is lost', async () => {
    const { createSpace, readSpace, updateSpace } = await store();
    await createSpace({ id: 's1', ownerId: 'user:ummi' });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => updateSpace('s1', { name: `name-${index}` }))
    );
    // Eight serialized read-modify-writes on top of revision 1.
    expect((await readSpace('s1')).revision).toBe(9);
  });

  it('deletes only the identity record, never the canvas or the blobs', async () => {
    const { createSpace, deleteSpaceRecord, spaceExists } = await store();
    const canvas = path.join(runtimeDir, 'workspace', 'workspaces');
    await mkdir(canvas, { recursive: true });
    await writeFile(path.join(canvas, 's1.json'), '{"version":1}');

    await createSpace({ id: 's1', ownerId: 'user:ummi' });
    await deleteSpaceRecord('s1');

    expect(await spaceExists('s1')).toBe(false);
    await expect(readFile(path.join(canvas, 's1.json'), 'utf8')).resolves.toContain('version');
  });
});

describe('corrupt records', () => {
  it('preserves an unparseable record instead of overwriting it', async () => {
    const { readSpace, SpaceLoadError } = await store();
    await mkdir(path.join(runtimeDir, 'spaces'), { recursive: true });
    await writeFile(spaceFile('broken'), '{ not json');

    const error = await readSpace('broken').catch((thrown) => thrown);
    expect(error).toBeInstanceOf(SpaceLoadError);
    const recoveryPath = (error as { recoveryPath?: string }).recoveryPath as string;
    expect(await readFile(recoveryPath, 'utf8')).toBe('{ not json');
    // The original is still there. A space record that fails to parse is the
    // only remaining evidence of who owned it and what its policy was.
    expect(await readFile(spaceFile('broken'), 'utf8')).toBe('{ not json');
  });

  it('reports a corrupt space as existing, so its id cannot be claimed', async () => {
    const { spaceExists, createSpace, SpaceExistsError } = await store();
    await mkdir(path.join(runtimeDir, 'spaces'), { recursive: true });
    await writeFile(spaceFile('broken'), '{ not json');

    expect(await spaceExists('broken')).toBe(true);
    await expect(createSpace({ id: 'broken', ownerId: 'user:ummi' })).rejects.toBeInstanceOf(
      SpaceExistsError
    );
  });

  it('rejects a record whose id does not match its filename', async () => {
    const { readSpace, SpaceLoadError } = await store();
    await mkdir(path.join(runtimeDir, 'spaces'), { recursive: true });
    await writeFile(spaceFile('claimed'), JSON.stringify({ id: 'other', ownerId: 'user:ummi' }));
    await expect(readSpace('claimed')).rejects.toBeInstanceOf(SpaceLoadError);
  });

  it('loads a record written by an older build, defaulting only what is missing', async () => {
    const { readSpace } = await store();
    await mkdir(path.join(runtimeDir, 'spaces'), { recursive: true });
    await writeFile(
      spaceFile('old'),
      JSON.stringify({ id: 'old', ownerId: 'user:ummi', name: 'Old', unknownField: 'ignored' })
    );
    const space = await readSpace('old');
    expect(space.policy).toEqual(defaultSpacePolicy());
    expect(space.policy.admission).toBe('open');
    expect(space.publication.state).toBe('unpublished');
    expect(space).not.toHaveProperty('unknownField');
  });
});

describe('listing', () => {
  it('returns an empty list before any space exists', async () => {
    const { listSpaces } = await store();
    expect(await listSpaces()).toEqual([]);
  });

  it('lists spaces by id and does not let a corrupt one hide the healthy ones', async () => {
    const { createSpace, listSpaces } = await store();
    await createSpace({ id: 'b-space', ownerId: 'user:ummi', name: 'B' });
    await createSpace({ id: 'a-space', ownerId: 'user:ummi', name: 'A' });
    await writeFile(spaceFile('c-space'), '{ not json');

    const listed = await listSpaces();
    expect(listed.map((entry) => entry.id)).toEqual(['a-space', 'b-space', 'c-space']);
    expect(listed.map((entry) => entry.status)).toEqual(['ready', 'ready', 'recovery']);
  });

  it('ignores recovery copies so a corrupt space is listed once', async () => {
    const { readSpace, listSpaces } = await store();
    await mkdir(path.join(runtimeDir, 'spaces'), { recursive: true });
    await writeFile(spaceFile('broken'), '{ not json');
    await readSpace('broken').catch(() => {});

    const names = await readdir(path.join(runtimeDir, 'spaces'));
    expect(names.length).toBe(2); // the record plus its preserved copy
    expect((await listSpaces()).map((entry) => entry.id)).toEqual(['broken']);
  });
});

describe('url safety', () => {
  it('produces ids that need no escaping in /s/:space_id', async () => {
    const { createSpace, listSpaces } = await store();
    await createSpace({ id: '14th-street', ownerId: 'user:ummi', name: '14th Street' });
    for (const { id } of await listSpaces()) {
      expect(encodeURIComponent(id)).toBe(id);
      expect(new URL(`https://humaninformationinterface.com/s/${id}`).pathname).toBe(`/s/${id}`);
    }
  });
});
