import type { WorkspaceNode } from './types';

export type WorkspaceConnection = {
  id: string;
  fromId: string;
  toId: string;
  kind: 'lineage' | 'context';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

function center(node: WorkspaceNode) {
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
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
