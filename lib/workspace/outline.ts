import { workspaceNodeTitle } from './search.ts';
import { workspaceScenes } from './scenes.ts';
import type { WorkspaceNode } from './types.ts';

export type WorkspaceOutlineEntry = {
  node: WorkspaceNode;
  children: WorkspaceOutlineEntry[];
  depth: number;
};

export type WorkspaceOutlineGroup = {
  id: string;
  title: string;
  scene: WorkspaceNode | null;
  sequence: number | null;
  entries: WorkspaceOutlineEntry[];
  memberCount: number;
  statusCounts: Array<[string, number]>;
};

function nodeParentId(node: WorkspaceNode) {
  for (const value of [node.object?.parentId, node.payload.parentId]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function nodeStatus(node: WorkspaceNode) {
  const value = node.payload.status ?? node.object?.status;
  return typeof value === 'string' && value.trim() ? value.trim().replaceAll('_', ' ') : '';
}

function compareNodes(left: WorkspaceNode, right: WorkspaceNode) {
  return left.y - right.y
    || left.x - right.x
    || left.z - right.z
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

function safeParentId(node: WorkspaceNode, byId: Map<string, WorkspaceNode>) {
  const parentId = nodeParentId(node);
  if (!parentId || parentId === node.id || !byId.has(parentId)) return null;
  const visited = new Set([node.id]);
  let cursor: string | null = parentId;
  while (cursor) {
    if (visited.has(cursor)) return null;
    visited.add(cursor);
    const parent = byId.get(cursor);
    cursor = parent ? nodeParentId(parent) : null;
    if (cursor && !byId.has(cursor)) cursor = null;
  }
  return parentId;
}

function buildEntries(nodes: WorkspaceNode[]) {
  const ordered = [...nodes].sort(compareNodes);
  const byId = new Map(ordered.map((node) => [node.id, node]));
  const children = new Map<string, WorkspaceNode[]>();
  const roots: WorkspaceNode[] = [];

  for (const node of ordered) {
    const parentId = safeParentId(node, byId);
    if (!parentId) {
      roots.push(node);
      continue;
    }
    children.set(parentId, [...(children.get(parentId) ?? []), node]);
  }

  const entry = (node: WorkspaceNode, depth: number): WorkspaceOutlineEntry => ({
    node,
    depth,
    children: (children.get(node.id) ?? []).sort(compareNodes).map((child) => entry(child, depth + 1))
  });
  return roots.map((node) => entry(node, 0));
}

function entryMatches(entry: WorkspaceOutlineEntry, terms: string[]): WorkspaceOutlineEntry | null {
  if (!terms.length) return entry;
  const haystack = [
    workspaceNodeTitle(entry.node),
    entry.node.type,
    entry.node.object?.kind,
    entry.node.object?.status,
    entry.node.object?.owner,
    entry.node.payload.status
  ].filter(Boolean).join(' ').toLocaleLowerCase();
  const children = entry.children
    .map((child) => entryMatches(child, terms))
    .filter((child): child is WorkspaceOutlineEntry => Boolean(child));
  return terms.every((term) => haystack.includes(term)) || children.length
    ? { ...entry, children }
    : null;
}

function statusCounts(nodes: WorkspaceNode[]) {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const status = nodeStatus(node);
    if (status) counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

export function workspaceOutlineGroups(nodes: WorkspaceNode[], query = ''): WorkspaceOutlineGroup[] {
  const scenes = workspaceScenes(nodes);
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const groups: WorkspaceOutlineGroup[] = scenes.map((scene, index) => {
    const members = nodes.filter((node) => node.frameId === scene.id && node.type !== 'frame');
    return {
      id: scene.id,
      title: workspaceNodeTitle(scene),
      scene,
      sequence: index + 1,
      entries: buildEntries(members),
      memberCount: members.length,
      statusCounts: statusCounts(members)
    };
  });
  const loose = nodes.filter((node) =>
    node.type !== 'frame' && (!node.frameId || !sceneIds.has(node.frameId))
  );
  if (loose.length) {
    groups.push({
      id: 'loose-objects',
      title: 'Loose objects',
      scene: null,
      sequence: null,
      entries: buildEntries(loose),
      memberCount: loose.length,
      statusCounts: statusCounts(loose)
    });
  }

  return groups
    .map((group) => {
      const entries = group.entries
        .map((entry) => entryMatches(entry, terms))
        .filter((entry): entry is WorkspaceOutlineEntry => Boolean(entry));
      const groupMatches = terms.length > 0 && terms.every((term) =>
        `${group.title} scene`.toLocaleLowerCase().includes(term)
      );
      return groupMatches ? group : { ...group, entries };
    })
    .filter((group) => !terms.length || group.entries.length > 0);
}

export function workspaceOutlineEntryCount(entries: WorkspaceOutlineEntry[]): number {
  return entries.reduce((count, entry) => count + 1 + workspaceOutlineEntryCount(entry.children), 0);
}

export function workspaceFlattenOutlineEntries(entries: WorkspaceOutlineEntry[]): WorkspaceOutlineEntry[] {
  return entries.flatMap((entry) => [entry, ...workspaceFlattenOutlineEntries(entry.children)]);
}
