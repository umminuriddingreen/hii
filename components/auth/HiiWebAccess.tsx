// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { HiiRoot } from '@/components/workspace/HiiRoot';
import { browserSpacePersistence } from '@/components/spaces/SpaceCanvas';
import type { WorkspaceNode } from '@/lib/workspace/types';
import { browserCanvasSeedsFromFiles, hydrateBrowserCanvasAssets } from '@/lib/web/canvas-assets';
import {
  AccountWorkspacePersistence,
  createAccountDeviceLinkCode,
  createAccountWorkspace,
  createWorkspaceShareCode,
  listAccountDevices,
  listAccountWorkspaces,
  listWorkspaceMembers,
  redeemWorkspaceShareCode,
  revokeAccountDevice,
  revokeWorkspaceMember,
  type AccountDevice,
  type AccountWorkspaceMember,
  type AccountWorkspaceSummary
} from '@/lib/web/account-workspace';
import { nodeSeedFromFeedSnapshot, type FeedItem } from '@/lib/web/feed-contract';
import { HiiWebPanel, type WebPanel } from './HiiWebPanels';
import styles from './HiiWebAccess.module.css';

type AccessMode = 'login' | 'signup' | null;

type Session = {
  authenticated: boolean;
  accountId?: string;
  handle?: string;
  csrfToken?: string;
  source?: 'account' | 'network' | 'local';
};

const LOCAL_OWNER_ACCOUNT_ID = 'z1zLugCcqYOu8FfOK51CCmatt6Q19nJrmEyqKZLi5Js';

function localOwnerSession(hostname: string): Session | null {
  const normalized = hostname.toLocaleLowerCase();
  const loopback = normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]'
    || normalized.endsWith('.localhost');
  return loopback ? {
    authenticated: true,
    accountId: LOCAL_OWNER_ACCOUNT_ID,
    handle: 'local owner',
    source: 'local',
  } : null;
}

async function networkOwnerSession(): Promise<Session | null> {
  try {
    const response = await fetch('/hii/network/session', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const session = await response.json() as Session;
    return session.authenticated ? session : null;
  } catch {
    return null;
  }
}

type RegistrationOptions = {
  ceremonyId: string;
  publicKey: PublicKeyCredentialCreationOptionsJSON;
};

type LoginOptions = {
  ceremonyId: string;
  publicKey: PublicKeyCredentialRequestOptionsJSON;
};

function bytesFromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64urlFromBytes(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function api<T>(path: string, body?: unknown, csrfToken?: string): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(csrfToken ? { 'X-HII-CSRF': csrfToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'request_failed');
  return payload;
}

function registrationCredential(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: base64urlFromBytes(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: base64urlFromBytes(response.clientDataJSON),
      attestationObject: base64urlFromBytes(response.attestationObject),
    },
  };
}

function loginCredential(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: base64urlFromBytes(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: base64urlFromBytes(response.clientDataJSON),
      authenticatorData: base64urlFromBytes(response.authenticatorData),
      signature: base64urlFromBytes(response.signature),
      userHandle: response.userHandle ? base64urlFromBytes(response.userHandle) : null,
    },
  };
}

function SupportHii({ onCreateAccount }: { onCreateAccount: () => void }) {
  const [spot, setSpot] = useState(1);
  return (
    <section className={styles.support} aria-labelledby="support-hii-title">
      <header>
        <small>support the next build</small>
        <h2 id="support-hii-title">brand the Mac that builds HII.</h2>
        <p>ten placements. one 14-day round. the round funds HII hardware and local-model work.</p>
      </header>
      <div className={styles.supportLid} role="group" aria-label="Mac sponsorship placements">
        {Array.from({ length: 10 }, (_, index) => index + 1).map((number) => (
          <button key={number} type="button" aria-pressed={spot === number} onClick={() => setSpot(number)}>
            {String(number).padStart(2, '0')}
          </button>
        ))}
        <span aria-hidden="true">hii</span>
      </div>
      <div className={styles.supportSelection} aria-live="polite">
        <span>placement {String(spot).padStart(2, '0')}</span>
        <span>opening round</span>
      </div>
      <button className={styles.supportAction} type="button" onClick={onCreateAccount}>create an account</button>
      <small>preview only. no bid or payment is taken here. terms come before the round opens.</small>
    </section>
  );
}

