import { describe, expect, it } from 'vitest';
import { rebaseWorkspaceDoc } from '../../lib/workspace/rebase';
import type { WorkspaceDoc, WorkspaceNode } from '../../lib/workspace/types';

const node = (id: string, updatedAt: string, extra: Partial<WorkspaceNode> = {}): WorkspaceNode => ({
  id,
  type: 'note',
  x: 0,
  y: 0,
  w: 200,
  h: 150,
  z: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt,
  payload: {},
  ...extra
} as WorkspaceNode);

const doc = (revision: number, nodes: WorkspaceNode[], overrides: Partial<WorkspaceDoc> = {}): WorkspaceDoc => ({
  version: 1,
  revision,
  updatedAt: '2026-01-01T00:00:00.000Z',
  viewport: { x: 0, y: 0, zoom: 1 },
  nextZ: 10,
  nodes,
  ...overrides
} as WorkspaceDoc);

const ids = (result: WorkspaceDoc) => result.nodes.map((n) => n.id).sort();

describe('workspace save-conflict rebase', () => {
  it('keeps both sides work when two clients add different nodes', () => {
    const base = doc(4, [node('shared', '2026-01-01T00:00:00.000Z')]);
    const local = doc(4, [node('shared', '2026-01-01T00:00:00.000Z'), node('mine', '2026-01-01T00:05:00.000Z')]);
    const remote = doc(5, [node('shared', '2026-01-01T00:00:00.000Z'), node('theirs', '2026-01-01T00:04:00.000Z')]);

    expect(ids(rebaseWorkspaceDoc(local, remote, base))).toEqual(['mine', 'shared', 'theirs']);
  });

  it('adopts the newer edit when both clients changed the same node', () => {
    const base = doc(4, [node('a', '2026-01-01T00:00:00.000Z')]);
    const local = doc(4, [node('a', '2026-01-01T00:01:00.000Z', { x: 100 })]);
    const remote = doc(5, [node('a', '2026-01-01T00:02:00.000Z', { x: 900 })]);

    expect(rebaseWorkspaceDoc(local, remote, base).nodes[0].x).toBe(900);
    // ...and the other way round.
    const localWins = rebaseWorkspaceDoc(
      doc(4, [node('a', '2026-01-01T00:03:00.000Z', { x: 100 })]),
      remote,
      base
    );
    expect(localWins.nodes[0].x).toBe(100);
  });

  it('honours a local delete rather than resurrecting the node from the server', () => {
    const base = doc(4, [node('a', '2026-01-01T00:00:00.000Z'), node('b', '2026-01-01T00:00:00.000Z')]);
    const local = doc(4, [node('a', '2026-01-01T00:00:00.000Z')]);
    const remote = doc(5, [node('a', '2026-01-01T00:00:00.000Z'), node('b', '2026-01-01T00:00:00.000Z')]);

    expect(ids(rebaseWorkspaceDoc(local, remote, base))).toEqual(['a']);
  });

  it('honours a remote delete of a node this client never touched', () => {
    const base = doc(4, [node('a', '2026-01-01T00:00:00.000Z'), node('b', '2026-01-01T00:00:00.000Z')]);
    const local = doc(4, [node('a', '2026-01-01T00:00:00.000Z'), node('b', '2026-01-01T00:00:00.000Z')]);
    const remote = doc(5, [node('a', '2026-01-01T00:00:00.000Z')]);

    expect(ids(rebaseWorkspaceDoc(local, remote, base))).toEqual(['a']);
  });

  it('resurrects a remotely deleted node when this client has edited it since', () => {
    // Losing an edit the user just made is worse than keeping a node someone
    // else deleted, so an edit wins over a delete.
    const base = doc(4, [node('a', '2026-01-01T00:00:00.000Z'), node('b', '2026-01-01T00:00:00.000Z')]);
    const local = doc(4, [node('a', '2026-01-01T00:00:00.000Z'), node('b', '2026-01-01T00:09:00.000Z', { x: 42 })]);
    const remote = doc(5, [node('a', '2026-01-01T00:00:00.000Z')]);

    const merged = rebaseWorkspaceDoc(local, remote, base);
    expect(ids(merged)).toEqual(['a', 'b']);
    expect(merged.nodes.find((n) => n.id === 'b')?.x).toBe(42);
  });

  it('adopts the server revision so the retried save is accepted', () => {
    const merged = rebaseWorkspaceDoc(doc(4, []), doc(9, []), doc(4, []));
    expect(merged.revision).toBe(9);
  });

  it('never merges the camera, which belongs to this client alone', () => {
    const local = doc(4, [], { viewport: { x: -500, y: -300, zoom: 1.75 } });
    const remote = doc(5, [], { viewport: { x: 0, y: 0, zoom: 0.2 } });

    expect(rebaseWorkspaceDoc(local, remote, doc(4, [])).viewport).toEqual({ x: -500, y: -300, zoom: 1.75 });
  });

  it('keeps z-ordering monotonic across both sides so new nodes land on top', () => {
    const merged = rebaseWorkspaceDoc(doc(4, [], { nextZ: 12 }), doc(5, [], { nextZ: 30 }), doc(4, []));
    expect(merged.nextZ).toBe(30);
  });
});
