// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspace, type WorkspaceApi, type WorkspacePersistence } from '../../components/workspace/useWorkspace';
import { emptyWorkspace, type WorkspaceDoc, type WorkspaceNode } from '../../lib/workspace/types';

vi.mock('../../lib/client/hii-bridge', () => ({ readWorkspace: vi.fn(), writeWorkspace: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const viewport = () => ({ x: 0, y: 0, zoom: 1 });
const node = (id: string): WorkspaceNode => ({ id, type: 'note', x: 0, y: 0, w: 100, h: 100, z: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01', payload: { content: id } });
const doc = (revision: number, ids: string[]) => ({ ...emptyWorkspace(), revision, nodes: ids.map(node) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function persistence(initial = doc(1, ['base'])) {
  let listener: ((value: WorkspaceDoc) => void) | undefined;
  const adapter: WorkspacePersistence = {
    read: vi.fn(async () => initial),
    write: vi.fn(async value => ({ ...value, revision: value.revision + 1 })),
    subscribe: vi.fn(next => { listener = next; return () => { listener = undefined; }; })
  };
  return { adapter, remote: (value: WorkspaceDoc) => listener?.(value) };
}
let root: Root;
let container: HTMLDivElement;
let api: WorkspaceApi;
function Harness({ adapter }: { adapter: WorkspacePersistence }) {
  api = useWorkspace(viewport, undefined, adapter);
  return null;
}
async function render(adapter: WorkspacePersistence, key = 'one') {
  await act(async () => { root.render(<Harness key={key} adapter={adapter} />); });
}
async function advance(ms = 180) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('workspace synchronization lifecycle', () => {
  it('undo and redo preserve independent agent objects and fields', async () => {
    const { adapter, remote } = persistence();
    await render(adapter);
    act(() => api.patchNode('base', { x: 40 }));
    await advance();
    const external = doc(3, ['base', 'agent']);
    external.nodes[0] = { ...external.nodes[0], x: 40, payload: { content: 'agent revision' } };
    act(() => remote(external));
    act(() => api.undo());
    expect(api.nodes.map(n => n.id)).toEqual(['base', 'agent']);
    expect(api.nodes[0]).toMatchObject({ x: 0, payload: { content: 'agent revision' } });
    act(() => api.redo());
    expect(api.nodes[0]).toMatchObject({ x: 40, payload: { content: 'agent revision' } });
    expect(api.nodes.map(n => n.id)).toContain('agent');
  });

  it('undo does not overwrite a newer edit to the same field', async () => {
    const { adapter, remote } = persistence();
    await render(adapter);
    act(() => api.patchNode('base', { x: 40 }));
    await advance();
    const external = doc(3, ['base']);
    external.nodes[0].x = 90;
    act(() => remote(external));
    act(() => api.undo());
    expect(api.nodes[0].x).toBe(90);
  });

  it('restores deleted node links without replacing independent remote links', async () => {
    const initial = doc(1, ['base', 'other']);
    initial.links = [{ id: 'original', fromId: 'base', toId: 'other' }];
    const { adapter, remote } = persistence(initial);
    await render(adapter);
    act(() => api.removeNode('base'));
    await act(async () => { await api.flush(); });
    expect(vi.mocked(adapter.write).mock.calls[0][0].links).toEqual([]);
    const external = doc(3, ['other', 'agent']);
    external.links = [{ id: 'agent-link', fromId: 'other', toId: 'agent' }];
    act(() => remote(external));
    act(() => api.undo());
    let restored!: WorkspaceDoc;
    await act(async () => { restored = await api.flush(); });
    expect(restored.links.map(link => link.id).sort()).toEqual(['agent-link', 'original']);
    act(() => api.redo());
    await act(async () => { restored = await api.flush(); });
    expect(restored.links.map(link => link.id)).toEqual(['agent-link']);
    expect(restored.nodes.map(n => n.id)).toEqual(['other', 'agent']);
  });

  it('flush commits debounced edits and returns the acknowledged revision', async () => {
    const { adapter } = persistence();
    await render(adapter);
    act(() => api.addNode(node('selected')));
    let committed!: WorkspaceDoc;
    await act(async () => { committed = await api.flush(); });
    expect(committed.revision).toBe(2);
    expect(committed.nodes.map(n => n.id)).toContain('selected');
    expect(api.hasUnsavedChanges).toBe(false);
    await advance();
    expect(adapter.write).toHaveBeenCalledTimes(1);
  });

  it('flush waits for edits made during an in-flight save', async () => {
    const { adapter } = persistence();
    const save = deferred<WorkspaceDoc>();
    vi.mocked(adapter.write).mockImplementationOnce(() => save.promise);
    await render(adapter);
    act(() => api.addNode(node('first')));
    await advance();
    act(() => api.addNode(node('second')));
    let committed!: WorkspaceDoc;
    await act(async () => {
      const flushing = api.flush();
      save.resolve(doc(2, ['base', 'first']));
      committed = await flushing;
    });
    expect(committed.revision).toBe(3);
    expect(committed.nodes.map(n => n.id)).toContain('second');
    expect(adapter.write).toHaveBeenCalledTimes(2);
  });

  it('flush rejects failed persistence instead of authorizing stale context', async () => {
    const { adapter } = persistence();
    await render(adapter);
    act(() => api.addNode(node('selected')));
    vi.mocked(adapter.write).mockRejectedValueOnce(new Error('disk unavailable'));
    await act(async () => { await expect(api.flush()).rejects.toThrow('disk unavailable'); });
    expect(api.hasUnsavedChanges).toBe(true);
  });

  it('flush rejects when its workspace changes while awaiting persistence', async () => {
    const first = persistence();
    const second = persistence(doc(1, ['other']));
    const save = deferred<WorkspaceDoc>();
    vi.mocked(first.adapter.write).mockImplementationOnce(() => save.promise);
    await render(first.adapter);
    act(() => api.addNode(node('selected')));
    let flushing!: Promise<WorkspaceDoc>;
    let rejected!: Promise<void>;
    act(() => {
      flushing = api.flush();
      rejected = expect(flushing).rejects.toThrow('Workspace changed while saving.');
    });
    await render(second.adapter);
    await act(async () => { save.resolve(doc(2, ['base', 'selected'])); await rejected; });
    expect(api.nodes.map(n => n.id)).toEqual(['other']);
    expect(second.adapter.write).not.toHaveBeenCalled();
  });

  it('merges a remote poll during debounce without erasing the local addition', async () => {
    const { adapter, remote } = persistence();
    await render(adapter);
    act(() => api.addNode(node('mine')));
    act(() => remote(doc(2, ['base', 'theirs'])));
    expect(api.nodes.map(n => n.id).sort()).toEqual(['base', 'mine', 'theirs']);
    await advance();
    expect(vi.mocked(adapter.write).mock.calls[0][0].nodes.map(n => n.id).sort()).toEqual(['base', 'mine', 'theirs']);
    expect(api.hasUnsavedChanges).toBe(false);
  });

  it('retains newer edits and remote nodes when an older save completes', async () => {
    const { adapter, remote } = persistence();
    const save = deferred<WorkspaceDoc>();
    vi.mocked(adapter.write).mockImplementationOnce(() => save.promise);
    await render(adapter);
    act(() => api.addNode(node('mine')));
    await advance();
    act(() => api.addNode(node('later')));
    act(() => remote(doc(3, ['base', 'mine', 'theirs'])));
    await act(async () => save.resolve(doc(2, ['base', 'mine'])));
    expect(api.nodes.map(n => n.id).sort()).toEqual(['base', 'later', 'mine', 'theirs']);
    await advance();
    expect(api.hasUnsavedChanges).toBe(false);
  });

  it('keeps a failed save dirty, warns on close, and allows an explicit retry', async () => {
    const { adapter, remote } = persistence();
    vi.mocked(adapter.write).mockRejectedValueOnce(new Error('offline'));
    await render(adapter);
    act(() => api.addNode(node('mine')));
    await advance();
    expect(api.syncError).toBe('offline');
    expect(api.hasUnsavedChanges).toBe(true);
    act(() => remote(doc(2, ['base', 'theirs'])));
    expect(api.nodes.map(n => n.id)).toContain('mine');
    const closing = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(closing);
    expect(closing.defaultPrevented).toBe(true);
    await act(async () => api.retrySave());
    expect(api.syncError).toBeNull();
    expect(api.hasUnsavedChanges).toBe(false);
  });

  it('flushes a pending old-workspace draft only to its original adapter', async () => {
    const first = persistence();
    const second = persistence(doc(1, ['other-workspace']));
    await render(first.adapter);
    act(() => api.addNode(node('mine')));
    await render(second.adapter, 'two');
    await advance();
    expect(first.adapter.write).toHaveBeenCalledTimes(1);
    expect(second.adapter.write).not.toHaveBeenCalled();
    expect(api.nodes.map(n => n.id)).toEqual(['other-workspace']);
  });

  it('ignores the previous adapter read after switching scope', async () => {
    const first = persistence();
    const read = deferred<WorkspaceDoc>();
    vi.mocked(first.adapter.read).mockReturnValue(read.promise);
    const second = persistence(doc(3, ['correct']));
    await render(first.adapter);
    await render(second.adapter);
    await act(async () => read.resolve(doc(5, ['wrong'])));
    expect(api.nodes.map(n => n.id)).toEqual(['correct']);
  });

  it('does not overwrite a failed initial load and can retry it', async () => {
    const { adapter, remote } = persistence();
    vi.mocked(adapter.read).mockRejectedValueOnce(new Error('load unavailable'));
    await render(adapter);
    expect(api.ready).toBe(false);
    expect(api.syncError).toBe('load unavailable');
    expect(adapter.write).not.toHaveBeenCalled();
    act(() => { api.addNode(node('too-early')); api.scheduleSave(); });
    expect(api.hasUnsavedChanges).toBe(false);
    await act(async () => api.retrySave());
    expect(api.ready).toBe(true);
    expect(api.nodes.map(n => n.id)).toEqual(['base']);
    act(() => remote(doc(2, ['base', 'after-retry'])));
    expect(api.nodes.map(n => n.id)).toEqual(['base', 'after-retry']);
  });

  it('retries a failed clean synchronization without creating a write', async () => {
    const { adapter } = persistence();
    let reportError: ((error: unknown) => void) | undefined;
    vi.mocked(adapter.subscribe!).mockImplementation((_listener, onError) => { reportError = onError; return () => {}; });
    await render(adapter);
    act(() => reportError?.(new Error('poll failed')));
    expect(api.syncError).toBe('poll failed');
    await act(async () => api.retrySave());
    expect(api.syncError).toBeNull();
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('preserves undo performed while a save is in flight', async () => {
    const { adapter } = persistence();
    const save = deferred<WorkspaceDoc>();
    vi.mocked(adapter.write).mockImplementationOnce(() => save.promise);
    await render(adapter);
    act(() => api.addNode(node('mine')));
    await advance();
    act(() => api.undo());
    await act(async () => save.resolve(doc(2, ['base', 'mine'])));
    expect(api.nodes.map(n => n.id)).toEqual(['base']);
    await advance();
    expect(api.hasUnsavedChanges).toBe(false);
  });
});
