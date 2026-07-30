import type { WorkspaceNode } from './types';

type PendingContextItem = Record<string, unknown> & { id: string };

const pendingStatuses = new Set(['waiting_approval', 'proposed']);

function contextItems(node: WorkspaceNode) {
  return Array.isArray(node.payload.context)
    ? node.payload.context.filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function pendingRun(node: WorkspaceNode) {
  if (node.type !== 'run') return false;
  const status = String(node.payload.status || node.object?.status || 'waiting_approval');
  return pendingStatuses.has(status);
}

function includesSource(node: WorkspaceNode, sourceId: string) {
  return contextItems(node).some((item) => String(item.id || '') === sourceId);
}

function replaceSource(
  node: WorkspaceNode,
  sourceId: string,
  item: PendingContextItem,
  updatedAt: string,
  clearPreview: boolean
) {
  return {
    ...node,
    updatedAt,
    payload: {
      ...node.payload,
      context: contextItems(node).map((current) =>
        String(current.id || '') === sourceId ? item : current
      ),
      ...(clearPreview
        ? {
            contextPreview: null,
            contextSyncedAt: updatedAt
          }
        : {})
    }
  };
}

export function rebindPendingWorkspaceContext(
  nodes: WorkspaceNode[],
  sourceId: string,
  item: PendingContextItem,
  updatedAt: string
) {
  const affectedRuns = nodes.filter((node) => pendingRun(node) && includesSource(node, sourceId));
  if (!affectedRuns.length) return nodes;
  const intentIds = new Set(
    affectedRuns
      .map((node) => String(node.object?.parentId || node.payload.parentId || ''))
      .filter(Boolean)
  );

  return nodes.map((node) => {
    if (affectedRuns.some((run) => run.id === node.id)) {
      return replaceSource(node, sourceId, item, updatedAt, true);
    }
    if (node.type === 'intent' && intentIds.has(node.id) && includesSource(node, sourceId)) {
      return replaceSource(node, sourceId, item, updatedAt, false);
    }
    return node;
  });
}
