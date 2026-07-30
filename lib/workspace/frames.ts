import type { WorkspaceDoc, WorkspaceNode } from './types';

export function nodesInsideFrame(nodes: WorkspaceNode[], frame: WorkspaceNode): WorkspaceNode[] {
  return nodes.filter((node) => node.id !== frame.id && node.type !== 'frame'
    && node.x >= frame.x && node.y >= frame.y
    && node.x + node.w <= frame.x + frame.w
    && node.y + node.h <= frame.y + frame.h);
}

export function assignNodesToFrame(doc: WorkspaceDoc, frameId: string): WorkspaceDoc {
  const frame = doc.nodes.find((node) => node.id === frameId && node.type === 'frame');
  if (!frame) return doc;
  const inside = new Set(nodesInsideFrame(doc.nodes, frame).map((node) => node.id));
  return { ...doc, nodes: doc.nodes.map((node) => inside.has(node.id) ? { ...node, frameId } : node) };
}

export function moveNodeAndFrameContents(doc: WorkspaceDoc, nodeId: string, x: number, y: number): WorkspaceDoc {
  const target = doc.nodes.find((node) => node.id === nodeId);
  if (!target) return doc;
  const dx = x - target.x, dy = y - target.y;
  return {
    ...doc,
    nodes: doc.nodes.map((node) => node.id === nodeId || (target.type === 'frame' && node.frameId === target.id)
      ? { ...node, x: node.x + dx, y: node.y + dy }
      : node)
  };
}

export function removeFrame(doc: WorkspaceDoc, frameId: string): WorkspaceDoc {
  return {
    ...doc,
    nodes: doc.nodes.filter((node) => node.id !== frameId)
      .map((node) => node.frameId === frameId ? { ...node, frameId: undefined } : node)
  };
}
