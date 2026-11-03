import { workspaceNodeTitle } from './search';
import type { WorkspaceDoc, WorkspaceNode } from './types';

/**
 * Stable `@name` addressing for workspace objects.
 *
 * A node id is a UUID: correct, and unusable in a sentence. A handle is the
 * name a human can type and an agent can resolve back to exactly one object,
 * so `isolate @facade` and `compare against @scheme-a` address real state
 * rather than being reconstructed from a description of it.
 *
 * Two kinds of handle exist and they are not interchangeable:
 *
 * - An **assigned** handle is authored. The user named this object, so the name
 *   is part of the document and survives retitling, editing, and reruns.
 * - A **derived** handle is computed from the node's current title. It exists so
 *   every object is addressable immediately, without ceremony. It is not stable:
 *   retitle the node and it changes.
 *
 * Resolution prefers assigned handles precisely because a derived handle can
 * silently start pointing at a different object, and a command that operated on
 * the wrong object because a title changed is the failure this ordering avoids.
 */

/** Maximum handle length. Long enough to stay descriptive, short enough to type. */
const MAX_HANDLE = 48;

/** Reserved because a bare `@run` or `@selection` reads as a role, not a name. */
const RESERVED = new Set(['selection', 'these', 'this', 'all', 'here', 'it', 'them', 'me', 'hii']);

export type HandleKind = 'assigned' | 'derived';

export type WorkspaceHandle = {
  handle: string;
  nodeId: string;
  kind: HandleKind;
  title: string;
};

/** A `@token` found in text, resolved or not. */
export type HandleReference = {
  raw: string;
  handle: string;
  start: number;
  end: number;
  nodeId?: string;
  kind?: HandleKind;
  ambiguous?: string[];
};

const HANDLE_TOKEN = /@([a-z0-9][a-z0-9-]{0,63})/gi;

/**
 * Reduce arbitrary text to a handle body.
 *
 * Diacritics fold to ASCII so `@fassade` and `@fassáde` cannot both exist and
 * quietly address different objects.
 */
export function slugifyHandle(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_HANDLE)
    .replace(/-+$/g, '');
}

/** The handle the user assigned to this node, if any. */
export function assignedHandle(node: WorkspaceNode): string | undefined {
  const raw = typeof node.handle === 'string' ? node.handle : undefined;
  const slug = slugifyHandle(raw);
  return slug && !RESERVED.has(slug) ? slug : undefined;
}

/** The handle this node would answer to based on its current title. */
export function derivedHandle(node: WorkspaceNode): string | undefined {
  const slug = slugifyHandle(workspaceNodeTitle(node));
  return slug && !RESERVED.has(slug) ? slug : undefined;
}

/**
 * Build the resolution table for a set of nodes.
 *
 * Collisions are resolved by suffixing `-2`, `-3`, … in a deterministic order
 * (assigned before derived, then oldest first) so the same document always
 * produces the same table. A handle that shifts between sessions is a handle
 * that cannot appear in a saved command.
 */
export function workspaceHandles(nodes: WorkspaceNode[]): WorkspaceHandle[] {
  const ordered = [...nodes].sort((a, b) => {
    const byKind = Number(Boolean(assignedHandle(b))) - Number(Boolean(assignedHandle(a)));
    if (byKind) return byKind;
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });

  const taken = new Set<string>();
  const table: WorkspaceHandle[] = [];

  for (const node of ordered) {
    const assigned = assignedHandle(node);
    const base = assigned ?? derivedHandle(node);
    if (!base) continue;
    let handle = base;
    let suffix = 2;
    while (taken.has(handle)) {
      const room = MAX_HANDLE - String(suffix).length - 1;
      handle = `${base.slice(0, room).replace(/-+$/g, '')}-${suffix}`;
      suffix += 1;
    }
    taken.add(handle);
    table.push({
      handle,
      nodeId: node.id,
      kind: assigned ? 'assigned' : 'derived',
      title: workspaceNodeTitle(node)
    });
  }

  return table;
}

/** Index a handle table for lookup. */
export function handleIndex(handles: WorkspaceHandle[]): Map<string, WorkspaceHandle> {
  return new Map(handles.map((entry) => [entry.handle, entry]));
}

/**
 * Find every `@token` in text and resolve what it addresses.
 *
 * Unresolved tokens are returned rather than dropped: a command naming an
 * object that does not exist must fail visibly, not silently operate on the
 * remainder of the sentence.
 */
