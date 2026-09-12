'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { HiiRoot } from '@/components/workspace/HiiRoot';
import { LocalChatSurface } from './chat/LocalChatSurface';
import { ChatCircle, UserCircle, SidebarSimple, X } from '@phosphor-icons/react';
import { readAccountWorkspaceSelection, resolveAccountWorkspaceSelection, saveAccountWorkspaceSelection } from '@/lib/desktop/account-selection';
import {
  accountSyncStatus,
  linkAccountSync,
  listNativeAccountWorkspaces,
  NativeAccountWorkspacePersistence,
  type NativeAccountWorkspace
} from '@/lib/desktop/account-sync';
import styles from './DesktopHiiAccess.module.css';
import { listLocalWorkspaces, selectLocalWorkspace, type LocalWorkspaceInventory } from '@/lib/desktop/local-workspaces';

type LinkedIdentity = { handle: string; deviceName: string };

/**
 * A first guess at what to call this machine in the account's device list.
 *
 * The default was the literal string "My Mac", so a Windows PC linked itself
 * under that name and two devices were indistinguishable. The platform hint is
 * the only signal available to a static export -- the user can still type over
 * it before linking.
 */
function detectDeviceName() {
  if (typeof navigator === 'undefined') return 'This computer';
  const platform = `${navigator.userAgent} ${navigator.platform ?? ''}`.toLowerCase();
  if (platform.includes('win')) return 'My PC';
  if (platform.includes('mac')) return 'My Mac';
  if (platform.includes('linux')) return 'My Linux machine';
  return 'This computer';
}

