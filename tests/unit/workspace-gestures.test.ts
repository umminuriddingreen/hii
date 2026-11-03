import { describe, expect, it, vi } from 'vitest';
import { scaleGestureDelta, trackPointerGesture } from '../../lib/workspace/gestures';

/** Minimal event target that records what is still subscribed. */
function fakeTarget() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    addEventListener(type: string, handler: (event: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: (event: Event) => void) {
      listeners.get(type)?.delete(handler);
    },
    emit(type: string, event: unknown) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event as Event);
    },
    count() {
      return [...listeners.values()].reduce((total, set) => total + set.size, 0);
    }
  };
}

/** A scheduler whose frames only run when the test says so. */
function manualFrames() {
  let queue: Array<() => void> = [];
  return {
    schedule(callback: () => void) {
      queue.push(callback);
      return queue.length;
    },
    cancelSchedule() {},
    flush() {
      const pending = queue;
      queue = [];
      for (const callback of pending) callback();
    },
    get pending() {
      return queue.length;
    }
  };
}

const pointer = (x: number, y: number, pointerId = 1) => ({ clientX: x, clientY: y, pointerId, target: null });

describe('workspace pointer gestures', () => {
  it('collapses a burst of pointer moves into a single frame of work', () => {
    const target = fakeTarget();
    const frames = manualFrames();
    const onMove = vi.fn();

    trackPointerGesture(pointer(0, 0) as never, { target, onMove, ...frames });
    for (let step = 1; step <= 60; step += 1) target.emit('pointermove', pointer(step, step));

    // Sixty events, one scheduled frame, and no work done until it runs.
    expect(onMove).not.toHaveBeenCalled();
    expect(frames.pending).toBe(1);

    frames.flush();
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][0]).toEqual({ dx: 60, dy: 60 });
  });

  it('commits the exact final position even when the last move never got a frame', () => {
    const target = fakeTarget();
    const frames = manualFrames();
    const onMove = vi.fn();
    const onEnd = vi.fn();

    trackPointerGesture(pointer(0, 0) as never, { target, onMove, onEnd, ...frames });
    target.emit('pointermove', pointer(10, 4));
    frames.flush();
    target.emit('pointermove', pointer(37, 19)); // still queued
    target.emit('pointerup', pointer(37, 19));

    expect(onMove).toHaveBeenLastCalledWith({ dx: 37, dy: 19 }, expect.anything());
    expect(onEnd).toHaveBeenCalledWith({ dx: 37, dy: 19 }, true, expect.anything());
  });

  it('reports a click as an unmoved gesture so it does not write to the document', () => {
    const target = fakeTarget();
    const onEnd = vi.fn();

    trackPointerGesture(pointer(0, 0) as never, { target, onEnd, ...manualFrames() });
    target.emit('pointermove', pointer(1, 0)); // below the drag threshold
    target.emit('pointerup', pointer(1, 0));

    expect(onEnd).toHaveBeenCalledWith({ dx: 1, dy: 0 }, false, expect.anything());
  });

  it('keeps NodeFrame-style drags below 4px from starting and uses Euclidean distance', () => {
    const target = fakeTarget();
    const frames = manualFrames();
    const onMove = vi.fn();
    const onEnd = vi.fn();

    trackPointerGesture(pointer(0, 0) as never, { target, onMove, onEnd, moveThreshold: 4, ...frames });
    target.emit('pointermove', pointer(2.8, 2.8));
    frames.flush();
    expect(onMove).toHaveBeenCalledTimes(1); // preview can update, but remains a click
    target.emit('pointerup', pointer(2.8, 2.8));
    expect(onEnd).toHaveBeenCalledWith({ dx: 2.8, dy: 2.8 }, false, expect.anything());

    const target2 = fakeTarget();
    const onEnd2 = vi.fn();
    trackPointerGesture(pointer(0, 0) as never, { target: target2, onEnd: onEnd2, moveThreshold: 4, ...manualFrames() });
    target2.emit('pointermove', pointer(4, 0));
    target2.emit('pointerup', pointer(4, 0));
    expect(onEnd2).toHaveBeenCalledWith({ dx: 4, dy: 0 }, true, expect.anything());
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur'])(
    'tears down completely on %s instead of leaking a live move listener',
    (interruption) => {
      const target = fakeTarget();
      const onMove = vi.fn();
      const onEnd = vi.fn();
      const onCancel = vi.fn();
      const frames = manualFrames();

      const handle = trackPointerGesture(pointer(0, 0) as never, { target, onMove, onEnd, onCancel, ...frames });
      target.emit('pointermove', pointer(30, 30));
      target.emit(interruption, {});

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onEnd).not.toHaveBeenCalled();
      expect(handle.active).toBe(false);
      expect(target.count()).toBe(0);

      // A move arriving after the interruption must do nothing at all.
      onMove.mockClear();
      target.emit('pointermove', pointer(99, 99));
      frames.flush();
      expect(onMove).not.toHaveBeenCalled();
    }
  );

  it('ignores events from a second, unrelated pointer', () => {
    const target = fakeTarget();
    const frames = manualFrames();
    const onMove = vi.fn();

    trackPointerGesture(pointer(0, 0, 1) as never, { target, onMove, ...frames });
    target.emit('pointermove', pointer(500, 500, 2));
    frames.flush();

    expect(onMove).not.toHaveBeenCalled();
  });

  it('converts screen deltas into workspace units for the current zoom', () => {
    expect(scaleGestureDelta({ dx: 100, dy: 50 }, 2)).toEqual({ dx: 50, dy: 25 });
    expect(scaleGestureDelta({ dx: 100, dy: 50 }, 0.5)).toEqual({ dx: 200, dy: 100 });
    // A degenerate zoom must not produce Infinity node coordinates.
    expect(scaleGestureDelta({ dx: 10, dy: 10 }, 0)).toEqual({ dx: 10, dy: 10 });
  });
});
