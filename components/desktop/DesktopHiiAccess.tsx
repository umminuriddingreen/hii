'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { HiiRoot } from '@/components/workspace/HiiRoot';
import {
  accountSyncStatus,
  linkAccountSync,
  listNativeAccountWorkspaces,
  NativeAccountWorkspacePersistence,
  type NativeAccountWorkspace
} from '@/lib/desktop/account-sync';
import styles from './DesktopHiiAccess.module.css';

type LinkedIdentity = { handle: string; deviceName: string };

export function DesktopHiiAccess() {
  const [ready, setReady] = useState(false);
  const [linked, setLinked] = useState(false);
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<NativeAccountWorkspace[]>([]);
  const [active, setActive] = useState('local');
  const [identity, setIdentity] = useState<LinkedIdentity | null>(null);
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState('My Mac');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const value = await listNativeAccountWorkspaces();
    setIdentity({ handle: value.account.handle, deviceName: value.device.name });
    setWorkspaces(value.workspaces);
    setLinked(true);
  }, []);

  useEffect(() => {
    setOnboardingComplete(window.localStorage.getItem('hii.onboarding.completed.v1') === 'true');
    void accountSyncStatus()
      .then(async (status) => {
        setLinked(status.linked);
        if (status.linked) await refresh();
      })
      .catch(() => setMessage('could not inspect account synchronization.'))
      .finally(() => setReady(true));
  }, [refresh]);

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
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.code !== 'Digit1' || event.repeat) return;
      event.preventDefault();
      setWorkspaceOpen((value) => !value);
    };
    window.addEventListener('keydown', toggleWorkspaces);
    return () => window.removeEventListener('keydown', toggleWorkspaces);
  }, []);

  const link = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || !deviceName.trim() || busy) return;
    setBusy(true);
    setMessage('');
    try {
      await linkAccountSync(code, deviceName);
      setCode('');
      await refresh();
      setMessage('this HII app is linked. choose an account workspace above.');
      finishOnboarding();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'could not link this app.');
    } finally {
      setBusy(false);
    }
  };

  return <div className={styles.shell} data-workspace-open={workspaceOpen || undefined}>
    <HiiRoot
      key={active}
      spaceId={active === 'local' ? '' : active}
      creatorId={identity ? `account:${identity.handle}` : 'human:local'}
      persistence={persistence}
      persistentChrome={false}
      openTerminalOnReady={ready && !onboardingComplete}
      onTerminalReady={finishOnboarding}
    />
    {workspaceOpen ? <aside className={styles.workspacePanel} data-workspace-ui aria-label="Workspaces">
      <header><strong>Workspaces</strong><kbd>⌘ 1</kbd></header>
      <nav aria-label="Available workspaces">
        <button type="button" data-active={active === 'local' || undefined} onClick={() => setActive('local')}>
          <span>this Mac</span><small>local canvas</small>
        </button>
        {workspaces.map((workspace) => <button type="button" key={workspace.id} data-active={active === workspace.id || undefined} onClick={() => setActive(workspace.id)}>
          <span>{workspace.name}</span><small>{workspace.role}</small>
        </button>)}
      </nav>
      <footer><span>Canvas</span><small>⌘ Space · ⌥ Space</small></footer>
    </aside> : null}
    {accountOpen ? <aside className={styles.panel} data-workspace-ui aria-label="HII account synchronization">
      {linked ? <>
        <dl>
          <div><dt>account</dt><dd>{identity?.handle}</dd></div>
          <div><dt>device</dt><dd>{identity?.deviceName}</dd></div>
          <div><dt>authority</dt><dd>revocable workspace sync</dd></div>
        </dl>
        <button type="button" disabled={busy} onClick={() => void refresh()}>refresh workspaces</button>
        <small>Your local files, models, and terminal stay on this Mac. Only the selected account workspace synchronizes.</small>
      </> : <>
        <p>Connect this HII app to your account. Your workspaces become available here without exposing this computer&apos;s terminal to the browser.</p>
        <ol>
          <li>Open HII on the web.</li>
          <li>Create a one-time computer code in your account menu.</li>
          <li>Paste it here within 15 minutes.</li>
        </ol>
        <form onSubmit={link}>
          <label>device name<input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={64} required /></label>
          <label>link code<input value={code} onChange={(event) => setCode(event.target.value)} maxLength={128} autoComplete="off" required /></label>
          <button disabled={busy || !code.trim()}>{busy ? 'linking…' : 'link this app'}</button>
        </form>
      </>}
      <p role="status">{message}</p>
    </aside> : null}
  </div>;
}
