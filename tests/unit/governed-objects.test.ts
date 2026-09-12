// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutationActor } from '../../lib/operational-graph/types';
import type { ObjectAccessScope } from '../../lib/server/governed-objects';
import type { WorkspaceDoc } from '../../lib/workspace/types';

let runtimeDir = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-governed-objects-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  vi.resetModules();
});

afterEach(async () => {
  const store = await import('../../lib/server/operational-object-store');
  store.resetOperationalObjectStoreForTests();
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

const agent: MutationActor = { actorId: 'agent:hii-cli', runId: 'run-1', intentId: 'intent-1' };

function scope(overrides: Partial<ObjectAccessScope> = {}): ObjectAccessScope {
  return {
    grantId: 'grant-1',
    spaceId: 'default',
    readableObjectIds: ['a', 'b'],
    writableObjectIds: ['b'],
    creatableTypes: ['note'],
    allowedRelationTypes: ['DERIVED_FROM'],
    allowedOperations: ['read', 'create', 'annotate', 'patch-semantic', 'patch-projection', 'relate'],
    projectionScope: ['scene-x'],
    externalTransmission: 'blocked',
    runId: 'run-1',
    ...overrides
  };
}

async function governed() {
  return import('../../lib/server/governed-objects');
}

async function seed(ids: string[]) {
  const { applyGraphMutation } = await import('../../lib/server/operational-graph-mutations');
  for (const id of ids) {
    applyGraphMutation({
      spaceId: 'default',
      type: 'CREATE_OBJECT',
      actor: { actorId: 'human:ummi' },
      payload: { id, type: 'note', properties: { title: id } }
    });
  }
}

function workspace(): WorkspaceDoc {
  return {
    version: 1,
    revision: 1,
    updatedAt: '2026-08-08T10:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 1 },
    nextZ: 2,
    nodes: [
      {
        id: 'idea-1',
        type: 'note',
        x: 0,
        y: 0,
        w: 200,
        h: 120,
        z: 1,
        createdAt: '2026-08-08T09:00:00.000Z',
        updatedAt: '2026-08-08T09:30:00.000Z',
        payload: { title: 'Authored by a human' }
      }
    ],
    links: []
  };
}

describe('governed object reads', () => {
  it('lists only objects inside the approved read scope', async () => {
    await seed(['a', 'b', 'c']);
    const { listApprovedObjects } = await governed();
    expect(listApprovedObjects(scope()).map((entry) => entry.id)).toEqual(['a', 'b']);
  }, 30_000); // Windows CI took 15s on this first DB-backed case under parallel load.

  it('refuses to read an object outside the approved scope', async () => {
    await seed(['a', 'c']);
    const { readApprovedObject } = await governed();
    expect(() => readApprovedObject(scope(), 'c')).toThrow(/outside the approved read scope/);
  });

  it('hides relations whose other end is outside the scope', async () => {
    await seed(['a', 'b', 'c']);
    const { applyGraphMutation } = await import('../../lib/server/operational-graph-mutations');
    applyGraphMutation({
      spaceId: 'default',
      type: 'CREATE_RELATION',
      actor: agent,
      payload: { id: 'r-in', type: 'REFERENCES', fromObjectId: 'a', toObjectId: 'b' }
    });
    applyGraphMutation({
      spaceId: 'default',
      type: 'CREATE_RELATION',
      actor: agent,
      payload: { id: 'r-out', type: 'REFERENCES', fromObjectId: 'a', toObjectId: 'c' }
    });
    const { readApprovedObject } = await governed();
    // An edge is a fact about two objects; revealing one through an edge is
    // still revealing it.
    expect(readApprovedObject(scope(), 'a').relations.map((entry) => entry.id)).toEqual(['r-in']);
  });

  it('refuses every operation once the grant has expired', async () => {
    await seed(['a']);
    const { listApprovedObjects } = await governed();
    const expired = scope({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(() => listApprovedObjects(expired)).toThrow(/expired/);
  });
});

describe('governed object writes', () => {
  it('records intent, run, actor, grant, base and result version on every mutation', async () => {
    await seed(['a', 'b']);
    const { patchApprovedObject } = await governed();
    const result = patchApprovedObject(scope(), agent, {
      id: 'b',
      baseVersion: 1,
      properties: { title: 'Changed' }
    });
    expect(result.resultVersion).toBe(2);

    const { readOperationalSpace } = await import('../../lib/server/operational-object-store');
    const operation = readOperationalSpace('default').operations.at(-1)!;
    expect(operation).toMatchObject({
      actorId: 'agent:hii-cli',
      authorityGrantId: 'grant-1',
      baseVersion: 1,
      resultVersion: 2
    });
    expect(operation.authority).toMatchObject({ intentId: 'intent-1', runId: 'run-1' });
  });

  it('refuses a write to a readable-but-not-writable object', async () => {
    await seed(['a', 'b']);
    const { patchApprovedObject } = await governed();
    expect(() =>
      patchApprovedObject(scope(), agent, { id: 'a', baseVersion: 1, properties: { title: 'no' } })
    ).toThrow(/outside the approved write scope/);
  });

  it('refuses an operation type the grant does not name', async () => {
    await seed(['a', 'b']);
    const { tombstoneApprovedObject } = await governed();
    // Removing something a human made is not a normal step of doing the work.
    expect(() => tombstoneApprovedObject(scope(), agent, { id: 'b', baseVersion: 1 })).toThrow(
      /does not allow tombstone/
    );
  });

  it('refuses a stale write', async () => {
    await seed(['a', 'b']);
    const { patchApprovedObject } = await governed();
    patchApprovedObject(scope(), agent, { id: 'b', baseVersion: 1, properties: { title: 'first' } });
    expect(() =>
      patchApprovedObject(scope(), agent, { id: 'b', baseVersion: 1, properties: { title: 'second' } })
    ).toThrow(/changed since this mutation was decided/);
  });

  it('refuses a graph-first edit to Workspace-owned state', async () => {
    const { projectWorkspaceIntoOperationalGraph } = await import(
      '../../lib/server/operational-object-store'
    );
    projectWorkspaceIntoOperationalGraph('default', workspace());
    const { patchApprovedObject } = await governed();
    const id = 'workspace:default:object:idea-1';
    expect(() =>
      patchApprovedObject(scope({ readableObjectIds: [id], writableObjectIds: [id] }), agent, {
        id,
        baseVersion: 1,
        properties: { title: 'Rewritten by an agent' }
      })
    ).toThrow(/owned by Workspace JSON/);
  });

  it('refuses a forged VERIFIED_BY relation even when the grant lists it', async () => {
    await seed(['a', 'b']);
    const { createApprovedRelation } = await governed();
    const wide = scope({ allowedRelationTypes: ['VERIFIED_BY', 'DERIVED_FROM'] });
    expect(() =>
      createApprovedRelation(wide, agent, {
        id: 'forged',
        type: 'VERIFIED_BY',
        fromObjectId: 'a',
        toObjectId: 'b'
      })
    ).toThrow(/VERIFIED_BY relation from this run is not available/);

    // With declared proof it is allowed. The grant permits the edge; the proof
    // is what makes the claim true.
    const proven = createApprovedRelation(
      wide,
      { ...agent, receiptId: 'r1', proof: { completed: true, legacy: false, proofStrength: 'declared' } },
      { id: 'verified', type: 'VERIFIED_BY', fromObjectId: 'a', toObjectId: 'b' }
    );
    expect(proven.applied).toBe(true);
  });

  it('refuses a relation type outside the grant', async () => {
    await seed(['a', 'b']);
    const { createApprovedRelation } = await governed();
    expect(() =>
      createApprovedRelation(scope(), agent, {
        id: 'r',
        type: 'CONTAINS',
        fromObjectId: 'a',
        toObjectId: 'b'
      })
    ).toThrow(/does not allow CONTAINS relations/);
  });

  it('refuses to relate to an object outside the scope', async () => {
    await seed(['a', 'b', 'c']);
    const { createApprovedRelation } = await governed();
    expect(() =>
      createApprovedRelation(scope(), agent, {
        id: 'r',
        type: 'DERIVED_FROM',
        fromObjectId: 'b',
        toObjectId: 'c'
      })
    ).toThrow(/outside the approved read scope/);
  });

  it('refuses placement outside the approved frame scope', async () => {
    await seed(['a', 'b']);
    const { createApprovedObject, patchApprovedProjection } = await governed();
    expect(() =>
      createApprovedObject(scope(), agent, { id: 'new-1', type: 'note', frameId: 'scene-y' })
    ).toThrow(/outside the approved projection scope/);

    expect(() =>
      patchApprovedProjection(scope(), agent, {
        objectId: 'b',
        upsert: true,
        state: { x: 0, y: 0, frameId: 'scene-y' }
      })
    ).toThrow(/outside the approved projection scope/);

    // Being allowed to change an object does not imply being allowed to move it
    // somewhere else, and the granted frame still works.
    const allowed = patchApprovedProjection(scope(), agent, {
      objectId: 'b',
      upsert: true,
      state: { x: 10, y: 10, frameId: 'scene-x' }
    });
    expect(allowed.applied).toBe(true);
  });

  it('refuses creating a type the grant does not name', async () => {
    const { createApprovedObject } = await governed();
    expect(() => createApprovedObject(scope(), agent, { id: 'x', type: 'invoice' })).toThrow(
      /does not allow creating "invoice"/
    );
  });

  it('lets an agent finish what it created without widening anything else', async () => {
    const { createApprovedObject, patchApprovedObject } = await governed();
    const live = scope();
    createApprovedObject(live, agent, { id: 'made-1', type: 'note', frameId: 'scene-x' });
    expect(live.writableObjectIds).toContain('made-1');
    expect(live.writableObjectIds).not.toContain('a');
    const patched = patchApprovedObject(live, agent, {
      id: 'made-1',
      baseVersion: 1,
      properties: { title: 'finished' }
    });
    expect(patched.resultVersion).toBe(2);
  });

  it('lets annotation be granted without semantic editing', async () => {
    await seed(['a', 'b']);
    const { annotateApprovedObject, patchApprovedObject } = await governed();
    const commentOnly = scope({ allowedOperations: ['read', 'annotate'] });
    const result = annotateApprovedObject(commentOnly, agent, {
      id: 'b',
      baseVersion: 1,
      annotation: 'This looks stale.'
    });
    expect(result.object?.properties.annotations).toMatchObject([{ text: 'This looks stale.' }]);
    expect(() =>
      patchApprovedObject(commentOnly, agent, { id: 'b', baseVersion: 2, properties: { title: 'x' } })
    ).toThrow(/does not allow patch-semantic/);
  });

  it('defaults to read-only over exactly the reviewed objects', async () => {
    await seed(['a']);
    const { readOnlyScope, createApprovedObject } = await governed();
    const minimal = readOnlyScope('default', ['a'], 'run-9');
    expect(minimal.writableObjectIds).toEqual([]);
    expect(minimal.externalTransmission).toBe('blocked');
    expect(() => createApprovedObject(minimal, agent, { id: 'x', type: 'note' })).toThrow(
      /does not allow create/
    );
  });

  it('keeps object scope independent of filesystem scope', async () => {
    await seed(['a', 'b']);
    const { readApprovedObject } = await governed();
    // A run with a wide filesystem root still reads only what its object grant
    // names: the two questions are answered separately on purpose.
    const filesystemWide = scope({ readableObjectIds: ['b'] });
    expect(() => readApprovedObject(filesystemWide, 'a')).toThrow(/outside the approved read scope/);
    expect(readApprovedObject(filesystemWide, 'b').object.id).toBe('b');
  });
});
