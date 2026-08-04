/**
 * Pointer gesture core for the spatial workspace.
 *
 * Two properties matter here and both were missing from the inline handlers this
 * replaces:
 *
 * 1. Moves are batched to one animation frame. Pointer events fire faster than
 *    the compositor paints, so committing per event did redundant work every
 *    frame of every drag.
 * 2. A gesture always tears down. The old handlers only listened for `pointerup`,
 *    so an interrupted gesture (pointercancel from a system gesture, window blur
 *    from a ⌘-tab) left a live `pointermove` listener mutating the document
 *    forever.
 */

export type GesturePoint = { x: number; y: number };
export type GestureDelta = { dx: number; dy: number };

export type GestureHandlers = {
  /** Called at most once per animation frame while the pointer moves. */
  onMove?(delta: GestureDelta, event: PointerEvent): void;
  /** Called once when the gesture finishes normally. `moved` is false for a click. */
  onEnd?(delta: GestureDelta, moved: boolean): void;
  /** Called instead of `onEnd` when the gesture is interrupted. */
  onCancel?(): void;
};

export type GestureHandle = {
  /** Abort the gesture and run `onCancel`. Safe to call more than once. */
  cancel(): void;
  /** True until the gesture has finished or been cancelled. */
  readonly active: boolean;
};

/** Movement under this many pixels is treated as a click, not a drag. */
export const GESTURE_MOVE_THRESHOLD = 2;

type GestureTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export type GestureOptions = GestureHandlers & {
  /**
   * Where move/up/cancel are observed. Defaults to `window`. Injectable so the
   * gesture core can be exercised without a browser.
   */
  target?: GestureTarget;
  /** Frame scheduler. Defaults to `requestAnimationFrame`. Injectable for tests. */
  schedule?(callback: () => void): number;
  cancelSchedule?(handle: number): void;
};

const defaultSchedule = (callback: () => void) =>
  (typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(callback)
    : (setTimeout(callback, 16) as unknown as number));

const defaultCancelSchedule = (handle: number) => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
};

/**
 * Begin tracking a pointer gesture that started with `event`.
 *
 * The returned handle stays active until the pointer is released, the gesture is
 * cancelled by the platform, or `cancel()` is called. Every one of those paths
 * removes all listeners.
 */
export function trackPointerGesture(event: PointerEvent, options: GestureOptions): GestureHandle {
  const target: GestureTarget = options.target
    ?? (typeof window !== 'undefined' ? window : ({ addEventListener() {}, removeEventListener() {} } as GestureTarget));
  const schedule = options.schedule ?? defaultSchedule;
  const cancelSchedule = options.cancelSchedule ?? defaultCancelSchedule;

  const startX = event.clientX;
  const startY = event.clientY;
  const pointerId = event.pointerId;

  let active = true;
  let moved = false;
  let frame: number | null = null;
  let pending: PointerEvent | null = null;
  let delta: GestureDelta = { dx: 0, dy: 0 };

  // Pointer capture keeps the gesture attached to the element even if the pointer
  // leaves it, and gives us `lostpointercapture` as an extra teardown signal.
  const captureTarget = event.target instanceof Element ? event.target : null;
  try {
    captureTarget?.setPointerCapture?.(pointerId);
  } catch {
    // Capture is best-effort; window listeners below still drive the gesture.
  }

  function flush() {
    frame = null;
    const current = pending;
    pending = null;
    if (!active || !current) return;
    options.onMove?.(delta, current);
  }

  function onPointerMove(raw: Event) {
    const pointerEvent = raw as PointerEvent;
    if (!active || pointerEvent.pointerId !== pointerId) return;
    delta = { dx: pointerEvent.clientX - startX, dy: pointerEvent.clientY - startY };
    if (!moved && Math.abs(delta.dx) + Math.abs(delta.dy) >= GESTURE_MOVE_THRESHOLD) moved = true;
    pending = pointerEvent;
    if (frame === null) frame = schedule(flush);
  }

  function teardown() {
    active = false;
    if (frame !== null) {
      cancelSchedule(frame);
      frame = null;
    }
    pending = null;
    target.removeEventListener('pointermove', onPointerMove);
    target.removeEventListener('pointerup', onPointerUp);
    target.removeEventListener('pointercancel', onAbort);
    target.removeEventListener('lostpointercapture', onAbort);
    target.removeEventListener('blur', onAbort);
    try {
      captureTarget?.releasePointerCapture?.(pointerId);
    } catch {
      // Already released, or capture was never granted.
    }
  }

  function onPointerUp(raw: Event) {
    const pointerEvent = raw as PointerEvent;
    if (!active || (pointerEvent.pointerId !== undefined && pointerEvent.pointerId !== pointerId)) return;
    // Apply any move that was still waiting on a frame so the commit is exact.
    if (pending) {
      const last = pending;
      pending = null;
      options.onMove?.(delta, last);
    }
    const finalDelta = delta;
    const finalMoved = moved;
    teardown();
    options.onEnd?.(finalDelta, finalMoved);
  }

  function onAbort() {
    if (!active) return;
    teardown();
    options.onCancel?.();
  }

  target.addEventListener('pointermove', onPointerMove);
  target.addEventListener('pointerup', onPointerUp);
  target.addEventListener('pointercancel', onAbort);
  target.addEventListener('lostpointercapture', onAbort);
  target.addEventListener('blur', onAbort);

  return {
    cancel: onAbort,
    get active() {
      return active;
    }
  };
}

/** Convert a screen-space gesture delta into workspace units. */
export function scaleGestureDelta(delta: GestureDelta, zoom: number): GestureDelta {
  const safeZoom = zoom > 0 ? zoom : 1;
  return { dx: delta.dx / safeZoom, dy: delta.dy / safeZoom };
}
