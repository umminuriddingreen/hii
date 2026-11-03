import type { WorkspaceLink, WorkspaceNode } from './types';

export type WorkspaceConnection = {
  id: string;
  fromId: string;
  toId: string;
  /**
   * `lineage` and `context` are derived from how work actually flowed and are
   * read-only. `link` is a connector the user drew, and is the only kind that can
   * be selected or deleted.
   */
  kind: 'lineage' | 'context' | 'link';
  label?: string;
  arrow?: WorkspaceLink['arrow'];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

function center(node: WorkspaceNode) {
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
}

/**
 * Pull the endpoint back to where the line crosses the node's border, so an
 * arrowhead lands on the edge of a card instead of being buried under it.
 */
export function edgePoint(node: WorkspaceNode, toward: { x: number; y: number }) {
  const from = center(node);
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  if (dx === 0 && dy === 0) return from;
  const halfW = node.w / 2;
  const halfH = node.h / 2;
  // Scale the direction vector until it first leaves the box on either axis.
  const scale = Math.min(
    dx === 0 ? Infinity : halfW / Math.abs(dx),
    dy === 0 ? Infinity : halfH / Math.abs(dy)
  );
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

/** Geometry for the user-authored connectors in a document. */
export function workspaceLinkConnections(nodes: WorkspaceNode[], links: WorkspaceLink[]): WorkspaceConnection[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const connections: WorkspaceConnection[] = [];
  for (const link of links) {
    const from = byId.get(link.fromId);
    const to = byId.get(link.toId);
    if (!from || !to) continue;
    const start = edgePoint(from, center(to));
    const end = edgePoint(to, center(from));
    connections.push({
      id: link.id,
      fromId: link.fromId,
      toId: link.toId,
      kind: 'link',
      label: link.label,
      arrow: link.arrow ?? 'end',
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y
    });
  }
  return connections;
}

export function workspaceConnections(nodes: WorkspaceNode[]): WorkspaceConnection[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const connections: WorkspaceConnection[] = [];
  const seen = new Set<string>();

  const add = (fromId: string, toId: string, kind: WorkspaceConnection['kind']) => {
    const from = byId.get(fromId);
    const to = byId.get(toId);
    const id = `${kind}:${fromId}:${toId}`;
    if (!from || !to || seen.has(id)) return;
    seen.add(id);
    const start = center(from);
    const end = center(to);
    connections.push({
      id,
      fromId,
      toId,
      kind,
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y
    });
  };

  for (const node of nodes) {
    if (node.object?.parentId) add(node.object.parentId, node.id, 'lineage');
    const context = Array.isArray(node.payload.context) ? node.payload.context : [];
    for (const item of context) {
      if (!item || typeof item !== 'object') continue;
      const id = String((item as Record<string, unknown>).id || '');
      if (id) add(id, node.id, 'context');
    }
  }
  return connections;
}
