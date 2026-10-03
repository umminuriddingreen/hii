import { describe, expect, it, vi } from 'vitest';
import { createNativeBrowserBoundsSync, type NativeBrowserBounds } from '@/lib/workspace/native-browser-bounds';

function harness() {
  let bounds: NativeBrowserBounds = { x: 0, y: 0, width: 100, height: 80 };
  let nextFrame = 0;
  const frames = new Map<number, () => void>();
  const positions: NativeBrowserBounds[] = [];
  const sizes: NativeBrowserBounds[] = [];
  const sync = createNativeBrowserBoundsSync({
    read: () => bounds,
    applyPosition: async (next) => { positions.push(next); },
    applySize: async (next) => { sizes.push(next); },
    requestFrame: (callback) => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelFrame: (id) => { frames.delete(id); },
    onError: vi.fn()
  });
  return {
    sync, positions, sizes,
    setBounds(next: NativeBrowserBounds) { bounds = next; },
    flushFrame() { const [id, callback] = [...frames.entries()][0] || []; if (id) { frames.delete(id); callback(); } },
    hasFrame() { return frames.size > 0; }
  };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('native browser bounds scheduler', () => {
  it('coalesces invalidations and does not resize for position-only pans', async () => {
    const h = harness();
    h.sync.schedule();
    h.sync.schedule();
    expect(h.hasFrame()).toBe(true);
    h.flushFrame();
    await settle();
    expect(h.positions).toHaveLength(1);
    expect(h.sizes).toHaveLength(1);

    h.setBounds({ x: 12, y: 4, width: 100, height: 80 });
    h.sync.schedule();
    h.sync.schedule();
    h.flushFrame();
    await settle();
    expect(h.positions).toHaveLength(2);
    expect(h.sizes).toHaveLength(1);
  });

  it('retries the newest bounds after an update is in flight', async () => {
    let finishPosition!: () => void;
    let current: NativeBrowserBounds = { x: 0, y: 0, width: 100, height: 80 };
    const seen: NativeBrowserBounds[] = [];
    let callback: (() => void) | undefined;
    let frameRequests = 0;
    const sync = createNativeBrowserBoundsSync({
      read: () => current,
      applyPosition: (next) => { seen.push(next); return new Promise<void>((resolve) => { finishPosition = resolve; }); },
      applySize: async () => {},
      requestFrame: (next) => { frameRequests += 1; callback = next; return 1; },
      cancelFrame: () => { callback = undefined; },
      onError: vi.fn()
    });
    sync.schedule();
    callback?.();
    current = { ...current, x: 20 };
    sync.schedule();
    current = { ...current, x: 30 };
    finishPosition();
    await settle();
    callback?.();
    await settle();
    expect(seen.map(({ x }) => x)).toEqual([0, 30]);
    sync.dispose();
  });

  it('cancels queued work and suppresses late errors after disposal', async () => {
    let callback: (() => void) | undefined;
    let frameRequests = 0;
    let rejectPosition!: (reason: Error) => void;
    const onError = vi.fn();
    const sync = createNativeBrowserBoundsSync({
      read: () => ({ x: 0, y: 0, width: 100, height: 80 }),
      applyPosition: () => new Promise<void>((_resolve, reject) => { rejectPosition = reject; }),
      applySize: async () => {},
      requestFrame: (next) => { frameRequests += 1; callback = next; return 1; },
      cancelFrame: () => { callback = undefined; },
      onError
    });
    sync.schedule();
    callback?.();
    sync.schedule();
    sync.dispose();
    rejectPosition(new Error('closed webview'));
    await settle();
    expect(frameRequests).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
