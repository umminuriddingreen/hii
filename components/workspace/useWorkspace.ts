'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readWorkspace, writeWorkspace } from '@/lib/client/hii-bridge';
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

export function useWorkspace(getViewport: () => WorkspaceViewport): WorkspaceApi {
  const [document, setDocument] = useState<WorkspaceDoc>(emptyWorkspace);
  const [ready, setReady] = useState(false);
  const [initialViewport, setInitialViewport] = useState<WorkspaceViewport | null>(null);
  const current = useRef(document);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const past = useRef<WorkspaceNode[][]>([]);
  const future = useRef<WorkspaceNode[][]>([]);
  current.current = document;

  const persist = useCallback(async () => {
    const next = { ...current.current, viewport: getViewport(), updatedAt: new Date().toISOString() };
    try {
      const saved = await writeWorkspace(next);
      current.current = saved;
      setDocument(saved);
    } catch {
      // The next mutation retries. The in-memory canvas remains usable.
    }
  }, [getViewport]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(persist, 180);
  }, [persist]);

  useEffect(() => {
    readWorkspace().then((loaded) => {
      current.current = loaded;
      setDocument(loaded);
      setInitialViewport(loaded.viewport);
      setReady(true);
    }).catch(() => setReady(true));
  }, []);

  const mutate = useCallback((change: (nodes: WorkspaceNode[]) => WorkspaceNode[]) => {
    setDocument((before) => {
      past.current.push(before.nodes);
      if (past.current.length > 80) past.current.shift();
      future.current = [];
      const next = { ...before, nodes: change(before.nodes), revision: before.revision + 1, updatedAt: new Date().toISOString() };
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
    const next = { ...current.current, nodes, revision: current.current.revision + 1, updatedAt: new Date().toISOString() };
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
