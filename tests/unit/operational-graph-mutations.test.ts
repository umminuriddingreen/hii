// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutationActor } from '../../lib/operational-graph/types';
import type { WorkspaceDoc } from '../../lib/workspace/types';

let runtimeDir = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-graph-mutations-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  vi.resetModules();
});

afterEach(async () => {
  const store = await import('../../lib/server/operational-object-store');
  store.resetOperationalObjectStoreForTests();
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

const human: MutationActor = { actorId: 'human:ummi' };
const agent: MutationActor = { actorId: 'agent:hii-cli', runId: 'run-1', intentId: 'intent-1' };
const declaredProof: MutationActor = {
  ...agent,
  receiptId: 'receipt-1',
  proof: { completed: true, legacy: false, proofStrength: 'declared', reasons: [] }
};

async function graph() {
  return import('../../lib/server/operational-graph-mutations');
}

async function store() {
  return import('../../lib/server/operational-object-store');
}

async function seedObject(id = 'note-1', actor: MutationActor = human) {
  const { applyGraphMutation } = await graph();
  return applyGraphMutation({
    spaceId: 'default',
    type: 'CREATE_OBJECT',
    actor,
    payload: { id, type: 'note', properties: { title: 'First' } }
  });
}

function workspace(revision = 1): WorkspaceDoc {
  return {
    version: 1,
    revision,
    updatedAt: '2026-08-08T10:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 1 },
    nextZ: 2,
    nodes: [
      {
        id: 'idea-1',
        type: 'note',
        x: 10,
        y: 20,
        w: 240,
        h: 160,
        z: 1,
        createdAt: '2026-08-08T09:00:00.000Z',
        updatedAt: '2026-08-08T09:30:00.000Z',
        payload: { title: 'Shared objects' }
      }
    ],
    links: []
  };
}

describe('versioned operational graph mutations', () => {
  it('migrates an existing v1 database and reruns the migration idempotently', async () => {
    // A v1 database with rows already in it, created before versioning existed.
    const { DatabaseSync } = await import('node:sqlite');
    const { operationalObjectDbPath } = await store();
    const file = operationalObjectDbPath();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(file), { recursive: true });
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE operational_objects (
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL, type TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1, properties_json TEXT NOT NULL DEFAULT '{}',
        provenance_json TEXT NOT NULL DEFAULT '{}', owner_actor_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
      INSERT INTO operational_objects (id, space_id, type, created_at, updated_at)
        VALUES ('workspace:default:object:old-1', 'default', 'note', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const { readOperationalSpace, resetOperationalObjectStoreForTests } = await store();
    const first = readOperationalSpace('default');
    expect(first.objects).toHaveLength(1);
    // Additive defaults, so the pre-existing row keeps its id and gains versions.
    expect(first.objects[0]).toMatchObject({
      id: 'workspace:default:object:old-1',
      semanticVersion: 1,
      canonicalSource: 'workspace-json',
      provenanceClass: 'migration'
    });

    resetOperationalObjectStoreForTests();
    const second = readOperationalSpace('default');
    expect(second.objects).toHaveLength(1);
    expect(second.objects[0].id).toBe('workspace:default:object:old-1');
  });

  it('bumps only the semantic version for a semantic change', async () => {
    const { applyGraphMutation } = await graph();
    const created = await seedObject();
    expect(created.resultVersion).toBe(1);

    const { readOperationalSpace } = await store();
    await applyGraphMutation({
      spaceId: 'default',
      type: 'UPSERT_PROJECTION',
      actor: human,
      payload: { objectId: 'note-1', projection: 'workspace-spatial', state: { x: 0, y: 0 } }
    });
    const before = readOperationalSpace('default');
    const projectionVersion = before.projections[0].projectionVersion;

    const patched = applyGraphMutation({
      spaceId: 'default',
      type: 'PATCH_OBJECT',
      actor: human,
      baseVersion: 1,
      payload: { id: 'note-1', properties: { title: 'Second' } }
    });
    expect(patched.resultVersion).toBe(2);

    const after = readOperationalSpace('default');
    expect(after.objects[0].semanticVersion).toBe(2);
    expect(after.objects[0].properties).toMatchObject({ title: 'Second' });
    // A semantic edit must not look like the object was dragged.
    expect(after.projections[0].projectionVersion).toBe(projectionVersion);
  });

  it('bumps only the projection version for a move', async () => {
    const { applyGraphMutation } = await graph();
    await seedObject();
    applyGraphMutation({
      spaceId: 'default',
      type: 'UPSERT_PROJECTION',
      actor: human,
      payload: { objectId: 'note-1', state: { x: 0, y: 0 } }
    });
    const moved = applyGraphMutation({
      spaceId: 'default',
      type: 'PATCH_PROJECTION',
      actor: human,
      baseVersion: 1,
      payload: { objectId: 'note-1', state: { x: 500, y: 40 } }
    });
    expect(moved.resultVersion).toBe(2);

    const { readOperationalSpace } = await store();
    const snapshot = readOperationalSpace('default');
    expect(snapshot.projections[0].state).toMatchObject({ x: 500, y: 40 });
    // A move must not invalidate the semantic context a run was reviewed against.
    expect(snapshot.objects[0].semanticVersion).toBe(1);
  });

  it('refuses a stale update instead of applying it to state the caller never saw', async () => {
    const { applyGraphMutation } = await graph();
    await seedObject();
    applyGraphMutation({
      spaceId: 'default',
      type: 'PATCH_OBJECT',
      actor: human,
      baseVersion: 1,
      payload: { id: 'note-1', properties: { title: 'Second' } }
    });
    try {
      applyGraphMutation({
        spaceId: 'default',
        type: 'PATCH_OBJECT',
        actor: human,
        baseVersion: 1,
        payload: { id: 'note-1', properties: { title: 'Third' } }
      });
      throw new Error('expected a stale-version refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('stale-version');
      expect((error as Error).message).toContain('expected version 1, found 2');
    }
  });

  it('lets exactly one of two concurrent same-base updates win', async () => {
    const { applyGraphMutation } = await graph();
    await seedObject();
    const attempts = [{ title: 'A' }, { title: 'B' }].map((properties) => {
      try {
        applyGraphMutation({
          spaceId: 'default',
          type: 'PATCH_OBJECT',
          actor: human,
          baseVersion: 1,
          payload: { id: 'note-1', properties }
        });
        return 'applied';
      } catch (error) {
        return (error as { code?: string }).code;
      }
    });
    expect(attempts).toEqual(['applied', 'stale-version']);

    const { readOperationalSpace } = await store();
    expect(readOperationalSpace('default').objects[0].semanticVersion).toBe(2);
  });

  it('replays an idempotency key without applying the mutation twice', async () => {
    const { applyGraphMutation } = await graph();
    const request = {
      spaceId: 'default',
      type: 'CREATE_OBJECT' as const,
      actor: agent,
      idempotencyKey: 'run-1:create-note',
      payload: { id: 'note-1', type: 'note', properties: { title: 'First' } }
    };
    const first = applyGraphMutation(request);
    const second = applyGraphMutation(request);
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.operationId).toBe(first.operationId);

    const { readOperationalSpace } = await store();
    const snapshot = readOperationalSpace('default');
    expect(snapshot.objects).toHaveLength(1);
    expect(snapshot.operations.filter((entry) => entry.idempotencyKey === 'run-1:create-note')).toHaveLength(1);
  });

  it('refuses a reused idempotency key carrying different content', async () => {
    const { applyGraphMutation } = await graph();
    applyGraphMutation({
      spaceId: 'default',
      type: 'CREATE_OBJECT',
      actor: agent,
      idempotencyKey: 'run-1:create',
      payload: { id: 'note-1', type: 'note', properties: { title: 'First' } }
    });
    try {
      applyGraphMutation({
        spaceId: 'default',
        type: 'CREATE_OBJECT',
        actor: agent,
        idempotencyKey: 'run-1:create',
        payload: { id: 'note-2', type: 'note', properties: { title: 'Different' } }
      });
      throw new Error('expected an idempotency-conflict refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('idempotency-conflict');
    }
    const { readOperationalSpace } = await store();
    expect(readOperationalSpace('default').objects).toHaveLength(1);
  });

  it('rejects a relation whose endpoint does not exist or is tombstoned', async () => {
    const { applyGraphMutation } = await graph();
    await seedObject('note-1');
    try {
      applyGraphMutation({
        spaceId: 'default',
        type: 'CREATE_RELATION',
        actor: agent,
        payload: { id: 'rel-1', type: 'REFERENCES', fromObjectId: 'note-1', toObjectId: 'nope' }
      });
      throw new Error('expected a dangling-relation refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('dangling-relation');
    }

    await seedObject('note-2');
    applyGraphMutation({
      spaceId: 'default',
      type: 'TOMBSTONE_OBJECT',
      actor: human,
      baseVersion: 1,
      payload: { id: 'note-2' }
    });
    try {
      applyGraphMutation({
        spaceId: 'default',
        type: 'CREATE_RELATION',
        actor: agent,
        payload: { id: 'rel-2', type: 'REFERENCES', fromObjectId: 'note-1', toObjectId: 'note-2' }
      });
      throw new Error('expected a dangling-relation refusal');
    } catch (error) {
      expect((error as Error).message).toContain('is tombstoned');
    }
  });

  it('rejects a relation type outside the controlled vocabulary', async () => {
    const { applyGraphMutation } = await graph();
    await seedObject('note-1');
    await seedObject('note-2');
    try {
      applyGraphMutation({
        spaceId: 'default',
        type: 'CREATE_RELATION',
        actor: agent,
        payload: { id: 'rel-1', type: 'SUPPORTS', fromObjectId: 'note-1', toObjectId: 'note-2' }
      });
      throw new Error('expected an invalid-relation refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('invalid-relation');
    }
  });

  it('preserves history when a target is tombstoned', async () => {
    const { applyGraphMutation, readOperationHistory } = await graph();
    await seedObject();
    applyGraphMutation({
      spaceId: 'default',
      type: 'PATCH_OBJECT',
      actor: human,
      baseVersion: 1,
      payload: { id: 'note-1', properties: { title: 'Second' } }
    });
    applyGraphMutation({
      spaceId: 'default',
      type: 'TOMBSTONE_OBJECT',
      actor: human,
      baseVersion: 2,
      payload: { id: 'note-1' }
    });

    const history = readOperationHistory('default', 'note-1');
    expect(history.map((entry) => entry.type)).toEqual(['CREATE_OBJECT', 'PATCH_OBJECT', 'TOMBSTONE_OBJECT']);

    const { readOperationalSpace } = await store();
    const snapshot = readOperationalSpace('default');
    // The row survives with a tombstone. Deleting it would erase the operations
    // that explain how the object got there.
    expect(snapshot.objects).toHaveLength(1);
    expect(snapshot.objects[0].deletedAt).not.toBeNull();
    expect(snapshot.objects[0].semanticVersion).toBe(3);
  });

  it('refuses direct graph mutation of a Workspace-owned object', async () => {
    const { projectWorkspaceIntoOperationalGraph } = await store();
    projectWorkspaceIntoOperationalGraph('default', workspace());
    const { applyGraphMutation } = await graph();
    try {
      applyGraphMutation({
        spaceId: 'default',
        type: 'PATCH_OBJECT',
        actor: agent,
        baseVersion: 1,
        payload: { id: 'workspace:default:object:idea-1', properties: { title: 'Rewritten' } }
      });
      throw new Error('expected a canonical-owner-mismatch refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('canonical-owner-mismatch');
      expect((error as Error).message).toContain('Edit it through the Workspace');
    }
  });

  it('maps every authored workspace link to AUTHORED_LINK whatever its label says', async () => {
    const { projectWorkspaceIntoOperationalGraph, readOperationalSpace } = await store();
    const doc = workspace();
    doc.nodes.push({ ...doc.nodes[0], id: 'idea-2', x: 400 });
    doc.links = [{ id: 'link-1', fromId: 'idea-1', toId: 'idea-2', label: 'VERIFIED_BY' }];
    projectWorkspaceIntoOperationalGraph('default', doc);
    const snapshot = readOperationalSpace('default');
    expect(snapshot.relations[0].type).toBe('AUTHORED_LINK');
    expect(snapshot.relations[0].provenanceClass).toBe('authored');
    expect(snapshot.relations[0].properties.authoredLabel).toBe('VERIFIED_BY');
  });

  it('requires declared proof for a VERIFIED_BY relation', async () => {
    const { applyGraphMutation } = await graph();
    await seedObject('artifact-1');
    await seedObject('run-object-1');

    for (const proof of [
      null,
      { completed: true, legacy: false, proofStrength: 'incidental', reasons: [] },
      { completed: false, legacy: false, proofStrength: 'declared', reasons: ['missing artifact'] },
      { completed: true, legacy: true, proofStrength: 'legacy', reasons: [] }
    ]) {
      try {
        applyGraphMutation({
          spaceId: 'default',
          type: 'CREATE_RELATION',
          actor: { ...agent, proof },
          payload: {
            id: `verified-${String(proof?.proofStrength ?? 'none')}`,
            type: 'VERIFIED_BY',
            fromObjectId: 'artifact-1',
            toObjectId: 'run-object-1'
          }
        });
        throw new Error(`expected an authority-mismatch refusal for ${String(proof?.proofStrength)}`);
      } catch (error) {
        expect((error as { code?: string }).code, String(proof?.proofStrength)).toBe('authority-mismatch');
      }
    }

    const allowed = applyGraphMutation({
      spaceId: 'default',
      type: 'CREATE_RELATION',
      actor: declaredProof,
      payload: {
        id: 'verified-1',
        type: 'VERIFIED_BY',
        fromObjectId: 'artifact-1',
        toObjectId: 'run-object-1'
      }
    });
    expect(allowed.applied).toBe(true);
    expect(allowed.relation?.provenanceClass).toBe('verified');
    expect(allowed.relation?.provenance).toMatchObject({ runId: 'run-1', receiptId: 'receipt-1' });
  });

  it('keeps mutations across a restart', async () => {
    const { applyGraphMutation } = await graph();
    await seedObject();
    applyGraphMutation({
      spaceId: 'default',
      type: 'PATCH_OBJECT',
      actor: human,
      baseVersion: 1,
      payload: { id: 'note-1', properties: { title: 'Persisted' } }
    });

    const { resetOperationalObjectStoreForTests } = await store();
    resetOperationalObjectStoreForTests();
    vi.resetModules();

    const { readOperationalSpace } = await import('../../lib/server/operational-object-store');
    const snapshot = readOperationalSpace('default');
    expect(snapshot.objects[0]).toMatchObject({
      id: 'note-1',
      semanticVersion: 2,
      canonicalSource: 'graph',
      properties: { title: 'Persisted' }
    });
    expect(snapshot.operations.map((entry) => entry.type)).toEqual(['CREATE_OBJECT', 'PATCH_OBJECT']);
    expect(snapshot.operations[1].authority).toMatchObject({ actorId: 'human:ummi' });
  });

  it('records actor, authority, provenance, base and result versions on every operation', async () => {
    const { applyGraphMutation } = await graph();
    applyGraphMutation({
      spaceId: 'default',
      type: 'CREATE_OBJECT',
      actor: { ...declaredProof, authorityGrantId: 'grant-1', deviceId: 'mac-1' },
      payload: { id: 'note-1', type: 'note', provenanceClass: 'execution_generated' }
    });
    const { readOperationalSpace } = await store();
    const operation = readOperationalSpace('default').operations[0];
    expect(operation).toMatchObject({
      actorId: 'agent:hii-cli',
      deviceId: 'mac-1',
      authorityGrantId: 'grant-1',
      provenanceClass: 'execution_generated',
      baseVersion: null,
      resultVersion: 1
    });
    expect(operation.operationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(operation.authority).toMatchObject({
      intentId: 'intent-1',
      runId: 'run-1',
      receiptId: 'receipt-1',
      proof: { completed: true, proofStrength: 'declared' }
    });
  });

  it('leaves no operation record when a mutation is refused', async () => {
    const { applyGraphMutation } = await graph();
    await seedObject();
    expect(() =>
      applyGraphMutation({
        spaceId: 'default',
        type: 'PATCH_OBJECT',
        actor: human,
        baseVersion: 99,
        payload: { id: 'note-1', properties: { title: 'Nope' } }
      })
    ).toThrow();
    const { readOperationalSpace } = await store();
    // Validation, recording and mutation share one transaction: an operation
    // exists only if it applied.
    expect(readOperationalSpace('default').operations.map((entry) => entry.type)).toEqual(['CREATE_OBJECT']);
  });

  it('reconciles a replayed workspace revision without inventing versions', async () => {
    const { projectWorkspaceIntoOperationalGraph, readOperationalSpace } = await store();
    const doc = workspace();
    projectWorkspaceIntoOperationalGraph('default', doc);
    projectWorkspaceIntoOperationalGraph('default', doc);
    const replayed = readOperationalSpace('default');
    expect(replayed.objects[0].semanticVersion).toBe(1);
    expect(replayed.projections[0].projectionVersion).toBe(1);

    // A move in the JSON changes only the projection version.
    const moved = workspace(2);
    moved.nodes[0].x = 900;
    projectWorkspaceIntoOperationalGraph('default', moved);
    const afterMove = readOperationalSpace('default');
    expect(afterMove.objects[0].semanticVersion).toBe(1);
    expect(afterMove.projections[0].projectionVersion).toBe(2);

    // An edit in the JSON changes only the semantic version.
    const edited = workspace(3);
    edited.nodes[0].x = 900;
    edited.nodes[0].payload = { title: 'Renamed' };
    projectWorkspaceIntoOperationalGraph('default', edited);
    const afterEdit = readOperationalSpace('default');
    expect(afterEdit.objects[0].semanticVersion).toBe(2);
    expect(afterEdit.projections[0].projectionVersion).toBe(2);
  });

  it('refuses a missing target and an unknown operation type', async () => {
    const { applyGraphMutation } = await graph();
    try {
      applyGraphMutation({
        spaceId: 'default',
        type: 'PATCH_OBJECT',
        actor: human,
        baseVersion: 1,
        payload: { id: 'ghost' }
      });
      throw new Error('expected a missing-target refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('missing-target');
    }
    try {
      applyGraphMutation({
        spaceId: 'default',
        // Deliberately outside the union, as an untrusted caller would send.
        type: 'DROP_EVERYTHING' as never,
        actor: human,
        payload: {}
      });
      throw new Error('expected an invalid-operation refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('invalid-operation');
    }
  });
});
