// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { useCallback, useEffect, useState } from 'react';
import styles from './AccountsOverview.module.css';

type AccountRow = {
  handle: string;
  created_at: number;
  devices: number;
  workspaces: number;
  last_seen_at: number | null;
};

type Overview = {
  generatedAt: number;
  totalAccounts: number;
  newLast7d: number;
  newLast30d: number;
  rosterLimit: number;
  signupsByWeek: { weekStart: number; count: number }[];
  accounts: AccountRow[];
};

/** `404` is what a signed-in non-operator gets, so it is not an error state. */
type State =
  | { kind: 'loading' }
  | { kind: 'ready'; data: Overview }
  | { kind: 'unavailable' }
  | { kind: 'signed-out' }
  | { kind: 'failed'; detail: string };

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function since(ms: number | null) {
  if (!ms) return '—';
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return day(ms);
}

/** Signups per week as a bar row. Heights are relative to the busiest week. */
function Sparkline({ weeks }: { weeks: Overview['signupsByWeek'] }) {
  if (!weeks.length) return <p className={styles.empty}>No signups yet.</p>;
  const peak = Math.max(...weeks.map((week) => week.count), 1);
  const total = weeks.reduce((sum, week) => sum + week.count, 0);
  return (
    <>
      <div
        className={styles.spark}
        role="img"
        aria-label={`${total} signups across the last ${weeks.length} weeks; busiest week ${peak}`}
      >
        {weeks.map((week) => (
          <span
            key={week.weekStart}
            className={styles.sparkBar}
            style={{ height: `${Math.max(6, (week.count / peak) * 100)}%` }}
            title={`Week of ${day(week.weekStart)}: ${week.count}`}
          />
        ))}
      </div>
      <p className={styles.sparkAxis}>
        <span>week of {day(weeks[0].weekStart)}</span>
        <span>peak {peak}</span>
        <span>this week</span>
      </p>
    </>
  );
}

export function AccountsOverview() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const response = await fetch('/api/admin/accounts', { credentials: 'same-origin' });
      if (response.status === 401) return setState({ kind: 'signed-out' });
      if (response.status === 404) return setState({ kind: 'unavailable' });
      if (!response.ok) return setState({ kind: 'failed', detail: `HTTP ${response.status}` });
      setState({ kind: 'ready', data: (await response.json()) as Overview });
    } catch (error) {
      setState({ kind: 'failed', detail: error instanceof Error ? error.message : 'request failed' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'loading') {
    return <main className={styles.shell} id="hii-main"><p className={styles.status} role="status">Reading accounts…</p></main>;
  }
  if (state.kind === 'signed-out') {
    return (
      <main className={styles.shell} id="hii-main">
        <p className={styles.kicker}>HII / Accounts</p>
        <h1>Sign in first.</h1>
        <p className={styles.lede}>This view reads your own deployment&rsquo;s records and needs your account.</p>
        <nav><a href="/">Go to HII</a></nav>
      </main>
    );
  }
  if (state.kind === 'unavailable') {
    return (
      <main className={styles.shell} id="hii-main">
        <p className={styles.kicker}>HII / Accounts</p>
        <h1>Nothing is here.</h1>
        <p className={styles.lede}>
          This account is not an operator of this deployment. Operators are named in the
          <code> HII_ADMIN_HANDLES</code> secret.
        </p>
        <nav><a href="/">Home</a></nav>
      </main>
    );
  }
  if (state.kind === 'failed') {
    return (
      <main className={styles.shell} id="hii-main">
        <p className={styles.kicker}>HII / Accounts</p>
        <h1>Could not read.</h1>
        <p className={styles.lede}>{state.detail}</p>
        <nav><button type="button" className={styles.action} onClick={() => void load()}>Try again</button></nav>
      </main>
    );
  }

  const { data } = state;
  const truncated = data.totalAccounts > data.accounts.length;

  return (
    <main className={styles.shell} id="hii-main">
      <header className={styles.head}>
        <p className={styles.kicker}>HII / Accounts</p>
        <button type="button" className={styles.action} onClick={() => void load()}>Refresh</button>
      </header>

      <section className={styles.figures} aria-label="Account totals">
        <div><strong>{data.totalAccounts.toLocaleString()}</strong><span>accounts</span></div>
        <div><strong>{data.newLast7d.toLocaleString()}</strong><span>new · 7 days</span></div>
        <div><strong>{data.newLast30d.toLocaleString()}</strong><span>new · 30 days</span></div>
      </section>

      <section className={styles.panel} aria-label="Signups per week">
        <h2>Signups per week</h2>
        <Sparkline weeks={data.signupsByWeek} />
      </section>

      <section className={styles.panel} aria-label="Account roster">
        <h2>
          Roster
          {truncated ? <small> · newest {data.accounts.length} of {data.totalAccounts}</small> : null}
        </h2>
        {data.accounts.length ? (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr><th scope="col">Handle</th><th scope="col">Created</th><th scope="col">Devices</th><th scope="col">Workspaces</th><th scope="col">Last seen</th></tr>
              </thead>
              <tbody>
                {data.accounts.map((account) => (
                  <tr key={account.handle}>
                    <th scope="row">{account.handle}</th>
                    <td>{day(account.created_at)}</td>
                    <td className={styles.num}>{account.devices}</td>
                    <td className={styles.num}>{account.workspaces}</td>
                    <td>{since(account.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className={styles.empty}>No accounts yet.</p>}
      </section>

      <footer className={styles.foot}>
        Read at {new Date(data.generatedAt).toLocaleString()} · this view reports only what HII already
        stores to run the service. Nothing additional is collected.
      </footer>
    </main>
  );
}