export function DesktopHiiAccess() {
  const [surface, setSurface] = useState<'canvas' | 'chat'>('canvas');
  const [chatOpened, setChatOpened] = useState(false);
  const [ready, setReady] = useState(false);
  const [linked, setLinked] = useState(false);
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<NativeAccountWorkspace[]>([]);
  const [active, setActive] = useState('local');
  const [identity, setIdentity] = useState<LinkedIdentity | null>(null);
  const [code, setCode] = useState('');
  // Every device would have arrived in the account list as "My Mac", including
  // the Windows ones. Name it after the machine it is actually running on.
  const [deviceName, setDeviceName] = useState(detectDeviceName);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [canvasAvailable, setCanvasAvailable] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const [localBoards, setLocalBoards] = useState<LocalWorkspaceInventory | null>(null);
  const [localEpoch, setLocalEpoch] = useState(0);

  useEffect(() => {
    void listLocalWorkspaces().then(setLocalBoards).catch((error) => setMessage(String(error)));
  }, []);

  const openLocalBoard = async (id: string) => {
    if (busy || unsaved) return;
    setBusy(true);
    try {
      await selectLocalWorkspace(id);
      if (linked) await saveAccountWorkspaceSelection(null);
      setLocalBoards(await listLocalWorkspaces());
      setActive('local');
      setLocalEpoch(value => value + 1);
      setCanvasAvailable(true);
      setMessage('Opened on this device. No content was uploaded.');
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };

  const refresh = useCallback(async (restore = false) => {
    const value = await listNativeAccountWorkspaces();
    setIdentity({ handle: value.account.handle, deviceName: value.device.name });
    setWorkspaces(value.workspaces);
    setLinked(true);
    if (restore) {
      const selection = await readAccountWorkspaceSelection();
      const local = await listLocalWorkspaces();
      setLocalBoards(local);
      const hasLocalContent = local.workspaces.some(board => board.id === local.selectedWorkspaceId && (board.objects ?? 0) > 0);
      const next = resolveAccountWorkspaceSelection(selection, value.workspaces, hasLocalContent);
      if (!selection.configured) await saveAccountWorkspaceSelection(next === 'local' ? null : next);
      setActive(next);
      setCanvasAvailable(true);
    }
  }, []);

  useEffect(() => {
    setOnboardingComplete(window.localStorage.getItem('hii.onboarding.completed.v1') === 'true');
    void accountSyncStatus()
      .then(async (status) => {
        setLinked(status.linked);
        if (status.linked) await refresh(true);
        else setCanvasAvailable(true);
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : 'Could not open your account workspace.');
        setAccountOpen(true);
      })
      .finally(() => setReady(true));
  }, [refresh]);

  const selectWorkspace = async (id: string) => {
    if (busy || unsaved || id === active && canvasAvailable) return;
    setBusy(true);
    try {
      if (linked) await saveAccountWorkspaceSelection(id === 'local' ? null : id);
      setActive(id);
      setCanvasAvailable(true);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not remember your workspace.');
      setAccountOpen(true);
    } finally {
      setBusy(false);
    }
  };

  const finishOnboarding = useCallback(() => {
    window.localStorage.setItem('hii.onboarding.completed.v1', 'true');
    setOnboardingComplete(true);
  }, []);

  const persistence = useMemo(
    () => active === 'local' ? undefined : new NativeAccountWorkspacePersistence(active),
    [active]
  );

  useEffect(() => () => persistence?.dispose(), [persistence]);

  useEffect(() => {
    const toggleWorkspaces = (event: KeyboardEvent) => {
      if (surface !== 'canvas' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.code !== 'Digit1' || event.repeat) return;
      event.preventDefault();
      setWorkspaceOpen((value) => !value);
    };
    window.addEventListener('keydown', toggleWorkspaces);
    return () => window.removeEventListener('keydown', toggleWorkspaces);
  }, [surface]);

  const link = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || !deviceName.trim() || busy || unsaved) return;
    setBusy(true);
    setMessage('');
    try {
      await linkAccountSync(code, deviceName);
      setCode('');
      await refresh(true);
      setMessage('Connected to your existing HII account.');
      finishOnboarding();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'could not link this app.');
    } finally {
      setBusy(false);
    }
  };

  return <div className={styles.shell} data-workspace-open={surface === 'canvas' && workspaceOpen || undefined}
    onKeyDown={(event) => { if (surface === 'chat') event.stopPropagation(); }}
    onPaste={(event) => { if (surface === 'chat') event.stopPropagation(); }}
    onPointerMove={(event) => { if (surface === 'chat') event.stopPropagation(); }}
  >
    <nav className={styles.surfaceSwitch} aria-label="HII panels" data-workspace-ui>
      <button type="button" aria-expanded={surface === 'chat'} onClick={() => { setChatOpened(true); setSurface((current) => current === 'chat' ? 'canvas' : 'chat'); }}><ChatCircle size={16} />chat</button>
    </nav>
    <div className={styles.surface}>
    {ready && canvasAvailable ? <HiiRoot
      key={`${active}:${localEpoch}`}
      spaceId={active === 'local' ? '' : active}
      creatorId={identity ? `account:${identity.handle}` : 'human:local'}
      persistence={persistence}
      persistentChrome={false}
      onUnsavedChanges={setUnsaved}
    /> : <div className={styles.loading} role="status">{ready ? 'Your account canvas could not be opened.' : 'Opening HII...'}</div>}
    </div>
    {chatOpened && surface === 'chat' && <aside className={styles.chatPanel} aria-label="Chat panel" data-workspace-ui>
      <button className={styles.chatClose} type="button" aria-label="Close chat panel" onClick={() => setSurface('canvas')}><X size={18} /></button>
      <LocalChatSurface />
    </aside>}
    {surface === 'canvas' && <nav className={styles.accountControls} data-workspace-ui aria-label="Canvas account">
      <button type="button" title="Workspaces" aria-label="Workspaces" aria-expanded={workspaceOpen} onClick={() => setWorkspaceOpen((value) => !value)}><SidebarSimple size={19} /></button>
      <button type="button" title="HII account" aria-expanded={accountOpen} onClick={() => setAccountOpen((value) => !value)}><UserCircle size={19} /><span>{identity?.handle ?? 'HII account'}</span></button>
    </nav>}
    {surface === 'canvas' && workspaceOpen ? <aside className={styles.workspacePanel} data-workspace-ui aria-label="Workspaces">
      <header><strong>Workspaces</strong><kbd>Ctrl / Cmd 1</kbd></header>
      <nav aria-label="Available workspaces">
        <button type="button" disabled={busy || unsaved} data-active={active === 'local' || undefined} onClick={() => void selectWorkspace('local')}>
          <span>this device</span><small>local canvas</small>
        </button>
        {localBoards?.workspaces.map(board => <button type="button" key={`local:${board.id}`} disabled={busy || unsaved || board.unreadable}
          data-active={active === 'local' && localBoards.selectedWorkspaceId === board.id || undefined}
          onClick={() => void openLocalBoard(board.id)}>
          <span>{board.id}</span><small>{board.unreadable ? 'needs recovery · preserved' : `${board.objects ?? 0} objects · on this device`}</small>
        </button>)}
        {workspaces.map((workspace) => <button type="button" disabled={busy || unsaved} key={workspace.id} data-active={active === workspace.id || undefined} onClick={() => void selectWorkspace(workspace.id)}>
          <span>{workspace.name}</span><small>{workspace.role} · mirrored with web</small>
        </button>)}
      </nav>
      <footer><span>Same account board in web and app</span><small>Device-only boards are preserved separately until you choose to connect them.</small></footer>
      <p role="status">{message}</p>
    </aside> : null}
    {surface === 'canvas' && accountOpen ? <aside className={styles.panel} data-workspace-ui aria-label="HII account synchronization">
      <button type="button" title="Close account" aria-label="Close account" onClick={() => setAccountOpen(false)}><X size={18} /></button>
      {linked ? <>
        <dl>
          <div><dt>account</dt><dd>{identity?.handle}</dd></div>
          <div><dt>device</dt><dd>{identity?.deviceName}</dd></div>
          <div><dt>authority</dt><dd>revocable workspace sync</dd></div>
        </dl>
        <button type="button" disabled={busy || unsaved} onClick={() => { void refresh(!canvasAvailable).catch((error) => setMessage(error instanceof Error ? error.message : 'Could not refresh workspaces.')); }}>Refresh workspaces</button>
        <small>Your local files, models, and terminal stay on this device. Only the selected account workspace synchronizes.</small>
      </> : <>
        <p>Connect this HII app to your account. Your workspaces become available here without exposing this computer&apos;s terminal to the browser.</p>
        <ol>
          <li>Sign in to your existing HII account on the web.</li>
          <li>Create a one-time computer code in your account menu.</li>
          <li>Paste it here within 15 minutes.</li>
        </ol>
        <form onSubmit={link}>
          <label>device name<input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={64} required /></label>
          <label>link code<input value={code} onChange={(event) => setCode(event.target.value)} maxLength={128} autoComplete="off" required /></label>
          <button disabled={busy || unsaved || !code.trim()}>{busy ? 'linking…' : 'link this app'}</button>
        </form>
      </>}
      <p role="status">{message}</p>
    </aside> : null}
  </div>;
}
