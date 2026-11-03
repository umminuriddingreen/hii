import { removeFrame } from './frames';
import type { WorkspaceDoc, WorkspaceLink, WorkspaceNode } from './types';
import { normalizeNode } from './types';

/** Where a duplicate lands relative to its original, in workspace units. */
export const DUPLICATE_OFFSET = 28;

export type MarqueeRect = { x: number; y: number; w: number; h: number };

const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `node-${Math.random().toString(36).slice(2)}-${Date.now()}`);

/**
 * State that must not be carried into a copy, because it names something that
 * exists exactly once.
 *
 * A terminal's `sessionId` addresses one pty — two nodes sharing it would fight
 * over the same stream. A run's identifiers address one agent run and its
 * append-only receipt; a copy has neither, so it starts as an unstarted run
 * rather than falsely claiming another run's proof.
 */
function freshenPayload(node: WorkspaceNode): Record<string, unknown> {
  const payload = { ...node.payload };
  if (node.type === 'terminal') payload.sessionId = newId();
  if (node.type === 'run') {
    delete payload.runId;
    delete payload.receiptPath;
    delete payload.boardTaskId;
    payload.status = 'waiting_approval';
    payload.autoStart = false;
  }
  return payload;
}

function freshenObject(node: WorkspaceNode): WorkspaceNode['object'] {
  if (!node.object) return node.object;
  const object = { ...node.object };
  if (node.type === 'run') {
    delete (object as Record<string, unknown>).runId;
    object.status = 'proposed';
  }
  // Proof references belong to the original's history, not to a fresh copy.
  delete (object as Record<string, unknown>).proofRefs;
  return object;
}

export function copyWorkspaceNode(node: WorkspaceNode, x: number, y: number, z: number): WorkspaceNode {
  const now = new Date().toISOString();
  return {
    ...node,
    id: newId(),
    x,
    y,
    z,
    createdAt: now,
    updatedAt: now,
    frameId: undefined,
    object: freshenObject(node),
    payload: freshenPayload(node)
  };
}

/**
 * Duplicate `ids` as a group, preserving their relative layout.
 *
 * Frame members come along with their frame so a duplicated scene is a whole
 * scene, and parent links are rewritten to point at the copies rather than back
 * at the originals.
 */
export function duplicateWorkspaceNodes(
  doc: WorkspaceDoc,
  ids: string[],
  offset = DUPLICATE_OFFSET
): { doc: WorkspaceDoc; createdIds: string[] } {
  const wanted = new Set(ids);
  for (const node of doc.nodes) {
    if (node.frameId && wanted.has(node.frameId)) wanted.add(node.id);
  }
  const sources = doc.nodes.filter((node) => wanted.has(node.id));
  if (!sources.length) return { doc, createdIds: [] };

  let z = doc.nextZ;
  const idMap = new Map<string, string>();
  const copies = sources.map((node) => {
    const copy = copyWorkspaceNode(node, node.x + offset, node.y + offset, ++z);
    idMap.set(node.id, copy.id);
    return copy;
  });

  const relinked = copies.map((copy, index) => {
    const source = sources[index];
    const frameId = source.frameId && idMap.has(source.frameId) ? idMap.get(source.frameId) : undefined;
    const parentId = source.object?.parentId;
    const object = copy.object && parentId && idMap.has(parentId)
      ? { ...copy.object, parentId: idMap.get(parentId) }
      : copy.object;
    return { ...copy, frameId, object };
  });

  // A connector wholly inside the duplicated set is part of what was duplicated;
  // one with a leg outside it is not, and copying it would silently re-point at
  // the original.
  const copiedLinks = (doc.links ?? [])
    .filter((link) => idMap.has(link.fromId) && idMap.has(link.toId))
    .map((link) => ({
      ...link,
      id: newId(),
      fromId: idMap.get(link.fromId)!,
      toId: idMap.get(link.toId)!
    }));

  return {
    doc: { ...doc, nextZ: z, nodes: [...doc.nodes, ...relinked], links: [...(doc.links ?? []), ...copiedLinks] },
    createdIds: relinked.map((node) => node.id)
  };
}

/** Draw a connector between two nodes, refusing self-links and duplicates. */
export function linkWorkspaceNodes(doc: WorkspaceDoc, fromId: string, toId: string): WorkspaceDoc {
  if (fromId === toId) return doc;
  const nodes = new Set(doc.nodes.map((node) => node.id));
  if (!nodes.has(fromId) || !nodes.has(toId)) return doc;
  const links = doc.links ?? [];
  // A connector is undirected for the purpose of "already exists".
  if (links.some((link) =>
    (link.fromId === fromId && link.toId === toId) || (link.fromId === toId && link.toId === fromId))) return doc;
  const link: WorkspaceLink = { id: newId(), fromId, toId, arrow: 'end' };
  return { ...doc, links: [...links, link] };
}

export function unlinkWorkspaceNodes(doc: WorkspaceDoc, linkIds: string[]): WorkspaceDoc {
  const doomed = new Set(linkIds);
  if (!doomed.size) return doc;
  return { ...doc, links: (doc.links ?? []).filter((link) => !doomed.has(link.id)) };
}

/**
 * Delete `ids`. Deleting a frame releases its members rather than deleting them,
 * matching what the close button already does — a scene is a grouping, and
 * removing the grouping should not destroy the work inside it.
 */
