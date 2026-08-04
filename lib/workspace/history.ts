import type { WorkspaceDoc } from './types';

export type WorkspaceHistory = { past: WorkspaceDoc[]; future: WorkspaceDoc[] };
const HISTORY_LIMIT = 50;

/**
 * History snapshots share node objects with the document they came from.
 *
 * Nodes are already treated as immutable everywhere — every mutation path builds
 * a new node object rather than writing into an existing one — so a shallow copy
 * of the node array is as safe as a deep clone. It matters because a deep clone
 * duplicated every contact sheet's `items[]` and every 2400-character context
 * excerpt, fifty times over, purely so undo could exist.
 */
const snapshot = (doc: WorkspaceDoc): WorkspaceDoc => ({ ...doc, nodes: [...doc.nodes] });
const restore = (saved: WorkspaceDoc, current: WorkspaceDoc): WorkspaceDoc => ({
  ...snapshot(saved),
  revision: current.revision,
  updatedAt: new Date().toISOString()
});

export function emptyWorkspaceHistory(): WorkspaceHistory {
  return { past: [], future: [] };
}

export function recordWorkspaceChange(history: WorkspaceHistory, before: WorkspaceDoc): WorkspaceHistory {
  return { past: [...history.past, snapshot(before)].slice(-HISTORY_LIMIT), future: [] };
}

export function undoWorkspace(history: WorkspaceHistory, current: WorkspaceDoc) {
  const previous = history.past.at(-1);
  if (!previous) return null;
  return {
    doc: restore(previous, current),
    history: {
      past: history.past.slice(0, -1),
      future: [snapshot(current), ...history.future].slice(0, HISTORY_LIMIT)
    }
  };
}

export function redoWorkspace(history: WorkspaceHistory, current: WorkspaceDoc) {
  const next = history.future[0];
  if (!next) return null;
  return {
    doc: restore(next, current),
    history: {
      past: [...history.past, snapshot(current)].slice(-HISTORY_LIMIT),
      future: history.future.slice(1)
    }
  };
}
