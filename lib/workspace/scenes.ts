import type { WorkspaceNode } from './types';

function storedOrder(node: WorkspaceNode) {
  const value = node.payload.sceneOrder;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

export function workspaceScenes(nodes: WorkspaceNode[]): WorkspaceNode[] {
  return nodes
    .filter((node) => node.type === 'frame')
    .sort((left, right) => {
      const order = storedOrder(left) - storedOrder(right);
      if (Number.isFinite(order) && order !== 0) return order;
      const created = left.createdAt.localeCompare(right.createdAt);
      return created || left.id.localeCompare(right.id);
    });
}

export function workspaceSceneMembers(nodes: WorkspaceNode[], sceneId: string): WorkspaceNode[] {
  return nodes.filter((node) => node.frameId === sceneId);
}

export function adjacentWorkspaceScene(
  scenes: WorkspaceNode[],
  currentSceneId: string | null,
  direction: -1 | 1
): WorkspaceNode | null {
  if (!scenes.length) return null;
  const currentIndex = scenes.findIndex((scene) => scene.id === currentSceneId);
  if (currentIndex < 0) return direction > 0 ? scenes[0] : scenes.at(-1) ?? null;
  return scenes[(currentIndex + direction + scenes.length) % scenes.length] ?? null;
}

export function workspaceSceneTypeSummary(members: WorkspaceNode[], limit = 3): string {
  if (!members.length) return 'empty scene';
  const counts = new Map<string, number>();
  for (const member of members) counts.set(member.type, (counts.get(member.type) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([type, count]) => `${count} ${type}`)
    .join(' · ');
}
