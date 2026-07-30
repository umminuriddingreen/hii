import type { WorkspaceDoc } from './types';

export type WorkspaceHistory = { past: WorkspaceDoc[]; future: WorkspaceDoc[] };
const HISTORY_LIMIT = 50;

const snapshot = (doc: WorkspaceDoc): WorkspaceDoc => structuredClone(doc);
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
