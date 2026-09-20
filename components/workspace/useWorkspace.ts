'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readWorkspace, writeWorkspace } from '@/lib/client/hii-bridge';
import { rebaseWorkspaceDoc, reconcileWorkspaceSave } from '@/lib/workspace/rebase';
import { reverseWorkspaceChange } from '@/lib/workspace/reverse-change';
import { emptyWorkspace, type WorkspaceDoc, type WorkspaceNode, type WorkspaceViewport } from '@/lib/workspace/types';

export type WorkspaceApi = {
  ready: boolean;
  saving: boolean;
  syncError: string | null;
  hasUnsavedChanges: boolean;
  retrySave: () => void;
  flush: () => Promise<WorkspaceDoc>;
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
  subscribe?: (listener: (document: WorkspaceDoc) => void, onError?: (error: unknown) => void) => () => void;
};

export function useWorkspace(
  getViewport: () => WorkspaceViewport,
  bootstrap?: (document: WorkspaceDoc) => WorkspaceDoc,
  persistence?: WorkspacePersistence
): WorkspaceApi {
  const [document, setDocument] = useState<WorkspaceDoc>(emptyWorkspace);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [initialViewport, setInitialViewport] = useState<WorkspaceViewport | null>(null);
  const current = useRef(document);
  const mutationVersion = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlight = useRef(false);
  const saveQueued = useRef(false);
  const authoritative = useRef(document);
  const dirty = useRef(false);
  const loaded = useRef(false);
  const epoch = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const persistRef = useRef<() => Promise<void>>(async () => undefined);
  const saveError = useRef<Error | null>(null);
  type Change = { before: WorkspaceDoc; after: WorkspaceDoc };
  const past = useRef<Change[]>([]);
  const future = useRef<Change[]>([]);

  const receive = useCallback((source: WorkspaceDoc) => {
    if (source.revision <= authoritative.current.revision) return;
    const next = dirty.current
      ? rebaseWorkspaceDoc(current.current, source, authoritative.current)
      : { ...source, viewport: getViewport() };
    authoritative.current = source;
    current.current = next;
    mutationVersion.current += 1;
    setDocument(next);
  }, [getViewport]);

  const persist = useCallback(async () => {
    if (!loaded.current || !dirty.current) return;
    if (saveInFlight.current) {
      saveQueued.current = true;
      return;
    }
    const submittedVersion = mutationVersion.current;
    const scope = epoch.current;
    const next = { ...current.current, viewport: getViewport(), updatedAt: new Date().toISOString() };
    saveInFlight.current = true;
    saveError.current = null;
    setSaving(true);
    try {
      const saved = await (persistence?.write(next) ?? writeWorkspace(next));
      if (scope !== epoch.current) return;
      const changedWhileSaving = mutationVersion.current !== submittedVersion;
      const newest = saved.revision >= authoritative.current.revision ? saved : authoritative.current;
      const reconciled = reconcileWorkspaceSave(current.current, newest, next, changedWhileSaving);
      authoritative.current = newest;
      current.current = reconciled;
      setDocument(reconciled);
      dirty.current = changedWhileSaving;
      setHasUnsavedChanges(changedWhileSaving);
      setSyncError(null);
      if (changedWhileSaving) saveQueued.current = true;
    } catch (error) {
      if (scope !== epoch.current) return;
      saveError.current = error instanceof Error ? error : new Error(String(error));
      setSyncError(error instanceof Error ? error.message : String(error));
    } finally {
      if (scope !== epoch.current) return;
      saveInFlight.current = false;
      setSaving(false);
      if (saveQueued.current) {
        saveQueued.current = false;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null;
          inFlight.current = persistRef.current();
        }, 180);
      }
    }
  }, [getViewport, persistence]);
  persistRef.current = persist;

  const flush = useCallback(async () => {
    const scope = epoch.current;
    if (!loaded.current) throw new Error('Workspace is not loaded.');
    do {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (saveInFlight.current) await inFlight.current;
      else if (dirty.current) {
        inFlight.current = persistRef.current();
        await inFlight.current;
      }
      if (scope !== epoch.current) throw new Error('Workspace changed while saving.');
      if (saveError.current) throw saveError.current;
    } while (dirty.current || saveInFlight.current);
    return authoritative.current;
  }, []);

  const scheduleSave = useCallback(() => {
    if (!loaded.current) return;
    dirty.current = true;
    setHasUnsavedChanges(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      inFlight.current = persistRef.current();
    }, 180);
  }, []);

  useEffect(() => {
    const scope = ++epoch.current;
    loaded.current = false;
    dirty.current = false;
    saveInFlight.current = false;
    saveQueued.current = false;
    saveError.current = null;
    inFlight.current = null;
    current.current = emptyWorkspace();
    authoritative.current = current.current;
    past.current = [];
    future.current = [];
    setDocument(current.current);
    setReady(false);
    setSaving(false);
    setSyncError(null);
    setHasUnsavedChanges(false);
    (persistence?.read() ?? readWorkspace()).then((source) => {
      if (epoch.current !== scope) return;
      const initial = bootstrap ? bootstrap(source) : source;
      current.current = dirty.current ? rebaseWorkspaceDoc(current.current, initial, authoritative.current) : initial;
      authoritative.current = initial;
      loaded.current = true;
      setDocument(current.current);
      setInitialViewport(initial.viewport);
      setReady(true);
      if (dirty.current) scheduleSave();
    }).catch((error) => {
      if (epoch.current !== scope) return;
      setSyncError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      // Flush only to the adapter this scope loaded; a new workspace cannot inherit the write.
      const pending = loaded.current && dirty.current
        ? { ...current.current, viewport: getViewport(), updatedAt: new Date().toISOString() }
        : null;
      const previousSave = inFlight.current;
      epoch.current += 1;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (pending) {
        const write = persistence ? (value: WorkspaceDoc) => persistence.write(value) : writeWorkspace;
        void (previousSave ?? Promise.resolve()).then(() => write(pending)).catch((error) => {
          console.error('Workspace save during close failed', error);
        });
      }
    };
  }, [bootstrap, getViewport, persistence, scheduleSave, loadAttempt]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  useEffect(() => {
    const scope = epoch.current;
    return persistence?.subscribe?.((source) => {
      if (scope !== epoch.current || !loaded.current) return;
      receive(bootstrap ? bootstrap(source) : source);
      if (!dirty.current) setSyncError(null);
    }, (error) => {
      if (scope === epoch.current) setSyncError(error instanceof Error ? error.message : String(error));
    });
  }, [bootstrap, persistence, receive, loadAttempt]);

  useEffect(() => {
    if (persistence) return;
    let disposed = false;
    const refresh = async () => {
      if (!loaded.current || saveInFlight.current) return;
      try {
        const source = await readWorkspace();
        if (disposed) return;
        receive(source);
        if (!dirty.current) setSyncError(null);
      } catch (error) {
        if (!disposed) setSyncError(error instanceof Error ? error.message : String(error));
      }
    };
    const timer = window.setInterval(() => void refresh(), 750);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [persistence, receive]);

  const mutate = useCallback((change: (nodes: WorkspaceNode[]) => WorkspaceNode[]) => {
    if (!loaded.current) return;
    const before = current.current;
    mutationVersion.current += 1;
    // Revision is the authoritative Runtime sequence. Local optimistic edits
    // keep the last observed sequence; persistence advances it atomically.
    const nodes = change(before.nodes);
    const ids = new Set(nodes.map(node => node.id));
    const next = { ...before, nodes, links: before.links.filter(link => ids.has(link.fromId) && ids.has(link.toId)), updatedAt: new Date().toISOString() };
    past.current.push({ before, after: next });
    if (past.current.length > 80) past.current.shift();
    future.current = [];
    current.current = next;
    setDocument(next);
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

  const restore = useCallback((source: React.MutableRefObject<Change[]>, destination: React.MutableRefObject<Change[]>) => {
    const change = source.current.pop();
    if (!change) return;
    const before = current.current;
    const next = reverseWorkspaceChange(change.before, change.after, before);
    destination.current.push({ before, after: next });
    mutationVersion.current += 1;
    current.current = next;
    setDocument(next);
    scheduleSave();
  }, [scheduleSave]);

  return {
    ready,
    saving,
    syncError,
    hasUnsavedChanges,
    flush,
    retrySave: () => {
      if (!loaded.current) setLoadAttempt((attempt) => attempt + 1);
      else if (dirty.current) inFlight.current = persistRef.current();
      else {
        const scope = epoch.current;
        void (persistence?.read() ?? readWorkspace()).then((source) => {
          if (scope !== epoch.current) return;
          receive(bootstrap ? bootstrap(source) : source);
          setSyncError(null);
        }).catch((error) => {
          if (scope === epoch.current) setSyncError(error instanceof Error ? error.message : String(error));
        });
      }
    },
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
