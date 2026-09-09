// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDoc } from '../../lib/workspace/types';

let runtimeDir = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-operational-objects-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  vi.resetModules();
});

afterEach(async () => {
  const store = await import('../../lib/server/operational-object-store');
  store.resetOperationalObjectStoreForTests();
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

function workspace(revision = 1): WorkspaceDoc {
  return {
    version: 1,
    revision,
    updatedAt: '2026-08-07T10:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 1 },
    nextZ: 3,
    nodes: [
      { id: 'idea-1', type: 'note', x: 10, y: 20, w: 240, h: 160, z: 1, createdAt: '2026-08-07T09:00:00.000Z', updatedAt: '2026-08-07T09:30:00.000Z', object: { kind: 'idea', owner: 'human' }, payload: { title: 'Shared objects' } },
      { id: 'decision-1', type: 'note', x: 400, y: 20, w: 240, h: 160, z: 2, createdAt: '2026-08-07T09:05:00.000Z', updatedAt: '2026-08-07T09:35:00.000Z', object: { kind: 'decision' }, payload: { title: 'Build graph first' } }
    ],
    links: [{ id: 'supports-1', fromId: 'idea-1', toId: 'decision-1', label: 'SUPPORTS' }]
  };
}

describe('universal operational object store', () => {
  it('projects semantic objects, typed relations, spatial state, provenance, and an operation', async () => {
    const { projectWorkspaceIntoOperationalGraph, readOperationalSpace } = await import('../../lib/server/operational-object-store');
    projectWorkspaceIntoOperationalGraph('default', workspace());
    const snapshot = readOperationalSpace('default');

    expect(snapshot.objects).toHaveLength(2);
    expect(snapshot.objects[0]).toMatchObject({ id: 'workspace:default:object:idea-1', type: 'idea', ownerActorId: 'human', deletedAt: null, properties: { legacyId: 'idea-1', payload: { title: 'Shared objects' } }, provenance: { system: 'hii-workspace-json', revision: 1 } });
    // A user-drawn arrow is authored, not verified provenance. Its label is kept
    // as data; it never becomes the relation type, or typing "VERIFIED_BY" on a
    // line would forge proof.
    expect(snapshot.relations).toEqual([
      expect.objectContaining({
        id: 'workspace:default:relation:supports-1',
        type: 'AUTHORED_LINK',
        provenanceClass: 'authored',
        canonicalSource: 'workspace-json',
        properties: expect.objectContaining({ authoredLabel: 'SUPPORTS' }),
        fromObjectId: 'workspace:default:object:idea-1',
        toObjectId: 'workspace:default:object:decision-1',
        deletedAt: null
      })
    ]);
    expect(snapshot.projections).toContainEqual(expect.objectContaining({
      objectId: 'workspace:default:object:idea-1',
      projection: 'workspace-spatial',
      state: {
        x: 10,
        y: 20,
        w: 240,
        h: 160,
        // Paint order, not depth. Depth is `position.z`, and it is 0 here.
        z: 1,
        rotation: 0,
        position: { x: 10, y: 20, z: 0 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
        size: { x: 240, y: 160, z: 0 }
      }
    }));
    expect(snapshot.operations).toEqual([expect.objectContaining({ type: 'PROJECT_WORKSPACE_REVISION', lamport: 1, payload: { revision: 1, objectCount: 2, relationCount: 1 } })]);
  });

  it('treats a move in depth as presentation, not meaning', async () => {
    const { projectWorkspaceIntoOperationalGraph, readOperationalSpace } = await import('../../lib/server/operational-object-store');
    projectWorkspaceIntoOperationalGraph('default', workspace());
    const before = readOperationalSpace('default');
    const objectId = 'workspace:default:object:idea-1';
    const semanticBefore = before.objects.find((object) => object.id === objectId)?.semanticVersion;
    const projectionBefore = before.projections.find((entry) => entry.objectId === objectId)?.projectionVersion;

    const moved = workspace(2);
    moved.updatedAt = '2026-08-07T11:00:00.000Z';
    moved.nodes[0] = {
      ...moved.nodes[0],
      transform: {
        position: { x: 10, y: 20, z: -180 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
        size: { x: 240, y: 160, z: 0 }
      }
    };
    projectWorkspaceIntoOperationalGraph('default', moved);

    const after = readOperationalSpace('default');
    const projection = after.projections.find((entry) => entry.objectId === objectId);

    expect(projection?.state).toMatchObject({ position: { x: 10, y: 20, z: -180 } });
    expect(projection?.projectionVersion).toBe((projectionBefore ?? 0) + 1);
    // The whole point of the three-domain split: pushing an object back in
    // space must not invalidate the semantic context an approved run was
    // reviewed against.
    expect(after.objects.find((object) => object.id === objectId)?.semanticVersion).toBe(semanticBefore);
  });

  it('is replay-safe and tombstones removed legacy objects and relations', async () => {
    const { projectWorkspaceIntoOperationalGraph, readOperationalSpace } = await import('../../lib/server/operational-object-store');
    const first = workspace();
    projectWorkspaceIntoOperationalGraph('default', first);
    projectWorkspaceIntoOperationalGraph('default', first);
    const second = workspace(2);
    second.nodes = second.nodes.slice(0, 1);
    second.links = [];
    second.updatedAt = '2026-08-07T11:00:00.000Z';
    projectWorkspaceIntoOperationalGraph('default', second);

    const snapshot = readOperationalSpace('default');
    expect(snapshot.operations).toHaveLength(2);
    expect(snapshot.objects.find((object) => object.id.endsWith('decision-1'))?.deletedAt).toBe(second.updatedAt);
    expect(snapshot.relations[0].deletedAt).toBe(second.updatedAt);
  });

  it('dual-writes normal workspace saves while retaining the legacy JSON contract', async () => {
    const { loadWorkspace, writeWorkspace } = await import('../../lib/server/workspace-store');
    const { readOperationalSpace } = await import('../../lib/server/operational-object-store');
    const initial = await loadWorkspace();
    const doc = workspace(0);
    const saved = await writeWorkspace(doc, initial.workspace.revision);
    expect(saved.revision).toBe(1);
    expect(readOperationalSpace('default')).toMatchObject({ objects: [{ id: 'workspace:default:object:idea-1' }, { id: 'workspace:default:object:decision-1' }], relations: [{ type: 'AUTHORED_LINK' }] });
    expect((await loadWorkspace()).workspace.nodes).toHaveLength(2);
  });

  it('backfills a legacy workspace without changing its revision or contents', async () => {
    const { loadWorkspace, writeWorkspace, backfillWorkspaceOperationalGraph } = await import('../../lib/server/workspace-store');
    const { readOperationalSpace } = await import('../../lib/server/operational-object-store');
    const initial = await loadWorkspace();
    const saved = await writeWorkspace(workspace(0), initial.workspace.revision);
    const before = JSON.stringify((await loadWorkspace()).workspace);

    const migration = await backfillWorkspaceOperationalGraph('default');

    expect(migration).toEqual({ workspaceId: 'default', revision: 1, objectCount: 2, relationCount: 1 });
    expect(readOperationalSpace('default').objects).toHaveLength(2);
    expect(JSON.stringify((await loadWorkspace()).workspace)).toBe(before);
    expect(saved.revision).toBe(1);
  });
});