export function deleteWorkspaceNodes(doc: WorkspaceDoc, ids: string[]): WorkspaceDoc {
  const doomed = new Set(ids);
  if (!doomed.size) return doc;
  let next = doc;
  for (const id of doomed) {
    if (next.nodes.find((node) => node.id === id)?.type === 'frame') next = removeFrame(next, id);
  }
  return {
    ...next,
    nodes: next.nodes.filter((node) => !doomed.has(node.id)),
    // A connector to a deleted node has nowhere to land, so it goes with it.
    links: (next.links ?? []).filter((link) => !doomed.has(link.fromId) && !doomed.has(link.toId))
  };
}

/** Move `ids` by a delta, carrying frame members along with their frame. */
export function nudgeWorkspaceNodes(doc: WorkspaceDoc, ids: string[], dx: number, dy: number): WorkspaceDoc {
  const moving = new Set(ids);
  for (const node of doc.nodes) {
    if (node.frameId && moving.has(node.frameId)) moving.add(node.id);
  }
  if (!moving.size) return doc;
  const updatedAt = new Date().toISOString();
  return {
    ...doc,
    nodes: doc.nodes.map((node) => moving.has(node.id) ? { ...node, x: node.x + dx, y: node.y + dy, updatedAt } : node)
  };
}

/**
 * Ids of nodes a marquee touches.
 *
 * Intersection, not containment: dragging a box across a cluster selects what it
 * crosses, which is what every canvas tool does and what
 * `nodesInsideFrame` deliberately does *not* do (frame membership requires full
 * containment so a scene's contents are unambiguous).
 */
export function nodesInMarquee(nodes: WorkspaceNode[], rect: MarqueeRect): string[] {
  const left = Math.min(rect.x, rect.x + rect.w);
  const right = Math.max(rect.x, rect.x + rect.w);
  const top = Math.min(rect.y, rect.y + rect.h);
  const bottom = Math.max(rect.y, rect.y + rect.h);
  return nodes
    .filter((node) => node.type !== 'frame'
      && node.x + node.w >= left && node.x <= right
      && node.y + node.h >= top && node.y <= bottom)
    .map((node) => node.id);
}

/**
 * Ids of nodes whose centre falls inside a freeform lasso path.
 *
 * Centre-based rather than intersection-based: a lasso is drawn *around* a
 * cluster, so "did I loop this one in?" is answered by where the object sits,
 * not by whether the ink grazed its corner.
 *
 * `path` is flat [x, y, …] in workspace coordinates and is treated as closed.
 */
export function nodesInLasso(nodes: WorkspaceNode[], path: number[]): string[] {
  const count = Math.floor(path.length / 2);
  if (count < 3) return [];
  return nodes
    .filter((node) => node.type !== 'frame'
      && pointInPolygon(node.x + node.w / 2, node.y + node.h / 2, path, count))
    .map((node) => node.id);
}

/** Standard ray-casting test: count crossings of a ray to the right of the point. */
function pointInPolygon(px: number, py: number, path: number[], count: number) {
  let inside = false;
  for (let current = 0, previous = count - 1; current < count; previous = current, current += 1) {
    const cx = path[current * 2];
    const cy = path[current * 2 + 1];
    const px2 = path[previous * 2];
    const py2 = path[previous * 2 + 1];
    if ((cy > py) !== (py2 > py) && px < ((px2 - cx) * (py - cy)) / (py2 - cy) + cx) inside = !inside;
  }
  return inside;
}

const CLIPBOARD_MARKER = 'hii.workspace.nodes/v1';

/** Serialize a selection for the system clipboard. */
export function writeWorkspaceClipboard(doc: WorkspaceDoc, ids: string[]): string {
  const wanted = new Set(ids);
  const nodes = doc.nodes.filter((node) => wanted.has(node.id));
  return JSON.stringify({ marker: CLIPBOARD_MARKER, nodes });
}

/**
 * Parse clipboard text back into nodes, or return null if this is ordinary text
 * that should be pasted as a new note instead.
 *
 * Everything is passed through `normalizeNode`, so text pasted from outside HII
 * cannot introduce a node shape the rest of the app does not expect.
 */
export function readWorkspaceClipboard(text: string): WorkspaceNode[] | null {
  if (!text.includes(CLIPBOARD_MARKER)) return null;
  try {
    const parsed = JSON.parse(text) as { marker?: unknown; nodes?: unknown };
    if (parsed.marker !== CLIPBOARD_MARKER || !Array.isArray(parsed.nodes)) return null;
    const nodes = parsed.nodes.map(normalizeNode).filter((node): node is WorkspaceNode => node !== null);
    return nodes.length ? nodes : null;
  } catch {
    return null;
  }
}

/** Place clipboard nodes at `at`, keeping their relative layout. */
export function pasteWorkspaceNodes(
  doc: WorkspaceDoc,
  nodes: WorkspaceNode[],
  at: { x: number; y: number }
): { doc: WorkspaceDoc; createdIds: string[] } {
  if (!nodes.length) return { doc, createdIds: [] };
  const anchorX = Math.min(...nodes.map((node) => node.x));
  const anchorY = Math.min(...nodes.map((node) => node.y));
  let z = doc.nextZ;
  const created = nodes.map((node) => copyWorkspaceNode(node, at.x + (node.x - anchorX), at.y + (node.y - anchorY), ++z));
  return {
    doc: { ...doc, nextZ: z, nodes: [...doc.nodes, ...created] },
    createdIds: created.map((node) => node.id)
  };
}
