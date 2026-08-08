// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let runtimeDir = '';
let grantsFile = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-grants-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  grantsFile = path.join(runtimeDir, 'grants', 'object-grants.jsonl');
  vi.resetModules();
});

afterEach(async () => {
  const store = await import('../../lib/server/operational-object-store');
  store.resetOperationalObjectStoreForTests();
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

const request = {
  subject: 'agent:hii-cli',
  spaceId: 'default',
  approvedBy: 'ummi',
  readableObjectIds: ['a', 'b', 'c'],
  writableObjectIds: [],
  creatableTypes: ['note'],
  allowedRelationTypes: ['DERIVED_FROM'],
  allowedOperations: ['read', 'create', 'annotate', 'relate'],
  projectionScope: ['scene-x'],
  externalTransmission: 'blocked',
  runId: 'run-1',
  intentId: 'intent-1',
  territory: { x: 100, y: 100, w: 600, h: 400 },
  note: 'Draft three variants of the launch note.'
};

async function grants() {
  return import('../../lib/server/object-grants');
}

describe('object grants', () => {
  it('records what a grant permits, who approved it, and when it ends', async () => {
    const { approveObjectGrant, readObjectGrants } = await grants();
    const grant = await approveObjectGrant(request);
    expect(grant).toMatchObject({
      subject: 'agent:hii-cli',
      approvedBy: 'ummi',
      runId: 'run-1',
      intentId: 'intent-1',
      status: 'active',
      revision: 1
    });
    const ledger = await readObjectGrants(grantsFile);
    expect(ledger.grants).toHaveLength(1);
    expect(ledger.events[0].kind).toBe('grant.approved');
  });

  it('refuses a grant with no approver, no subject, or no end', async () => {
    const { approveObjectGrant } = await grants();
    await expect(approveObjectGrant({ ...request, approvedBy: '' })).rejects.toThrow(/human who approved/);
    await expect(approveObjectGrant({ ...request, subject: '' })).rejects.toThrow(/needs a subject/);
    // A grant that never ends is a permission, which is what this replaces.
    await expect(
      approveObjectGrant({ ...request, runId: '', expiresAt: '' })
    ).rejects.toThrow(/must end/);
  });

  it('refuses an unknown relation type or operation at approval time', async () => {
    const { approveObjectGrant } = await grants();
    await expect(
      approveObjectGrant({ ...request, allowedRelationTypes: ['SUPPORTS'] })
    ).rejects.toThrow(/not a known relation type/);
    await expect(
      approveObjectGrant({ ...request, allowedOperations: ['delete-everything'] })
    ).rejects.toThrow(/not a known object operation/);
  });

  it('enforces exactly what the grant says, below the UI', async () => {
    const { approveObjectGrant, grantToScope } = await grants();
    const { applyGraphMutation } = await import('../../lib/server/operational-graph-mutations');
    for (const id of ['a', 'b', 'c', 'd']) {
      applyGraphMutation({
        spaceId: 'default',
        type: 'CREATE_OBJECT',
        actor: { actorId: 'human:ummi' },
        payload: { id, type: 'note' }
      });
    }
    const grant = await approveObjectGrant(request);
    const scope = grantToScope(grant);
    const { listApprovedObjects, patchApprovedObject, readApprovedObject } = await import(
      '../../lib/server/governed-objects'
    );
    expect(listApprovedObjects(scope).map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(() => readApprovedObject(scope, 'd')).toThrow(/outside the approved read scope/);
    // The grant lists no writable objects and no patch operation.
    expect(() =>
      patchApprovedObject(scope, { actorId: 'agent:hii-cli' }, { id: 'a', baseVersion: 1 })
    ).toThrow(/does not allow patch-semantic/);
  });

  it('does not widen authority when the territory is moved', async () => {
    const { approveObjectGrant, moveObjectGrantTerritory, grantToScope } = await grants();
    const grant = await approveObjectGrant(request);
    const before = grantToScope(grant);
    const moved = await moveObjectGrantTerritory(grant.id, { x: -5000, y: -5000, w: 99999, h: 99999 });
    const after = grantToScope(moved);
    expect(moved.territory).toEqual({ x: -5000, y: -5000, w: 99999, h: 99999 });
    // Geometry is presentation. Every scope field is untouched.
    expect(after.readableObjectIds).toEqual(before.readableObjectIds);
    expect(after.writableObjectIds).toEqual(before.writableObjectIds);
    expect(after.allowedOperations).toEqual(before.allowedOperations);
    expect(after.projectionScope).toEqual(before.projectionScope);
    expect(after.externalTransmission).toBe('blocked');
  });

  it('needs a fresh approval to widen, and records it as a new revision', async () => {
    const { approveObjectGrant, reviseObjectGrant, readObjectGrants } = await grants();
    const grant = await approveObjectGrant(request);
    await expect(
      reviseObjectGrant(grant.id, { ...request, approvedBy: '', writableObjectIds: ['a'] })
    ).rejects.toThrow(/human who approved/);

    const revised = await reviseObjectGrant(grant.id, {
      ...request,
      approvedBy: 'ummi',
      writableObjectIds: ['a'],
      allowedOperations: [...request.allowedOperations, 'patch-semantic']
    });
    expect(revised.revision).toBe(2);
    const ledger = await readObjectGrants(grantsFile);
    // The earlier record is still there: what was approved when a run executed
    // stays readable afterwards.
    expect(ledger.events.map((event) => event.kind)).toEqual(['grant.approved', 'grant.revised']);
    expect(ledger.grants).toHaveLength(1);
    expect(ledger.grants[0].writableObjectIds).toEqual(['a']);
  });

  it('refuses a revoked or expired grant', async () => {
    const { approveObjectGrant, revokeObjectGrant, grantToScope, scopeForGrant } = await grants();
    const grant = await approveObjectGrant(request);
    await revokeObjectGrant(grant.id, 'ummi');
    await expect(scopeForGrant(grant.id, grantsFile)).rejects.toThrow(/revoked/);

    const expiring = await approveObjectGrant({
      ...request,
      runId: '',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    expect(() => grantToScope(expiring, Date.now() + 120_000)).toThrow(/expired/);
  });

  it('offers a run only grants that are active and bound to it or unbound', async () => {
    const { approveObjectGrant, grantsForRun } = await grants();
    await approveObjectGrant({ ...request, runId: 'run-1' });
    await approveObjectGrant({ ...request, runId: 'run-2' });
    await approveObjectGrant({
      ...request,
      runId: '',
      expiresAt: new Date(Date.now() + 600_000).toISOString()
    });
    const usable = await grantsForRun('run-1', grantsFile);
    expect(usable.map((grant) => grant.runId).sort()).toEqual([null, 'run-1']);
  });

  it('preserves and reports a malformed authority record instead of erasing it', async () => {
    await mkdir(path.dirname(grantsFile), { recursive: true });
    await writeFile(grantsFile, '{"broken\nnot json at all\n');
    const { approveObjectGrant, readObjectGrants } = await grants();
    await approveObjectGrant(request);
    const ledger = await readObjectGrants(grantsFile);
    expect(ledger.grants).toHaveLength(1);
    expect(ledger.corruption).toHaveLength(2);
    expect(ledger.corruption[0].raw).toContain('{"broken');
    // The damaged lines are still on disk, byte for byte.
    const raw = await readFile(grantsFile, 'utf8');
    expect(raw.startsWith('{"broken\nnot json at all\n')).toBe(true);
  });

  it('describes a grant as limits a person can check', async () => {
    const { approveObjectGrant, describeObjectGrant } = await grants();
    const description = describeObjectGrant(await approveObjectGrant(request));
    expect(description.may).toEqual(
      expect.arrayContaining(['read 3 objects', 'create note inside scene-x', 'annotate', 'create DERIVED_FROM'])
    );
    expect(description.mayNot).toEqual(
      expect.arrayContaining(['edit source objects', 'delete objects', 'send anything externally'])
    );
    expect(description.ends).toBe('when run run-1 finishes');
    expect(description.approvedBy).toBe('ummi');
  });
});
