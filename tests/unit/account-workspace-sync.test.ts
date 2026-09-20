// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountWorkspacePersistence } from '../../lib/web/account-workspace';
import { NativeAccountWorkspacePersistence } from '../../lib/desktop/account-sync';
import { ACCOUNT_CANVAS_SYNC_INTERVAL_MS } from '../../lib/workspace/account-sync-timing';
import { emptyWorkspace, type WorkspaceDoc, type WorkspaceNode } from '../../lib/workspace/types';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => native);
const node = (id: string): WorkspaceNode => ({ id, type: 'note', x: 0, y: 0, w: 100, h: 100, z: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01', payload: { content: id } });
const doc = (revision: number, ids: string[]) => ({ ...emptyWorkspace(), revision, nodes: ids.map(node) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const envelope = (document: WorkspaceDoc) => ({ workspace: { document } });

beforeEach(() => {
  vi.useFakeTimers();
  native.invoke.mockReset();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('native Runtime conflicts preserve competing text instead of picking a timestamp winner', async () => {
  const base = doc(2, ['one']);
  const local = structuredClone(base);
  local.nodes[0].payload.content = 'unsaved canvas text';
  local.nodes[0].updatedAt = '2026-03-01';
  const competing = structuredClone(base);
  competing.revision = 3;
  competing.nodes[0].payload.content = 'concurrent CLI text';
  native.invoke.mockImplementation(async command => command === 'account_workspace_read'
    ? { status: 200, body: envelope(base) }
    : { status: 409, body: envelope(competing) });
  const adapter = new NativeAccountWorkspacePersistence('workspace');
  await adapter.read();
  await expect(adapter.write(local)).rejects.toThrow('conflict at nodes/one/payload/content');
  expect(native.invoke.mock.calls.filter(([command]) => command === 'account_workspace_write')).toHaveLength(1);
  expect(local.nodes[0].payload.content).toBe('unsaved canvas text');
  adapter.dispose();
});

it('native account documents use Runtime sequence rather than the hosted revision', async () => {
  const document = doc(3, ['one']);
  native.invoke.mockResolvedValue({ status: 200, body: { workspace: {
    revision: 87, remoteRevision: 87, runtimeSpaceId: 'workspace', document
  } } });
  const adapter = new NativeAccountWorkspacePersistence('workspace');
  expect((await adapter.read()).revision).toBe(3);
  native.invoke.mockResolvedValue({ status: 200, body: { workspace: {
    runtimeSpaceId: 'another-workspace', document
  } } });
  await expect(adapter.read()).rejects.toThrow('account_projection_space_mismatch');
  adapter.dispose();
});

it('mirrors a board between real web/native adapters and preserves independent edits after reopening', async () => {
  let stored = doc(1, ['shared']);
  const transact = (next: WorkspaceDoc, expected: number) => {
    if (expected !== stored.revision) return { status: 409, document: structuredClone(stored) };
    stored = structuredClone({ ...next, revision: stored.revision + 1 });
    return { status: 200, document: structuredClone(stored) };
  };
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'account_workspace_read') return { status: 200, body: envelope(structuredClone(stored)) };
    const saved = transact(args.document, args.expectedRevision);
    return { status: saved.status, body: envelope(saved.document) };
  });
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    const saved = options?.method === 'POST'
      ? (() => { const request = JSON.parse(options.body); return transact(request.document, request.expectedRevision); })()
      : { status: 200, document: structuredClone(stored) };
    return new Response(JSON.stringify(envelope(saved.document)), { status: saved.status });
  }));
  const web = new AccountWorkspacePersistence('shared-board', 'csrf');
  const mac = new NativeAccountWorkspacePersistence('shared-board');
  const [webDoc, macDoc] = await Promise.all([web.read(), mac.read()]);
  await web.write({ ...webDoc, nodes: [{ ...webDoc.nodes[0], payload: { content: 'browser edit' }, updatedAt: '2026-02-01' }] });
  await mac.write({ ...macDoc, nodes: [{ ...macDoc.nodes[0], x: 420, updatedAt: '2026-02-02' }] });
  const changed = vi.fn();
  web.subscribe(changed);
  await vi.advanceTimersByTimeAsync(ACCOUNT_CANVAS_SYNC_INTERVAL_MS);
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({ nodes: [expect.objectContaining({ x: 420, payload: { content: 'browser edit' } })] }));
  web.dispose(); mac.dispose();
  const reopened = new NativeAccountWorkspacePersistence('shared-board');
  expect((await reopened.read()).nodes[0]).toMatchObject({ x: 420, payload: { content: 'browser edit' } });
  reopened.dispose();
});

