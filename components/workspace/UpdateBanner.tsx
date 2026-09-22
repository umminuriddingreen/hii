'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { checkForUpdate, installUpdate, type UpdateState } from '@/lib/client/hii-updates';
import { hiiUpdateStatus, syncCodexKnowledge, type HiiUpdateStatus } from '@/lib/client/hii-bridge';

type UpdateStatusAccess = { openUpdateStatus: () => void };
const UpdateStatusContext = createContext<UpdateStatusAccess | null>(null);
type UpdateStatusHandle = { current: (() => void) | null };
const UpdateStatusRegistrationContext = createContext<UpdateStatusHandle | null>(null);

export function useUpdateStatusAccess() {
  return useContext(UpdateStatusContext);
}

export function UpdateStatusProvider({ children }: { children: ReactNode }) {
  const handle = useRef<UpdateStatusHandle>({ current: null });
  const access = useRef<UpdateStatusAccess>({ openUpdateStatus: () => handle.current.current?.() });
  const registration = useContext(UpdateStatusRegistrationContext);
  if (registration) return <>{children}</>;
  return <UpdateStatusContext.Provider value={access.current}>
    <UpdateStatusRegistrationContext.Provider value={handle.current}>{children}</UpdateStatusRegistrationContext.Provider>
  </UpdateStatusContext.Provider>;
}

/** Source work and signed app releases have separate lifecycles. */
export function UpdateBanner({ children }: { children?: ReactNode }) {
  const updateStatusHandle = useContext(UpdateStatusRegistrationContext);
  const updateStatusAccess = useContext(UpdateStatusContext);
  const [desktop, setDesktop] = useState(false);
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [releaseDismissed, setReleaseDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [source, setSource] = useState<HiiUpdateStatus | null>(null);
  const [sourceError, setSourceError] = useState('');
  const [syncMessage, setSyncMessage] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    setDesktop(true);
    let live = true;
    void checkForUpdate().then((next) => { if (live) setState(next); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let live = true;
    // Reconcile on launch and periodically while this desktop workspace is open.
    const reconcile = async () => {
      try {
        const result = await syncCodexKnowledge();
        if (live) setSyncMessage(`${result.tracked} Codex files tracked · ${result.changed} changed`);
      } catch (error) {
        if (live) setSyncMessage(error instanceof Error ? error.message : 'Codex sync unavailable');
      }
    };
    void reconcile();
    const timer = window.setInterval(() => void reconcile(), 15 * 60 * 1000);
    return () => { live = false; window.clearInterval(timer); };
  }, [desktop]);

  useEffect(() => {
    if (!expanded) return;
    let live = true;
    const timer = window.setInterval(() => {
      void hiiUpdateStatus().then((next) => { if (live) { setSource(next); setSourceError(''); } })
        .catch((error) => { if (live) setSourceError(error instanceof Error ? error.message : 'Source status unavailable'); });
    }, 10_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [expanded]);

  const inspect = async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    setSourceError('');
    try { setSource(await hiiUpdateStatus()); }
    catch (error) { setSourceError(error instanceof Error ? error.message : 'Source status unavailable'); }
  };

  const openUpdateStatus = () => {
    if (expanded) return;
    setExpanded(true);
    setSourceError('Checking source…');
    void hiiUpdateStatus().then(setSource).catch((error) => setSourceError(error instanceof Error ? error.message : 'Source status unavailable'));
  };

  if (updateStatusHandle) updateStatusHandle.current = openUpdateStatus;

  const syncNow = async () => {
    if (syncBusy) return;
    setSyncBusy(true);
    try {
      const result = await syncCodexKnowledge();
      setSyncMessage(`${result.tracked} Codex files tracked · ${result.changed} changed`);
      setSource(await hiiUpdateStatus());
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'Codex sync unavailable');
    } finally { setSyncBusy(false); }
  };

  if (!desktop && !updateStatusHandle) return children ?? null;

  return <>
    {children}
    <aside className="hii-update-banner" data-workspace-ui data-has-update-command={updateStatusAccess ? '' : undefined} role="status" onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" className={updateStatusAccess ? 'hii-update-banner-command' : undefined} onClick={() => void inspect()} aria-expanded={expanded}>Update HII</button>
      {expanded && <span>
        {source ? `${source.source ? `Source ${source.source.commit.slice(0, 8)} · ${source.source.dirty ? `${source.source.changedFiles} changed files` : 'clean'}` : 'Source checkout unavailable'} · ${source.featureRunCount} feature runs` : sourceError || 'Checking source…'}
        {source?.featureRuns.length ? ` · Latest: ${[...source.featureRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0].status}` : ''}
        {' · '}{syncMessage || 'Syncing Codex knowledge…'}
        {' · '}{state.status === 'current' ? 'App current' : state.status === 'failed' ? 'App update check unavailable' : state.status === 'unsupported' ? 'Signed app updates unavailable in this build' : ''}
      </span>}
      {state.status === 'available' && !releaseDismissed && <>
        <span>Signed HII app {state.version} is available.</span>
        <button type="button" onClick={() => void installUpdate(setState)}>Update app and restart</button>
        <button type="button" className="hii-update-dismiss" onClick={() => setReleaseDismissed(true)}>Later</button>
      </>}
      {state.status === 'downloading' && <span>Downloading HII {state.version} · {state.percent}%</span>}
      {state.status === 'ready' && <span>HII {state.version} is ready. Restarting…</span>}
      {expanded && <button type="button" disabled={syncBusy} onClick={() => void syncNow()}>{syncBusy ? 'Syncing…' : 'Sync Codex now'}</button>}
    </aside>
  </>;
}
