import type { WorkspaceNode } from './types';

const preferredPayloadFields = ['title', 'name', 'text', 'description', 'url', 'path', 'source', 'label'];

function readable(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

export function workspaceNodeTitle(node: WorkspaceNode) {
  for (const key of preferredPayloadFields) {
    const value = readable(node.payload[key]);
    if (value) return value;
  }
  return node.type.replaceAll('-', ' ');
}

export function searchWorkspaceNodes(nodes: WorkspaceNode[], query: string, limit = 12) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  return nodes
    .map((node) => {
      const values = [
        node.type,
        node.object?.kind,
        node.object?.status,
        node.object?.owner,
        ...preferredPayloadFields.map((key) => readable(node.payload[key]))
      ].filter(Boolean);
      const haystack = values.join(' ').toLocaleLowerCase();
      const title = workspaceNodeTitle(node);
      const titleText = title.toLocaleLowerCase();
      if (!terms.every((term) => haystack.includes(term))) return null;
      const score = terms.reduce((total, term) => total + (titleText.startsWith(term) ? 3 : titleText.includes(term) ? 2 : 1), 0);
      return { node, title, score };
    })
    .filter((result): result is { node: WorkspaceNode; title: string; score: number } => Boolean(result))
    .sort((a, b) => b.score - a.score || b.node.updatedAt.localeCompare(a.node.updatedAt))
    .slice(0, Math.max(0, limit));
}
