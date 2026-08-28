// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { HiiRoot } from '@/components/workspace/HiiRoot';
import { browserSpacePersistence } from '@/components/spaces/SpaceCanvas';
import type { WorkspaceNode } from '@/lib/workspace/types';
import { browserCanvasSeedsFromFiles, hydrateBrowserCanvasAssets } from '@/lib/web/canvas-assets';
import { nodeSeedFromFeedSnapshot, type FeedItem } from '@/lib/web/feed-contract';
import { HiiWebPanel, type WebPanel } from './HiiWebPanels';
import styles from './HiiWebAccess.module.css';

type AccessMode = 'login' | 'signup' | null;

type Session = {
  authenticated: boolean;
  accountId?: string;
  handle?: string;
  csrfToken?: string;
};

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
  const canvasAccountId = session.accountId ?? '';
  const canvasAccountReady = /^[A-Za-z0-9_-]{43}$/.test(canvasAccountId);
  const canvasPersistence = useMemo(
    () => canvasAccountReady
      ? browserSpacePersistence(`account:${canvasAccountId}`, (document) => hydrateBrowserCanvasAssets(canvasAccountId, document))
      : undefined,
    [canvasAccountId, canvasAccountReady],
  );
  const canvasFileSeeder = useCallback(
    (files: File[]) => browserCanvasSeedsFromFiles(canvasAccountId, files),
    [canvasAccountId],
  );

  useEffect(() => {
    let active = true;
    void api<Session>('/api/auth/session')
      .then((value) => { if (active) setSession(value); })
      .catch(() => { if (active) setSession({ authenticated: false }); })
      .finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);

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
        setSession(next);
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
        setSession(next);
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
    } catch {
      setDeviceMessage('could not log out. try again.');
    } finally {
      setBusy(false);
    }
  };

  const openOnAnotherDevice = async () => {
    const share = {
      title: 'HII',
      text: 'Open HII and sign in with your passkey.',
      url: window.location.origin,
    };
    try {
      if (navigator.share) {
        await navigator.share(share);
        setDeviceMessage('sign-in link shared.');
        return;
      }
      await navigator.clipboard.writeText(share.url);
      setDeviceMessage('sign-in link copied.');
    } catch {
      setDeviceMessage('share cancelled.');
    }
  };

  if (ready && session.authenticated) {
    const accountName = session.handle ?? 'account';
    if (!canvasAccountReady || !canvasPersistence) {
      return (
        <main className={styles.access}>
          <span className={styles.wordmark}>hii</span>
          <section className={styles.formPanel} aria-label="Account unavailable">
            <p className={styles.message} role="alert">could not open this account.</p>
            <button type="button" onClick={() => window.location.reload()}>retry</button>
          </section>
        </main>
      );
    }
    return (
      <div className={styles.canvasShell}>
        <HiiRoot
          surface="account"
          spaceId={`account:${canvasAccountId}`}
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
          <nav className={styles.canvasNav} aria-label="HII canvas views">
            <button type="button" aria-pressed={panel === 'chat'} onClick={() => setPanel((value) => value === 'chat' ? null : 'chat')}>chat</button>
            <button type="button" aria-pressed={panel === 'feed'} onClick={() => setPanel((value) => value === 'feed' ? null : 'feed')}>feed</button>
            <button type="button" aria-pressed={panel === 'models'} onClick={() => setPanel((value) => value === 'models' ? null : 'models')}>models</button>
          </nav>
          <button
            type="button"
            aria-expanded={accountOpen}
            aria-controls="hii-web-account"
            onClick={() => setAccountOpen((value) => !value)}
          >
            {accountName}
          </button>
        </header>
        {panel ? <HiiWebPanel
          panel={panel}
          accountId={canvasAccountId}
          csrfToken={session.csrfToken ?? ''}
          shareNode={shareNode}
          onClose={() => { setPanel(null); setShareNode(null); }}
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
              <div><dt>canvas</dt><dd>stored only in this browser</dd></div>
            </dl>
            <button type="button" onClick={() => void openOnAnotherDevice()}>open on another device</button>
            <button type="button" onClick={signOut} disabled={busy}>log out</button>
            <p role="status" aria-live="polite">{deviceMessage}</p>
            <small>use the same passkey there. canvas sync is not enabled yet. browser storage may be cleared.</small>
          </aside>
        ) : null}
      </div>
    );
  }

  return (
    <main className={styles.access}>
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