describe.each(['web', 'native'] as const)('%s account canvas synchronization', kind => {
  function setup() {
    const read = vi.fn<() => Promise<WorkspaceDoc>>();
    const save = vi.fn<(document: WorkspaceDoc, expectedRevision: number) => Promise<{ status: number; document: WorkspaceDoc }>>();
    if (kind === 'native') {
      native.invoke.mockImplementation(async (command, args) => {
        if (command === 'account_workspace_read') return { status: 200, body: envelope(await read()) };
        const result = await save(args.document, args.expectedRevision);
        return { status: result.status, body: envelope(result.document) };
      });
    } else {
      vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        if (options?.method === 'POST') {
          const body = JSON.parse(options.body);
          const result = await save(body.document, body.expectedRevision);
          return new Response(JSON.stringify(envelope(result.document)), { status: result.status });
        }
        return new Response(JSON.stringify(envelope(await read())), { status: 200 });
      }));
    }
    const adapter = kind === 'native'
      ? new NativeAccountWorkspacePersistence('workspace')
      : new AccountWorkspacePersistence('workspace', 'test-csrf');
    return { adapter, read, save };
  }

  it('uses the submitted revision after a newer poll, preserving both clients on conflict', async () => {
    const { adapter, read, save } = setup();
    read.mockResolvedValueOnce(doc(1, ['base'])).mockResolvedValue(doc(2, ['base', 'theirs']));
    save.mockResolvedValueOnce({ status: 409, document: doc(2, ['base', 'theirs']) })
      .mockImplementationOnce(async value => ({ status: 200, document: { ...value, revision: 3 } }));
    await adapter.read();
    adapter.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(ACCOUNT_CANVAS_SYNC_INTERVAL_MS);
    const saved = await adapter.write(doc(1, ['base', 'mine']));
    expect(save.mock.calls[0][1]).toBe(1);
    expect(save.mock.calls[1][1]).toBe(2);
    expect(saved.nodes.map(n => n.id).sort()).toEqual(['base', 'mine', 'theirs']);
    adapter.dispose();
  });

  it('discards poll results overlapping a save and resumes polling afterward', async () => {
    const { adapter, read, save } = setup();
    const poll = deferred<WorkspaceDoc>();
    const writing = deferred<{ status: number; document: WorkspaceDoc }>();
    read.mockResolvedValueOnce(doc(1, ['base'])).mockReturnValueOnce(poll.promise).mockResolvedValue(doc(3, ['base', 'mine', 'theirs']));
    save.mockReturnValue(writing.promise);
    await adapter.read();
    const listener = vi.fn();
    adapter.subscribe(listener);
    await vi.advanceTimersByTimeAsync(ACCOUNT_CANVAS_SYNC_INTERVAL_MS);
    const pending = adapter.write(doc(1, ['base', 'mine']));
    poll.resolve(doc(3, ['base', 'mine', 'theirs']));
    await vi.advanceTimersByTimeAsync(ACCOUNT_CANVAS_SYNC_INTERVAL_MS);
    expect(listener).not.toHaveBeenCalled();
    writing.resolve({ status: 200, document: doc(2, ['base', 'mine']) });
    await pending;
    await vi.advanceTimersByTimeAsync(ACCOUNT_CANVAS_SYNC_INTERVAL_MS);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ revision: 3 }));
    adapter.dispose();
  });

  it('reports polling failures and suppresses late updates after disposal', async () => {
    const { adapter, read } = setup();
    const pending = deferred<WorkspaceDoc>();
    read.mockResolvedValueOnce(doc(1, ['base'])).mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(pending.promise);
    await adapter.read();
    const listener = vi.fn();
    const errors = vi.fn();
    adapter.subscribe(listener, errors);
    await vi.advanceTimersByTimeAsync(ACCOUNT_CANVAS_SYNC_INTERVAL_MS);
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }));
    await vi.advanceTimersByTimeAsync(ACCOUNT_CANVAS_SYNC_INTERVAL_MS);
    adapter.dispose();
    pending.resolve(doc(2, ['wrong']));
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('resubscribes after StrictMode cleanup without reviving the old poll', async () => {
    const { adapter, read } = setup();
    const oldPoll = deferred<WorkspaceDoc>();
    read.mockResolvedValueOnce(doc(1, ['base'])).mockReturnValueOnce(oldPoll.promise)
      .mockResolvedValue(doc(2, ['base', 'current']));
    await adapter.read();
    const oldListener = vi.fn();
    adapter.subscribe(oldListener);
    await vi.advanceTimersByTimeAsync(ACCOUNT_CANVAS_SYNC_INTERVAL_MS);
    adapter.dispose();
    const currentListener = vi.fn();
    adapter.subscribe(currentListener);
    oldPoll.resolve(doc(10, ['stale-scope']));
    await vi.advanceTimersByTimeAsync(ACCOUNT_CANVAS_SYNC_INTERVAL_MS);
    expect(oldListener).not.toHaveBeenCalled();
    expect(currentListener).toHaveBeenCalledTimes(1);
    expect(currentListener).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
    adapter.dispose();
  });
});
