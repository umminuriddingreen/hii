// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceNode } from '@/lib/workspace/types';
import { feedSnapshotFromNode, type FeedItem, type FeedSnapshot } from '@/lib/web/feed-contract';
import styles from './HiiWebAccess.module.css';
import { PairedMachines } from '@/components/remote/PairedMachines';
import { LocalHiiChat } from '@/components/remote/LocalHiiChat';

export type WebPanel = 'feed' | 'models';

async function request<T>(path: string, csrfToken: string, body?: unknown, method?: 'POST' | 'DELETE'): Promise<T> {
  const response = await fetch(path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(body === undefined ? {} : { 'X-HII-CSRF': csrfToken }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'request_failed');
  return payload;
}

function Snapshot({ snapshot }: { snapshot: FeedSnapshot }) {
  if (snapshot.kind === 'text') return <p className={styles.feedText}>{snapshot.text}</p>;
  if (snapshot.kind === 'sticker') return <p className={styles.feedSticker}>{snapshot.emoji}</p>;
  return <p className={styles.feedText}>drawing · {snapshot.strokes.reduce((count, stroke) => count + stroke.points.length / 2, 0)} points</p>;
}

function FeedPanel({ csrfToken, shareNode, onImport }: { csrfToken: string; shareNode: WorkspaceNode | null; onImport: (item: FeedItem) => void }) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [message, setMessage] = useState('');
  const snapshot = shareNode ? feedSnapshotFromNode(shareNode) : null;
  const load = useCallback(async () => {
    try {
      const page = await request<{ items: Array<{ id: string; author: { handle: string }; snapshot: FeedSnapshot; provenance: FeedItem['provenance']; publishedAt: number; mine: boolean }> }>('/api/feed?limit=30', csrfToken);
      setItems(page.items.map((item) => ({ id: item.id, authorHandle: item.author.handle, snapshot: item.snapshot, provenance: item.provenance, createdAt: item.publishedAt, ownedByViewer: item.mine })));
    } catch { setMessage('could not load the feed.'); }
  }, [csrfToken]);
  useEffect(() => { void load(); }, [load]);
  const publish = async () => {
    if (!shareNode || !snapshot) return;
    setMessage('');
    try {
      const publishedSnapshot = snapshot.kind === 'ink'
        ? { kind: 'ink' as const, strokes: snapshot.strokes.map((stroke) => ({ points: stroke.points })) }
        : snapshot;
      await request('/api/feed/items', csrfToken, { clientRequestId: crypto.randomUUID(), sourceNodeId: shareNode.id, sourceUpdatedAt: shareNode.updatedAt, snapshot: publishedSnapshot });
      setMessage('shared.');
      await load();
    } catch { setMessage('could not share this item.'); }
  };
  const act = async (item: FeedItem, action: 'revoke' | 'report') => {
    try {
      await request(`/api/feed/items/${item.id}/${action}`, csrfToken, action === 'report' ? { reason: 'other' } : {});
      await load();
    } catch { setMessage(`could not ${action}.`); }
  };
  return <>
    {shareNode ? <section className={styles.sharePreview} aria-label="Share preview">
      <small>public preview</small>
      {snapshot ? <Snapshot snapshot={snapshot} /> : <p>this item cannot be shared.</p>}
      <button type="button" disabled={!snapshot} onClick={() => void publish()}>share to feed</button>
      <small>only this preview is published. canvas context stays private.</small>
    </section> : null}
    <div className={styles.list}>
      {items.map((item) => <article key={item.id}>
        <small>{item.authorHandle} · {new Date(item.createdAt).toLocaleString()}</small>
        <Snapshot snapshot={item.snapshot} />
        <div><button type="button" onClick={() => onImport(item)}>add to canvas</button>{item.ownedByViewer ? <button type="button" onClick={() => void act(item, 'revoke')}>revoke</button> : <button type="button" onClick={() => void act(item, 'report')}>report</button>}</div>
      </article>)}
    </div>
    <p role="status">{message}</p>
  </>;
}

export function HiiWebPanel({ panel, csrfToken, shareNode, contextNodes, onClose, onImport, onPlaceResult }: { panel: WebPanel; csrfToken: string; shareNode: WorkspaceNode | null; contextNodes?: WorkspaceNode[]; onClose: () => void; onImport: (item: FeedItem) => void; onPlaceResult?: (text: string) => void }) {
  const [showDevices, setShowDevices] = useState(false);
  return <aside className={styles.webPanel} aria-label={`HII ${panel}`} data-workspace-ui>
    <header><span>{panel === 'models' ? 'HII Remote' : panel}</span><button type="button" onClick={onClose}>close</button></header>
    {panel === 'feed' ? <FeedPanel csrfToken={csrfToken} shareNode={shareNode} onImport={onImport} /> : null}
    {panel === 'models' ? <>
      <LocalHiiChat contextNodes={contextNodes} onPlaceResult={onPlaceResult} onOpenDevices={() => setShowDevices(true)} />
      <button type="button" className={styles.remoteDevicesToggle} onClick={() => setShowDevices((value) => !value)}>{showDevices ? 'Hide computers' : 'Connect or manage computers'}</button>
      {showDevices && <PairedMachines embedded authenticatedSession={{ authenticated: true, csrfToken }} />}
    </> : null}
  </aside>;
}
