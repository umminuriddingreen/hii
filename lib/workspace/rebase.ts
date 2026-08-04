import type { WorkspaceDoc, WorkspaceNode } from './types';

/**
 * Three-way merge of a local workspace onto a newer server revision.
 *
 * A save conflict happens whenever the same workspace file is open twice — a
 * second tab, the desktop shell alongside the browser, or an agent run writing
 * results while the user edits. Previously the client simply reported
 * "Workspace not saved" and every later save failed the same way, so the losing
 * side had to reload and discard work.
 *
 * `base` is the document as of the client's last successful sync. It is what
 * makes deletions decidable: a node missing from `local` but present in `base`
 * was deleted here, while a node missing from `base` but present in `remote` was
 * added over there. Without it the two cases are indistinguishable.
 *
 * The viewport is never merged — the camera belongs to this client alone.
 */
export function rebaseWorkspaceDoc(
  local: WorkspaceDoc,
  remote: WorkspaceDoc,
  base: WorkspaceDoc
): WorkspaceDoc {
  const baseIds = new Set(base.nodes.map((node) => node.id));
  const localById = new Map(local.nodes.map((node) => [node.id, node]));
  const remoteById = new Map(remote.nodes.map((node) => [node.id, node]));

  const merged: WorkspaceNode[] = [];
  const taken = new Set<string>();

  // Remote order first, so nodes another client added keep their relative order.
  for (const remoteNode of remote.nodes) {
    const localNode = localById.get(remoteNode.id);
    if (!localNode) {
      // Deleted here since the last sync, or added there since. Only a node we
      // once knew about can have been deleted by us.
      if (baseIds.has(remoteNode.id)) continue;
      merged.push(remoteNode);
      taken.add(remoteNode.id);
      continue;
    }
    merged.push(pickNewer(localNode, remoteNode));
    taken.add(remoteNode.id);
  }

  // Anything local that the server has not seen: our own additions, plus nodes
  // the other client deleted but we have since edited (an edit resurrects them —
  // preserving work is the safer failure).
  for (const localNode of local.nodes) {
    if (taken.has(localNode.id)) continue;
    if (baseIds.has(localNode.id) && !remoteById.has(localNode.id)) {
      const baseNode = base.nodes.find((node) => node.id === localNode.id);
      if (baseNode && baseNode.updatedAt === localNode.updatedAt) continue; // untouched here, deleted there
    }
    merged.push(localNode);
  }

  return {
    ...local,
    revision: remote.revision,
    updatedAt: new Date().toISOString(),
    nextZ: Math.max(local.nextZ, remote.nextZ),
    viewport: local.viewport,
    nodes: merged,
    links: mergeLinks(local, remote, base, new Set(merged.map((node) => node.id)))
  };
}

/**
 * Connectors merge by the same delete-aware rule as nodes, then drop any whose
 * endpoints did not survive the node merge.
 */
function mergeLinks(
  local: WorkspaceDoc,
  remote: WorkspaceDoc,
  base: WorkspaceDoc,
  survivingNodes: Set<string>
): WorkspaceDoc['links'] {
  const baseIds = new Set((base.links ?? []).map((link) => link.id));
  const localIds = new Set((local.links ?? []).map((link) => link.id));
  const merged = new Map<string, WorkspaceDoc['links'][number]>();

  for (const link of remote.links ?? []) {
    // Present at base but gone locally means we deleted it.
    if (baseIds.has(link.id) && !localIds.has(link.id)) continue;
    merged.set(link.id, link);
  }
  for (const link of local.links ?? []) merged.set(link.id, link);

  return [...merged.values()].filter((link) =>
    survivingNodes.has(link.fromId) && survivingNodes.has(link.toId));
}

function pickNewer(local: WorkspaceNode, remote: WorkspaceNode): WorkspaceNode {
  const localTime = Date.parse(local.updatedAt || '');
  const remoteTime = Date.parse(remote.updatedAt || '');
  if (!Number.isFinite(remoteTime)) return local;
  if (!Number.isFinite(localTime)) return remote;
  // Ties go to the local edit: this client is the one with a user in front of it.
  return remoteTime > localTime ? remote : local;
}
