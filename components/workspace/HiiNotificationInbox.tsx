// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';
import { useCallback, useEffect, useState } from 'react';
import { listNotifications, markNotificationRead } from '@/lib/client/hii-bridge';
import type { HiiNotification } from '@/lib/notifications/types';

export function HiiNotificationInbox() {
  const [items, setItems] = useState<HiiNotification[]>([]);
  const [open, setOpen] = useState(false);
  const refresh = useCallback(async () => {
    try { setItems(await listNotifications()); }
    catch { /* The canvas stays usable when its local server is unavailable. */ }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 3000); return () => window.clearInterval(timer); }, [refresh]);
  const unread = items.filter((item) => !item.readAt).length;
  const markRead = async (id: string) => { await markNotificationRead(id); await refresh(); };
  return <aside className="hii-notification-inbox" data-open={open || undefined} aria-label="Agent notifications">
    <button className="hii-notification-trigger" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}><span>Agents</span>{unread > 0 && <b>{unread}</b>}</button>
    {open && <section><header><strong>Agent inbox</strong><small>{unread} unread · local ledger</small></header><div className="hii-notification-list">
      {items.length ? items.map((item) => <article key={item.id} data-severity={item.severity} data-read={Boolean(item.readAt)}>
        <header><strong>{item.title}</strong><time>{new Date(Number(item.createdAt) || item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></header>
        <p>{item.body}</p><footer><span>{item.source}{item.coordinate ? ` · ${item.coordinate}` : ''}</span>{!item.readAt && <button type="button" onClick={() => void markRead(item.id)}>Read</button>}</footer>
        {item.deliveries.some((delivery) => delivery.route !== 'canvas') && <small>{item.deliveries.filter((delivery) => delivery.route !== 'canvas').map((delivery) => `${delivery.route}: ${delivery.status.replace('_', ' ')}`).join(' · ')}</small>}
      </article>) : <p className="hii-notification-empty">Agent updates will arrive here.</p>}
    </div></section>}
  </aside>;
}