export function findHandleReferences(text: string, nodes: WorkspaceNode[]): HandleReference[] {
  const index = handleIndex(workspaceHandles(nodes));
  const references: HandleReference[] = [];

  for (const match of String(text ?? '').matchAll(HANDLE_TOKEN)) {
    const raw = match[0];
    const handle = slugifyHandle(match[1]);
    const start = match.index ?? 0;
    const found = handle ? index.get(handle) : undefined;
    const reference: HandleReference = { raw, handle, start, end: start + raw.length };
    if (found) {
      reference.nodeId = found.nodeId;
      reference.kind = found.kind;
    } else if (handle) {
      const near = [...index.keys()].filter((key) => key.startsWith(handle) || handle.startsWith(key)).slice(0, 5);
      if (near.length) reference.ambiguous = near;
    }
    references.push(reference);
  }

  return references;
}

export type ResolvedHandles = {
  /** Nodes named explicitly, in the order they appeared in the text. */
  nodes: WorkspaceNode[];
  /** Handles that matched nothing, with near-miss suggestions. */
  unresolved: HandleReference[];
  /** The instruction with each resolved `@handle` replaced by its title. */
  text: string;
  references: HandleReference[];
};

/**
 * Resolve an instruction's handles into concrete nodes.
 *
 * The rewritten text substitutes titles for handles because the model reads the
 * instruction while the runtime reads `nodes` — the two must describe the same
 * objects, and a raw `@a7f3` in a prompt is noise the model will guess about.
 */
export function resolveHandles(text: string, nodes: WorkspaceNode[]): ResolvedHandles {
  const references = findHandleReferences(text, nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const resolved: WorkspaceNode[] = [];
  const seen = new Set<string>();
  const unresolved: HandleReference[] = [];

  for (const reference of references) {
    if (!reference.nodeId) {
      unresolved.push(reference);
      continue;
    }
    const node = byId.get(reference.nodeId);
    if (node && !seen.has(node.id)) {
      seen.add(node.id);
      resolved.push(node);
    }
  }

  let rewritten = '';
  let cursor = 0;
  for (const reference of references) {
    rewritten += String(text).slice(cursor, reference.start);
    const node = reference.nodeId ? byId.get(reference.nodeId) : undefined;
    rewritten += node ? workspaceNodeTitle(node) : reference.raw;
    cursor = reference.end;
  }
  rewritten += String(text).slice(cursor);

  return { nodes: resolved, unresolved, text: rewritten, references };
}

/**
 * Assign a handle to a node.
 *
 * Assignment is exclusive: taking a name from another node would leave saved
 * commands pointing somewhere new, so a taken name is rejected rather than
 * reassigned.
 */
export function assignWorkspaceHandle(
  doc: WorkspaceDoc,
  nodeId: string,
  name: string
): { doc: WorkspaceDoc; handle: string } | { error: string } {
  const handle = slugifyHandle(name);
  if (!handle) return { error: 'A handle needs at least one letter or number.' };
  if (RESERVED.has(handle)) return { error: `“@${handle}” is reserved — it reads as a role, not a name.` };

  const target = doc.nodes.find((node) => node.id === nodeId);
  if (!target) return { error: 'That object is no longer on the canvas.' };

  const owner = doc.nodes.find((node) => node.id !== nodeId && assignedHandle(node) === handle);
  if (owner) return { error: `“@${handle}” already names ${workspaceNodeTitle(owner)}.` };

  const updatedAt = new Date().toISOString();
  return {
    handle,
    doc: {
      ...doc,
      updatedAt,
      nodes: doc.nodes.map((node) => (node.id === nodeId ? { ...node, handle, updatedAt } : node))
    }
  };
}

/** Drop an assigned handle, falling the node back to its derived one. */
export function clearWorkspaceHandle(doc: WorkspaceDoc, nodeId: string): WorkspaceDoc {
  const updatedAt = new Date().toISOString();
  return {
    ...doc,
    updatedAt,
    nodes: doc.nodes.map((node) => {
      if (node.id !== nodeId || !node.handle) return node;
      const { handle: _dropped, ...rest } = node;
      return { ...rest, updatedAt };
    })
  };
}

/** Completion candidates for a partially typed `@token`. */
export function handleCompletions(prefix: string, nodes: WorkspaceNode[], limit = 8): WorkspaceHandle[] {
  const slug = slugifyHandle(prefix.replace(/^@/, ''));
  const handles = workspaceHandles(nodes);
  if (!slug) return handles.slice(0, limit);
  return handles
    .filter((entry) => entry.handle.includes(slug))
    .sort((a, b) => {
      const byStart = Number(b.handle.startsWith(slug)) - Number(a.handle.startsWith(slug));
      if (byStart) return byStart;
      const byKind = Number(b.kind === 'assigned') - Number(a.kind === 'assigned');
      return byKind || a.handle.length - b.handle.length;
    })
    .slice(0, limit);
}
