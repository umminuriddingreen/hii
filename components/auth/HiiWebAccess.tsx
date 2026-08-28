// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { FormEvent, useEffect, useState } from 'react';
import styles from './HiiWebAccess.module.css';

type AccessMode = 'login' | 'signup' | null;

type Session = {
  authenticated: boolean;
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

export function HiiWebAccess() {
  const [mode, setMode] = useState<AccessMode>(null);
  const [session, setSession] = useState<Session>({ authenticated: false });
  const [handle, setHandle] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

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
    await api('/api/auth/logout', {}, session.csrfToken).catch(() => undefined);
    setSession({ authenticated: false });
    setMode(null);
    setBusy(false);
  };

  return (
    <main className={styles.access}>
      <span className={styles.wordmark}>hii</span>

      {ready && session.authenticated ? (
        <section className={styles.instructions} aria-label="HII download instructions">
          <header className={styles.accountLine}>
            <span>{session.handle}</span>
            <button type="button" onClick={signOut} disabled={busy}>
              log out
            </button>
          </header>
          <ol className={styles.downloadList}>
            <li>
              <a href="/download/windows">download for windows</a>
              <p>open the installer. macOS is coming next.</p>
            </li>
            <li>
              <strong>open hii</strong>
              <p>the terminal runs natively on your machine.</p>
            </li>
            <li>
              <strong>choose access</strong>
              <p>grant a folder only when you want hii to work with it.</p>
            </li>
          </ol>
        </section>
      ) : mode ? (
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
    </main>
  );
}

export default HiiWebAccess;
