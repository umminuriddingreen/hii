// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountWorkspacePersistence } from '../../lib/web/account-workspace';
import { NativeAccountWorkspacePersistence } from '../../lib/desktop/account-sync';
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
    await vi.advanceTimersByTimeAsync(2000);
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
    await vi.advanceTimersByTimeAsync(2000);
    const pending = adapter.write(doc(1, ['base', 'mine']));
    poll.resolve(doc(3, ['base', 'mine', 'theirs']));
    await vi.advanceTimersByTimeAsync(2000);
    expect(listener).not.toHaveBeenCalled();
    writing.resolve({ status: 200, document: doc(2, ['base', 'mine']) });
    await pending;
    await vi.advanceTimersByTimeAsync(2000);
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
    await vi.advanceTimersByTimeAsync(2000);
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }));
    await vi.advanceTimersByTimeAsync(2000);
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
    await vi.advanceTimersByTimeAsync(2000);
    adapter.dispose();
    const currentListener = vi.fn();
    adapter.subscribe(currentListener);
    oldPoll.resolve(doc(10, ['stale-scope']));
    await vi.advanceTimersByTimeAsync(2000);
    expect(oldListener).not.toHaveBeenCalled();
    expect(currentListener).toHaveBeenCalledTimes(1);
    expect(currentListener).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
    adapter.dispose();
  });
});
