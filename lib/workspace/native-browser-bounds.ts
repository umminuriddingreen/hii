export type NativeBrowserBounds = { x: number; y: number; width: number; height: number };

type Options = {
  read: () => NativeBrowserBounds | null;
  applyPosition: (bounds: NativeBrowserBounds) => Promise<void>;
  applySize: (bounds: NativeBrowserBounds) => Promise<void>;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frame: number) => void;
  onError: () => void;
};

export function createNativeBrowserBoundsSync({ read, applyPosition, applySize, requestFrame, cancelFrame, onError }: Options) {
  let lastPosition = '';
  let lastSize = '';
  let inFlight = false;
  let dirty = false;
  let frame = 0;
  let disposed = false;

  const schedule = () => {
    dirty = true;
    if (disposed || frame || inFlight) return;
    frame = requestFrame(() => {
      frame = 0;
      if (disposed || !dirty) return;
      const bounds = read();
      dirty = false;
      if (!bounds || bounds.width < 2 || bounds.height < 2) return;
      const position = `${Math.round(bounds.x)}:${Math.round(bounds.y)}`;
      const size = `${Math.round(bounds.width)}:${Math.round(bounds.height)}`;
      const move = position !== lastPosition;
      const resize = size !== lastSize;
      if (!move && !resize) return;
      inFlight = true;
      void (async () => {
        try {
          if (move) await applyPosition(bounds);
          if (resize && !disposed) await applySize(bounds);
          if (!disposed) {
            if (move) lastPosition = position;
            if (resize) lastSize = size;
          }
        } catch {
          if (!disposed) onError();
        } finally {
          inFlight = false;
          if (dirty && !disposed) schedule();
        }
      })();
    });
  };

  return {
    schedule,
    reset() { lastPosition = ''; lastSize = ''; schedule(); },
    dispose() {
      disposed = true;
      dirty = false;
      if (frame) cancelFrame(frame);
      frame = 0;
    }
  };
}
