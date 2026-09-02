// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

// PairedMachines — the account side of the HII paired-host link.
//
// This surface pairs, lists, and revokes machines. It deliberately does not
// view them: the screen viewer and input injection were removed along with the
// host-side capture. The remote surface HII wants over this link is live canvas
// synchronisation, and pairing is the transport that will carry it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import styles from './PairedMachines.module.css';

export type RemoteSession = {
  authenticated: boolean;
  handle?: string;
  csrfToken?: string;
};

type Host = {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  online: boolean;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'request_failed');
  return payload;
}

function remoteError(cause: unknown) {
  const code = cause instanceof Error ? cause.message : String(cause || 'request_failed');
  if (code === 'request_failed') return 'HII Remote is unavailable in this preview.';
  return code.replaceAll('_', ' ');
}

export function PairedMachines({ embedded = false, authenticatedSession }: { embedded?: boolean; authenticatedSession?: RemoteSession }) {
  const [session, setSession] = useState<RemoteSession | null>(authenticatedSession ?? null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<{ hostId: string; token: string } | null>(null);
  const [newHostName, setNewHostName] = useState('');

  useEffect(() => {
    if (authenticatedSession) {
      setSession(authenticatedSession);
      return;
    }
    api<RemoteSession>('/api/auth/session')
      .then(setSession)
      .catch(() => setSession({ authenticated: false }));
  }, [authenticatedSession]);

  const refreshHosts = useCallback(async () => {
    try {
      const payload = await api<{ hosts: Host[] }>('/api/remote/hosts');
      setHosts(payload.hosts);
    } catch (cause) {
      setError(remoteError(cause));
    }
  }, []);

  useEffect(() => {
    if (session?.authenticated) void refreshHosts();
  }, [session?.authenticated, refreshHosts]);

  const pairHost = useCallback(async () => {
    if (!session?.csrfToken) return;
    try {
      const created = await api<{ hostId: string; token: string }>('/api/remote/hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HII-CSRF': session.csrfToken },
        body: JSON.stringify({ name: newHostName.trim() || 'My Mac' }),
      });
      setIssuedToken(created);
      setNewHostName('');
      await refreshHosts();
    } catch (cause) {
      setError(remoteError(cause));
    }
  }, [session?.csrfToken, newHostName, refreshHosts]);

  const revokeHost = useCallback(
    async (host: Host) => {
      if (!session?.csrfToken) return;
      try {
        await api(`/api/remote/hosts/${host.id}`, {
          method: 'DELETE',
          headers: { 'X-HII-CSRF': session.csrfToken },
        });
        await refreshHosts();
      } catch (cause) {
        setError(remoteError(cause));
      }
    },
    [session?.csrfToken, refreshHosts],
  );

  const setupCommand = useMemo(
    () =>
      issuedToken
        ? 'curl -fsSL https://humaninformationinterface.com/hii-chat/install.sh | sh'
        : null,
    [issuedToken],
  );

  if (session && !session.authenticated) {
    return (
      <main className={`${styles.gate} ${embedded ? styles.embeddedGate : ''}`}>
        <h1>HII Remote</h1>
        <p>Sign in to your HII account to reach your paired machines.</p>
        <a className={styles.primary} href="/">Sign in</a>
      </main>
    );
  }

  return (
    <main className={`${styles.shell} ${embedded ? styles.embedded : ''}`}>
      <header className={styles.bar}>
        <span className={styles.brand}>HII Remote</span>
        <div className={styles.spacer} />
      </header>

      {error ? <p className={styles.error}>{error}</p> : null}

      <section className={styles.hosts}>
        <h1>Your computers</h1>
        {hosts.length === 0 ? <p>No computers paired yet.</p> : null}
        <ul>
          {hosts.map((host) => (
            <li key={host.id}>
              <span className={styles.dot} data-online={host.online} />
              <strong>{host.name}</strong>
              <span className={styles.subtle}>
                {host.online ? 'online' : host.lastSeenAt
                  ? `last seen ${new Date(host.lastSeenAt).toLocaleString()}`
                  : 'never connected'}
              </span>
              <div className={styles.spacer} />
              <button type="button" onClick={() => void revokeHost(host)}>Revoke</button>
            </li>
          ))}
        </ul>

        <h2>Pair a computer</h2>
        <div className={styles.pair}>
          <input
            value={newHostName}
            placeholder="Computer name"
            onChange={(event) => setNewHostName(event.target.value)}
          />
          <button type="button" className={styles.primary} onClick={() => void pairHost()}>
            Create pairing token
          </button>
        </div>
        {setupCommand ? (
          <div className={styles.token}>
            <p>Run this once on the Mac you want to reach, then paste the pairing token when asked. The token is shown only now and stays out of shell history.</p>
            <code>{setupCommand}</code>
            <button type="button" onClick={() => navigator.clipboard?.writeText(setupCommand)}>
              Copy installer
            </button>
            <code>{issuedToken?.token}</code>
            <button type="button" onClick={() => navigator.clipboard?.writeText(issuedToken?.token ?? '')}>
              Copy pairing token
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
