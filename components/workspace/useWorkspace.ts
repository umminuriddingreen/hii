'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readWorkspace, writeWorkspace } from '@/lib/client/hii-bridge';
import { reconcileWorkspaceSave } from '@/lib/workspace/rebase';
import { emptyWorkspace, type WorkspaceDoc, type WorkspaceNode, type WorkspaceViewport } from '@/lib/workspace/types';

export type WorkspaceApi = {
  ready: boolean;
  nodes: WorkspaceNode[];
  addNode: (node: WorkspaceNode) => void;
  patchNode: (id: string, patch: Partial<WorkspaceNode>) => void;
  removeNode: (id: string) => void;
  bringToFront: (id: string) => void;
  takeZ: () => number;
  initialViewport: WorkspaceViewport | null;
  scheduleSave: () => void;
  undo: () => void;
  redo: () => void;
};

export type WorkspacePersistence = {
  read: () => Promise<WorkspaceDoc>;
  write: (document: WorkspaceDoc) => Promise<WorkspaceDoc>;
  /** Optional authoritative updates, used by connected Spaces only. */
  subscribe?: (listener: (document: WorkspaceDoc) => void) => () => void;
};

export function useWorkspace(
  getViewport: () => WorkspaceViewport,
  bootstrap?: (document: WorkspaceDoc) => WorkspaceDoc,
  persistence?: WorkspacePersistence
): WorkspaceApi {
  const [document, setDocument] = useState<WorkspaceDoc>(emptyWorkspace);
  const [ready, setReady] = useState(false);
  const [initialViewport, setInitialViewport] = useState<WorkspaceViewport | null>(null);
  const current = useRef(document);
  const mutationVersion = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlight = useRef(false);
  const saveQueued = useRef(false);
  const persistRef = useRef<() => Promise<void>>(async () => undefined);
  const past = useRef<WorkspaceNode[][]>([]);
  const future = useRef<WorkspaceNode[][]>([]);
  current.current = document;

  const persist = useCallback(async () => {
    if (saveInFlight.current) {
      saveQueued.current = true;
      return;
    }
    const submittedVersion = mutationVersion.current;
    const next = { ...current.current, viewport: getViewport(), updatedAt: new Date().toISOString() };
    saveInFlight.current = true;
    try {
      const saved = await (persistence?.write(next) ?? writeWorkspace(next));
      const changedWhileSaving = mutationVersion.current !== submittedVersion;
      const reconciled = reconcileWorkspaceSave(current.current, saved, next, changedWhileSaving);
      current.current = reconciled;
      setDocument(reconciled);
      if (changedWhileSaving) saveQueued.current = true;
    } catch {
      // The next mutation retries. The in-memory canvas remains usable.
    } finally {
      saveInFlight.current = false;
      if (saveQueued.current) {
        saveQueued.current = false;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null;
          void persistRef.current();
        }, 180);
      }
    }
  }, [getViewport, persistence]);
  persistRef.current = persist;

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void persistRef.current();
    }, 180);
  }, []);

  useEffect(() => {
    (persistence?.read() ?? readWorkspace()).then((source) => {
      const loaded = bootstrap ? bootstrap(source) : source;
      current.current = loaded;
      setDocument(loaded);
      setInitialViewport(loaded.viewport);
      setReady(true);
    }).catch(() => setReady(true));
  }, [bootstrap, persistence]);

  useEffect(() => persistence?.subscribe?.((source) => {
    const loaded = bootstrap ? bootstrap(source) : source;
    current.current = loaded;
    setDocument(loaded);
  }), [bootstrap, persistence]);

  useEffect(() => {
    if (persistence) return;
    let disposed = false;
    const refresh = async () => {
      if (saveTimer.current || saveInFlight.current) return;
      try {
        const source = await readWorkspace();
        if (disposed || source.revision <= current.current.revision) return;
        current.current = source;
        setDocument(source);
      } catch {
        // The native canvas remains usable while the next poll retries.
      }
    };
    const timer = window.setInterval(() => void refresh(), 750);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [persistence]);

  const mutate = useCallback((change: (nodes: WorkspaceNode[]) => WorkspaceNode[]) => {
    setDocument((before) => {
      mutationVersion.current += 1;
      past.current.push(before.nodes);
      if (past.current.length > 80) past.current.shift();
      future.current = [];
      // Revision is the authoritative Runtime sequence. Local optimistic edits
      // keep the last observed sequence; persistence advances it atomically.
      const next = { ...before, nodes: change(before.nodes), updatedAt: new Date().toISOString() };
      current.current = next;
      return next;
    });
    scheduleSave();
  }, [scheduleSave]);

  const addNode = useCallback((node: WorkspaceNode) => mutate((nodes) => [...nodes, node]), [mutate]);
  const patchNode = useCallback((id: string, patch: Partial<WorkspaceNode>) => mutate((nodes) => nodes.map((node) => node.id === id ? { ...node, ...patch, updatedAt: new Date().toISOString() } : node)), [mutate]);
  const removeNode = useCallback((id: string) => mutate((nodes) => nodes.filter((node) => node.id !== id)), [mutate]);
  const takeZ = useCallback(() => {
    const z = current.current.nextZ + 1;
    current.current.nextZ = z;
    return z;
  }, []);
  const bringToFront = useCallback((id: string) => {
    const node = current.current.nodes.find((entry) => entry.id === id);
    if (node) patchNode(id, { z: takeZ() });
  }, [patchNode, takeZ]);

  const restore = useCallback((source: React.MutableRefObject<WorkspaceNode[][]>, destination: React.MutableRefObject<WorkspaceNode[][]>) => {
    const nodes = source.current.pop();
    if (!nodes) return;
    destination.current.push(current.current.nodes);
    const next = { ...current.current, nodes, updatedAt: new Date().toISOString() };
    current.current = next;
    setDocument(next);
    scheduleSave();
  }, [scheduleSave]);

  return {
    ready,
    nodes: document.nodes,
    addNode,
    patchNode,
    removeNode,
    bringToFront,
    takeZ,
    initialViewport,
    scheduleSave,
    undo: () => restore(past, future),
    redo: () => restore(future, past)
  };
}
