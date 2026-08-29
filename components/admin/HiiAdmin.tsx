'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createAdminTask, readAdminSnapshot, type AdminSnapshot } from '@/lib/client/admin-bridge';
import styles from './HiiAdmin.module.css';

function stateOf(value: unknown) {
  return typeof value === 'string' ? value : 'unknown';
}

export function HiiAdmin() {
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [intent, setIntent] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setSnapshot(await readAdminSnapshot()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const home = snapshot?.home ?? {};
  const workspace = home.workspace ?? {};
  const tasks = snapshot?.work.activeTasks ?? [];
  const capabilities = Array.isArray(home.capabilities) ? home.capabilities : [];
  const proof = snapshot?.latestProof;
  const lanes = useMemo(() => tasks.reduce<Record<string, number>>((counts, task) => {
    const lane = stateOf(task.lane);
    counts[lane] = (counts[lane] ?? 0) + 1;
    return counts;
  }, {}), [tasks]);

  return (
    <main className={styles.portal}>
      <header className={styles.header}>
        <a href="/" className={styles.mark}>hii</a>
        <div><p>Local authority</p><h1>Control room</h1></div>
        <span className={styles.localSeal}>This Mac only</span>
        <button type="button" onClick={() => void refresh()} disabled={loading}>{loading ? 'Reading…' : 'Refresh state'}</button>
      </header>

      {error && <section className={styles.failure}><b>Admin bridge unavailable</b><span>{error}</span></section>}

      <div className={styles.authoritySpine} aria-label="Authority boundary">
        <span>Observe</span><i /><span>Act with approval</span>
      </div>

      <section className={styles.system} aria-labelledby="system-heading">
        <div className={styles.sectionTitle}><p>Machine truth</p><h2 id="system-heading">HII is {workspace.clean === false ? 'in motion' : 'settled'}.</h2></div>
        <dl>
          <div><dt>Repository</dt><dd>{home.identity?.repo ?? 'unavailable'}</dd></div>
          <div><dt>Branch</dt><dd>{workspace.branch ?? 'unknown'}</dd></div>
          <div><dt>Changes</dt><dd>{workspace.changes?.total ?? 0}</dd></div>
          <div><dt>Runtime</dt><dd>{home.identity?.runtime ?? 'unavailable'}</dd></div>
        </dl>
      </section>

      <section className={styles.work} aria-labelledby="work-heading">
        <div className={styles.sectionTitle}><p>Human + agent work</p><h2 id="work-heading">{tasks.length} open assignments</h2></div>
        <div className={styles.lanes}>{Object.entries(lanes).map(([lane, count]) => <span key={lane}><b>{count}</b>{lane}</span>)}</div>
        <form className={styles.assignment} onSubmit={(event) => {
          event.preventDefault();
          if (!intent.trim() || loading) return;
          setLoading(true); setError('');
          void createAdminTask(intent.trim())
            .then((next) => { setSnapshot(next); setIntent(''); })
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setLoading(false));
        }}>
          <label htmlFor="admin-assignment">Give HII or an agent an assignment</label>
          <div><input id="admin-assignment" value={intent} maxLength={500} onChange={(event) => setIntent(event.target.value)} placeholder="Describe the outcome…" /><button type="submit" disabled={!intent.trim() || loading}>Queue work</button></div>
          <small>Queues intent locally. Execution and consequential actions still require their normal approvals.</small>
        </form>
        <div className={styles.rows}>{tasks.slice(0, 8).map((task) => (
          <article key={String(task.id)}><i data-priority={task.priority} /><div><strong>{task.title}</strong><small>{task.owner} · {task.coordinate}</small></div><code>{task.lane}</code></article>
        ))}{!tasks.length && !loading && <p>No assignments are waiting. Create work through the HII CLI or canvas.</p>}</div>
      </section>

      <section className={styles.capabilities} aria-labelledby="cap-heading">
        <div className={styles.sectionTitle}><p>Available hands</p><h2 id="cap-heading">{capabilities.length} capabilities</h2></div>
        <div className={styles.capGrid}>{capabilities.map((capability: any) => (
          <article key={capability.id}><span data-status={capability.status}>{capability.status}</span><strong>{capability.id}</strong><small>{capability.name ?? capability.summary ?? 'HII capability'}</small></article>
        ))}</div>
      </section>

      <section className={styles.proof} aria-labelledby="proof-heading">
        <div className={styles.sectionTitle}><p>Last receipt</p><h2 id="proof-heading">{proof?.status ?? 'No proof yet'}</h2></div>
        <code>{proof?.id ?? 'Run verified work through HII to create a receipt.'}</code>
        <p>{proof?.goal ?? 'Receipts bind intent, execution, verification, and artifacts.'}</p>
      </section>

      <footer><span>Authority: {snapshot?.authority ?? 'awaiting HII CLI'}</span><span>{snapshot ? new Date(snapshot.generatedAt).toLocaleString() : 'Reading local state…'}</span></footer>
    </main>
  );
}
