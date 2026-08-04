import { describe, expect, it } from 'vitest';
import { edgePoint, workspaceLinkConnections } from '../../lib/workspace/connections';
import { deleteWorkspaceNodes, duplicateWorkspaceNodes, linkWorkspaceNodes, unlinkWorkspaceNodes } from '../../lib/workspace/selection';
import { normalizeLinks, normalizeWorkspace } from '../../lib/workspace/types';
import type { WorkspaceDoc, WorkspaceNode } from '../../lib/workspace/types';

const node = (id: string, x = 0, y = 0, w = 200, h = 100): WorkspaceNode => ({
  id,
  type: 'note',
  x,
  y,
  w,
  h,
  z: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  payload: {}
} as WorkspaceNode);

const doc = (nodes: WorkspaceNode[], links: WorkspaceDoc['links'] = []): WorkspaceDoc => ({
  version: 1,
  revision: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  viewport: { x: 0, y: 0, zoom: 1 },
  nextZ: 5,
  nodes,
  links
} as WorkspaceDoc);

describe('drawing connectors', () => {
  const board = doc([node('a'), node('b', 500)]);

  it('links two nodes', () => {
    const next = linkWorkspaceNodes(board, 'a', 'b');
    expect(next.links).toHaveLength(1);
    expect(next.links[0]).toMatchObject({ fromId: 'a', toId: 'b', arrow: 'end' });
  });

  it('refuses a self-link', () => {
    expect(linkWorkspaceNodes(board, 'a', 'a')).toBe(board);
  });

  it('refuses a link to a node that is not on the board', () => {
    expect(linkWorkspaceNodes(board, 'a', 'ghost')).toBe(board);
  });

  it('does not stack a second connector between the same pair, in either direction', () => {
    const once = linkWorkspaceNodes(board, 'a', 'b');
    expect(linkWorkspaceNodes(once, 'a', 'b')).toBe(once);
    expect(linkWorkspaceNodes(once, 'b', 'a')).toBe(once);
  });

  it('removes a connector on request', () => {
    const linked = linkWorkspaceNodes(board, 'a', 'b');
    expect(unlinkWorkspaceNodes(linked, [linked.links[0].id]).links).toHaveLength(0);
  });
});

describe('connectors and node lifetime', () => {
  it('deletes connectors that lose an endpoint', () => {
    const linked = linkWorkspaceNodes(doc([node('a'), node('b', 500)]), 'a', 'b');
    expect(deleteWorkspaceNodes(linked, ['b']).links).toHaveLength(0);
  });

  it('copies a connector only when both of its ends were duplicated', () => {
    const board = doc([node('a'), node('b', 500), node('c', 1_000)]);
    const linked = linkWorkspaceNodes(linkWorkspaceNodes(board, 'a', 'b'), 'b', 'c');

    const { doc: next, createdIds } = duplicateWorkspaceNodes(linked, ['a', 'b']);
    const copied = next.links.filter((link) => !linked.links.some((original) => original.id === link.id));

    // a->b is wholly inside the duplicated set; b->c is not.
    expect(copied).toHaveLength(1);
    expect(createdIds).toContain(copied[0].fromId);
    expect(createdIds).toContain(copied[0].toId);
  });

  it('drops dangling connectors when a document is normalized', () => {
    const cleaned = normalizeLinks(
      [{ id: 'l1', fromId: 'a', toId: 'gone' }, { id: 'l2', fromId: 'a', toId: 'b' }],
      [node('a'), node('b')]
    );
    expect(cleaned.map((link) => link.id)).toEqual(['l2']);
  });

  it('rejects self-links and duplicate ids arriving from disk', () => {
    const cleaned = normalizeLinks(
      [{ id: 'l1', fromId: 'a', toId: 'a' }, { id: 'l2', fromId: 'a', toId: 'b' }, { id: 'l2', fromId: 'b', toId: 'a' }],
      [node('a'), node('b')]
    );
    expect(cleaned.map((link) => link.id)).toEqual(['l2']);
  });

  it('reads a document saved before connectors existed', () => {
    const legacy = normalizeWorkspace({
      version: 1,
      revision: 3,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [node('a')]
    });
    expect(legacy.links).toEqual([]);
  });
});

describe('connector geometry', () => {
  it('anchors the line on the node border so an arrowhead is not buried', () => {
    // Centre (100,50), pointing right: the line should leave at x = 200.
    expect(edgePoint(node('a'), { x: 1_000, y: 50 })).toEqual({ x: 200, y: 50 });
  });

  it('leaves through the top or bottom when the target is mostly above or below', () => {
    expect(edgePoint(node('a'), { x: 100, y: -1_000 })).toEqual({ x: 100, y: 0 });
  });

  it('builds geometry only for connectors whose nodes are present', () => {
    const nodes = [node('a'), node('b', 500)];
    const geometry = workspaceLinkConnections(nodes, [
      { id: 'l1', fromId: 'a', toId: 'b', arrow: 'end' },
      { id: 'l2', fromId: 'a', toId: 'missing', arrow: 'end' }
    ]);
    expect(geometry.map((link) => link.id)).toEqual(['l1']);
    expect(geometry[0].kind).toBe('link');
  });
});
