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
  const [linked, setLinked] = useState(false);
  const [ready, setReady] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
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
    void accountSyncStatus()
      .then(async (status) => {
        setLinked(status.linked);
        if (status.linked) await refresh();
      })
      .catch(() => setMessage('could not inspect account synchronization.'))
      .finally(() => setReady(true));
  }, [refresh]);

  const persistence = useMemo(
    () => active === 'local' ? undefined : new NativeAccountWorkspacePersistence(active),
    [active]
  );

  useEffect(() => () => persistence?.dispose(), [persistence]);

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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'could not link this app.');
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return <main className={styles.loading}>opening HII…</main>;

  return <div className={styles.shell}>
    <HiiRoot
      key={active}
      spaceId={active === 'local' ? '' : active}
      creatorId={identity ? `account:${identity.handle}` : 'human:local'}
      persistence={persistence}
    />
    <header className={styles.header} data-workspace-ui>
      <span>hii</span>
      <nav>
        {linked ? <label>
          <span className={styles.srOnly}>workspace</span>
          <select value={active} onChange={(event) => setActive(event.target.value)}>
            <option value="local">this Mac · local</option>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>
              {workspace.name} · {workspace.role}
            </option>)}
          </select>
        </label> : null}
        <button type="button" aria-expanded={accountOpen} onClick={() => setAccountOpen((value) => !value)}>
          {identity?.handle ?? 'account sync'}
        </button>
      </nav>
    </header>
    {accountOpen ? <aside className={styles.panel} data-workspace-ui aria-label="HII account synchronization">
      {linked ? <>
        <dl>
          <div><dt>account</dt><dd>{identity?.handle}</dd></div>
          <div><dt>device</dt><dd>{identity?.deviceName}</dd></div>
          <div><dt>authority</dt><dd>revocable workspace sync</dd></div>
        </dl>
        <button type="button" disabled={busy} onClick={() => void refresh()}>refresh workspaces</button>
        <small>local terminal and files stay on this Mac. Only the selected account workspace document synchronizes.</small>
      </> : <>
        <p>Link this installed app to your HII account without giving the browser terminal access.</p>
        <ol>
          <li>Open HII on the web.</li>
          <li>Create a one-time app link code in your account menu.</li>
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
