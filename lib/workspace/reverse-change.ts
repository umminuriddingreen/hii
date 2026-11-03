import type { WorkspaceDoc } from './types';

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Reverse only values still owned by this edit; newer independent work survives. */
function reverse(before: unknown, after: unknown, current: unknown): unknown {
  if (equal(before, after)) return current;
  if (equal(after, current)) return before;
  if (!record(before) || !record(after) || !record(current)) return current;
  const result = { ...current };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'updatedAt') continue;
    const value = reverse(before[key], after[key], current[key]);
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result;
}

function reverseItems<T extends { id: string }>(before: T[], after: T[], current: T[]): T[] {
  const beforeById = new Map(before.map(item => [item.id, item]));
  const afterById = new Map(after.map(item => [item.id, item]));
  const currentIds = new Set(current.map(item => item.id));
  const result: T[] = [];
  for (const item of current) {
    const old = beforeById.get(item.id);
    const edited = afterById.get(item.id);
    if (!old && edited && equal(edited, item)) continue;
    result.push(old && edited ? reverse(old, edited, item) as T : item);
  }
  for (const item of before) {
    if (!afterById.has(item.id) && !currentIds.has(item.id)) result.push(item);
  }
  return result;
}

export function reverseWorkspaceChange(before: WorkspaceDoc, after: WorkspaceDoc, current: WorkspaceDoc): WorkspaceDoc {
  const now = new Date().toISOString();
  const currentById = new Map(current.nodes.map(node => [node.id, node]));
  const nodes = reverseItems(before.nodes, after.nodes, current.nodes).map(node =>
    equal(node, currentById.get(node.id)) ? node : { ...node, updatedAt: now });
  const ids = new Set(nodes.map(node => node.id));
  return {
    ...current,
    nodes,
    links: reverseItems(before.links ?? [], after.links ?? [], current.links ?? []).filter(link => ids.has(link.fromId) && ids.has(link.toId)),
    updatedAt: new Date().toISOString()
  };
}
