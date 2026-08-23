'use client';

import { useEffect, useState } from 'react';
import { checkForUpdate, installUpdate, type UpdateState } from '@/lib/client/hii-updates';

/**
 * A quiet corner notice. HII never installs an update without the person saying so,
 * and it stays out of the way entirely when the app is current or is not the desktop build.
 */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let live = true;
    void checkForUpdate().then((next) => { if (live) setState(next); });
    return () => { live = false; };
  }, []);

  if (dismissed) return null;
  if (state.status === 'idle' || state.status === 'checking') return null;
  if (state.status === 'unsupported' || state.status === 'current') return null;

  return (
    <aside className="hii-update-banner" data-workspace-ui role="status" onPointerDown={(event) => event.stopPropagation()}>
      {state.status === 'available' && <>
        <span>HII {state.version} is available.</span>
        <button type="button" onClick={() => void installUpdate(setState)}>Update and restart</button>
        <button type="button" className="hii-update-dismiss" onClick={() => setDismissed(true)}>Later</button>
      </>}
      {state.status === 'downloading' && <span>Downloading HII {state.version} · {state.percent}%</span>}
      {state.status === 'ready' && <span>HII {state.version} is ready. Restarting…</span>}
      {state.status === 'failed' && <>
        <span>Update failed: {state.message}</span>
        <button type="button" className="hii-update-dismiss" onClick={() => setDismissed(true)}>Dismiss</button>
      </>}
    </aside>
  );
}
