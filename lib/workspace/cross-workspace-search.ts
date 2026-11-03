import { searchWorkspaceNodes } from './search';
import type { WorkspaceNode } from './types';

export type SearchableWorkspace = { id: string; title: string; nodes: WorkspaceNode[] };
export type CrossWorkspaceHit = { workspaceId: string; workspaceTitle: string; node: WorkspaceNode; title: string };

/** Search only documents the caller is authorized to read. Never merge their contents. */
export function searchCanvasWorkspaces(workspaces: SearchableWorkspace[], query: string, limit = 24): CrossWorkspaceHit[] {
  if (!query.trim()) return [];
  return workspaces.flatMap((workspace) =>
    searchWorkspaceNodes(workspace.nodes.filter((node) => node.type !== 'frame'), query, workspace.nodes.length)
      .map(({ node, title, score }) => ({ workspaceId: workspace.id, workspaceTitle: workspace.title, node, title, score }))
  ).sort((a, b) => b.score - a.score || b.node.updatedAt.localeCompare(a.node.updatedAt))
    .slice(0, Math.max(0, limit))
    .map(({ score: _score, ...hit }) => hit);
}
