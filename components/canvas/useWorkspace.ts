'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeWorkspace, type CanvasNode, type WorkspaceDoc, type WorkspaceViewport } from '../../lib/canvas/types';

export type WorkspaceApi = {
  ready: boolean;
  nodes: CanvasNode[];
  addNode: (node: CanvasNode) => void;
  patchNode: (id: string, patch: Partial<CanvasNode>) => void;
  removeNode: (id: string) => void;
  bringToFront: (id: string) => void;
  takeZ: () => number;
  initialViewport: WorkspaceViewport | null;
  scheduleSave: () => void;
};

export function useWorkspace(getViewport: () => WorkspaceViewport): WorkspaceApi {
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [ready, setReady] = useState(false);
  const [initialViewport, setInitialViewport] = useState<WorkspaceViewport | null>(null);
  const nextZ = useRef(1);
  const nodesRef = useRef<CanvasNode[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  nodesRef.current = nodes;

  const persist = useCallback(async () => {
    const doc: WorkspaceDoc = {
      version: 1,
      updatedAt: new Date().toISOString(),
      viewport: getViewport(),
      nextZ: nextZ.current,
      nodes: nodesRef.current.filter((node) => !node.payload.ephemeral || node.type !== 'image')
    };
    try {
      await fetch('/api/canvas/workspace', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(doc)
      });
    } catch {
      /* local-only surface; retry on next mutation */
    }
  }, [getViewport]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(persist, 750);
  }, [persist]);

  const load = useCallback(async (initial: boolean) => {
    try {
      const res = await fetch('/api/canvas/workspace', { cache: 'no-store' });
      if (!res.ok) return;
      const doc = normalizeWorkspace(await res.json());
      nextZ.current = Math.max(nextZ.current, doc.nextZ);
      if (initial) {
        setNodes(doc.nodes);
        setInitialViewport(doc.viewport);
      } else {
        // merge externally edited nodes (agents writing workspace.json) by updatedAt
        setNodes((current) => {
          const byId = new Map(current.map((node) => [node.id, node]));
          const merged = doc.nodes.map((incoming) => {
            const mine = byId.get(incoming.id);
            byId.delete(incoming.id);
            return mine && mine.updatedAt >= incoming.updatedAt ? mine : incoming;
          });
          // keep local nodes created since the file was last written
          for (const leftover of byId.values()) {
            if (leftover.updatedAt > doc.updatedAt || leftover.payload.ephemeral) merged.push(leftover);
          }
          return merged;
        });
      }
    } catch {
      /* ignore */
    } finally {
      if (initial) setReady(true);
    }
  }, []);

  useEffect(() => {
    load(true);
  }, [load]);

  useEffect(() => {
    const onFocus = () => load(false);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const addNode = useCallback(
    (node: CanvasNode) => {
      setNodes((current) => [...current, node]);
      scheduleSave();
    },
    [scheduleSave]
  );

  const patchNode = useCallback(
    (id: string, patch: Partial<CanvasNode>) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === id ? { ...node, ...patch, updatedAt: new Date().toISOString() } : node
        )
      );
      scheduleSave();
    },
    [scheduleSave]
  );

  const removeNode = useCallback(
    (id: string) => {
      setNodes((current) => {
        const node = current.find((n) => n.id === id);
        const url = node?.payload.url;
        if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url);
        return current.filter((n) => n.id !== id);
      });
      scheduleSave();
    },
    [scheduleSave]
  );

  const takeZ = useCallback(() => ++nextZ.current, []);

  const bringToFront = useCallback(
    (id: string) => {
      const node = nodesRef.current.find((n) => n.id === id);
      if (!node || node.z >= nextZ.current) return;
      patchNode(id, { z: ++nextZ.current });
    },
    [patchNode]
  );

  return { ready, nodes, addNode, patchNode, removeNode, bringToFront, takeZ, initialViewport, scheduleSave };
}