export function HiiWebAccess() {
  const [mode, setMode] = useState<AccessMode>(null);
  const [session, setSession] = useState<Session>({ authenticated: false });
  const [handle, setHandle] = useState('');
  const [message, setMessage] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [deviceMessage, setDeviceMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [panel, setPanel] = useState<WebPanel | null>(null);
  const [shareNode, setShareNode] = useState<WorkspaceNode | null>(null);
  const [canvasImport, setCanvasImport] = useState<{ id: string; seed: ReturnType<typeof nodeSeedFromFeedSnapshot> } | null>(null);
  const [workspaces, setWorkspaces] = useState<AccountWorkspaceSummary[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('');
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceMessage, setWorkspaceMessage] = useState('');
  const [shareCode, setShareCode] = useState('');
  const [redeemCode, setRedeemCode] = useState('');
  const [accountDevices, setAccountDevices] = useState<AccountDevice[]>([]);
  const [appLinkCode, setAppLinkCode] = useState('');
  const [workspaceMembers, setWorkspaceMembers] = useState<AccountWorkspaceMember[]>([]);
  const canvasAccountId = session.accountId ?? '';
  const canvasAccountReady = /^[A-Za-z0-9_-]{43}$/.test(canvasAccountId);
  const accountSync = session.source === 'account' && Boolean(session.csrfToken);
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const canvasSpaceId = activeWorkspace?.id ?? `account:${canvasAccountId}`;
  const canvasPersistence = useMemo(
    () => !canvasAccountReady
      ? undefined
      : accountSync && activeWorkspace
        ? new AccountWorkspacePersistence(
            activeWorkspace.id,
            session.csrfToken ?? '',
            (document) => hydrateBrowserCanvasAssets(canvasAccountId, document)
          )
        : browserSpacePersistence(
            `account:${canvasAccountId}`,
            (document) => hydrateBrowserCanvasAssets(canvasAccountId, document)
          ),
    [accountSync, activeWorkspace, canvasAccountId, canvasAccountReady, session.csrfToken],
  );
  const canvasFileSeeder = useCallback(
    (files: File[]) => browserCanvasSeedsFromFiles(canvasAccountId, files),
    [canvasAccountId],
  );

  useEffect(() => {
    const localSession = localOwnerSession(window.location.hostname);
    if (localSession) {
      setSession(localSession);
      setReady(true);
      return;
    }
    let active = true;
    void networkOwnerSession()
      .then(async (networkSession) => networkSession
        ? { ...networkSession, source: 'network' as const }
        : { ...(await api<Session>('/api/auth/session')), source: 'account' as const })
      .then((value) => { if (active) setSession(value); })
      .catch(() => { if (active) setSession({ authenticated: false }); })
      .finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => () => {
    if (canvasPersistence instanceof AccountWorkspacePersistence) canvasPersistence.dispose();
  }, [canvasPersistence]);

  const refreshWorkspaces = useCallback(async (preferredId = '') => {
    if (!accountSync || !session.csrfToken) return;
    setWorkspaceBusy(true);
    setWorkspaceMessage('');
    try {
      let next = await listAccountWorkspaces();
      if (!next.length) {
        const created = await createAccountWorkspace(`${session.handle ?? 'My'} HII`, session.csrfToken);
        next = [created];
      }
      setWorkspaces(next);
      setActiveWorkspaceId((current) => {
        const requested = preferredId || current;
        return next.some((workspace) => workspace.id === requested) ? requested : next[0]?.id ?? '';
      });
    } catch {
      setWorkspaceMessage('could not synchronize account workspaces.');
    } finally {
      setWorkspaceBusy(false);
    }
  }, [accountSync, session.csrfToken, session.handle]);

  const refreshDevices = useCallback(async () => {
    if (!accountSync) return;
    try {
      setAccountDevices(await listAccountDevices());
    } catch {
      setWorkspaceMessage('could not load linked apps.');
    }
  }, [accountSync]);

  const refreshMembers = useCallback(async () => {
    if (!accountSync || !activeWorkspace || !['owner', 'admin'].includes(activeWorkspace.role)) {
      setWorkspaceMembers([]);
      return;
    }
    try {
      setWorkspaceMembers(await listWorkspaceMembers(activeWorkspace.id));
    } catch {
      setWorkspaceMessage('could not load workspace members.');
    }
  }, [accountSync, activeWorkspace]);

  useEffect(() => {
    if (!accountSync) {
      setWorkspaces([]);
      setActiveWorkspaceId('');
      return;
    }
    void refreshWorkspaces();
    void refreshDevices();
  }, [accountSync, refreshDevices, refreshWorkspaces]);

  useEffect(() => {
    setShareCode('');
    void refreshMembers();
  }, [activeWorkspaceId, refreshMembers]);

  const createWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session.csrfToken || !workspaceName.trim() || workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceMessage('');
    try {
      const created = await createAccountWorkspace(workspaceName, session.csrfToken);
      setWorkspaceName('');
      await refreshWorkspaces(created.id);
      setWorkspaceMessage(`${created.name} is ready.`);
    } catch {
      setWorkspaceMessage('could not create that workspace.');
      setWorkspaceBusy(false);
    }
  };

  const issueStudioCode = async () => {
    if (!session.csrfToken || !activeWorkspace || workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceMessage('');
    try {
      const issued = await createWorkspaceShareCode(activeWorkspace.id, session.csrfToken, 'admin');
      setShareCode(issued.code);
      setWorkspaceMessage('single-use studio admin code ready for 15 minutes.');
    } catch {
      setWorkspaceMessage('could not create a studio admin code.');
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const redeemStudioCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session.csrfToken || !redeemCode.trim() || workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceMessage('');
    try {
      const granted = await redeemWorkspaceShareCode(redeemCode, session.csrfToken);
      setRedeemCode('');
      await refreshWorkspaces(granted.id);
      setWorkspaceMessage(`admin access granted to ${granted.name}.`);
    } catch {
      setWorkspaceMessage('that share code is invalid, expired, or already used.');
      setWorkspaceBusy(false);
    }
  };

  const issueAppLinkCode = async () => {
    if (!session.csrfToken || workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceMessage('');
    try {
      const issued = await createAccountDeviceLinkCode(session.csrfToken);
      setAppLinkCode(issued.code);
      setWorkspaceMessage('single-use app link code ready for 15 minutes.');
    } catch {
      setWorkspaceMessage('could not create an app link code.');
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const revokeDevice = async (deviceId: string) => {
    if (!session.csrfToken || workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceMessage('');
    try {
      await revokeAccountDevice(deviceId, session.csrfToken);
      await refreshDevices();
      setWorkspaceMessage('app workspace access revoked.');
    } catch {
      setWorkspaceMessage('could not revoke that app.');
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const revokeMember = async (accountId: string) => {
    if (!session.csrfToken || !activeWorkspace || activeWorkspace.role !== 'owner' || workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceMessage('');
    try {
      await revokeWorkspaceMember(activeWorkspace.id, accountId, session.csrfToken);
      await refreshMembers();
      setWorkspaceMessage('workspace access revoked.');
    } catch {
      setWorkspaceMessage('could not revoke that workspace member.');
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const chooseMode = (nextMode: Exclude<AccessMode, null>) => {
    setMode(nextMode);
    setMessage('');
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!mode || busy) return;

    setBusy(true);
    setMessage('');

    try {
      if (!window.PublicKeyCredential || !navigator.credentials) {
        throw new Error('passkeys_unavailable');
      }

      if (mode === 'signup') {
        const options = await api<RegistrationOptions>('/api/auth/register/start', {
          handle: handle.trim(),
        });
        const publicKey: PublicKeyCredentialCreationOptions = {
          rp: options.publicKey.rp,
          user: {
            ...options.publicKey.user,
            id: bytesFromBase64url(options.publicKey.user.id),
          },
          challenge: bytesFromBase64url(options.publicKey.challenge),
          pubKeyCredParams: options.publicKey.pubKeyCredParams.map((parameter) => ({
            type: 'public-key',
            alg: parameter.alg,
          })),
          timeout: options.publicKey.timeout,
          excludeCredentials: options.publicKey.excludeCredentials?.map((item) => ({
            type: 'public-key',
            id: bytesFromBase64url(item.id),
          })),
          authenticatorSelection: options.publicKey.authenticatorSelection ? {
            authenticatorAttachment: options.publicKey.authenticatorSelection.authenticatorAttachment as AuthenticatorAttachment | undefined,
            requireResidentKey: options.publicKey.authenticatorSelection.requireResidentKey,
            residentKey: options.publicKey.authenticatorSelection.residentKey as ResidentKeyRequirement | undefined,
            userVerification: options.publicKey.authenticatorSelection.userVerification as UserVerificationRequirement | undefined,
          } : undefined,
          attestation: options.publicKey.attestation as AttestationConveyancePreference | undefined,
        };
        const credential = await navigator.credentials.create({
          publicKey,
        }) as PublicKeyCredential | null;
        if (!credential) throw new Error('passkey_cancelled');
        const next = await api<Session>('/api/auth/register/finish', {
          ceremonyId: options.ceremonyId,
          credential: registrationCredential(credential),
        });
        setSession({ ...next, source: 'account' });
      } else {
        const options = await api<LoginOptions>('/api/auth/login/start', {});
        const publicKey: PublicKeyCredentialRequestOptions = {
          challenge: bytesFromBase64url(options.publicKey.challenge),
          rpId: options.publicKey.rpId,
          timeout: options.publicKey.timeout,
          userVerification: options.publicKey.userVerification as UserVerificationRequirement | undefined,
          allowCredentials: options.publicKey.allowCredentials?.map((item) => ({
            type: 'public-key',
            id: bytesFromBase64url(item.id),
          })),
        };
        const credential = await navigator.credentials.get({
          publicKey,
        }) as PublicKeyCredential | null;
        if (!credential) throw new Error('passkey_cancelled');
        const next = await api<Session>('/api/auth/login/finish', {
          ceremonyId: options.ceremonyId,
          credential: loginCredential(credential),
        });
        setSession({ ...next, source: 'account' });
      }
    } catch {
      setMessage(
        mode === 'signup'
          ? 'could not sign up.'
          : 'could not log in.',
      );
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (busy || !session.csrfToken) return;
    setBusy(true);
    setDeviceMessage('');
    try {
      await api('/api/auth/logout', {}, session.csrfToken);
      setSession({ authenticated: false });
      setMode(null);
      setAccountOpen(false);
      setWorkspaces([]);
      setActiveWorkspaceId('');
    } catch {
      setDeviceMessage('could not log out. try again.');
    } finally {
      setBusy(false);
    }
  };

  if (ready && session.authenticated) {
    const accountName = session.handle ?? 'account';
    if (!canvasAccountReady || !canvasPersistence || (accountSync && (!activeWorkspace || workspaceBusy && !workspaces.length))) {
      return (
        <main className={styles.access} id="hii-main">
          <span className={styles.wordmark}>hii</span>
          <section className={styles.formPanel} aria-label="Account unavailable">
            <p className={styles.message} role="status">
              {accountSync && workspaceBusy
                ? 'opening your account-owned workspace.'
                : 'could not open this account.'}
            </p>
            <button type="button" onClick={() => window.location.reload()}>retry</button>
          </section>
        </main>
      );
    }
    return (
      <div className={styles.canvasShell}>
        <HiiRoot
          surface="account"
          spaceId={canvasSpaceId}
          creatorId={`account:${canvasAccountId}`}
          persistence={canvasPersistence}
          allowPhoto
          fileSeeder={canvasFileSeeder}
          onRequestDevice={() => setPanel('models')}
          onShareNode={(node) => { setShareNode(node); setPanel('feed'); }}
          canvasImportRequest={canvasImport}
        />
        <header className={styles.canvasHeader} data-workspace-ui>
          <span className={styles.canvasWordmark}>hii</span>
          <nav aria-label="HII account actions">
            <button type="button" onClick={() => { setPanel('chat'); setAccountOpen(false); }}>social</button>
            <button type="button" onClick={() => { setPanel('say-hi'); setAccountOpen(false); }}>say hi</button>
            <button
              type="button"
              aria-expanded={accountOpen}
              aria-controls="hii-web-account"
              onClick={() => setAccountOpen((value) => !value)}
            >
              {accountName}
            </button>
          </nav>
        </header>
        {panel ? <HiiWebPanel
          panel={panel}
          accountId={canvasAccountId}
          csrfToken={session.csrfToken ?? ''}
          shareNode={shareNode}
          onClose={() => { setPanel(null); setShareNode(null); }}
          onPanel={(nextPanel) => setPanel(nextPanel)}
          onImport={(item: FeedItem) => {
            setCanvasImport({ id: crypto.randomUUID(), seed: nodeSeedFromFeedSnapshot(item) });
            setPanel(null);
            setShareNode(null);
          }}
        /> : null}
        {accountOpen ? (
          <aside id="hii-web-account" className={styles.accountPanel} data-workspace-ui aria-label="HII account">
            <dl>
              <div><dt>name</dt><dd>{accountName}</dd></div>
              <div><dt>access</dt><dd>passkey</dd></div>
              <div><dt>canvas</dt><dd>{accountSync ? 'account synchronized' : 'stored on this device'}</dd></div>
              <div><dt>computer</dt><dd>live through HII Chat</dd></div>
            </dl>
            {accountSync ? <section className={styles.workspaceControls} aria-label="Business workspaces">
              <label>
                workspace
                <select value={activeWorkspaceId} onChange={(event) => setActiveWorkspaceId(event.target.value)}>
                  {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>
                    {workspace.name} · {workspace.role}
                  </option>)}
                </select>
              </label>
              <form onSubmit={createWorkspace}>
                <input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="new business workspace" maxLength={80} />
                <button type="submit" disabled={workspaceBusy || !workspaceName.trim()}>create</button>
              </form>
              {activeWorkspace?.role === 'owner' ? <button type="button" disabled={workspaceBusy} onClick={() => void issueStudioCode()}>
                create studio admin code
              </button> : null}
              {shareCode ? <div>
                <code>{shareCode}</code>
                <button type="button" onClick={() => navigator.clipboard?.writeText(shareCode)}>copy once</button>
              </div> : null}
              {workspaceMembers.length ? <div>
                <small>workspace members</small>
                {workspaceMembers.map((member) => <span key={member.accountId}>
                  {member.handle} · {member.role}
                  {activeWorkspace?.role === 'owner' && member.role !== 'owner' ? <button
                    type="button"
                    disabled={workspaceBusy}
                    onClick={() => void revokeMember(member.accountId)}
                  >revoke</button> : null}
                </span>)}
              </div> : null}
              <form onSubmit={redeemStudioCode}>
                <input value={redeemCode} onChange={(event) => setRedeemCode(event.target.value)} placeholder="redeem workspace share code" maxLength={96} />
                <button type="submit" disabled={workspaceBusy || !redeemCode.trim()}>redeem</button>
              </form>
              <button type="button" disabled={workspaceBusy} onClick={() => void issueAppLinkCode()}>
                link an installed HII app
              </button>
              {appLinkCode ? <div>
                <code>{appLinkCode}</code>
                <button type="button" onClick={() => navigator.clipboard?.writeText(appLinkCode)}>copy once</button>
              </div> : null}
              {accountDevices.length ? <div>
                <small>linked apps</small>
                {accountDevices.map((device) => <span key={device.id}>
                  {device.name}
                  <button type="button" disabled={workspaceBusy} onClick={() => void revokeDevice(device.id)}>revoke</button>
                </span>)}
              </div> : null}
              <p role="status" aria-live="polite">{workspaceMessage}</p>
            </section> : null}
            <nav className={styles.platformLinks} aria-label="Open HII on a computer">
              <button type="button" onClick={() => { setPanel('chat'); setAccountOpen(false); }}>open HII Social</button>
              <button type="button" onClick={() => { setPanel('say-hi'); setAccountOpen(false); }}>say hi</button>
              <button type="button" onClick={() => { setPanel('models'); setAccountOpen(false); }}>devices &amp; local intelligence</button>
              <a href="/download#mac">open on Mac</a>
              <a href="/download#windows">open on Windows</a>
            </nav>
            <button type="button" onClick={signOut} disabled={busy}>log out</button>
            <p role="status" aria-live="polite">{deviceMessage}</p>
            <small>{accountSync ? 'workspace objects synchronize through your account. media bytes remain on the importing browser until private asset sync is enabled.' : 'canvas media stays on this browser.'} paired computer screens and HII answers stream live through an outbound, revocable link.</small>
          </aside>
        ) : null}
      </div>
    );
  }

  return (
    <main className={styles.access} id="hii-main">
      <span className={styles.wordmark}>hii</span>

      {mode ? (
        <section className={styles.formPanel} aria-label={mode === 'login' ? 'Log in' : 'Sign up'}>
          <form onSubmit={submit}>
            {mode === 'signup' ? (
              <label>
                name
                <input
                  type="text"
                  name="handle"
                  autoComplete="username"
                  value={handle}
                  onChange={(event) => setHandle(event.target.value)}
                  minLength={3}
                  maxLength={48}
                  pattern="[-A-Za-z0-9._]+"
                  required
                />
              </label>
            ) : null}
            <button type="submit" disabled={busy || (mode === 'signup' && handle.trim().length < 3)}>
              {busy ? 'working…' : 'continue'}
            </button>
          </form>
          {message ? <p className={styles.message} role="status">{message}</p> : null}
          <p className={styles.note}>{mode === 'login' ? 'use your passkey' : 'no password. names are public.'}</p>
          <nav className={styles.modeLinks} aria-label="Switch account action">
            <button type="button" aria-current={mode === 'login'} onClick={() => chooseMode('login')}>login</button>
            <span aria-hidden="true">/</span>
            <button type="button" aria-current={mode === 'signup'} onClick={() => chooseMode('signup')}>sign up</button>
          </nav>
        </section>
      ) : (
        <nav className={styles.actions} aria-label="HII account access">
          <button type="button" onClick={() => chooseMode('login')}>login</button>
          <span aria-hidden="true">/</span>
          <button type="button" onClick={() => chooseMode('signup')}>sign up</button>
        </nav>
      )}
      <SupportHii onCreateAccount={() => {
        chooseMode('signup');
        document.scrollingElement?.scrollTo({ top: 0, behavior: 'smooth' });
      }} />
    </main>
  );
}

export default HiiWebAccess;
